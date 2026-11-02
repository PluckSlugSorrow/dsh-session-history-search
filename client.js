/**
 * Session History Search — browser half.
 *
 * Registers one global panel (`sidebar.panellist` icon + `main` keyed view) that
 * searches the message text of every past Session. Results open the matching
 * Session in the conversation view through the Workspace navigation service.
 *
 * The panel is intentionally built from theme tokens and inline styles only: it
 * ships no CSS file, imports no Harness Client package, and touches no DOM that
 * belongs to another plugin.
 */

window.__ModuleLoader__.load({
	id: 'dsh-session-history-search',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useCallback, useEffect, useRef, useState } = React;

		const NS = 'session-history-search';
		const PANEL_ID = 'session-history-search';
		const SEARCH_ROUTE = '/plugin/session-history-search/search';
		const DEBOUNCE_MS = 320;
		const RESULT_LIMIT = 40;

		const DICT = {
			zh: {
				panel: '历史搜索',
				title: '搜索历史对话',
				subtitle: '按内容找到你在任意会话里提过的问题或需求',
				placeholder: '输入关键词，例如：插件、投标、价格库',
				clear: '清除',
				onlyMine: '只看我发的消息',
				allRoles: '搜索全部消息',
				refresh: '重建索引',
				'idle.title': '在全部历史会话中搜索',
				'idle.tip1': '任意关键词都可以，逐个会话扫描消息正文。',
				'idle.tip2': '匹配中文子串，不需要完整句子或空格分词。',
				'idle.tip3': '点击任意结果即可切回那个会话继续追问。',
				loading: '正在扫描历史会话…',
				'empty.title': '没有找到匹配的消息',
				'empty.tip': '试试更短的关键词，或改成「搜索全部消息」以包含助手回复。',
				'error.title': '搜索失败',
				retry: '重试',
				open: '打开会话',
				live: '进行中',
				user: '我',
				assistant: '助手',
				hits: '处命中',
				sessionsMatched: '个会话命中',
				scanned: '扫描',
				sessions: '个会话',
				messages: '条消息',
				partial: '已达时间上限，结果可能不完整',
				shown: '最多显示',
				fallbackWorkspace: '默认工作区',
				'time.justNow': '刚刚',
				'time.minutes': '分钟前',
				'time.hours': '小时前',
				'time.days': '天前',
			},
			en: {
				panel: 'History',
				title: 'Search past conversations',
				subtitle: 'Find anything you asked in any earlier session, by content',
				placeholder: 'Type a keyword, e.g. plugin, invoice, budget',
				clear: 'Clear',
				onlyMine: 'Only my messages',
				allRoles: 'Search all messages',
				refresh: 'Rebuild index',
				'idle.title': 'Search across every past session',
				'idle.tip1': 'Any keyword works; each session body is scanned in turn.',
				'idle.tip2': 'Matching is substring based, so Chinese needs no word breaks.',
				'idle.tip3': 'Click a result to jump back into that conversation.',
				loading: 'Scanning past sessions…',
				'empty.title': 'No matching messages',
				'empty.tip': 'Try a shorter keyword, or switch to “Search all messages” to include replies.',
				'error.title': 'Search failed',
				retry: 'Retry',
				open: 'Open session',
				live: 'active',
				user: 'You',
				assistant: 'Assistant',
				hits: 'hits',
				sessionsMatched: 'sessions matched',
				scanned: 'scanned',
				sessions: 'sessions',
				messages: 'messages',
				partial: 'time budget reached, results may be incomplete',
				shown: 'showing first',
				fallbackWorkspace: 'Default workspace',
				'time.justNow': 'just now',
				'time.minutes': 'min ago',
				'time.hours': 'h ago',
				'time.days': 'd ago',
			},
		};

		/**
		 * Read a client service, tolerating both the property and `get()` form.
		 * @param ctx - plugin context.
		 * @param name - service name.
		 * @returns the service, or undefined.
		 */
		function serviceOf(ctx, name) {
			try {
				const value = ctx[name];
				if (value !== undefined) return value;
			} catch {}
			try {
				return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
			} catch {
				return undefined;
			}
		}

		/**
		 * Last path segment of a workspace root.
		 * @param cwd - absolute path.
		 * @param fallback - label used when the path is empty.
		 * @returns short workspace label.
		 */
		function workspaceLabel(cwd, fallback) {
			if (typeof cwd !== 'string' || cwd === '') return fallback;
			const parts = cwd.split(/[\\/]+/u).filter((part) => part !== '');
			return parts.length === 0 ? fallback : parts[parts.length - 1];
		}

		/**
		 * Human-readable age of a timestamp.
		 * @param ms - epoch milliseconds.
		 * @param t - translate function.
		 * @returns short relative label.
		 */
		function relativeTime(ms, t) {
			if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
			const diff = Date.now() - ms;
			if (diff < 60_000) return t('time.justNow');
			if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} ${t('time.minutes')}`;
			if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ${t('time.hours')}`;
			if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} ${t('time.days')}`;
			const date = new Date(ms);
			const pad = (value) => String(value).padStart(2, '0');
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		/**
		 * Split text into plain runs and highlighted hits.
		 * @param text - snippet.
		 * @param needle - query.
		 * @param keyPrefix - stable React key prefix.
		 * @returns renderable nodes.
		 */
		function highlight(text, needle, keyPrefix) {
			const source = String(text);
			if (needle === '') return [source];
			const lowerSource = source.toLowerCase();
			const lowerNeedle = needle.toLowerCase();
			const nodes = [];
			let index = 0;
			let guard = 0;
			while (guard < 80) {
				guard += 1;
				const at = lowerSource.indexOf(lowerNeedle, index);
				if (at < 0) break;
				if (at > index) nodes.push(source.slice(index, at));
				nodes.push(
					h(
						'mark',
						{
							key: `${keyPrefix}-${at}`,
							style: {
								background: 'var(--dsw-alias-brand-primary)',
								color: 'var(--dsw-alias-bg-base)',
								borderRadius: 3,
								padding: '0 2px',
							},
						},
						source.slice(at, at + lowerNeedle.length),
					),
				);
				index = at + lowerNeedle.length;
			}
			if (index < source.length) nodes.push(source.slice(index));
			return nodes;
		}

		const buttonReset = {
			appearance: 'none',
			border: 'none',
			background: 'transparent',
			color: 'inherit',
			font: 'inherit',
			padding: 0,
			margin: 0,
			textAlign: 'left',
			cursor: 'pointer',
			width: '100%',
			display: 'block',
		};

		/**
		 * Focusable button with hover feedback, built from theme tokens.
		 * @param props - onPress, style, hoverStyle, children, title, ariaLabel.
		 */
		function Pressable({ onPress, style, hoverStyle, children, title, ariaLabel }) {
			const [hovered, setHovered] = useState(false);
			const [focused, setFocused] = useState(false);
			return h(
				'button',
				{
					type: 'button',
					title,
					'aria-label': ariaLabel,
					onClick: onPress,
					onMouseEnter: () => setHovered(true),
					onMouseLeave: () => setHovered(false),
					onFocus: () => setFocused(true),
					onBlur: () => setFocused(false),
					style: {
						...buttonReset,
						...(style ?? null),
						...(hovered ? hoverStyle : null),
						...(focused ? { outline: '2px solid var(--dsw-alias-brand-primary)', outlineOffset: 2 } : null),
					},
				},
				children,
			);
		}

		/** Sidebar entry icon: a magnifier over two text lines. */
		function PanelIcon({ size, active }) {
			const edge = typeof size === 'number' && size > 0 ? size : 18;
			return h(
				'svg',
				{
					width: edge,
					height: edge,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: active ? 1.9 : 1.7,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('circle', { cx: 10.2, cy: 10.2, r: 6.1 }),
				h('path', { d: 'M14.7 14.7 20 20' }),
				h('path', { d: 'M7.6 8.1h5.2' }),
				h('path', { d: 'M7.6 11.2h3.1' }),
			);
		}

		/** One Session's result card: header plus matched snippets. */
		function SessionCard({ item, t, needle, onOpen }) {
			const [hovered, setHovered] = useState(false);
			const title = item.title === '' ? t('empty.title') : item.title;
			return h(
				'div',
				{
					onMouseEnter: () => setHovered(true),
					onMouseLeave: () => setHovered(false),
					style: {
						border: '1px solid var(--dsw-alias-border-l2)',
						borderRadius: 12,
						background: 'var(--dsw-alias-bg-layer-1)',
						overflow: 'hidden',
						marginBottom: 10,
						transition: 'border-color 120ms ease',
						borderColor: hovered ? 'var(--dsw-alias-border-l4)' : 'var(--dsw-alias-border-l2)',
					},
				},
				h(
					Pressable,
					{
						onPress: () => onOpen(item.sessionId),
						title: t('open'),
						ariaLabel: `${t('open')}: ${title}`,
						style: { padding: '12px 14px' },
						hoverStyle: { background: 'var(--dsw-alias-interactive-bg-hover)' },
					},
					h(
						'div',
						{ style: { display: 'flex', alignItems: 'center', gap: 10 } },
						h(
							'span',
							{
								style: {
									flex: 1,
									minWidth: 0,
									fontSize: 14,
									fontWeight: 600,
									color: 'var(--dsw-alias-label-primary)',
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
								},
							},
							title,
						),
						h(
							'span',
							{
								style: {
									flexShrink: 0,
									fontSize: 11,
									lineHeight: 1.6,
									padding: '0 6px',
									borderRadius: 6,
									color: 'var(--dsw-alias-brand-primary)',
									background: 'var(--dsw-alias-bg-layer-2)',
								},
							},
							`${item.matchCount} ${t('hits')}`,
						),
					),
					h(
						'div',
						{
							style: {
								marginTop: 4,
								display: 'flex',
								alignItems: 'center',
								gap: 8,
								fontSize: 12,
								color: 'var(--dsw-alias-label-tertiary)',
							},
						},
						h('span', null, workspaceLabel(item.cwd, t('fallbackWorkspace'))),
						h('span', { 'aria-hidden': 'true' }, '·'),
						h('span', null, relativeTime(item.latest, t)),
						item.live === true
							? h(
									'span',
									{
										style: {
											fontSize: 11,
											lineHeight: 1.6,
											padding: '0 6px',
											borderRadius: 6,
											color: 'var(--dsw-alias-state-success-primary)',
											background: 'var(--dsw-alias-bg-layer-2)',
										},
									},
									t('live'),
								)
							: null,
					),
				),
				...(item.matches ?? []).map((match, index) =>
					h(
						Pressable,
						{
							key: `${item.sessionId}-${match.seq}-${index}`,
							onPress: () => onOpen(item.sessionId),
							title: t('open'),
							style: {
								padding: '10px 14px',
								borderTop: '1px solid var(--dsw-alias-border-l3)',
								display: 'flex',
								alignItems: 'flex-start',
								gap: 8,
							},
							hoverStyle: { background: 'var(--dsw-alias-interactive-bg-hover)' },
						},
						h(
							'span',
							{
								style: {
									flexShrink: 0,
									marginTop: 1,
									fontSize: 11,
									lineHeight: 1.7,
									padding: '0 6px',
									borderRadius: 6,
									color:
										match.type === 'user'
											? 'var(--dsw-alias-brand-primary)'
											: 'var(--dsw-alias-label-secondary)',
									background: 'var(--dsw-alias-bg-layer-2)',
								},
							},
							match.type === 'user' ? t('user') : t('assistant'),
						),
						h(
							'span',
							{
								style: {
									flex: 1,
									minWidth: 0,
									fontSize: 13,
									lineHeight: 1.65,
									color: 'var(--dsw-alias-label-secondary)',
									overflowWrap: 'anywhere',
								},
							},
							highlight(match.snippet, needle, `${match.seq}`),
						),
					),
				),
			);
		}

		/** Centered idle / empty / error notice. */
		function Notice({ heading, body, tip, children }) {
			return h(
				'div',
				{
					style: {
						maxWidth: 520,
						margin: '0 auto',
						padding: '48px 8px',
						textAlign: 'center',
						color: 'var(--dsw-alias-label-secondary)',
					},
				},
				h(
					'svg',
					{
						width: 34,
						height: 34,
						viewBox: '0 0 24 24',
						fill: 'none',
						stroke: 'var(--dsw-alias-label-tertiary)',
						strokeWidth: 1.5,
						strokeLinecap: 'round',
						strokeLinejoin: 'round',
						'aria-hidden': 'true',
						style: { margin: '0 auto 14px', display: 'block' },
					},
					h('circle', { cx: 10.5, cy: 10.5, r: 6.4 }),
					h('path', { d: 'M15.3 15.3 20.4 20.4' }),
				),
				h(
					'div',
					{ style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 8 } },
					heading,
				),
				body === undefined
					? null
					: h('div', { style: { fontSize: 13, lineHeight: 1.7 } }, body),
				tip === undefined
					? null
					: h(
							'ul',
							{
								style: {
									listStyle: 'none',
									margin: '14px 0 0',
									padding: 0,
									fontSize: 13,
									lineHeight: 1.9,
									color: 'var(--dsw-alias-label-tertiary)',
									textAlign: 'left',
								},
							},
							tip.map((line, index) => h('li', { key: `tip-${index}` }, `· ${line}`)),
						),
				children,
			);
		}

		/** The panel view registered under the `main` key. */
		function HistorySearchPage({ t, nav }) {
			const [query, setQuery] = useState('');
			const [onlyMine, setOnlyMine] = useState(true);
			const [focused, setFocused] = useState(false);
			const [result, setResult] = useState({ status: 'idle', query: '', items: [], stats: null, error: null });
			const inputRef = useRef(null);
			const abortRef = useRef(null);
			const ticketRef = useRef(0);

			const run = useCallback((rawQuery, mine, refresh) => {
				const text = typeof rawQuery === 'string' ? rawQuery.trim() : '';
				if (abortRef.current !== null) {
					abortRef.current.abort();
					abortRef.current = null;
				}
				ticketRef.current += 1;
				const ticket = ticketRef.current;
				if (text === '') {
					setResult({ status: 'idle', query: '', items: [], stats: null, error: null });
					return;
				}
				const controller = typeof AbortController === 'function' ? new AbortController() : null;
				abortRef.current = controller;
				setResult((previous) => ({
					status: 'loading',
					query: text,
					items: previous.query === text ? previous.items : [],
					stats: previous.query === text ? previous.stats : null,
					error: null,
				}));
				const payload = { query: text, userOnly: mine, limit: RESULT_LIMIT, refresh: refresh === true };
				(async () => {
					try {
						const response = await fetch(SEARCH_ROUTE, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify(payload),
							...(controller === null ? null : { signal: controller.signal }),
						});
						const body = await response.json().catch(() => null);
						if (!response.ok || body === null || body.error !== undefined) {
							const message = body !== null && body.error !== undefined ? body.error.message : `HTTP ${response.status}`;
							throw new Error(message);
						}
						if (ticket !== ticketRef.current) return;
						setResult({
							status: 'ready',
							query: text,
							items: Array.isArray(body.items) ? body.items : [],
							stats: body.stats ?? null,
							error: null,
						});
					} catch (error) {
						if (ticket !== ticketRef.current) return;
						if (error !== null && typeof error === 'object' && error.name === 'AbortError') return;
						setResult({
							status: 'error',
							query: text,
							items: [],
							stats: null,
							error: error instanceof Error ? error.message : String(error),
						});
					} finally {
						if (ticket === ticketRef.current) abortRef.current = null;
					}
				})();
			}, []);

			useEffect(() => {
				const handle = window.setTimeout(() => run(query, onlyMine, false), DEBOUNCE_MS);
				return () => window.clearTimeout(handle);
			}, [query, onlyMine, run]);

			useEffect(() => {
				const node = inputRef.current;
				if (node !== null && typeof node.focus === 'function') node.focus();
			}, []);

			useEffect(
				() => () => {
					if (abortRef.current !== null) abortRef.current.abort();
				},
				[],
			);

			const stats = result.stats;
			const needle = result.query;

			const body = [];
			if (result.status === 'loading' && result.items.length === 0) {
				body.push(h(Notice, { key: 'loading', heading: t('loading') }));
			} else if (result.status === 'error') {
				body.push(
					h(Notice, {
						key: 'error',
						heading: t('error.title'),
						body: result.error,
						children: h(
							'div',
							{ style: { marginTop: 16 } },
							h(
								Pressable,
								{
									onPress: () => run(result.query, onlyMine, true),
									style: {
										display: 'inline-block',
										width: 'auto',
										padding: '6px 14px',
										borderRadius: 8,
										border: '1px solid var(--dsw-alias-border-l2)',
										color: 'var(--dsw-alias-label-primary)',
										fontSize: 13,
									},
									hoverStyle: { background: 'var(--dsw-alias-interactive-bg-hover)' },
								},
								t('retry'),
							),
						),
					}),
				);
			} else if (result.status === 'ready' && result.items.length === 0) {
				body.push(h(Notice, { key: 'empty', heading: t('empty.title'), body: t('empty.tip') }));
			} else if (result.items.length > 0) {
				for (const item of result.items) {
					body.push(h(SessionCard, { key: item.sessionId, item, t, needle, onOpen: nav.open }));
				}
			} else {
				body.push(
					h(Notice, {
						key: 'idle',
						heading: t('idle.title'),
						tip: [t('idle.tip1'), t('idle.tip2'), t('idle.tip3')],
					}),
				);
			}

			const chips = [];
			if (stats !== null && result.status !== 'loading') {
				chips.push(
					`${t('scanned')} ${stats.scanned}/${stats.totalSessions} ${t('sessions')} · ${stats.matchedSessions} ${t('sessionsMatched')} · ${(stats.elapsedMs / 1000).toFixed(1)}s`,
				);
				if (stats.returned < stats.matchedSessions) chips.push(`${t('shown')} ${stats.returned}`);
				if (stats.partial === true) chips.push(t('partial'));
			}

			return h(
				'div',
				{
					style: {
						display: 'flex',
						flexDirection: 'column',
						height: '100%',
						minHeight: 0,
						background: 'var(--dsw-alias-bg-base)',
						color: 'var(--dsw-alias-label-primary)',
					},
				},
				h(
					'div',
					{
						style: {
							flexShrink: 0,
							borderBottom: '1px solid var(--dsw-alias-border-l2)',
						},
					},
					h(
						'div',
						{ style: { maxWidth: 880, margin: '0 auto', padding: '22px 24px 16px' } },
						h('div', { style: { fontSize: 17, fontWeight: 600, letterSpacing: 0.1 } }, t('title')),
						h(
							'div',
							{ style: { marginTop: 4, fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary)' } },
							t('subtitle'),
						),
						h(
							'div',
							{ style: { position: 'relative', marginTop: 14 } },
							h(
								'svg',
								{
									width: 16,
									height: 16,
									viewBox: '0 0 24 24',
									fill: 'none',
									stroke: 'var(--dsw-alias-label-tertiary)',
									strokeWidth: 1.8,
									strokeLinecap: 'round',
									'aria-hidden': 'true',
									style: { position: 'absolute', left: 12, top: 12, pointerEvents: 'none' },
								},
								h('circle', { cx: 10.5, cy: 10.5, r: 6.4 }),
								h('path', { d: 'M15.3 15.3 20.4 20.4' }),
							),
							h('input', {
								ref: inputRef,
								type: 'text',
								value: query,
								placeholder: t('placeholder'),
								'aria-label': t('placeholder'),
								onChange: (event) => setQuery(event.target.value),
								onFocus: () => setFocused(true),
								onBlur: () => setFocused(false),
								onKeyDown: (event) => {
									if (event.key === 'Escape') {
										setQuery('');
									} else if (event.key === 'Enter') {
										run(query, onlyMine, false);
									}
								},
								style: {
									width: '100%',
									boxSizing: 'border-box',
									height: 40,
									padding: '0 78px 0 36px',
									borderRadius: 10,
									border: `1px solid ${focused ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
									background: 'var(--dsw-alias-bg-layer-1)',
									color: 'var(--dsw-alias-label-primary)',
									fontSize: 14,
									outline: 'none',
								},
							}),
							query === ''
								? null
								: h(
										'button',
										{
											type: 'button',
											onClick: () => {
												setQuery('');
												const node = inputRef.current;
												if (node !== null && typeof node.focus === 'function') node.focus();
											},
											style: {
												position: 'absolute',
												right: 8,
												top: 8,
												height: 24,
												padding: '0 8px',
												borderRadius: 6,
												border: 'none',
												background: 'transparent',
												color: 'var(--dsw-alias-label-tertiary)',
												fontSize: 12,
												cursor: 'pointer',
											},
											title: t('clear'),
										},
										t('clear'),
									),
						),
						h(
							'div',
							{
								style: {
									marginTop: 10,
									display: 'flex',
									alignItems: 'center',
									gap: 8,
									flexWrap: 'wrap',
									fontSize: 12,
									color: 'var(--dsw-alias-label-tertiary)',
								},
							},
							h(
								Pressable,
								{
									onPress: () => setOnlyMine((value) => !value),
									ariaLabel: onlyMine ? t('onlyMine') : t('allRoles'),
									style: {
										width: 'auto',
										display: 'inline-flex',
										alignItems: 'center',
										gap: 6,
										padding: '4px 10px',
										borderRadius: 999,
										border: '1px solid var(--dsw-alias-border-l2)',
										fontSize: 12,
										color: 'var(--dsw-alias-label-secondary)',
									},
									hoverStyle: { background: 'var(--dsw-alias-interactive-bg-hover)' },
								},
								h(
									'span',
									{
										'aria-hidden': 'true',
										style: {
											width: 6,
											height: 6,
											borderRadius: 999,
											background: onlyMine
												? 'var(--dsw-alias-brand-primary)'
												: 'var(--dsw-alias-label-dimmed)',
										},
									},
								),
								onlyMine ? t('onlyMine') : t('allRoles'),
							),
							h(
								Pressable,
								{
									onPress: () => run(query, onlyMine, true),
									style: {
										width: 'auto',
										padding: '4px 10px',
										borderRadius: 999,
										border: '1px solid var(--dsw-alias-border-l2)',
										fontSize: 12,
										color: 'var(--dsw-alias-label-secondary)',
									},
									hoverStyle: { background: 'var(--dsw-alias-interactive-bg-hover)' },
								},
								t('refresh'),
							),
						),
					),
				),
				h(
					'div',
					{ style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
					h(
						'div',
						{ style: { maxWidth: 880, margin: '0 auto', padding: '16px 24px 40px' } },
						body,
						chips.length === 0
							? null
							: h(
									'div',
									{
										style: {
											marginTop: 14,
											textAlign: 'center',
											fontSize: 11.5,
											color: 'var(--dsw-alias-label-dimmed)',
											lineHeight: 1.8,
										},
									},
									chips.join(' · '),
								),
					),
				),
			);
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, 'zh', DICT.zh));
				ctx.effect(() => ctx.locale.register(NS, 'en', DICT.en));

				/** Active locale, defaulting to Chinese when the snapshot is unavailable. */
				const activeLocale = () => {
					try {
						const snapshot = ctx.locale.getLocale();
						return snapshot !== null && typeof snapshot === 'object' && typeof snapshot.active === 'string'
							? snapshot.active
							: 'zh';
					} catch {
						return 'zh';
					}
				};

				/** Translate one key for the sidebar label, outside React. */
				const labelNow = (key) => {
					const dict = DICT[activeLocale()] ?? DICT.zh;
					return dict[key] ?? key;
				};

				const nav = {
					open(sessionId) {
						try {
							const layout = serviceOf(ctx, 'layout');
							if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null);
						} catch {}
						const workspace = serviceOf(ctx, 'uiWorkspace');
						if (workspace === undefined || typeof workspace.openSession !== 'function') {
							console.error('[session-history-search] the uiWorkspace service is unavailable; cannot open the session');
							return;
						}
						try {
							workspace.openSession(sessionId);
						} catch (error) {
							console.error('[session-history-search] openSession failed', error);
						}
					},
					close() {
						try {
							const layout = serviceOf(ctx, 'layout');
							if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null);
						} catch {}
					},
				};

				ctx.slots.inject('main', () =>
					ctx.slots.register(
						{
							name: 'main',
							key: PANEL_ID,
							locale: NS,
							inject: () => ({ nav }),
						},
						HistorySearchPage,
					),
				);

				ctx.slots.inject('sidebar.panellist', () =>
					ctx.slots.register(
						{
							name: 'sidebar.panellist',
							id: PANEL_ID,
							order: 8,
							label: () => labelNow('panel'),
						},
						PanelIcon,
					),
				);
			},
		};
	},
});
