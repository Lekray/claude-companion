// Offline tests for the pure helpers of extension.js: node --test test/
// The `vscode` module only exists inside the extension host, so a minimal stub is injected.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

const config = {};
const vscodeStub = {
	env: { language: "en" },
	workspace: {
		workspaceFolders: [],
		getConfiguration: () => ({ get: (key, def) => (key in config ? config[key] : def) })
	},
	MarkdownString: class {},
	ThemeColor: class {}
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	return request === "vscode" ? vscodeStub : originalLoad.call(this, request, ...rest);
};
const { _test: x } = require(path.join(__dirname, "..", "extension.js"));
Module._load = originalLoad;

const ICON = "$(claude-companion-logo)";

test("status bar text: counters, the longest working turn and the usage part", () => {
	const text = x.buildStatusText({
		counts: { working: 2, waiting: 1, done: 1, error: 1 },
		longestWorkingMs: 192000,
		sessionStatus: true,
		usageInStatusBar: true,
		slots: [
			{ id: "5h", ratio: 0.69 },
			{ id: "7d", ratio: 0.36 }
		]
	});
	assert.equal(text, `${ICON} ~2 3:12 ?1 V1 !1 · 5h 69% · 7d 36%`);
});

test("status bar text omits zero counters and an absent timer", () => {
	assert.equal(
		x.buildStatusText({ counts: { working: 0, waiting: 0, done: 0, error: 0 }, longestWorkingMs: 0, slots: [] }),
		`${ICON} Claude`
	);
	assert.equal(
		x.buildStatusText({ counts: { waiting: 0, done: 3 }, longestWorkingMs: 60000, slots: [] }),
		`${ICON} V3`
	);
});

test("status bar parts switch off independently", () => {
	assert.equal(
		x.buildStatusText({
			counts: { working: 1 },
			longestWorkingMs: 5000,
			sessionStatus: false,
			usageInStatusBar: true,
			slots: [{ id: "5h", ratio: 0.8 }]
		}),
		`${ICON} 5h 80%`
	);
	assert.equal(
		x.buildStatusText({
			counts: { working: 1 },
			longestWorkingMs: 5000,
			sessionStatus: true,
			usageInStatusBar: false,
			slots: [{ id: "5h", ratio: 0.8 }]
		}),
		`${ICON} ~1 0:05`
	);
	assert.equal(x.buildUsagePart(null, true), "");
	assert.equal(x.buildUsagePart([{ id: "5h", ratio: 0.123 }], true), "5h 12%");
});

test("turn timer formatting: mm:ss, h:mm:ss and the zero floor", () => {
	assert.equal(x.formatTurn(192000), "3:12");
	assert.equal(x.formatTurn(1000), "0:01");
	assert.equal(x.formatTurn(3723000), "1:02:03");
	assert.equal(x.formatTurn(-5), "0:00");
	assert.equal(x.formatTurn(undefined), "0:00");
});

test("Claude's 25-character tab labels truncate to 24 plus an ellipsis", () => {
	const exact = "a".repeat(25);
	assert.equal(x.truncateTitle(exact), exact);
	assert.equal(x.truncateTitle("a".repeat(26)), "a".repeat(24) + "…");
	assert.equal(x.truncateTitle(""), "");
	assert.equal(x.truncateTitle(null), "");
});

test("effects belong to their owner; null effects belong to the leader", () => {
	assert.equal(x.effectApplies({ owner: "w1", kind: "done" }, false, "w1"), true);
	assert.equal(x.effectApplies({ owner: "w1", kind: "done" }, true, "w2"), false);
	assert.equal(x.effectApplies({ owner: null, kind: "done" }, true, "w2"), true);
	assert.equal(x.effectApplies({ owner: null, kind: "done" }, false, "w2"), false);
	assert.equal(x.effectApplies({ kind: "done" }, true, "w2"), true);
	assert.equal(x.effectApplies(null, true, "w2"), false);
});

test("a window records the current seq at start and never replays old effects", () => {
	const first = x.collectNewEffects({ seq: 5, effects: [{ seq: 4 }, { seq: 5 }] }, -1);
	assert.deepEqual(first.effects, []);
	assert.equal(first.maxSeq, 5);

	const next = x.collectNewEffects({ seq: 7, effects: [{ seq: 4 }, { seq: 7 }, { seq: 6 }] }, first.maxSeq);
	assert.deepEqual(
		next.effects.map((e) => e.seq),
		[6, 7]
	);
	assert.equal(next.maxSeq, 7);

	const replay = x.collectNewEffects({ seq: 7, effects: [{ seq: 6 }, { seq: 7 }] }, next.maxSeq);
	assert.deepEqual(replay.effects, []);
	assert.equal(replay.maxSeq, 7);

	const gap = x.collectNewEffects({ seq: 9, effects: [{ seq: 9 }] }, 7);
	assert.deepEqual(
		gap.effects.map((e) => e.seq),
		[9]
	);
	assert.equal(gap.maxSeq, 9);
});

