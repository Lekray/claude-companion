// Offline tests for the session state machine and transcript readers.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const s = require(path.join(__dirname, "..", "src", "sessions.js"));

const T0 = 1700000000000;
const HOUR = 3600000;
const MIN20 = 20 * 1000;

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "claude-companion-sessions-"));
}

function event(name, extra = {}) {
	return Object.assign(
		{
			name,
			sessionId: "s1",
			cwd: "C:\\proj",
			transcript: "",
			title: "",
			tool: "",
			notificationType: "",
			error: "",
			windowId: "w1",
			nested: ""
		},
		extra
	);
}

function apply(store, name, extra = {}, now = T0, opts = { owner: "w1" }) {
	return s.applyEvent(store, event(name, extra), now, opts);
}

function session(overrides = {}) {
	return Object.assign(
		{
			id: "s1",
			owner: "w1",
			cwd: "",
			title: "",
			transcript: "",
			status: "idle",
			since: T0,
			turnStart: T0,
			lastEvent: T0,
			lastTurnMs: 0,
			waitingReason: null,
			error: null,
			contextTokens: null,
			contextWarned: false,
			seen: true
		},
		overrides
	);
}

function record(line) {
	return JSON.stringify(line);
}

function usageRecord(usage, extra = {}) {
	return record(Object.assign({ type: "assistant", isSidechain: false, message: { usage } }, extra));
}

// --- normalizeEvent / resolveOwner ------------------------------------

test("normalizeEvent maps the hook payload and lower-case headers", () => {
	const ev = s.normalizeEvent(
		{
			hook_event_name: "Notification",
			session_id: "abc",
			cwd: "C:\\work",
			transcript_path: "C:\\t.jsonl",
			session_title: "My session",
			tool_name: "Bash",
			notification_type: "permission_prompt",
			error_details: { message: "boom" }
		},
		{ "x-companion-window": "w9", "x-companion-nested": "1" }
	);
	assert.deepEqual(ev, {
		name: "Notification",
		sessionId: "abc",
		cwd: "C:\\work",
		transcript: "C:\\t.jsonl",
		title: "My session",
		tool: "Bash",
		notificationType: "permission_prompt",
		error: "boom",
		windowId: "w9",
		nested: "1"
	});
});

test("normalizeEvent rejects payloads without a session or event name", () => {
	assert.equal(s.normalizeEvent(null, {}), null);
	assert.equal(s.normalizeEvent({ hook_event_name: "Stop" }, {}), null);
	assert.equal(s.normalizeEvent({ session_id: "s" }, {}), null);
	assert.equal(s.normalizeEvent({ session_id: "", hook_event_name: "Stop" }, {}), null);
});

test("normalizeEvent reads error text, title-case header fallback and no headers", () => {
	const withError = s.normalizeEvent({ session_id: "s", hook_event_name: "StopFailure", error: "  bad  " }, null);
	assert.equal(withError.error, "  bad  ");
	assert.equal(withError.windowId, "");
	const titled = s.normalizeEvent({ session_id: "s", hook_event_name: "Stop" }, { "X-Companion-Window": "w2" });
	assert.equal(titled.windowId, "w2");
	const nested = s.normalizeEvent({ session_id: "s", hook_event_name: "Stop" }, { "x-companion-nested": " 1 " });
	assert.equal(nested.nested, "1");
});

test("resolveOwner prefers the header window and falls back to the cwd owner", () => {
	const windows = [{ windowId: "w1", folders: ["C:\\proj"], startedAt: 0 }];
	let calls = 0;
	const seen = (list, cwd) => {
		calls++;
		assert.equal(list, windows);
		assert.equal(cwd, "C:\\proj");
		return "w1";
	};
	assert.equal(s.resolveOwner({ windowId: "w7", cwd: "C:\\proj" }, windows, seen), "w7");
	assert.equal(calls, 0, "ownerForCwd is not consulted when the header names a window");
	assert.equal(s.resolveOwner({ windowId: "", cwd: "C:\\proj" }, windows, seen), "w1");
	assert.equal(calls, 1);
	assert.equal(s.resolveOwner({ windowId: "", cwd: "" }, windows, () => null), null);
	assert.equal(s.resolveOwner({ windowId: "" }, windows, () => { throw new Error("boom"); }), null);
	assert.equal(s.resolveOwner({ windowId: "" }, windows, null), null);
	assert.equal(s.resolveOwner(null, windows, seen), null);
});

