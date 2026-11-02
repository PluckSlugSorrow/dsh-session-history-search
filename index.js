/**
 * Session History Search — Host half.
 *
 * Adds two same-origin HTTP routes to the running Harness:
 *
 *   POST /plugin/session-history-search/search   { query, userOnly?, limit?, refresh? }
 *   GET  /plugin/session-history-search/health
 *
 * The search is a literal **substring** scan over the semantic text of every
 * Session the Session Query service can see, performed by `filterEvents` (the
 * first-party `kind: 'text'` predicate is a literal, case-insensitive scan).
 * It deliberately does not use the FTS5 index the shipped
 * `@deepseek-ai/dsh-session-query-sqlite` builds: that index tokenizes with
 * `unicode61`, where a whole run of CJK ideographs between two punctuation
 * marks becomes a single token, so a Chinese phrase such as 插件 never matches
 * the sentence 创建一个可以搜索插件的工具. A substring scan keeps Chinese (and
 * every other script) searchable.
 */

const ROUTE_SEARCH = '/plugin/session-history-search/search';
const ROUTE_HEALTH = '/plugin/session-history-search/health';

/** Requests larger than this are refused instead of buffered. */
const MAX_BODY_BYTES = 64 * 1024;
/** Longest accepted query. */
const MAX_QUERY_CHARS = 200;
/** Sessions read per search when no explicit limit is asked for. */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
/** Wall-clock budget for one cold scan; the scan reports itself as partial past it. */
const SCAN_BUDGET_MS = 10000;
/** Parallel Session reads. */
const READ_CONCURRENCY = 12;
/** Snippets kept per Session. */
const MATCHES_PER_SESSION = 4;
/** Characters of context kept on each side of a hit. */
const SNIPPET_RADIUS = 64;
/** Cached per-Session message text is reused for this long. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Hard cap on cached Sessions, oldest evicted first. */
const CACHE_CAPACITY = 400;

export const inject = ['webServer', 'sessionQuery', 'connection'];

/**
 * Read a service off the Context, tolerating both the property and `get()` form.
 * @param ctx - plugin context.
 * @param name - service name.
 * @returns the service, or undefined when the composition does not provide it.
 */
function service(ctx, name) {
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
 * Write one JSON response.
 * @param res - response being owned by this route.
 * @param status - HTTP status.
 * @param payload - serializable payload.
 */
function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(payload));
}

/**
 * Reject a request whose method is not allowed.
 * @param res - response being owned by this route.
 * @param allow - value for the Allow header.
 */
function sendMethodNotAllowed(res, allow) {
	res.statusCode = 405;
	res.setHeader('allow', allow);
	res.end();
}

/**
 * Buffer a request body with a hard size ceiling.
 * @param req - inbound request.
 * @returns decoded UTF-8 body, or undefined when it exceeded the ceiling.
 */
async function readBoundedBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) {
			req.resume();
			return undefined;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size).toString('utf8');
}

