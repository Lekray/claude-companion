// Offline tests for src/usage.js: node --test test/usage.test.js
// No real ~/.claude, no network: everything runs against temp dirs and local sockets.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const usage = require(path.join(__dirname, "..", "src", "usage.js"));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docs", "usage-sample.json"), "utf8"));

const HOUR = 3600000;
const DAY = 24 * HOUR;

function tempDir(t, prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// --- parseClaudeUsage ---------------------------------------------------

test("parseClaudeUsage reads the real sample: 5h 74%, 7d 37%, resetAt in ms", () => {
	const slots = usage.parseClaudeUsage(SAMPLE, Date.now());
	assert.equal(slots.length, 2);
	const five = slots[0];
	assert.equal(five.id, "5h");
	assert.equal(five.label, "5h");
	assert.equal(five.ratio, 0.74);
	assert.equal(five.durationMinutes, 300);
	assert.equal(five.resetAt, Date.parse("2026-10-18T18:49:59.961658+00:00"));
	const seven = slots[1];
	assert.equal(seven.id, "7d");
	assert.equal(seven.ratio, 0.37);
	assert.equal(seven.durationMinutes, 10080);
	assert.equal(seven.resetAt, Date.parse("2026-10-24T09:59:59.961684+00:00"));
});

test("parseClaudeUsage falls back to limits[] when five_hour/seven_day are null", () => {
	const slots = usage.parseClaudeUsage({
		five_hour: null,
		seven_day: null,
		limits: [
			{ kind: "session", percent: 74, resets_at: "2026-10-18T18:49:59Z" },
			{ kind: "weekly_all", percent: 37, resets_at: "2026-10-24T09:59:59Z" }
		]
	});
	assert.deepEqual(
		slots.map((s) => [s.id, s.ratio, s.durationMinutes]),
		[
			["5h", 0.74, 300],
			["7d", 0.37, 10080]
		]
	);
	assert.equal(slots[0].resetAt, Date.parse("2026-10-18T18:49:59Z"));
});

test("parseClaudeUsage prefers the main fields over limits[] (no duplicates)", () => {
	const slots = usage.parseClaudeUsage({
		five_hour: { utilization: 10 },
		seven_day: { utilization: 20 },
		limits: [
			{ kind: "session", percent: 99 },
			{ kind: "weekly_all", percent: 99 }
		]
	});
	assert.equal(slots.length, 2);
	assert.equal(slots[0].ratio, 0.1);
	assert.equal(slots[1].ratio, 0.2);
});

test("parseClaudeUsage emits an extra seven_day_opus slot", () => {
	const slots = usage.parseClaudeUsage({
		five_hour: { utilization: 74, resets_at: "2026-10-18T18:49:59Z" },
		seven_day: { utilization: 37, resets_at: "2026-10-24T09:59:59Z" },
		seven_day_opus: { utilization: 12.5, resets_at: "2026-10-24T09:59:59Z" },
		seven_day_sonnet: null
	});
	assert.equal(slots.length, 3);
	const opus = slots[2];
	assert.equal(opus.id, "seven_day_opus");
	assert.equal(opus.label, "7d opus");
	assert.equal(opus.ratio, 0.125);
	assert.equal(opus.durationMinutes, 10080);
	assert.ok(opus.resetAt > 0);
});

test("parseClaudeUsage clamps ratios and ignores unusable payloads", () => {
	const slots = usage.parseClaudeUsage({
		five_hour: { utilization: 150 },
		seven_day: { utilization: "37" },
		seven_day_bogus: { note: "no utilization" }
	});
	assert.equal(slots.length, 1);
	assert.equal(slots[0].ratio, 1);
	assert.equal(slots[0].resetAt, null);
	assert.deepEqual(usage.parseClaudeUsage(null), []);
	assert.deepEqual(usage.parseClaudeUsage("nope"), []);
});

// --- resolveProxy -------------------------------------------------------

test("resolveProxy: override wins, none forces direct", () => {
	const env = { HTTPS_PROXY: "http://env-proxy:8080" };
	assert.equal(usage.resolveProxy(env, null, "none"), null);
	assert.equal(usage.resolveProxy(env, null, "NONE"), null);
	assert.equal(usage.resolveProxy(env, null, " http://override:3128 "), "http://override:3128");
	assert.equal(usage.resolveProxy(env, null, ""), "http://env-proxy:8080");
});

test("resolveProxy: env precedence and claude settings fallback", () => {
	assert.equal(usage.resolveProxy({ HTTPS_PROXY: "http://a:1" }), "http://a:1");
	assert.equal(usage.resolveProxy({ https_proxy: "http://b:2" }), "http://b:2");
	assert.equal(usage.resolveProxy({ HTTPS_PROXY: "http://a:1", https_proxy: "http://b:2" }), "http://a:1");
	assert.equal(usage.resolveProxy({ HTTP_PROXY: "http://c:3" }), "http://c:3");
	assert.equal(usage.resolveProxy({ http_proxy: "http://d:4" }), "http://d:4");
	assert.equal(usage.resolveProxy({}, { env: { HTTPS_PROXY: "http://settings:5" } }), "http://settings:5");
	assert.equal(usage.resolveProxy({}, null), null);
	assert.equal(usage.resolveProxy({}, { env: {} }), null);
});

test("resolveProxy: NO_PROXY entries match suffixes, ignore ports, support *", () => {
	const env = { HTTPS_PROXY: "http://p:8080" };
	assert.equal(usage.resolveProxy({ ...env, NO_PROXY: "*" }), null);
	assert.equal(usage.resolveProxy({ ...env, NO_PROXY: "example.com" }), "http://p:8080");
	assert.equal(usage.resolveProxy({ ...env, NO_PROXY: "api.anthropic.com" }), null);
	assert.equal(usage.resolveProxy({ ...env, NO_PROXY: "api.anthropic.com:443" }), null);
	assert.equal(usage.resolveProxy({ ...env, NO_PROXY: ".anthropic.com" }), null);
	assert.equal(usage.resolveProxy({ ...env, NO_PROXY: ".anthropic.com" }, null, "", "api.anthropic.com"), null);
	assert.equal(usage.resolveProxy({ ...env, no_proxy: "API.ANTHROPIC.COM" }), null);
	assert.equal(usage.resolveProxy({ ...env, NO_PROXY: "other.com, api.anthropic.com" }), null);
	assert.equal(usage.resolveProxy({ ...env, NO_PROXY: "notanthropic.com" }), "http://p:8080");
	assert.equal(usage.resolveProxy({ ...env, NO_PROXY: "*.anthropic.com" }), null);
	assert.equal(usage.resolveProxy({ ...env, NO_PROXY: "http://api.anthropic.com:443/" }), null);
	assert.equal(usage.resolveProxy({ ...env, NO_PROXY: "*" }, null, "http://override:1"), "http://override:1");
	assert.equal(usage.resolveProxy(env, null, "", "api.deepseek.com"), "http://p:8080");
});

// --- credentials, DeepSeek key, cache -----------------------------------

test("readOauth: missing, corrupt and valid credential files", (t) => {
	const home = tempDir(t, "cc-usage-oauth-");
	assert.equal(usage.readOauth({}, home), null);
	const dir = path.join(home, ".claude");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".credentials.json"), "{not json", "utf8");
	assert.equal(usage.readOauth({}, home), null);
	fs.writeFileSync(
		path.join(dir, ".credentials.json"),
		JSON.stringify({ claudeAiOauth: { accessToken: "tok-123", expiresAt: 1792349399961, subscriptionType: "max" } }),
		"utf8"
	);
	assert.deepEqual(usage.readOauth({}, home), {
		accessToken: "tok-123",
		expiresAt: 1792349399961,
		subscriptionType: "max"
	});
});