// --- Transition table -------------------------------------------------

test("UserPromptSubmit starts a working turn and clears the previous error", () => {
	const store = s.emptyStore();
	apply(store, "StopFailure", { error: "boom" }, T0);
	assert.equal(store.sessions.s1.status, "error");
	const res = apply(store, "UserPromptSubmit", {}, T0 + 1000);
	assert.equal(res.changed, true);
	assert.equal(store.sessions.s1.status, "working");
	assert.equal(store.sessions.s1.since, T0 + 1000);
	assert.equal(store.sessions.s1.turnStart, T0 + 1000);
	assert.equal(store.sessions.s1.error, null);
	assert.equal(store.sessions.s1.seen, false);
});

test("PreToolUse AskUserQuestion and ExitPlanMode wait for the user", () => {
	const question = s.emptyStore();
	const q = apply(question, "PreToolUse", { tool: "AskUserQuestion" });
	assert.equal(question.sessions.s1.status, "waiting");
	assert.equal(question.sessions.s1.waitingReason, "question");
	assert.equal(q.effects.length, 1);
	assert.equal(q.effects[0].kind, "waiting");
	assert.equal(q.effects[0].seq, 1);
	assert.equal(q.effects[0].at, T0);
	assert.equal(q.effects[0].owner, "w1");
	assert.equal(q.effects[0].sessionId, "s1");

	const plan = s.emptyStore();
	apply(plan, "PreToolUse", { tool: "ExitPlanMode" });
	assert.equal(plan.sessions.s1.status, "waiting");
	assert.equal(plan.sessions.s1.waitingReason, "plan");
	assert.equal(plan.effects.at(-1).kind, "waiting");
});

test("ordinary tool events keep the session working", () => {
	for (const name of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
		const store = s.emptyStore();
		apply(store, "UserPromptSubmit", {}, T0);
		const res = apply(store, name, { tool: "Bash" }, T0 + 500);
		assert.equal(store.sessions.s1.status, "working", name);
		assert.equal(store.sessions.s1.turnStart, T0, name);
		assert.equal(res.effects.length, 0, name);
	}
});

test("tool activity after a finished turn starts a new turn", () => {
	const store = s.emptyStore();
	apply(store, "UserPromptSubmit", {}, T0);
	apply(store, "Stop", {}, T0 + 5000);
	assert.equal(store.sessions.s1.status, "done");
	apply(store, "PostToolUse", {}, T0 + 9000);
	assert.equal(store.sessions.s1.status, "working");
	assert.equal(store.sessions.s1.turnStart, T0 + 9000);
	apply(store, "Stop", {}, T0 + 9500);
	assert.equal(store.sessions.s1.lastTurnMs, 500);
});

test("PermissionRequest and permission notifications wait for permission", () => {
	const request = s.emptyStore();
	const r = apply(request, "PermissionRequest");
	assert.equal(request.sessions.s1.status, "waiting");
	assert.equal(request.sessions.s1.waitingReason, "permission");
	assert.equal(r.effects[0].kind, "waiting");

	const notification = s.emptyStore();
	apply(notification, "Notification", { notificationType: "permission_prompt" });
	assert.equal(notification.sessions.s1.status, "waiting");
	assert.equal(notification.sessions.s1.waitingReason, "permission");
	assert.equal(notification.effects[0].kind, "waiting");
});

test("input notifications and Elicitation wait for input", () => {
	const types = ["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input", "worker_permission_prompt"];
	for (const notificationType of types) {
		const store = s.emptyStore();
		apply(store, "Notification", { notificationType });
		assert.equal(store.sessions.s1.status, "waiting", notificationType);
		assert.equal(store.sessions.s1.waitingReason, "input", notificationType);
		assert.equal(store.effects.length, 1, notificationType);
	}
	const elicitation = s.emptyStore();
	apply(elicitation, "Elicitation");
	assert.equal(elicitation.sessions.s1.status, "waiting");
	assert.equal(elicitation.sessions.s1.waitingReason, "input");
	assert.equal(elicitation.effects[0].kind, "waiting");
});

test("other notifications do not change the status", () => {
	const store = s.emptyStore();
	apply(store, "UserPromptSubmit", {}, T0);
	const res = apply(store, "Notification", { notificationType: "auth_success" }, T0 + 10);
	assert.equal(store.sessions.s1.status, "working");
	assert.equal(store.sessions.s1.since, T0);
	assert.equal(res.effects.length, 0);
	assert.equal(store.sessions.s1.lastEvent, T0 + 10);
});

