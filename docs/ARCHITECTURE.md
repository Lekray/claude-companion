# Claude Code Companion — architecture

A dependency-free VS Code extension (`lekra.claude-companion`) that adds session statuses, sounds,
subscription limits, DeepSeek spend and context-size warnings on top of the official Claude Code
extension (`anthropic.claude-code`). Statuses come from **Claude Code HTTP hooks**, the transcript files and the
OAuth usage endpoint. The only patch of Claude's code is the optional tab-title marker hook
(`src/patch.js`, see "Tab status markers").

Plain CommonJS, Node ≥ 20 / Electron built-ins only (`http`, `https`, `net`, `tls`, `fs`, `os`,
`path`, `zlib`, `crypto`, `child_process`). No npm dependencies, no bundler. Tabs for indentation,
double quotes, semicolons — same style as `kimi-companion`.

## Files

| File | Owner | Purpose |
|---|---|---|
| `extension.js` | UI | activation, status bar, tooltip, menu, commands, sounds, notifications, i18n |
| `src/hooks-config.js` | transport | add/remove our hook entries in `~/.claude/settings.json` |
| `src/registry.js` | transport | live-window registry (one file per VS Code window) |
| `src/server.js` | transport | leader election + HTTP receiver on `127.0.0.1:<port>` |
| `src/sessions.js` | sessions | pure state machine, shared store IO, transcript readers |
| `src/usage.js` | usage | Claude limits, proxy tunnel, DeepSeek balance + ledger, pace, alerts, PNG bars |
| `uninstall.js` | transport | `vscode:uninstall` script: removes our hooks |
| `test/*.test.js` | each owner | `node --test` unit tests, `vscode` stubbed via `Module._load` |

`src/*.js` must NOT `require("vscode")` — they are pure Node so tests run without VS Code. Only
`extension.js` touches the VS Code API.

## Transport

### Hook entries

`hooks-config.js` writes one entry per event into `~/.claude/settings.json` (respect
`CLAUDE_CONFIG_DIR` if set: `<dir>/settings.json`):

```json
{ "hooks": [ { "type": "http",
  "url": "http://127.0.0.1:47823/claude-companion/v1/event",
  "timeout": 5,
  "headers": { "X-Companion-Window": "$CLAUDE_COMPANION_WINDOW", "X-Companion-Nested": "$CLAUDECODE" },
  "allowedEnvVars": ["CLAUDE_COMPANION_WINDOW", "CLAUDECODE"] } ] }
```

Events (`HOOK_EVENTS`): `UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure,
PermissionRequest, Notification, Elicitation, Stop, StopFailure, SessionEnd`. No `matcher` (= all).
An entry is "ours" when any of its hooks has a `url` containing `/claude-companion/`. Install is
idempotent: remove ours, append fresh ones (port may have changed), keep every foreign entry and
every other top-level key untouched, drop event arrays that become empty, delete a `hooks` object
that becomes empty. Write
atomically (`.tmp` + rename), 2-space JSON + trailing newline. If the file is not valid JSON —
refuse to touch it and report the error (never overwrite a file we could not parse). Missing file →
create `{ "hooks": {...} }`.

API:
```js
HOOK_EVENTS, HOOK_PATH = "/claude-companion/v1/event", hookUrl(port)
settingsPath(env = process.env, home = os.homedir()) -> string
withHooks(settingsObj, port) -> newObj        // pure, does not mutate input
withoutHooks(settingsObj) -> newObj           // pure
hasCurrentHooks(settingsObj, port) -> bool    // all events present with this exact url
installHooks(port, file?) -> { ok, changed, error? }
removeHooks(file?) -> { ok, changed, error? }
```

### Lifecycle (why hooks come and go)

With no listener the CLI prints a non-blocking "hook failed" line per event. So hooks are installed
while at least one companion window is alive and removed when the last one closes:
`activate` → register window → `installHooks` (when `claudeCompanion.manageHooks`);
`deactivate` → unregister → if no other live window → `removeHooks`. A crash leaves them until the
next VS Code start, which is harmless. `uninstall.js` removes them on extension uninstall.

### Window registry (`registry.js`)

Directory `<storageDir>/windows/` (storageDir = `context.globalStorageUri.fsPath`, shared by all
windows of the profile). One file per window: `<windowId>.json` =
`{ windowId, pid, folders: [fsPath...], startedAt }`.