/** Collapse every whitespace run into one space so snippets read on one line. */
function flatten(text) {
	return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Derive a fallback title from the earliest operator message that matched.
 * @param matches - matched events for one Session in seq order.
 * @returns a short title, or undefined.
 */
function fallbackTitle(matches) {
	for (const match of matches) {
		if (match.type !== 'user') continue;
		const text = String(match.snippet).replace(/^…/, '').trim();
		if (text === '') continue;
		return text.length > 42 ? `${text.slice(0, 42)}…` : text;
	}
	return undefined;
}

/**
 * Run `worker` over `items` with a bounded number in flight.
 * @param items - inputs.
 * @param limit - maximum concurrent workers.
 * @param worker - async body.
 */
async function mapLimit(items, limit, worker) {
	let cursor = 0;
	const runners = [];
	const width = Math.min(limit, items.length);
	for (let index = 0; index < width; index += 1) {
		runners.push(
			(async () => {
				for (;;) {
					const current = cursor;
					cursor += 1;
					if (current >= items.length) return;
					await worker(items[current], current);
				}
			})(),
		);
	}
	await Promise.all(runners);
}

/**
 * Plugin body.
 * @param ctx - host cordis context.
 */
export function apply(ctx) {
	/** `${sessionId}\u0000${query}\u0000${userOnly}` -> { at, live, documents } */
	const cache = new Map();

	/**
	 * Scan one Session for literal text matches, reusing the cache when fresh.
	 * `filterEvents` is the first-party semantic scan: it extracts each event's
	 * prose with the same rules the FTS index uses and applies the literal,
	 * case-insensitive text predicate before returning the documents.
	 * @param sessionQuery - Session Query service.
	 * @param record - session record.
	 * @param query - normalized query text.
	 * @param userOnly - whether only the operator's own messages count.
	 * @returns cached or freshly scanned matching documents.
	 */
	async function loadMatches(sessionQuery, record, query, userOnly) {
		const id = record.header.id;
		const key = `${id}\u0000${query}\u0000${userOnly ? '1' : '0'}`;
		const cached = cache.get(key);
		// A live Session keeps growing, so only settled ones are reused.
		if (cached !== undefined && cached.live === false && Date.now() - cached.at < CACHE_TTL_MS) return cached;
		const filters = [];
		if (userOnly) filters.push({ kind: 'type', values: ['user/message'] });
		filters.push({ kind: 'text', text: query });
		const documents = await sessionQuery.filterEvents(id, filters);
		const entry = {
			at: Date.now(),
			live: record.live === true,
			documents: Array.isArray(documents) ? documents : [],
		};
		cache.delete(key);
		cache.set(key, entry);
		while (cache.size > CACHE_CAPACITY) {
			const oldest = cache.keys().next();
			if (oldest.done === true) break;
			cache.delete(oldest.value);
		}
		return entry;
	}

	/**
	 * Build a snippet around the first occurrence of `needle`.
	 * @param text - flattened message text.
	 * @param needle - lowercase query.
	 * @returns bounded context.
	 */
	function makeSnippet(text, needle) {
		const at = text.toLowerCase().indexOf(needle);
		if (at < 0) return text.slice(0, SNIPPET_RADIUS * 2);
		const start = Math.max(0, at - SNIPPET_RADIUS);
		const end = Math.min(text.length, at + needle.length + SNIPPET_RADIUS);
		const prefix = start > 0 ? '…' : '';
		const suffix = end < text.length ? '…' : '';
		return `${prefix}${text.slice(start, end)}${suffix}`;
	}

	/**
	 * Execute one search.
	 * @param body - parsed request payload.
	 * @returns response payload.
	 */
	async function search(body) {
		const sessionQuery = service(ctx, 'sessionQuery');
		if (sessionQuery === undefined) {
			const error = new Error('Session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query.');
			error.code = 'SEARCH_UNAVAILABLE';
			error.status = 503;
			throw error;
		}
		const rawQuery = typeof body.query === 'string' ? body.query : '';
		const query = flatten(rawQuery);
		if (query === '') {
			const error = new Error('query must contain non-whitespace text');
			error.code = 'INVALID_QUERY';
			error.status = 400;
			throw error;
		}
		if (Array.from(query).length > MAX_QUERY_CHARS) {
			const error = new Error(`query must be at most ${MAX_QUERY_CHARS} characters`);
			error.code = 'INVALID_QUERY';
			error.status = 400;
			throw error;
		}
		const limit = Number.isSafeInteger(body.limit) ? Math.min(Math.max(body.limit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
		const userOnly = body.userOnly === false ? false : true;
		if (body.refresh === true) cache.clear();

		const startedAt = Date.now();
		const records = await sessionQuery.listSessions();
		const visible = [];
		for (const record of records) {
			// Sessions without a workspace never appear in the sidebar; skip them here too.
			if (record.header === undefined || record.header.cwd === undefined) continue;
			visible.push(record);
		}
		visible.sort((left, right) => right.header.createdAt - left.header.createdAt);

		const needle = query.toLowerCase();
		const found = [];
		let scanned = 0;
		let partial = false;
		const deadline = startedAt + SCAN_BUDGET_MS;

		await mapLimit(visible, READ_CONCURRENCY, async (record) => {
			if (Date.now() > deadline) {
				partial = true;
				return;
			}
			let entry;
			try {
				entry = await loadMatches(sessionQuery, record, query, userOnly);
			} catch {
				return;
			}
			scanned += 1;
			const matches = [];
			const snippets = new Set();
			let latest = 0;
			let matchCount = 0;
			for (const document of entry.documents) {
				const text = flatten(typeof document.text === 'string' ? document.text : '');
				matchCount += 1;
				if (document.time > latest) latest = document.time;
				if (matches.length >= MATCHES_PER_SESSION) continue;
				const snippet = makeSnippet(text, needle);
				// Injected context repeats verbatim across turns; one copy reads better.
				if (matches.length > 0 && snippets.has(snippet)) continue;
				snippets.add(snippet);
				matches.push({
					seq: document.seq,
					type: document.type === 'user/message' ? 'user' : 'assistant',
					time: document.time,
					snippet,
				});
			}
			if (matches.length === 0) return;
			found.push({
				record,
				matches,
				matchCount,
				latest: latest === 0 ? record.header.createdAt : latest,
			});
		});

		found.sort((left, right) => right.latest - left.latest);
		const selected = found.slice(0, limit);

		const titles = new Map();
		if (selected.length > 0) {
			try {
				const observations = await sessionQuery.readTitleSnapshots(selected.map((item) => item.record.header.id));
				for (const observation of observations) {
					if (observation.status !== 'fulfilled') continue;
					const title = observation.value?.title?.title;
					if (typeof title === 'string' && title !== '') titles.set(observation.sessionId, title);
				}
			} catch {}
		}

		const items = selected.map((item) => {
			const header = item.record.header;
			return {
				sessionId: header.id,
				title: titles.get(header.id) ?? fallbackTitle(item.matches) ?? '',
				cwd: header.cwd ?? '',
				createdAt: header.createdAt,
				live: item.record.live === true,
				latest: item.latest,
				matchCount: item.matchCount,
				matches: item.matches,
			};
		});

		return {
			query,
			items,
			stats: {
				totalSessions: visible.length,
				scanned,
				matchedSessions: found.length,
				returned: items.length,
				partial,
				elapsedMs: Date.now() - startedAt,
			},
		};
	}

	/**
	 * Refuse a request the connection layer marks untrusted.
	 * @param req - inbound request.
	 * @param res - response being owned by this route.
	 * @returns true when the request was already answered.
	 */
	function refused(req, res) {
		const connection = service(ctx, 'connection');
		if (connection === undefined || typeof connection.requestRejection !== 'function') return false;
		let status;
		try {
			status = connection.requestRejection(req);
		} catch {
			return false;
		}
		if (status === undefined) return false;
		res.statusCode = status;
		res.end();
		return true;
	}

	ctx.effect(() =>
		ctx.webServer.register({
			kind: 'exact',
			path: ROUTE_HEALTH,
			handler: (req, res) => {
				if (refused(req, res)) return;
				sendJson(res, 200, {
					ok: true,
					sessionQuery: service(ctx, 'sessionQuery') !== undefined,
					cachedSessions: cache.size,
				});
			},
		}),
	);

	ctx.effect(() =>
		ctx.webServer.register({
			kind: 'exact',
			path: ROUTE_SEARCH,
			handler: async (req, res) => {
				if (refused(req, res)) return;
				if (req.method !== 'POST') {
					sendMethodNotAllowed(res, 'POST');
					return;
				}
				const raw = await readBoundedBody(req);
				if (raw === undefined) {
					sendJson(res, 413, { error: { code: 'BODY_TOO_LARGE', message: 'request body is too large' } });
					return;
				}
				let body;
				try {
					body = raw.trim() === '' ? {} : JSON.parse(raw);
				} catch {
					sendJson(res, 400, { error: { code: 'INVALID_BODY', message: 'request body must be JSON' } });
					return;
				}
				if (body === null || typeof body !== 'object') {
					sendJson(res, 400, { error: { code: 'INVALID_BODY', message: 'request body must be a JSON object' } });
					return;
				}
				try {
					sendJson(res, 200, await search(body));
				} catch (error) {
					const status = typeof error?.status === 'number' ? error.status : 500;
					sendJson(res, status, {
						error: {
							code: typeof error?.code === 'string' ? error.code : 'SEARCH_FAILED',
							message: error instanceof Error ? error.message : String(error),
						},
					});
				}
			},
		}),
	);
}