test("idle_prompt ends an interrupted turn silently but never a wait or a finished turn", () => {
	const store = s.emptyStore();
	apply(store, "UserPromptSubmit", {}, T0);
	const res = apply(store, "Notification", { notificationType: "idle_prompt" }, T0 + 10);
	assert.equal(store.sessions.s1.status, "idle");
	assert.equal(res.effects.length, 0);
	apply(store, "PermissionRequest", {}, T0 + 20);
	apply(store, "Notification", { notificationType: "idle_prompt" }, T0 + 30);
	assert.equal(store.sessions.s1.status, "waiting");
	apply(store, "Stop", {}, T0 + 40);
	apply(store, "Notification", { notificationType: "idle_prompt" }, T0 + 50);
	assert.equal(store.sessions.s1.status, "done");
});

test("Stop finishes the turn and carries turnMs on the effect", () => {
	const store = s.emptyStore();
	apply(store, "UserPromptSubmit", { title: "Fix the parser" }, T0);
	const res = apply(store, "Stop", {}, T0 + 7000);
	assert.equal(store.sessions.s1.status, "done");
	assert.equal(store.sessions.s1.since, T0 + 7000);
	assert.equal(store.sessions.s1.lastTurnMs, 7000);
	assert.deepEqual(res.effects, [
		{ seq: 1, at: T0 + 7000, owner: "w1", sessionId: "s1", title: "Fix the parser", kind: "done", turnMs: 7000 }
	]);
});

test("Stop only emits a done effect at or above doneSoundMinMs", () => {
	for (const [elapsed, min, expected] of [
		[MIN20 - 1, MIN20, 0],
		[MIN20, MIN20, 1],
		[MIN20 + 1, MIN20, 1]
	]) {
		const store = s.emptyStore();
		apply(store, "UserPromptSubmit", {}, T0);
		const res = apply(store, "Stop", {}, T0 + elapsed, { owner: "w1", doneSoundMinMs: min });
		assert.equal(store.sessions.s1.status, "done");
		assert.equal(res.effects.length, expected, `elapsed ${elapsed}`);
		if (expected) assert.equal(res.effects[0].turnMs, elapsed);
	}
});

test("StopFailure records the error and emits an error effect", () => {
	const store = s.emptyStore();
	apply(store, "UserPromptSubmit", {}, T0);
	const res = apply(store, "StopFailure", { error: "rate limited" }, T0 + 100);
	assert.equal(store.sessions.s1.status, "error");
	assert.equal(store.sessions.s1.error, "rate limited");
	assert.equal(res.effects.length, 1);
	assert.equal(res.effects[0].kind, "error");
	assert.equal(res.effects[0].owner, "w1");
});

test("SessionEnd deletes the session but is a no-op for an unknown one", () => {
	const store = s.emptyStore();
	apply(store, "UserPromptSubmit", {}, T0);
	const ended = apply(store, "SessionEnd", {}, T0 + 10);
	assert.equal(ended.changed, true);
	assert.deepEqual(store.sessions, {});

	const fresh = s.emptyStore();
	const unknown = apply(fresh, "SessionEnd", {}, T0);
	assert.equal(unknown.changed, false);
	assert.deepEqual(fresh.sessions, {});
});

test("a waiting effect is not repeated while the session is already waiting", () => {
	const store = s.emptyStore();
	apply(store, "PermissionRequest", {}, T0);
	assert.equal(store.effects.length, 1);
	const again = apply(store, "PermissionRequest", {}, T0 + 1000);
	assert.equal(again.changed, true);
	assert.equal(again.effects.length, 0);
	assert.equal(store.effects.length, 1);
	assert.equal(store.sessions.s1.since, T0, "staying in the same status does not move since");
	assert.equal(store.sessions.s1.lastEvent, T0 + 1000);

	const otherReason = apply(store, "PreToolUse", { tool: "AskUserQuestion" }, T0 + 2000);
	assert.equal(otherReason.effects.length, 0);
	assert.equal(store.sessions.s1.waitingReason, "question");
});