test("readOauth honours CLAUDE_CONFIG_DIR", (t) => {
	const home = tempDir(t, "cc-usage-oauth2-");
	const custom = tempDir(t, "cc-usage-cfg-");
	fs.writeFileSync(
		path.join(custom, ".credentials.json"),
		JSON.stringify({ claudeAiOauth: { accessToken: "tok-custom", expiresAt: 1792349399961 } }),
		"utf8"
	);
	const oauth = usage.readOauth({ CLAUDE_CONFIG_DIR: custom }, home);
	assert.equal(oauth.accessToken, "tok-custom");
	assert.equal(oauth.subscriptionType, null);
});

test("fetchClaudeUsage reports missing and expired tokens without a network call", async (t) => {
	const home = tempDir(t, "cc-usage-fetch-");
	const empty = await usage.fetchClaudeUsage({ env: {}, home, timeoutMs: 50 });
	assert.equal(empty.ok, false);
	assert.equal(empty.reason, "no-credentials");
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".claude", ".credentials.json"),
		JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() } }),
		"utf8"
	);
	const expired = await usage.fetchClaudeUsage({ env: {}, home, timeoutMs: 50 });
	assert.equal(expired.ok, false);
	assert.equal(expired.reason, "token-expired");
});

test("deepseekApiKey uses env, then secrets/deepseek.json, then config.toml", (t) => {
	const home = tempDir(t, "cc-usage-dskey-");
	assert.equal(usage.deepseekApiKey({}, home), null);
	assert.equal(usage.deepseekApiKey({ DEEPSEEK_API_KEY: " env-key " }, home), "env-key");
	const secrets = path.join(home, ".claude", "secrets");
	fs.mkdirSync(secrets, { recursive: true });
	fs.writeFileSync(path.join(secrets, "deepseek.json"), JSON.stringify({ api_key: "file-key" }), "utf8");
	assert.equal(usage.deepseekApiKey({}, home), "file-key");
	assert.equal(usage.deepseekApiKey({ DEEPSEEK_API_KEY: "env-key" }, home), "env-key");
	fs.rmSync(path.join(home, ".claude"), { recursive: true, force: true });
	const kimi = path.join(home, ".kimi-code");
	fs.mkdirSync(kimi, { recursive: true });
	fs.writeFileSync(
		path.join(kimi, "config.toml"),
		['[providers.other]', 'api_key = "wrong"', '[providers.deepseek]', "api_key = 'toml-key'", ""].join("\n"),
		"utf8"
	);
	assert.equal(usage.deepseekApiKey({}, home), "toml-key");
});