test("sound gap: done/error are dropped inside the gap, waiting is delayed", () => {
	const gap = 1500;
	assert.equal(x.soundDelay("done", 100000, 0, gap), 0);
	assert.equal(x.soundDelay("done", 100500, 100000, gap), -1);
	assert.equal(x.soundDelay("error", 100500, 100000, gap), -1);
	assert.equal(x.soundDelay("waiting", 100500, 100000, gap), 1000);
	assert.equal(x.soundDelay("done", 101500, 100000, gap), 0);
	assert.equal(x.soundDelay("waiting", 103000, 100000, gap), 0);
	assert.equal(x.soundDelay("waiting", 100000, 100000, gap), gap);
});

test("markdown escaping keeps a title from becoming a link or HTML", () => {
	const evil = "[click](command:workbench.action.quit) <img src=x> **bold**";
	const escaped = x.escapeMarkdown(evil);
	assert.ok(!escaped.includes("](command:"));
	assert.ok(!escaped.includes("\\]("));
	assert.ok(escaped.includes("\\[click\\]"));
	assert.ok(escaped.includes("\\<img"));
	assert.ok(escaped.includes("\\*\\*bold\\*\\*"));
});

test("tooltip: sessions, limits, DeepSeek spend and only our command links", () => {
	const now = Date.parse("2026-10-18T12:00:00Z");
	const evil = "[x](command:workbench.action.quit)";
	const md = x.buildTooltipMarkdown({
		now,
		mine: [
			{
				id: "s1",
				status: "working",
				title: evil,
				turnStart: now - 192000,
				contextTokens: 312000
			}
		],
		others: 2,
		cache: {
			at: now - 60000,
			claude: {
				ok: true,
				slots: [
					{ id: "5h", label: "5h", ratio: 0.69, resetAt: now + 3600000, durationMinutes: 300 },
					{ id: "7d", label: "7d", ratio: 0.36, resetAt: now + 86400000, durationMinutes: 10080 }
				]
			},
			deepseek: { available: true, currency: "USD", total: 0.84 },
			ledger: { today: { usd: 0.18, runs: 12 }, week: { usd: 1.2, runs: 30 } }
		},
		t: x.STR.en
	});
	assert.ok(md.includes("working · 3:12 · 312K"), "state, running turn and context K");
	assert.ok(md.includes("2 sessions in other windows"));
	assert.ok(md.includes("### **69%**"));
	assert.ok(md.includes("data:image/png;base64,"));
	assert.ok(md.includes("DeepSeek:"));
	assert.ok(md.includes("$0.84"));
	assert.ok(md.includes("today $0.18 (12 runs)"));
	assert.ok(md.includes("7 days $1.20"));
	assert.ok(!md.includes("](command:workbench"));
	for (const link of md.match(/\]\(command:[^)]+\)/g) || []) {
		assert.match(link, /command:claudeCompanion\.(usage|refresh|diagnostics|deepseekToggle)/);
	}
});

test("tooltip: the DeepSeek routing line shows the state, the scope and a toggle link", () => {
	const md = x.buildTooltipMarkdown({
		now: Date.now(),
		mine: [],
		others: 0,
		cache: null,
		deepseek: { on: true, target: { scope: "project", file: "C:\\p\\.claude\\settings.local.json" } },
		t: x.STR.en
	});
	assert.ok(md.includes("DeepSeek routing: on"));
	assert.ok(md.includes("(command:claudeCompanion.deepseekToggle"));
	assert.ok(md.includes("applies to new chats"));
});

test("tooltip: DeepSeek off is reported as off, user scope says all projects", () => {
	const md = x.buildTooltipMarkdown({
		now: Date.now(),
		mine: [],
		others: 0,
		cache: null,
		deepseek: { on: false, target: { scope: "user", file: "/home/u/.claude/settings.json" } },
		t: x.STR.en
	});
	assert.ok(md.includes("DeepSeek routing: off"));
	assert.ok(md.includes("all projects"));
});

test("status bar: the DeepSeek part is the balance plus today's spend", () => {
	assert.strictEqual(
		x.buildDeepseekPart({ total: 3.42, currency: "USD" }, 0.18),
		"DS $3.42 (−$0.18)"
	);
	assert.strictEqual(x.buildDeepseekPart({ total: 3.42, currency: "CNY" }, 0), "DS ¥3.42");
	assert.strictEqual(x.buildDeepseekPart({ total: 3.42, currency: "USD" }, 0.004), "DS $3.42 (−<$0.01)");
	assert.strictEqual(x.buildDeepseekPart(null, 0.18), "", "no balance, no part");
	assert.strictEqual(x.buildDeepseekPart({ total: NaN }, 0.18), "", "a broken balance is not a promise");
});

test("status bar text: the DeepSeek part goes last and leaves the rest alone", () => {
	const text = x.buildStatusText({
		counts: { working: 1 },
		longestWorkingMs: 5000,
		slots: [],
		deepseek: "DS $3.42 (−$0.18)"
	});
	assert.ok(text.endsWith("DS $3.42 (−$0.18)"));
	assert.ok(text.includes("~1"));
});