test("any event type creates an unknown session", () => {
	for (const name of [
		"UserPromptSubmit",
		"PreToolUse",
		"PostToolUse",
		"PostToolUseFailure",
		"PermissionRequest",
		"Notification",
		"Elicitation",
		"Stop",
		"StopFailure",
		"SomeFutureEvent"
	]) {
		const store = s.emptyStore();
		const res = apply(store, name, {}, T0, { owner: null });
		assert.equal(res.changed, true, name);
		assert.ok(store.sessions.s1, name);
		assert.equal(store.sessions.s1.owner, null, name);
		assert.equal(store.sessions.s1.lastEvent, T0, name);
	}
});

test("applyEvent ignores events without a session id", () => {
	const store = s.emptyStore();
	assert.deepEqual(s.applyEvent(store, null, T0, {}), { changed: false, effects: [] });
	assert.deepEqual(s.applyEvent(store, { name: "Stop" }, T0, {}), { changed: false, effects: [] });
});

test("titles are sanitised, capped and never regress to empty", () => {
	const store = s.emptyStore();
	apply(store, "UserPromptSubmit", { title: "  Fix\n\tthe   parser " }, T0);
	assert.equal(store.sessions.s1.title, "Fix the parser");
	apply(store, "PostToolUse", { title: "" }, T0 + 1);
	assert.equal(store.sessions.s1.title, "Fix the parser");
	apply(store, "PostToolUse", { title: "Second" }, T0 + 2);
	assert.equal(store.sessions.s1.title, "Second");
	apply(store, "PostToolUse", { title: "x".repeat(200) }, T0 + 3);
	assert.equal(store.sessions.s1.title.length, 120);
	assert.ok(store.sessions.s1.title.endsWith("…"));
});

test("a session keeps its owner when a later event has no window header", () => {
	const store = s.emptyStore();
	apply(store, "UserPromptSubmit", {}, T0);
	apply(store, "Stop", {}, T0 + 1, { owner: null });
	assert.equal(store.sessions.s1.owner, "w1");
	apply(store, "PostToolUse", {}, T0 + 2, { owner: "w2" });
	assert.equal(store.sessions.s1.owner, "w2");
});

test("effects are trimmed to the last 50 with strictly increasing seq", () => {
	const store = s.emptyStore();
	for (let i = 0; i < 60; i++) {
		s.applyEvent(store, event("Stop", { sessionId: `s${i}` }), T0 + i, { owner: "w1", doneSoundMinMs: 0 });
	}
	assert.equal(store.effects.length, s.MAX_EFFECTS);
	assert.equal(store.effects.length, 50);
	assert.equal(store.seq, 60);
	assert.equal(store.effects[0].seq, 11, "the oldest effects are the ones dropped");
	assert.equal(store.effects.at(-1).seq, 60);
	for (let i = 1; i < store.effects.length; i++) {
		assert.ok(store.effects[i].seq > store.effects[i - 1].seq);
	}
});

// --- recordContext ----------------------------------------------------

test("recordContext stores tokens and warns once above the threshold", () => {
	const store = s.emptyStore();
	apply(store, "UserPromptSubmit", {}, T0);
	apply(store, "Stop", {}, T0 + 1);

	assert.deepEqual(s.recordContext(store, "s1", 1000, T0 + 2, 5000), { changed: true, effects: [] });
	assert.equal(store.sessions.s1.contextTokens, 1000);
	assert.equal(store.sessions.s1.contextWarned, false);

	const warned = s.recordContext(store, "s1", 5000, T0 + 3, 5000);
	assert.equal(warned.effects.length, 1);
	assert.equal(warned.effects[0].kind, "context");
	assert.equal(warned.effects[0].tokens, 5000);
	assert.equal(store.sessions.s1.contextWarned, true);

	assert.deepEqual(s.recordContext(store, "s1", 900000, T0 + 4, 500).effects, [], "warned only once");
	assert.deepEqual(s.recordContext(store, "nope", 900, T0 + 5, 500), { changed: false, effects: [] });
	assert.deepEqual(s.recordContext(store, "s1", NaN, T0 + 6, 500).changed, false);
});

test("recordContext with warning disabled never warns", () => {
	const store = s.emptyStore();
	apply(store, "UserPromptSubmit", {}, T0);
	assert.deepEqual(s.recordContext(store, "s1", 10_000_000, T0 + 1, 0).effects, []);
	assert.equal(store.sessions.s1.contextWarned, false);
});

// --- prune ------------------------------------------------------------