```js
registerWindow(dir, info) ; unregisterWindow(dir, windowId)
listWindows(dir, isAlive = pidAlive) -> [info]   // drops (and deletes) files of dead pids
pidAlive(pid) -> bool                            // process.kill(pid, 0), EPERM counts as alive
ownerForCwd(windows, cwd) -> windowId|null       // longest folder prefix match; case-insensitive and
                                                 // separator-insensitive on win32
```

`windowId` is stable across reloads: kept in `workspaceState` (`claudeCompanion.windowId`), random
hex 12 when absent. `extension.js` sets `process.env.CLAUDE_COMPANION_WINDOW = windowId` at the very
start of `activate` (activation event `*`), so CLI processes spawned later by the Claude extension in
this window inherit it and the hook header names the owning window.

### Server / leader (`server.js`)

All windows try to listen on `127.0.0.1:<port>` (setting `claudeCompanion.port`, default 47823).
The one that succeeds is the **leader**; others are followers and retry every 3 s
(`EADDRINUSE`). Only the leader mutates the session store.

Routes (leader):
- `POST /claude-companion/v1/event` — body ≤ 1 MB JSON hook input; respond `204` immediately
  (empty body — hook output must not inject anything), then hand
  `{ input, windowId: header x-companion-window || "", nested: header x-companion-nested || "" }`
  to `onEvent`. Bad JSON → 400, too large → 413.
- `POST /claude-companion/v1/control` — `{ action: "seen"|"dismiss", sessionId }` from any window
  → `onControl`, respond 204.
- `GET /claude-companion/v1/ping` → `200 {"app":"claude-companion","pid":…}`.
- anything else → 404.

```js
startServer({ port, onEvent, onControl, onRoleChange(role), log }) -> { stop(), get role(), port }
sendControl(port, payload) -> Promise<bool>   // follower → leader, 2 s timeout, never throws
```

## Sessions (`sessions.js`)

### Store (`<storageDir>/state.json`, written by the leader only, atomic)

```js
{ version: 1, seq: <int>, sessions: { [sessionId]: Session }, effects: [Effect] /* last 50 */ }
Session = { id, owner /* windowId|null */, cwd, title, transcript, status, since, turnStart,
            lastEvent, lastTurnMs, waitingReason, error, contextTokens, contextWarned, seen }
status ∈ "working" | "waiting" | "done" | "error" | "idle"
waitingReason ∈ "permission" | "question" | "plan" | "input" | null
Effect = { seq, at, owner, sessionId, title, kind: "done"|"waiting"|"error"|"context", turnMs?, tokens? }
```

Followers and the leader all read it (fs.watch + 1 s mtime poll) to render, and each window plays
the effects whose `owner` is its own windowId (effects with `owner === null` are played by the
leader). On start a window records the current max `seq` and does not replay older effects.

### Normalised event

`normalizeEvent(input, headers) -> Ev | null` →
`{ name, sessionId, cwd, transcript, title, tool, notificationType, error, windowId, nested }`
(`title` from `session_title`, `tool` from `tool_name`, `error` from `error`/`error_details`).
Returns `null` for missing `session_id`/`hook_event_name`.

Nested sessions (`nested` non-empty: DeepSeek workers, `claude -p` started from a Bash tool) are
ignored unless `claudeCompanion.trackNestedSessions`.

### Transitions — `applyEvent(store, ev, now, opts) -> { changed, effects }` (pure; mutates `store`)

`opts = { owner, doneSoundMinMs }` (owner resolved by the caller: `ev.windowId` or `ownerForCwd`).
Create the session on first event. `lastEvent = now` always. Title: keep non-empty newest.