test("deepseek: the menu item reads the project settings file and shows its state", () => {
	const fs = require("node:fs");
	const os = require("node:os");
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cc-menu-"));
	fs.mkdirSync(path.join(folder, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(folder, ".claude", "settings.local.json"),
		JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-x" } })
	);
	vscodeStub.workspace.workspaceFolders = [{ uri: { scheme: "file", fsPath: folder } }];
	config.deepseekScope = "project";
	x.resetDeepseekCache();
	const state = x.deepseekState();
	assert.strictEqual(state.on, true);
	const item = x.deepseekMenuItem();
	assert.match(item.label, /: on$/);
	assert.ok(item.label.startsWith("$(circle-filled)"));
	assert.ok(item.detail.includes("settings.local.json"));
	assert.ok(item.detail.includes("applies to new chats"));
	assert.strictEqual(item.action, "deepseek");

	fs.writeFileSync(path.join(folder, ".claude", "settings.local.json"), JSON.stringify({ env: {} }));
	x.resetDeepseekCache();
	assert.strictEqual(x.deepseekMenuItem().label.endsWith(": off"), true);
	vscodeStub.workspace.workspaceFolders = [];
	x.resetDeepseekCache();
});

test("deepseek: without a folder the item explains what to open", () => {
	vscodeStub.workspace.workspaceFolders = [];
	config.deepseekScope = "project";
	x.resetDeepseekCache();
	const item = x.deepseekMenuItem();
	assert.strictEqual(item.detail, x.STR.en.deepseekNoWorkspace);
	assert.strictEqual(item.label.endsWith(": off"), true);
});

test("deepseek: the user scope always has a file, so it needs no folder", () => {
	vscodeStub.workspace.workspaceFolders = [];
	config.deepseekScope = "user";
	x.resetDeepseekCache();
	const item = x.deepseekMenuItem();
	assert.ok(item.detail.includes(".claude"));
	assert.ok(!item.detail.includes("Open a folder"));
	delete config.deepseekScope;
	vscodeStub.workspace.workspaceFolders = [];
	x.resetDeepseekCache();
});

test("tooltip: no DeepSeek switch requested, no routing line", () => {
	const md = x.buildTooltipMarkdown({ now: Date.now(), mine: [], others: 0, cache: null, t: x.STR.en });
	assert.ok(!md.includes("DeepSeek routing"));
});

test("tooltip shows the token-expired explanation instead of a bare reason code", () => {
	const now = Date.now();
	const md = x.buildTooltipMarkdown({
		now,
		mine: [],
		others: 0,
		cache: { at: now, claude: { ok: false, slots: [], reason: "token-expired" }, deepseek: null, ledger: null },
		t: x.STR.en
	});
	assert.ok(md.includes("Claude login token expired"));
	assert.ok(md.includes("it refreshes when Claude Code is next used"));
});

test("usage report: every slot, pace and the failure reason", () => {
	// The report is rendered against the live clock, so the fixture must be relative to it.
	const now = Date.now();
	const ok = x.usageReportText({
		at: now,
		claude: {
			ok: true,
			slots: [{ id: "5h", label: "5h", ratio: 0.74, resetAt: now + 3600000, durationMinutes: 300 }]
		},
		deepseek: { available: true, currency: "USD", total: 0.84 },
		ledger: { today: { usd: 0.18, runs: 12 }, week: { usd: 1.2, runs: 30 } }
	});
	assert.ok(ok.includes("5h: 74%"));
	assert.ok(ok.includes("resets"));
	assert.ok(ok.includes("pace"));
	assert.ok(ok.includes("Balance: $0.84"));
	assert.ok(ok.includes("today: $0.18 (12 runs)"));
	assert.ok(ok.includes("7 days: $1.20 (30 runs)"));

	const failed = x.usageReportText({
		at: now,
		claude: { ok: false, slots: [], reason: "token-expired" },
		deepseek: null,
		ledger: null
	});
	assert.ok(failed.includes("Claude usage request failed"));
	assert.ok(failed.includes("token expired"));
});

test("only the proxy host:port is ever shown", () => {
	assert.equal(x.formatProxy("http://user:secret@127.0.0.1:7890/"), "127.0.0.1:7890");
	assert.equal(x.formatProxy("127.0.0.1:8080"), "127.0.0.1:8080");
	assert.equal(x.formatProxy(""), x.STR.en.direct);
});

test("money formats USD, RUB and an unknown currency safely", () => {
	assert.equal(x.money(0.84, "USD"), "$0.84");
	assert.equal(x.money(150, "RUB"), "₽150.00");
	assert.equal(x.money(1.2, "](evil)"), "$1.20");
});

test("every language bundle exposes the same keys", () => {
	const keys = Object.keys(x.STR.en).sort();
	assert.deepEqual(Object.keys(x.STR.ru).sort(), keys);
	assert.deepEqual(Object.keys(x.STR.zh).sort(), keys);
});