test("usage cache round-trips atomically and rejects corrupt files", (t) => {
	const dir = tempDir(t, "cc-usage-cache-");
	const file = path.join(dir, "usage.json");
	assert.equal(usage.loadUsageCache(file), null);
	const cache = {
		at: 1792349399961,
		claude: { ok: true, slots: [{ id: "5h", label: "5h", ratio: 0.74, resetAt: null, durationMinutes: 300 }] },
		deepseek: { available: true, currency: "USD", total: 3.5 },
		ledger: { today: { usd: 0.01, runs: 2 }, week: { usd: 0.2, runs: 9 } }
	};
	assert.equal(usage.saveUsageCache(file, cache), true);
	assert.deepEqual(usage.loadUsageCache(file), cache);
	assert.equal(fs.existsSync(file + ".tmp"), false);
	fs.writeFileSync(file, "broken", "utf8");
	assert.equal(usage.loadUsageCache(file), null);
});

test("refreshUsage never throws and reports nulls when everything is missing", async (t) => {
	const home = tempDir(t, "cc-usage-refresh-");
	const cache = await usage.refreshUsage({ env: {}, home, timeoutMs: 100, now: 1792349399961 });
	assert.equal(cache.at, 1792349399961);
	assert.equal(cache.claude.ok, false);
	assert.deepEqual(cache.claude.slots, []);
	assert.equal(cache.deepseek, null);
	assert.equal(cache.ledger, null);
});

// --- ledger -------------------------------------------------------------

test("ledgerSpend sums today by local calendar day and the last 7×24 h", () => {
	const now = new Date(2026, 9, 18, 12, 0, 0).getTime();
	const at = (...parts) => new Date(...parts).toISOString();
	const lines = [
		JSON.stringify({ ts: at(2026, 9, 18, 0, 10), cmd: "run", usd: 0.1 }), // today, week
		JSON.stringify({ ts: at(2026, 9, 17, 23, 50), cmd: "ask", usd: 0.2 }), // yesterday local, week
		JSON.stringify({ ts: at(2026, 9, 10, 12, 0), cmd: "run", usd: 5 }), // 8 days ago
		JSON.stringify({ ts: at(2026, 9, 11, 12, 0), cmd: "run", usd: 7 }), // exactly now-7d: excluded
		JSON.stringify({ ts: new Date(now).toISOString(), cmd: "run", usd: 0.02 }), // exact now: included
		JSON.stringify({ ts: at(2026, 9, 18, 9, 0), cmd: "verdict", usd: 9 }), // wrong cmd
		JSON.stringify({ ts: at(2026, 9, 18, 9, 0), cmd: "run", usd: "0.5" }), // usd not numeric
		JSON.stringify({ ts: "not a date", cmd: "run", usd: 1 }),
		"not json"
	];
	const spend = usage.ledgerSpend(lines, now);
	assert.ok(Math.abs(spend.today.usd - 0.12) < 1e-9, `today usd ${spend.today.usd}`);
	assert.equal(spend.today.runs, 2);
	assert.ok(Math.abs(spend.week.usd - 0.32) < 1e-9, `week usd ${spend.week.usd}`);
	assert.equal(spend.week.runs, 3);
	assert.deepEqual(usage.ledgerSpend([], now), { today: { usd: 0, runs: 0 }, week: { usd: 0, runs: 0 } });
});