test("prune deletes sessions whose window is no longer live", () => {
	const store = s.emptyStore();
	store.sessions.gone = session({ id: "gone", owner: "w-gone" });
	store.sessions.kept = session({ id: "kept", owner: "w1", lastEvent: T0 });
	store.sessions.orphan = session({ id: "orphan", owner: null, lastEvent: T0 });
	const changed = s.prune(store, [{ windowId: "w1", startedAt: T0 - 1000 }], T0 + 1000);
	assert.equal(changed, true);
	assert.deepEqual(Object.keys(store.sessions).sort(), ["kept", "orphan"]);
});

test("prune turns a working or waiting session into idle when its window restarted", () => {
	const store = s.emptyStore();
	store.sessions.working = session({ id: "working", owner: "w1", status: "working", lastEvent: T0 });
	store.sessions.waiting = session({
		id: "waiting",
		owner: "w1",
		status: "waiting",
		waitingReason: "permission",
		lastEvent: T0
	});
	store.sessions.done = session({ id: "done", owner: "w1", status: "done", lastEvent: T0 });
	const now = T0 + 100;
	const changed = s.prune(store, [{ windowId: "w1", startedAt: T0 + 1 }], now);
	assert.equal(changed, true);
	assert.equal(store.sessions.working.status, "idle");
	assert.equal(store.sessions.working.since, now);
	assert.equal(store.sessions.waiting.status, "idle");
	assert.equal(store.sessions.waiting.waitingReason, null);
	assert.equal(store.sessions.done.status, "done", "a finished session is not reset");
});

test("prune leaves sessions alone when the window did not restart", () => {
	const store = s.emptyStore();
	store.sessions.s1 = session({ owner: "w1", status: "working", lastEvent: T0 });
	const changed = s.prune(store, [{ windowId: "w1", startedAt: T0 - 5000 }], T0 + HOUR);
	assert.equal(changed, false);
	assert.equal(store.sessions.s1.status, "working");
});

test("prune expires sessions after 12 hours without events", () => {
	const store = s.emptyStore();
	store.sessions.fresh = session({ id: "fresh", lastEvent: T0 });
	store.sessions.edge = session({ id: "edge", owner: null, lastEvent: T0 - 12 * HOUR });
	store.sessions.old = session({ id: "old", owner: null, lastEvent: T0 - 12 * HOUR - 1 });
	const changed = s.prune(store, [{ windowId: "w1", startedAt: T0 - 1000 }], T0);
	assert.equal(changed, true);
	assert.deepEqual(Object.keys(store.sessions), ["fresh"]);
});

test("prune reports no change for an empty store", () => {
	const store = s.emptyStore();
	assert.equal(s.prune(store, [], T0), false);
	assert.equal(s.prune(null, [], T0), false);
});

// --- markSeen / dismiss -----------------------------------------------

test("markSeen settles done and error sessions but leaves other statuses alone", () => {
	const store = s.emptyStore();
	store.sessions.done = session({ id: "done", status: "done", seen: false });
	store.sessions.error = session({ id: "error", status: "error", seen: false });
	store.sessions.working = session({ id: "working", status: "working", seen: false });

	assert.equal(s.markSeen(store, "done"), true);
	assert.equal(store.sessions.done.status, "idle");
	assert.equal(store.sessions.done.seen, true);
	assert.equal(s.markSeen(store, "error"), true);
	assert.equal(store.sessions.error.status, "idle");
	assert.equal(store.sessions.error.seen, true);
	assert.equal(s.markSeen(store, "working"), false);
	assert.equal(store.sessions.working.status, "working");
	assert.equal(s.markSeen(store, "missing"), false);
});

test("dismiss deletes a session", () => {
	const store = s.emptyStore();
	store.sessions.s1 = session();
	assert.equal(s.dismiss(store, "s1"), true);
	assert.equal(store.sessions.s1, undefined);
	assert.equal(s.dismiss(store, "s1"), false);
	assert.equal(s.dismiss(null, "s1"), false);
});

// --- summarize --------------------------------------------------------