| Event | Result |
|---|---|
| `UserPromptSubmit` | `working`, `turnStart = now`, clear `error`, `seen = false` |
| `PreToolUse` tool `AskUserQuestion` | `waiting/question` (+effect `waiting`) |
| `PreToolUse` tool `ExitPlanMode` | `waiting/plan` (+effect `waiting`) |
| other `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | `working`; if previous status was not working/waiting → new turn: `turnStart = now` |
| `PermissionRequest` | `waiting/permission` (+effect) |
| `Notification` `permission_prompt` | `waiting/permission` (+effect) |
| `Notification` `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`, `worker_permission_prompt` | `waiting/input` (+effect) |
| `Elicitation` | `waiting/input` (+effect) |
| `Notification` `idle_prompt` while `working` | `idle`, no effect (a turn interrupted with Esc ends without `Stop`) |
| other notifications | no status change |
| `Stop` | `done`, `lastTurnMs = now - turnStart`, effect `done` (with `turnMs`) only if `lastTurnMs >= doneSoundMinMs` |
| `StopFailure` | `error` with message (+effect `error`) |
| `SessionEnd` | delete the session |

A `waiting` effect is emitted only on the transition *into* waiting (already waiting → no repeat).
Every status change sets `since = now`. Effects get `seq = ++store.seq`, `at = now`; trim to 50.

### Housekeeping — `prune(store, windows, now) -> changed`
- owner window not in the live list → delete the session (its window closed; CLI died with it);
- owner window restarted (`window.startedAt > session.lastEvent`) and status working/waiting →
  `idle` (reload killed the turn);
- `working` with no event for 30 min → keep status, renderer shows it as stale (`now - lastEvent`);
- any session with no event for 12 h → delete.

`markSeen(store, id)`: `done`/`error` → `idle`, `seen = true`. `dismiss(store, id)`: delete.

### Transcript readers (async, tail only, never read whole big files)

- `readContextTokens(transcriptPath) -> Promise<number|null>`: read the last ≤ 512 KB, scan lines
  backwards for the newest `type: "assistant"` record with `message.usage`; return
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Skip sidechain records
  (`isSidechain: true`).
- `readTitle(transcriptPath) -> Promise<string|null>`: newest `custom-title.customTitle`, else newest
  `ai-title.aiTitle`, else `last-prompt.lastPrompt` (first 60 chars), from the last ≤ 512 KB.

On `Stop` the leader reads both (if `transcript` set), updates the session and, when
`contextTokens >= contextWarnTokens` and not yet `contextWarned`, emits a `context` effect once.

Store IO: `loadStore(file) -> store` (missing/corrupt → empty store), `saveStore(file, store)`
(atomic). `summarize(store, windowId, now)` → `{ counts: {working, waiting, done, error},
longestWorkingMs, mine: [Session], others: [Session] }` (sorted: waiting, working, error, done,
idle; then newest `since` first).

## Usage (`usage.js`)

### Claude subscription limits
- `readOauth(env, home)` → `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) →
  `claudeAiOauth.{accessToken, expiresAt, subscriptionType}`; `null` when absent. The token is never
  logged, never refreshed by us (refreshing would rotate Claude's own login).
- `fetchClaudeUsage({ proxy, timeoutMs = 15000 })` → GET
  `https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer …`,
  `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-companion`. Token expired → do not call,
  return `{ ok: false, reason: "token-expired" }`. 401 → `reason: "unauthorized"`. Network error →
  `reason: "network"` + message.
- `parseClaudeUsage(json, now)` → `slots: [{ id, label, ratio (0..1), resetAt (ms|null),
  durationMinutes }]`: `five_hour` → `5h`/300; `seven_day` → `7d`/10080; any other non-null
  `seven_day_*` object with numeric `utilization` → label like `7d opus`/10080. Fallback when those
  are null: `limits[]` (`kind: "session"` → 5h, `kind: "weekly_all"` → 7d, `percent`). Real
  response sample: `docs/usage-sample.json`.
- `resolveProxy(env, claudeSettings, override)`: override `"none"` → null; non-empty override → it;
  else `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` from `process.env`, else from
  `claudeSettings.env` (the user keeps their proxy there); honour `NO_PROXY` for the target host.
- HTTP via proxy = CONNECT tunnel (`http.request({method:"CONNECT"})` → `tls.connect({socket,
  servername})`) wrapped as an `https.request` `createConnection`; direct otherwise. Shared helper
  `httpsJson(url, { headers, proxy, timeoutMs }) -> { status, json, text }`.

### DeepSeek
- Key chain (same as `ds.py`): `DEEPSEEK_API_KEY` → `~/.claude/secrets/deepseek.json` `api_key` →
  `~/.kimi-code/config.toml` `[providers.deepseek] api_key`. Never logged.
- Balance: GET `https://api.deepseek.com/user/balance` **direct, no proxy** →
  `{ available, currency, total }`.
- Ledger `~/.claude/deepseek-ledger.jsonl` (read last ≤ 4 MB): records with `cmd` `run`/`ask` and
  numeric `usd`; `ledgerSpend(lines, now)` → `{ today: {usd, runs}, week: {usd, runs} }` by **local**
  date (today = local calendar day; week = last 7×24 h).

### Pace, alerts, bars (ported from kimi-companion)
`formatDuration, paceInfo, paceLabel, paceSummary(slot, now, hotThreshold), fractionSetting,
barPngDataUri(ratio, hot)`, `computeAlerts(slots, deepseek, cfg, latch) -> { alerts: [{key, text}],
latch }` — latch per reset window (`key → resetAt`), DeepSeek re-arms at ≥ 1.5 × threshold.

Cache `<storageDir>/usage.json` = `{ at, claude: {ok, slots, reason?}, deepseek: {...}|null,
ledger: {...}|null }` (atomic write). Only the **leader** fetches automatically (every 5 min, and
≥ 90 s after the last refresh when any turn stops); followers read the cache. HTTP 429 sets a shared
backoff `claude.retryAt` (5 → 10 → 20 → 30 min); a manual refresh within 60 s of the last attempt only
re-reads the cache. A failed fetch keeps the last good slots (`okAt`) for up to 2 h.

## UI (`extension.js`)

- **Status bar** (right): `$(claude-companion-logo) ~2 3:12 ?1 V1 !1 · 5h 69% · 7d 36%` — zero
  counters omitted, `3:12` = longest working turn of this window, usage part when enabled. Background
  `statusBarItem.errorBackground` when the 5 h slot ≥ threshold, else
  `statusBarItem.warningBackground` while a session of this window waits for the user.
- **Tooltip**: sessions of this window (status, title, time, context), limits with PNG bars and
  pace, DeepSeek balance + today/week spend, command links.
- **Menu** (click): sessions of this window (pick → `claude-vscode.editor.open <sessionId>`, which
  reveals the existing tab; then mark seen), sessions in other windows (info only — opening them
  here would start a second CLI on the same session), then actions: New session, Refresh limits,
  Usage report, Test sounds, Diagnostics.
- **Seen**: when the active tab is a Claude tab (`tab.input.viewType` ends with
  `claudeVSCodePanel`) whose label matches a done/error session title of this window (Claude
  truncates labels to 25 chars: `t.length > 25 ? t.slice(0, 24) + "…" : t`) → `markSeen`.
- **Sounds**: `resources/done.wav`, `waiting.wav`, `error.wav`, played the kimi-companion way
  (PowerShell `SoundPlayer` / `afplay` / `paplay`); ≥ 1.5 s between sounds of one window.
- **Notifications** (opt-in): toast with session title and an "Open" button.
- i18n: in-file `STR = { en, ru, zh }` + `package.nls*.json`.

## Tab status markers (`src/patch.js`)

VS Code exposes no API to rename another extension's webview tab, so two hooks are patched into
`anthropic.claude-code/extension.js` (regex anchors — the bundle is minified and local names change
between builds; class fields `panelTab`, `applyTabIcon`, `tabBadgeAnchor` are stable):

- `this.panelTab.title=<fn>(<req>.request.title)` → keep the raw title in `this.__ccTitle` and set
  `globalThis.__claudeCompanionTabTitle(this, raw)` when present (else the raw title);
- start of `applyTabIcon()` → `globalThis.__claudeCompanionTabSeen(this)`.

Both extensions share one extension host, so the companion defines those globals, keeps the panel
hosts in a set, and on every store change sets `[~] / [?] / [V] / [!]` + raw title by the session of
`host.tabBadgeAnchor.sessionId`. Patching is all-or-nothing (anchor must match exactly once, or
nothing is written), keeps a pristine `.bak-claude-companion`, runs on activate and on
`extensions.onDidChange`, and asks for one reload when it changed the file. Without the companion
the patched code falls back to the raw title. Deactivate restores raw titles.

Claude names a tab without a session title `"Claude Code"` (both at panel creation and in the
webview's `rename_tab`) and later renames it to the generated session title. `projectTabTitle`
replaces the title with the workspace name (truncated like Claude's labels, multi-root
` (Workspace)` suffix dropped): `always` — every title, `untitled` — only the placeholder, `off`.
`__ccTitle` keeps Claude's raw title, so switching modes or deactivating restores it. A host seen
before its first rename takes its raw title from the panel's creation title. The patch is applied
while either `tabStatusMarkers` or `projectTabTitle` is on.

## Settings (`claudeCompanion.*`)

`statusBar` (true), `sessionStatus` (true), `tabStatusMarkers` (true), `projectTabTitle` ("always"), `usageInStatusBar` (true), `soundDone` (true),
`soundWaiting` (true), `soundError` (true), `doneSoundMinSeconds` (20), `notifications` (false),
`alerts` (true), `alertThreshold5h` (0.8), `alertThreshold7d` (0.9), `alertDeepseekBelowUsd` (1),
`contextWarnTokens` (300000, 0 = off), `manageHooks` (true), `port` (47823), `proxy` ("" = auto,
"none" = direct), `trackNestedSessions` (false).