test("readLedger reads JSONL, skips bad lines and returns null when missing", (t) => {
	const dir = tempDir(t, "cc-usage-ledger-");
	const file = path.join(dir, "ledger.jsonl");
	assert.equal(usage.readLedger(path.join(dir, "absent.jsonl")), null);
	fs.writeFileSync(
		file,
		[
			JSON.stringify({ ts: "2026-10-18T10:00:00+00:00", cmd: "run", usd: 0.1 }),
			"not json",
			JSON.stringify({ ts: "2026-10-18T11:00:00+00:00", cmd: "ask", usd: 0.2 }),
			""
		].join("\r\n"),
		"utf8"
	);
	const records = usage.readLedger(file);
	assert.equal(records.length, 2);
	assert.equal(records[1].cmd, "ask");
});

// --- computeAlerts ------------------------------------------------------

const slot = (id, ratio, resetAt) => ({ id, label: id, ratio, resetAt, durationMinutes: id === "5h" ? 300 : 10080 });
const CFG = { alerts: true, threshold5h: 0.8, threshold7d: 0.9, deepseekBelowUsd: 1 };

test("computeAlerts fires once per 5h reset window and re-arms on a new resetAt", () => {
	const t1 = 1792349399961;
	const t2 = t1 + 5 * HOUR;
	const first = usage.computeAlerts([slot("5h", 0.85, t1)], null, CFG, {});
	assert.equal(first.alerts.length, 1);
	assert.deepEqual(first.alerts[0], { key: "5h", kind: "5h", ratio: 0.85, resetAt: t1 });
	assert.equal(first.latch["5h"], t1);
	const second = usage.computeAlerts([slot("5h", 0.86, t1)], null, CFG, first.latch);
	assert.deepEqual(second.alerts, []);
	const third = usage.computeAlerts([slot("5h", 0.81, t2)], null, CFG, second.latch);
	assert.equal(third.alerts.length, 1);
	assert.equal(third.alerts[0].key, "5h");
	assert.equal(third.latch["5h"], t2);
});

test("computeAlerts uses the plain 7d slot and respects thresholds", () => {
	const t1 = 1792349399961;
	const below = usage.computeAlerts([slot("7d", 0.85, t1), slot("7d opus", 0.99, t1)], null, CFG, {});
	assert.deepEqual(below.alerts, []);
	const above = usage.computeAlerts([slot("7d", 0.91, t1)], null, CFG, {});
	assert.equal(above.alerts.length, 1);
	assert.equal(above.alerts[0].kind, "7d");
	assert.equal(above.alerts[0].ratio, 0.91);
	assert.equal(above.latch["7d"], t1);
});

test("computeAlerts re-arms DeepSeek at 1.5× the threshold", () => {
	const low = { available: true, total: 0.5, currency: "USD" };
	const first = usage.computeAlerts([], low, CFG, {});
	assert.deepEqual(first.alerts, [{ key: "deepseek", kind: "deepseek", total: 0.5, currency: "USD" }]);
	assert.equal(first.latch.deepseek, "low");
	assert.deepEqual(usage.computeAlerts([], { ...low, total: 1.2 }, CFG, first.latch).alerts, []);
	const recovered = usage.computeAlerts([], { ...low, total: 1.5 }, CFG, first.latch);
	assert.deepEqual(recovered.alerts, []);
	assert.equal("deepseek" in recovered.latch, false);
	const again = usage.computeAlerts([], { ...low, total: 0.4 }, CFG, recovered.latch);
	assert.equal(again.alerts.length, 1);
	assert.equal(again.alerts[0].kind, "deepseek");
});

