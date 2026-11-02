# Session History Search

A sidebar panel that searches the text of **every past Session** and jumps back to the conversation a hit came from. Built for the "I know I asked for this somewhere, but in which chat?" case.

## Install

```sh
dsh plugin --profile web add dsh-session-history-search
```

Or install it from the plugin market inside the app, and restart once if the panel does not appear right away.

## What you get

- A magnifier icon in the left sidebar rail (`sidebar.panellist`, order 8) labelled **历史搜索 / History**.
- A panel (`main` key `session-history-search`) with a search box, a "只看我发的消息 / Only my messages" toggle, a manual "重建索引 / Rebuild index" action, and result cards.
- Each card shows the Session title, its workspace folder, how long ago the newest hit was, how many messages matched, and up to four highlighted snippets labelled 我 / 助手.
- Clicking any result opens that Session in the conversation view.

## How it searches

`POST /plugin/session-history-search/search`

```json
{ "query": "插件", "userOnly": true, "limit": 40, "refresh": false }
```

```json
{
  "query": "插件",
  "items": [
    {
      "sessionId": "…",
      "title": "…",
      "cwd": "E:\\deepseek\\gerentisheng",
      "createdAt": 1762000000000,
      "live": false,
      "latest": 1762000500000,
      "matchCount": 3,
      "matches": [{ "seq": 12, "type": "user", "time": 1762000500000, "snippet": "…创建一个可以搜索插件的…" }]
    }
  ],
  "stats": { "totalSessions": 41, "scanned": 41, "matchedSessions": 2, "returned": 2, "partial": false, "elapsedMs": 812 }
}
```

`GET /plugin/session-history-search/health` reports whether the Session Query service is mounted and how many Sessions are cached.

### Why not the FTS index

`@deepseek-ai/dsh-session-query-sqlite` indexes with `tokenize = 'unicode61'`. A run of CJK ideographs between punctuation becomes **one token**, so 插件 does not match 创建一个可以搜索插件的工具 — Chinese content is effectively unsearchable through that index (this is also why the workspace sidebar's built-in content search misses Chinese).

This plugin therefore uses `sessionQuery.listSessions()` + `filterEvents(id, [{ kind: 'text', text: query }])`. The `kind: 'text'` predicate is the first-party literal, case-insensitive scan over each event's semantic text — it is applied per Session, which keeps Chinese, English, mixed text and partial words all searchable with no word segmentation to get wrong.

Consequences worth knowing:

- Cost is proportional to history size (each scanned Session is decompressed and parsed), so the scan has a 10 s wall-clock budget and reports `stats.partial` when it runs out.
- Sessions are ordered newest-first, so a partial scan still surfaces the most recent matches.
- Results are cached per `(session, query, userOnly)` for 5 minutes (capacity 400), and settled Sessions only. Repeating a search therefore finishes the sessions the previous run could not reach, within the same budget — coverage grows without ever rescanning what was already done. Live Sessions are always re-read.
- Sessions without a workspace (`header.cwd === undefined`) are skipped, matching what the sidebar shows.

`openSession` cannot address a message inside a Session, so a result opens the Session at its end; the highlighted snippet is what tells you where to look.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: the two routes, the per-Session text scan, the cache. Injects `webServer`, `sessionQuery`, `connection`. |
| `client.js` | Browser half: locale dictionaries, sidebar icon, panel view. No CSS file, no Client package imports, theme tokens only. |
| `cordis.patch.yml` | Bundle patch that inserts the plugin. |
| `locale/zh.json`, `locale/en.json` | Marketplace display metadata. |
| `icon.svg` | Package icon. |

## Notes

- Both halves tolerate a missing `sessionQuery`: the panel renders a normal error with a retry action instead of crashing the slot.
- The route answers 405 for non-POST, 413 above 64 KiB, 400 for an empty query or bad JSON, 503 when the Session Query service is not mounted.
- Requests the `connection` service marks untrusted are refused before any work happens.
