// Session store, state machine and transcript readers. Pure Node: never requires "vscode".
const fs = require("fs");
const path = require("path");

const STORE_VERSION = 1;
const MAX_EFFECTS = 50;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TAIL_BYTES = 512 * 1024;
const TITLE_MAX = 120;
const PROMPT_TITLE_MAX = 60;
const ERROR_MAX = 500;

// A notification that moves the session into waiting; the value is the waitingReason.
const WAITING_NOTIFICATIONS = {
	permission_prompt: "permission",
	elicitation_dialog: "input",
	elicitation_url_dialog: "input",
	agent_needs_input: "input",
	worker_permission_prompt: "input"
};

const HEADER_NAMES = {
	"x-companion-window": "X-Companion-Window",
	"x-companion-nested": "X-Companion-Nested"
};

const STATUS_ORDER = { waiting: 0, working: 1, error: 2, done: 3, idle: 4 };

function text(value, max = 0) {
	if (typeof value === "string") return max && value.length > max ? value.slice(0, max) : value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function cleanTitle(value) {
	if (typeof value !== "string") return "";
	const title = value.replace(/\s+/g, " ").trim();
	if (!title) return "";
	return title.length > TITLE_MAX ? title.slice(0, TITLE_MAX - 1) + "…" : title;
}

function errorText(input) {
	const direct = text(input.error, ERROR_MAX);
	if (direct) return direct;
	const details = input.error_details;
	if (typeof details === "string") return text(details, ERROR_MAX);
	if (details && typeof details === "object") {
		const message = text(details.message, ERROR_MAX);
		if (message) return message;
		try {
			return text(JSON.stringify(details), ERROR_MAX);
		} catch {
			return "";
		}
	}
	return "";
}

function headerValue(headers, name) {
	if (!headers || typeof headers !== "object") return "";
	const value = headers[name] ?? headers[HEADER_NAMES[name]];
	return text(value).trim();
}

// --- Store IO ---------------------------------------------------------

function emptyStore() {
	return { version: STORE_VERSION, seq: 0, sessions: {}, effects: [] };
}

async function loadStore(file) {
	let raw;
	try {
		raw = await fs.promises.readFile(file, "utf8");
	} catch {
		return emptyStore();
	}
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return emptyStore();
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return emptyStore();

	const sessions = {};
	const source = data.sessions && typeof data.sessions === "object" && !Array.isArray(data.sessions) ? data.sessions : {};
	for (const [id, session] of Object.entries(source)) {
		if (!session || typeof session !== "object" || Array.isArray(session)) continue;
		sessions[id] = Object.assign({}, session, { id: session.id || id });
	}

	const effects = (Array.isArray(data.effects) ? data.effects : []).filter(
		(effect) => effect && typeof effect === "object" && Number.isFinite(effect.seq)
	);
	let seq = Number.isInteger(data.seq) && data.seq >= 0 ? data.seq : 0;
	for (const effect of effects) seq = Math.max(seq, effect.seq);

	return { version: STORE_VERSION, seq, sessions, effects: effects.slice(-MAX_EFFECTS) };
}

// Atomic: a crash can leave a stale .tmp but never a half-written state.json.
async function saveStore(file, store) {
	const tmp = file + ".tmp";
	try {
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		await fs.promises.writeFile(tmp, JSON.stringify(store), "utf8");
		// Windows refuses the replace (EPERM/EBUSY) while another window is reading the file; the
		// readers hold it for milliseconds, so a few short retries are enough.
		for (let attempt = 0; ; attempt++) {
			try {
				await fs.promises.rename(tmp, file);
				return true;
			} catch (err) {
				if (attempt >= 5 || !err || (err.code !== "EPERM" && err.code !== "EBUSY" && err.code !== "EACCES")) throw err;
				await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
			}
		}
	} catch {
		await fs.promises.unlink(tmp).catch(() => {});
		return false;
	}
}

// --- Events -----------------------------------------------------------

function normalizeEvent(input, headers) {
	if (!input || typeof input !== "object") return null;
	const sessionId = text(input.session_id).trim();
	const name = text(input.hook_event_name).trim();
	if (!sessionId || !name) return null;
	return {
		name,
		sessionId,
		cwd: text(input.cwd),
		transcript: text(input.transcript_path),
		title: text(input.session_title),
		tool: text(input.tool_name),
		notificationType: text(input.notification_type),
		error: errorText(input),
		windowId: headerValue(headers, "x-companion-window"),
		nested: headerValue(headers, "x-companion-nested")
	};
}

// Header owner wins (the CLI inherited CLAUDE_COMPANION_WINDOW); otherwise the cwd's folder.
function resolveOwner(ev, windows, ownerForCwd) {
	if (!ev) return null;
	if (ev.windowId) return ev.windowId;
	if (typeof ownerForCwd !== "function") return null;
	try {
		return ownerForCwd(Array.isArray(windows) ? windows : [], ev.cwd || "") || null;
	} catch {
		return null;
	}
}

// --- State machine ----------------------------------------------------

function createSession(ev, owner, now) {
	return {
		id: ev.sessionId,
		owner: owner || null,
		cwd: ev.cwd || "",
		title: "",
		transcript: ev.transcript || "",
		status: "idle",
		since: now,
		turnStart: now,
		lastEvent: now,
		lastTurnMs: 0,
		waitingReason: null,
		error: null,
		contextTokens: null,
		contextWarned: false,
		seen: true
	};
}

function setStatus(session, status, now) {
	if (session.status !== status) {
		session.status = status;
		session.since = now;
	}
	if (status !== "waiting") session.waitingReason = null;
}

function addEffect(store, fields, now) {
	if (!Array.isArray(store.effects)) store.effects = [];
	if (!Number.isInteger(store.seq)) store.seq = 0;
	const effect = {
		seq: ++store.seq,
		at: now,
		owner: fields.owner || null,
		sessionId: fields.sessionId || "",
		title: fields.title || "",
		kind: fields.kind || "done"
	};
	if (fields.turnMs !== undefined) effect.turnMs = fields.turnMs;
	if (fields.tokens !== undefined) effect.tokens = fields.tokens;
	store.effects.push(effect);
	if (store.effects.length > MAX_EFFECTS) store.effects.splice(0, store.effects.length - MAX_EFFECTS);
	return effect;
}

// A waiting sound belongs to the transition into waiting, not to every repeated request.
function enterWaiting(store, session, reason, now, effects) {
	const wasWaiting = session.status === "waiting";
	setStatus(session, "waiting", now);
	session.waitingReason = reason;
	if (wasWaiting) return;
	effects.push(addEffect(store, { owner: session.owner, sessionId: session.id, title: session.title, kind: "waiting" }, now));
}

// Tool activity during a wait continues the same turn; anything else starts a new one.
function enterWorking(session, now) {
	const wasActive = session.status === "working" || session.status === "waiting";
	setStatus(session, "working", now);
	if (!wasActive) session.turnStart = now;
}

function applyEvent(store, ev, now, opts) {
	if (!store || !ev || !ev.sessionId) return { changed: false, effects: [] };
	if (!store.sessions) store.sessions = {};
	if (!Array.isArray(store.effects)) store.effects = [];
	if (!Number.isInteger(store.seq)) store.seq = 0;
	const options = opts || {};
	const effects = [];

	let session = store.sessions[ev.sessionId];
	if (ev.name === "SessionEnd") {
		if (!session) return { changed: false, effects };
		delete store.sessions[ev.sessionId];
		return { changed: true, effects };
	}

	if (!session) {
		session = createSession(ev, options.owner, now);
		store.sessions[ev.sessionId] = session;
	}

	// A later header-less event must not orphan a session that already has an owner.
	if (options.owner && session.owner !== options.owner) session.owner = options.owner;
	if (ev.cwd) session.cwd = ev.cwd;
	if (ev.transcript) session.transcript = ev.transcript;
	const title = cleanTitle(ev.title);
	if (title) session.title = title;
	session.lastEvent = now;

	switch (ev.name) {
		case "UserPromptSubmit":
			setStatus(session, "working", now);
			session.turnStart = now;
			session.error = null;
			session.seen = false;
			break;
		case "PreToolUse":
			if (ev.tool === "AskUserQuestion") enterWaiting(store, session, "question", now, effects);
			else if (ev.tool === "ExitPlanMode") enterWaiting(store, session, "plan", now, effects);
			else enterWorking(session, now);
			break;
		case "PostToolUse":
		case "PostToolUseFailure":
			enterWorking(session, now);
			break;
		case "PermissionRequest":
			enterWaiting(store, session, "permission", now, effects);
			break;
		case "Notification": {
			const reason = Object.hasOwn(WAITING_NOTIFICATIONS, ev.notificationType)
				? WAITING_NOTIFICATIONS[ev.notificationType]
				: null;
			if (reason) enterWaiting(store, session, reason, now, effects);
			// An interrupted turn (Esc) ends without Stop; the idle prompt is the only sign it is over.
			else if (ev.notificationType === "idle_prompt" && session.status === "working") setStatus(session, "idle", now);
			break;
		}
		case "Elicitation":
			enterWaiting(store, session, "input", now, effects);
			break;
		case "Stop": {
			setStatus(session, "done", now);
			const turnStart = Number.isFinite(session.turnStart) ? session.turnStart : now;
			session.lastTurnMs = Math.max(0, now - turnStart);
			const min = Number.isFinite(options.doneSoundMinMs) ? options.doneSoundMinMs : 0;
			if (session.lastTurnMs >= min) {
				effects.push(
					addEffect(
						store,
						{ owner: session.owner, sessionId: session.id, title: session.title, kind: "done", turnMs: session.lastTurnMs },
						now
					)
				);
			}
			break;
		}
		case "StopFailure":
			setStatus(session, "error", now);
			session.error = ev.error || "error";
			effects.push(addEffect(store, { owner: session.owner, sessionId: session.id, title: session.title, kind: "error" }, now));
			break;
		default:
			// Unknown events and plain notifications only refresh lastEvent.
			break;
	}

	return { changed: true, effects };
}

// Records the context size after Stop and emits the one-time warning effect.
function recordContext(store, sessionId, tokens, now, warnTokens) {
	const session = store && store.sessions ? store.sessions[sessionId] : null;
	if (!session || !Number.isFinite(tokens)) return { changed: false, effects: [] };
	session.contextTokens = tokens;
	const warn = Number.isFinite(warnTokens) ? warnTokens : 0;
	if (warn <= 0 || tokens < warn || session.contextWarned) return { changed: true, effects: [] };
	session.contextWarned = true;
	const effect = addEffect(
		store,
		{ owner: session.owner, sessionId, title: session.title, kind: "context", tokens },
		Number.isFinite(now) ? now : Date.now()
	);
	return { changed: true, effects: [effect] };
}

// --- Housekeeping -----------------------------------------------------

function prune(store, windows, now) {
	if (!store || !store.sessions) return false;
	const at = Number.isFinite(now) ? now : Date.now();
	const live = new Map();
	for (const win of Array.isArray(windows) ? windows : []) {
		if (win && win.windowId) live.set(win.windowId, win);
	}

	let changed = false;
	for (const [id, session] of Object.entries(store.sessions)) {
		if (!session || typeof session !== "object") {
			delete store.sessions[id];
			changed = true;
			continue;
		}
		const last = Number.isFinite(session.lastEvent) ? session.lastEvent : 0;
		if (session.owner) {
			const win = live.get(session.owner);
			if (!win) {
				delete store.sessions[id];
				changed = true;
				continue;
			}
			// A restarted window kills the CLI turn that was running in it.
			if (
				Number.isFinite(win.startedAt) &&
				win.startedAt > last &&
				(session.status === "working" || session.status === "waiting")
			) {
				session.status = "idle";
				session.waitingReason = null;
				session.since = at;
				changed = true;
			}
		}
		if (at - last >= SESSION_TTL_MS) {
			delete store.sessions[id];
			changed = true;
		}
	}
	return changed;
}

function markSeen(store, id) {
	const session = store && store.sessions ? store.sessions[id] : null;
	if (!session || (session.status !== "done" && session.status !== "error")) return false;
	session.status = "idle";
	session.waitingReason = null;
	session.seen = true;
	return true;
}

function dismiss(store, id) {
	if (!store || !store.sessions || !Object.hasOwn(store.sessions, id)) return false;
	delete store.sessions[id];
	return true;
}

function summarize(store, windowId, now) {
	const at = Number.isFinite(now) ? now : Date.now();
	const counts = { working: 0, waiting: 0, done: 0, error: 0 };
	const mine = [];
	const others = [];
	let longestWorkingMs = 0;

	for (const session of Object.values((store && store.sessions) || {})) {
		if (!session) continue;
		if (session.owner === windowId) {
			mine.push(session);
			if (Object.hasOwn(counts, session.status)) counts[session.status]++;
			if (session.status === "working") {
				const start = Number.isFinite(session.turnStart)
					? session.turnStart
					: Number.isFinite(session.since)
						? session.since
						: at;
				longestWorkingMs = Math.max(longestWorkingMs, at - start);
			}
		} else {
			others.push(session);
		}
	}

	const rank = (session) => (Object.hasOwn(STATUS_ORDER, session.status) ? STATUS_ORDER[session.status] : 5);
	const compare = (a, b) => rank(a) - rank(b) || (Number(b.since) || 0) - (Number(a.since) || 0);
	return {
		counts,
		longestWorkingMs: Math.max(0, longestWorkingMs),
		mine: mine.sort(compare),
		others: others.sort(compare)
	};
}

// --- Transcript readers -----------------------------------------------

// Transcript lines hold tool outputs and can be megabytes; only the tail is ever read.
// The extra leading byte tells a line boundary from a fragment of a huge record.
async function readTailLines(file) {
	if (typeof file !== "string" || !file) return null;
	let handle;
	try {
		handle = await fs.promises.open(file, "r");
	} catch {
		return null;
	}
	try {
		const { size } = await handle.stat();
		if (!size) return [];
		const want = Math.min(size, TAIL_BYTES + 1);
		const start = size - want;
		const buffer = Buffer.alloc(want);
		const { bytesRead } = await handle.read(buffer, 0, want, start);
		let content = buffer.toString("utf8", 0, bytesRead);
		if (start > 0) {
			if (content[0] === "\n") {
				content = content.slice(1);
			} else {
				const newline = content.indexOf("\n");
				content = newline < 0 ? "" : content.slice(newline + 1);
			}
		}
		return content.split(/\r?\n/);
	} catch {
		return null;
	} finally {
		await handle.close().catch(() => {});
	}
}

function parseLine(line) {
	if (!line) return null;
	try {
		const record = JSON.parse(line);
		return record && typeof record === "object" ? record : null;
	} catch {
		return null;
	}
}

function tokenCount(value) {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

async function readContextTokens(transcriptPath) {
	const lines = await readTailLines(transcriptPath);
	if (!lines) return null;
	for (let i = lines.length - 1; i >= 0; i--) {
		const record = parseLine(lines[i]);
		if (!record || record.type !== "assistant" || record.isSidechain === true) continue;
		const usage = record.message && record.message.usage;
		if (!usage || typeof usage !== "object") continue;
		return (
			tokenCount(usage.input_tokens) +
			tokenCount(usage.cache_creation_input_tokens) +
			tokenCount(usage.cache_read_input_tokens)
		);
	}
	return null;
}

async function readTitle(transcriptPath) {
	const lines = await readTailLines(transcriptPath);
	if (!lines) return null;
	let custom = null;
	let ai = null;
	let prompt = null;
	for (let i = lines.length - 1; i >= 0; i--) {
		const record = parseLine(lines[i]);
		if (!record) continue;
		if (custom === null && record.type === "custom-title") {
			custom = cleanTitle(record.customTitle) || null;
		} else if (ai === null && record.type === "ai-title") {
			ai = cleanTitle(record.aiTitle) || null;
		} else if (prompt === null && record.type === "last-prompt") {
			prompt = cleanTitle(record.lastPrompt).slice(0, PROMPT_TITLE_MAX) || null;
		}
		if (custom !== null && ai !== null && prompt !== null) break;
	}
	// A user-renamed title outranks a generated one even if the generated one is newer.
	return custom || ai || prompt;
}

module.exports = {
	STORE_VERSION,
	MAX_EFFECTS,
	SESSION_TTL_MS,
	TAIL_BYTES,
	emptyStore,
	loadStore,
	saveStore,
	normalizeEvent,
	resolveOwner,
	applyEvent,
	recordContext,
	prune,
	markSeen,
	dismiss,
	summarize,
	addEffect,
	readContextTokens,
	readTitle
};