test("summarize counts this window, sorts by status then newest and never counts others", () => {
	const now = T0 + 10000;
	const store = s.emptyStore();
	store.sessions.waiting = session({ id: "waiting", status: "waiting", since: 50 });
	store.sessions.workOld = session({ id: "workOld", status: "working", since: 100, turnStart: now - 5000 });
	store.sessions.workNew = session({ id: "workNew", status: "working", since: 200, turnStart: now - 3000 });
	store.sessions.error = session({ id: "error", status: "error", since: 300 });
	store.sessions.done = session({ id: "done", status: "done", since: 400 });
	store.sessions.idle = session({ id: "idle", status: "idle", since: 500 });
	store.sessions.otherWaiting = session({ id: "otherWaiting", owner: "w2", status: "waiting", since: 900 });
	store.sessions.orphanDone = session({ id: "orphanDone", owner: null, status: "done", since: 800 });

	const summary = s.summarize(store, "w1", now);
	assert.deepEqual(summary.counts, { working: 2, waiting: 1, done: 1, error: 1 });
	assert.equal(summary.longestWorkingMs, 5000);
	assert.deepEqual(
		summary.mine.map((x) => x.id),
		["waiting", "workNew", "workOld", "error", "done", "idle"]
	);
	assert.deepEqual(
		summary.others.map((x) => x.id),
		["otherWaiting", "orphanDone"]
	);
});

test("summarize on an empty store returns zeroes", () => {
	const summary = s.summarize(s.emptyStore(), "w1", T0);
	assert.deepEqual(summary.counts, { working: 0, waiting: 0, done: 0, error: 0 });
	assert.equal(summary.longestWorkingMs, 0);
	assert.deepEqual(summary.mine, []);
	assert.deepEqual(summary.others, []);
});

test("summarize treats idle as a sort rank but not as a count", () => {
	const store = s.emptyStore();
	store.sessions.a = session({ id: "a", status: "idle", since: 1 });
	store.sessions.b = session({ id: "b", status: "waiting", since: 2 });
	const summary = s.summarize(store, "w1", T0);
	assert.deepEqual(summary.counts, { working: 0, waiting: 1, done: 0, error: 0 });
	assert.deepEqual(summary.mine.map((x) => x.id), ["b", "a"]);
});

// --- store IO ---------------------------------------------------------

test("saveStore and loadStore round-trip through an atomic temp file", async () => {
	const dir = tempDir();
	const file = path.join(dir, "nested", "state.json");
	const store = s.emptyStore();
	apply(store, "UserPromptSubmit", { title: "Round trip" }, T0);
	apply(store, "Stop", {}, T0 + 5000);

	assert.equal(await s.saveStore(file, store), true);
	assert.equal(fs.existsSync(file + ".tmp"), false, "the temp file is renamed away");
	const loaded = await s.loadStore(file);
	assert.deepEqual(loaded, store);
});

test("loadStore returns an empty store for missing, corrupt and foreign JSON", async () => {
	const dir = tempDir();
	const missing = await s.loadStore(path.join(dir, "absent.json"));
	assert.deepEqual(missing, s.emptyStore());

	const corruptFile = path.join(dir, "corrupt.json");
	fs.writeFileSync(corruptFile, '{"version":1,"sessions":{', "utf8");
	assert.deepEqual(await s.loadStore(corruptFile), s.emptyStore());

	const arrayFile = path.join(dir, "array.json");
	fs.writeFileSync(arrayFile, "[]", "utf8");
	assert.deepEqual(await s.loadStore(arrayFile), s.emptyStore());

	const trashFile = path.join(dir, "trash.json");
	fs.writeFileSync(trashFile, JSON.stringify({ version: 1, seq: 3, sessions: { a: "nope" }, effects: "nope" }), "utf8");
	assert.deepEqual(await s.loadStore(trashFile), { version: 1, seq: 3, sessions: {}, effects: [] });
});

test("loadStore keeps seq ahead of every stored effect", async () => {
	const dir = tempDir();
	const file = path.join(dir, "state.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			version: 1,
			seq: 0,
			sessions: {},
			effects: [{ seq: 41, at: T0, owner: null, sessionId: "s", title: "", kind: "done" }]
		}),
		"utf8"
	);
	const store = await s.loadStore(file);
	assert.equal(store.seq, 41);
	const res = s.applyEvent(store, event("Stop"), T0 + 1, { owner: "w1" });
	assert.equal(res.effects[0].seq, 42);
});

// --- transcript readers -----------------------------------------------

test("readContextTokens sums usage of the newest main-chain assistant record", async () => {
	const dir = tempDir();
	const file = path.join(dir, "t.jsonl");
	fs.writeFileSync(
		file,
		[
			usageRecord({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 }),
			record({ type: "user", message: { role: "user" } }),
			usageRecord({ input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 50 })
		].join("\r\n"),
		"utf8"
	);
	assert.equal(await s.readContextTokens(file), 350);
});