test("computeAlerts returns nothing when alerts are off and never mutates the input latch", () => {
	const latch = { "5h": 1 };
	const off = usage.computeAlerts([slot("5h", 0.99, 2)], { available: true, total: 0 }, { ...CFG, alerts: false }, latch);
	assert.deepEqual(off.alerts, []);
	assert.equal(off.latch["5h"], 1);
	// A reset an hour later is a new window (resets_at within minutes counts as the same one).
	const on = usage.computeAlerts([slot("5h", 0.99, 1 + 3600000)], null, CFG, latch);
	assert.equal(on.alerts.length, 1);
	assert.equal(latch["5h"], 1);
});

test("computeAlerts normalises percent-style thresholds", () => {
	const res = usage.computeAlerts([slot("5h", 0.85, 1)], null, { ...CFG, threshold5h: 80 }, {});
	assert.equal(res.alerts.length, 1);
});

// --- pace + PNG ---------------------------------------------------------

test("formatDuration and paceInfo keep the kimi-companion behaviour", () => {
	assert.equal(usage.formatDuration(59 * 60000), "59m");
	assert.equal(usage.formatDuration(90 * 60000), "1h 30m");
	assert.equal(usage.formatDuration(0), "0m");
	assert.equal(usage.formatDuration(-1), null);
	const now = 1792349399961;
	const resetAt = now + 2 * HOUR;
	const info = usage.paceInfo(slot("5h", 0.5, resetAt), now);
	assert.equal(info.resetInMs, 2 * HOUR);
	assert.ok(Math.abs(info.pace - 0.5 / 0.6) < 1e-9);
	assert.equal(usage.paceInfo(slot("5h", 0.5, null), now), null);
	const summary = usage.paceSummary(slot("5h", 0.9, resetAt), now, 0.8);
	assert.equal(summary.hot, true);
	assert.match(summary.text, /pace fast/);
	assert.match(summary.text, /resets in 2h 0m/);
	assert.equal(usage.paceSummary(slot("7d", 0.9, resetAt), now, 0.8).hot, false);
});

test("barPngDataUri yields a valid 260x8 PNG", () => {
	const uri = usage.barPngDataUri(0.42, false);
	assert.ok(uri.startsWith("data:image/png;base64,"));
	const png = Buffer.from(uri.slice("data:image/png;base64,".length), "base64");
	assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
	assert.equal(png.readUInt32BE(8), 13);
	assert.equal(png.readUInt32BE(16), 260);
	assert.equal(png.readUInt32BE(20), 8);
	assert.equal(png.subarray(png.length - 8, png.length - 4).toString("ascii"), "IEND");
});

// --- httpsJson over a CONNECT proxy -------------------------------------

function listen(t, server) {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("httpsJson sends a proper CONNECT line and rejects cleanly on 403", async (t) => {
	const sockets = new Set();
	const seen = [];
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const end = buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			seen.push(buffer.slice(0, end));
			socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
		});
	});
	t.after(() => {
		for (const socket of sockets) socket.destroy();
		server.close();
	});
	const port = await listen(t, server);
	const proxy = `http://user:pass@127.0.0.1:${port}`;
	await assert.rejects(
		usage.httpsJson("https://api.anthropic.com/api/oauth/usage", {
			proxy,
			timeoutMs: 2000,
			headers: { Authorization: "Bearer super-secret-token" }
		}),
		(err) => {
			assert.match(err.message, /403/);
			assert.doesNotMatch(err.message, /super-secret-token/);
			assert.doesNotMatch(err.message, /Basic/);
			return true;
		}
	);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].split("\r\n")[0], "CONNECT api.anthropic.com:443 HTTP/1.1");
	assert.ok(seen[0].includes("Proxy-Authorization: Basic " + Buffer.from("user:pass").toString("base64")));
	assert.ok(!seen[0].includes("super-secret-token"));
});

test("httpsJson rejects on timeout when the proxy never answers", async (t) => {
	const sockets = new Set();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
	});
	t.after(() => {
		for (const socket of sockets) socket.destroy();
		server.close();
	});
	const port = await listen(t, server);
	const started = Date.now();
	await assert.rejects(
		usage.httpsJson("https://api.anthropic.com/api/oauth/usage", {
			proxy: `http://127.0.0.1:${port}`,
			timeoutMs: 200
		}),
		(err) => {
			assert.match(err.message, /timed out after 200 ms/);
			return true;
		}
	);
	assert.ok(Date.now() - started < 3000, "timeout must not wait for the socket");
});

test("mergeUsageCache keeps the last good limits through a failed refresh", () => {
	const t0 = Date.UTC(2026, 9, 18, 12, 0, 0);
	const slots = [{ id: "5h", label: "5h", ratio: 0.8, resetAt: t0 + 3600000, durationMinutes: 300 }];
	const good = usage.mergeUsageCache(null, { at: t0, claude: { ok: true, slots }, deepseek: { total: 5 }, ledger: null });
	assert.equal(good.claude.okAt, t0);
	const failed = usage.mergeUsageCache(good, {
		at: t0 + 60000,
		claude: { ok: false, slots: [], reason: "http", status: 429 },
		deepseek: null,
		ledger: null
	});
	assert.equal(failed.claude.ok, false);
	assert.equal(failed.claude.status, 429);
	assert.deepEqual(failed.claude.slots, slots);
	assert.equal(failed.claude.okAt, t0);
	assert.deepEqual(failed.deepseek, { total: 5 });
	// A second failure still points at the original good time, and old data is eventually dropped.
	const again = usage.mergeUsageCache(failed, { at: t0 + 120000, claude: { ok: false, slots: [], reason: "network" } });
	assert.equal(again.claude.okAt, t0);
	const tooOld = usage.mergeUsageCache(failed, { at: t0 + 3 * 3600000, claude: { ok: false, slots: [], reason: "network" } });
	assert.deepEqual(tooOld.claude.slots, []);
	assert.equal(tooOld.deepseek, undefined);
});

test("isFreshUsage only trusts a recent successful fetch", () => {
	const now = 1_000_000;
	assert.equal(usage.isFreshUsage({ at: now - 1000, claude: { ok: true, slots: [] } }, 5000, now), true);
	assert.equal(usage.isFreshUsage({ at: now - 9000, claude: { ok: true, slots: [] } }, 5000, now), false);
	assert.equal(usage.isFreshUsage({ at: now - 1000, claude: { ok: false, slots: [] } }, 5000, now), false);
	assert.equal(usage.isFreshUsage(null, 5000, now), false);
});

test("computeAlerts does not re-fire when resets_at jitters by fractions of a second", () => {
	const reset = Date.UTC(2026, 9, 18, 18, 50, 0);
	const slot = (resetAt) => [{ id: "5h", label: "5h", ratio: 0.87, resetAt, durationMinutes: 300 }];
	const cfg = { alerts: true, threshold5h: 0.8, threshold7d: 0.9, deepseekBelowUsd: 1 };
	const first = usage.computeAlerts(slot(reset - 39), null, cfg, {});
	assert.equal(first.alerts.length, 1);
	const jitter = usage.computeAlerts(slot(reset + 350), null, cfg, first.latch);
	assert.equal(jitter.alerts.length, 0);
	const next = usage.computeAlerts(slot(reset + 5 * 3600000), null, cfg, jitter.latch);
	assert.equal(next.alerts.length, 1);
});

test("HTTP 429 sets a growing shared backoff that a success clears", () => {
	const t0 = Date.UTC(2026, 9, 18, 19, 0, 0);
	const r429 = (at) => ({ at, claude: { ok: false, slots: [], reason: "http", status: 429 } });
	const a = usage.mergeUsageCache(null, r429(t0));
	assert.equal(a.claude.failCount, 1);
	assert.equal(a.claude.retryAt, t0 + 5 * 60000);
	assert.equal(usage.retryAfter(a, t0 + 60000), t0 + 5 * 60000);
	const b = usage.mergeUsageCache(a, r429(t0 + 6 * 60000));
	assert.equal(b.claude.retryAt, t0 + 6 * 60000 + 10 * 60000);
	let c = b;
	for (let i = 0; i < 5; i++) c = usage.mergeUsageCache(c, r429(t0 + (i + 7) * 60000));
	assert.equal(c.claude.retryAt - (t0 + 11 * 60000), 30 * 60000);
	const ok = usage.mergeUsageCache(c, { at: t0 + 3600000, claude: { ok: true, slots: [{ id: "5h", ratio: 0.5 }] } });
	assert.equal(ok.claude.failCount, undefined);
	assert.equal(usage.retryAfter(ok, t0 + 3600000), 0);
	const net = usage.mergeUsageCache(null, { at: t0, claude: { ok: false, slots: [], reason: "network" } });
	assert.equal(net.claude.retryAt, undefined);
});