test("readContextTokens skips sidechain and usage-less assistant records", async () => {
	const dir = tempDir();
	const file = path.join(dir, "t.jsonl");
	fs.writeFileSync(
		file,
		[
			usageRecord({ input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 }),
			usageRecord({ input_tokens: 9000 }, { isSidechain: true }),
			record({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [] } })
		].join("\n"),
		"utf8"
	);
	assert.equal(await s.readContextTokens(file), 60);
});

test("readContextTokens survives invalid lines and missing files", async () => {
	const dir = tempDir();
	const file = path.join(dir, "t.jsonl");
	fs.writeFileSync(file, `not json\n{"type":"user"}\n${usageRecord({ input_tokens: 7 })}\n`, "utf8");
	assert.equal(await s.readContextTokens(file), 7);
	assert.equal(await s.readContextTokens(path.join(dir, "absent.jsonl")), null);
	assert.equal(await s.readContextTokens(""), null);
	const empty = path.join(dir, "empty.jsonl");
	fs.writeFileSync(empty, "", "utf8");
	assert.equal(await s.readContextTokens(empty), null);
});

test("readContextTokens tails a file larger than 512 KB and drops the partial first line", async () => {
	const dir = tempDir();
	const file = path.join(dir, "big.jsonl");
	const padding = "x".repeat(600 * 1024);
	const big = record({
		type: "assistant",
		isSidechain: false,
		pad: padding,
		message: { usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
	});
	const newest = usageRecord({ input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 });
	fs.writeFileSync(file, big + "\n" + newest + "\n", "utf8");
	assert.ok(fs.statSync(file).size > 512 * 1024);
	assert.equal(await s.readContextTokens(file), 600, "the fragment of the huge first record is skipped");
});

test("readTitle prefers the newest custom title over a newer ai title", async () => {
	const dir = tempDir();
	const file = path.join(dir, "t.jsonl");
	fs.writeFileSync(
		file,
		[
			record({ type: "custom-title", customTitle: "  My   renamed\nsession " }),
			record({ type: "ai-title", aiTitle: "Generated title" }),
			record({ type: "last-prompt", lastPrompt: "prompt" })
		].join("\n"),
		"utf8"
	);
	assert.equal(await s.readTitle(file), "My renamed session");
});

test("readTitle falls back to ai-title and then to the first 60 chars of the prompt", async () => {
	const dir = tempDir();
	const aiFile = path.join(dir, "ai.jsonl");
	fs.writeFileSync(aiFile, record({ type: "ai-title", aiTitle: "Generated" }) + "\n", "utf8");
	assert.equal(await s.readTitle(aiFile), "Generated");

	const promptFile = path.join(dir, "prompt.jsonl");
	const prompt = "p".repeat(100);
	fs.writeFileSync(promptFile, record({ type: "last-prompt", lastPrompt: prompt }) + "\n", "utf8");
	assert.equal(await s.readTitle(promptFile), "p".repeat(60));
});

test("readTitle uses the newest ai-title when several exist", async () => {
	const dir = tempDir();
	const file = path.join(dir, "t.jsonl");
	fs.writeFileSync(
		file,
		[record({ type: "ai-title", aiTitle: "old" }), record({ type: "ai-title", aiTitle: "new" })].join("\n"),
		"utf8"
	);
	assert.equal(await s.readTitle(file), "new");
});

test("readTitle caps long titles and returns null for missing files", async () => {
	const dir = tempDir();
	const file = path.join(dir, "t.jsonl");
	fs.writeFileSync(file, record({ type: "custom-title", customTitle: "t".repeat(500) }) + "\n", "utf8");
	assert.equal((await s.readTitle(file)).length, 120);
	assert.equal(await s.readTitle(path.join(dir, "absent.jsonl")), null);
	const empty = path.join(dir, "empty.jsonl");
	fs.writeFileSync(empty, "", "utf8");
	assert.equal(await s.readTitle(empty), null);
});

test("readTitle finds a title near the end of a file larger than 512 KB", async () => {
	const dir = tempDir();
	const file = path.join(dir, "big.jsonl");
	const filler = record({ type: "assistant", isSidechain: false, pad: "y".repeat(600 * 1024), message: { usage: {} } });
	fs.writeFileSync(file, filler + "\r\n" + record({ type: "custom-title", customTitle: "Tail title" }) + "\r\n", "utf8");
	assert.equal(await s.readTitle(file), "Tail title");
});
