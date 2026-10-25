// Offline tests for the transport layer: hooks-config, registry and server.
// Everything that writes goes to a temp dir; the real ~/.claude is never touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const hooksConfig = require(path.join(__dirname, "..", "src", "hooks-config.js"));
const registry = require(path.join(__dirname, "..", "src", "registry.js"));
const { startServer, sendControl } = require(path.join(__dirname, "..", "src", "server.js"));

const { HOOK_EVENTS, hookUrl, settingsPath, withHooks, withoutHooks, hasCurrentHooks, installHooks, removeHooks } =
	hooksConfig;

function tempDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-companion-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
	return file;
}

// Backdate the file so a rewrite would visibly change its mtime.
function agedMtime(file) {
	const past = new Date(Date.now() - 600000);
	fs.utimesSync(file, past, past);
	return fs.statSync(file).mtimeMs;
}

function ourEntries(settings) {
	const found = [];
	for (const event of HOOK_EVENTS) {
		for (const entry of settings.hooks[event]) {
			for (const hook of entry.hooks) if (typeof hook.url === "string" && hook.url.includes("/claude-companion/")) found.push(hook.url);
		}
	}
	return found;
}

const FOREIGN = {
	model: "opus",
	permissions: { allow: ["Bash(ls)"] },
	hooks: {
		SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
		PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hello", timeout: 2 }] }]
	}
};

// --- hooks-config ----------------------------------------------------

test("settingsPath honours CLAUDE_CONFIG_DIR and the home override", () => {
	assert.equal(
		settingsPath({ CLAUDE_CONFIG_DIR: "C:\\cfg" }, "C:\\Users\\x"),
		path.join("C:\\cfg", "settings.json")
	);
	assert.equal(settingsPath({}, path.join("C:", "Users", "x")), path.join("C:", "Users", "x", ".claude", "settings.json"));
});

test("withHooks keeps foreign entries and key order and does not mutate its input", () => {
	const before = JSON.stringify(FOREIGN);
	const next = withHooks(FOREIGN, 47823);
	assert.equal(JSON.stringify(FOREIGN), before, "input object is untouched");
	assert.deepEqual(Object.keys(next), ["model", "permissions", "hooks"]);
	assert.deepEqual(next.hooks.PostToolUse[0], FOREIGN.hooks.PostToolUse[0], "foreign hook stays first");
	assert.deepEqual(next.hooks.SessionStart, FOREIGN.hooks.SessionStart, "foreign-only event untouched");
	for (const event of HOOK_EVENTS) {
		const ours = next.hooks[event].filter((entry) => entry.hooks.some((h) => h.url === hookUrl(47823)));
		assert.equal(ours.length, 1, `${event} has exactly one entry of ours`);
	}
	assert.equal(next.hooks.Stop.length, 1, "events without a matcher are created");
	assert.equal(ourEntries(next).length, HOOK_EVENTS.length);
	assert.equal(next.hooks.PreToolUse[0].matcher, undefined, "no matcher means all tools");
});

test("hasCurrentHooks requires the exact url on every event", () => {
	const next = withHooks({}, 47823);
	assert.equal(hasCurrentHooks(next, 47823), true);
	assert.equal(hasCurrentHooks(next, 47824), false);
	assert.equal(hasCurrentHooks({}, 47823), false);
	assert.equal(hasCurrentHooks({ hooks: [] }, 47823), false);
	assert.equal(hasCurrentHooks({ hooks: { Stop: [{}] } }, 47823), false);
});

test("withoutHooks is the inverse of withHooks and drops what becomes empty", () => {
	const roundTrip = withoutHooks(withHooks(FOREIGN, 47823));
	assert.deepEqual(roundTrip, FOREIGN);
	assert.equal(withoutHooks({ hooks: { Stop: [] } }).hooks, undefined, "empty hooks object is deleted");
	assert.deepEqual(withoutHooks({ hooks: { Stop: "keep" } }).hooks, { Stop: "keep" }, "non-array values survive");
});

test("install then remove preserves foreign entries byte for byte", (t) => {
	const dir = tempDir(t);
	const file = writeJson(path.join(dir, "settings.json"), FOREIGN);
	const installed = installHooks(47823, file);
	assert.equal(installed.ok, true);
	assert.equal(installed.changed, true);
	const afterInstall = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(hasCurrentHooks(afterInstall, 47823), true);
	assert.deepEqual(afterInstall.hooks.PostToolUse[0], FOREIGN.hooks.PostToolUse[0]);

	const removed = removeHooks(file);
	assert.equal(removed.ok, true);
	assert.equal(removed.changed, true);
	assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(FOREIGN, null, 2) + "\n");
});

test("re-installing with another port replaces ours", (t) => {
	const dir = tempDir(t);
	const file = path.join(dir, "settings.json");
	assert.equal(installHooks(47823, file).changed, true);
	assert.equal(installHooks(47824, file).changed, true);
	const settings = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(hasCurrentHooks(settings, 47824), true);
	assert.equal(hasCurrentHooks(settings, 47823), false);
	assert.equal(ourEntries(settings).length, HOOK_EVENTS.length, "no duplicate entries");
});

test("installing twice with the same port does not rewrite the file", (t) => {
	const dir = tempDir(t);
	const file = path.join(dir, "settings.json");
	assert.equal(installHooks(47823, file).changed, true);
	const mtime = agedMtime(file);
	const again = installHooks(47823, file);
	assert.deepEqual(again, { ok: true, changed: false });
	assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test("removing when we have no hooks leaves the file untouched", (t) => {
	const dir = tempDir(t);
	const file = writeJson(path.join(dir, "settings.json"), FOREIGN);
	const mtime = agedMtime(file);
	assert.deepEqual(removeHooks(file), { ok: true, changed: false });
	assert.equal(fs.statSync(file).mtimeMs, mtime);

	const missing = path.join(dir, "absent", "settings.json");
	assert.deepEqual(removeHooks(missing), { ok: true, changed: false });
	assert.equal(fs.existsSync(missing), false, "a missing settings file is not created");
});

test("invalid JSON is refused and never overwritten", (t) => {
	const dir = tempDir(t);
	const file = path.join(dir, "settings.json");
	const broken = '{\n  "hooks": {\n';
	fs.writeFileSync(file, broken, "utf8");
	const mtime = agedMtime(file);

	const installed = installHooks(47823, file);
	assert.equal(installed.ok, false);
	assert.match(installed.error, /invalid JSON/);
	assert.equal(fs.readFileSync(file, "utf8"), broken);
	assert.equal(fs.statSync(file).mtimeMs, mtime);

	const removed = removeHooks(file);
	assert.equal(removed.ok, false);
	assert.equal(fs.readFileSync(file, "utf8"), broken);
});

test("an unparsable hooks shape is refused instead of losing data", (t) => {
	const dir = tempDir(t);
	const file = writeJson(path.join(dir, "settings.json"), { hooks: { Stop: "nope" } });
	const before = fs.readFileSync(file, "utf8");
	const result = installHooks(47823, file);
	assert.equal(result.ok, false);
	assert.equal(fs.readFileSync(file, "utf8"), before);

	const arrayFile = writeJson(path.join(dir, "other.json"), { hooks: [] });
	assert.equal(installHooks(47823, arrayFile).ok, false);
	assert.equal(fs.readFileSync(arrayFile, "utf8"), JSON.stringify({ hooks: [] }, null, 2) + "\n");
});

test("a UTF-8 BOM is tolerated on read and not written back", (t) => {
	const dir = tempDir(t);
	const file = path.join(dir, "settings.json");
	fs.writeFileSync(file, "\uFEFF" + JSON.stringify(FOREIGN, null, 2) + "\n", "utf8");
	assert.equal(installHooks(47823, file).ok, true);
	const text = fs.readFileSync(file, "utf8");
	assert.equal(text.charCodeAt(0), "{".charCodeAt(0), "no BOM in the rewritten file");
	const settings = JSON.parse(text);
	assert.equal(hasCurrentHooks(settings, 47823), true);
	assert.deepEqual(settings.hooks.PostToolUse[0], FOREIGN.hooks.PostToolUse[0]);
});

test("installHooks creates missing parent directories", (t) => {
	const dir = tempDir(t);
	const file = path.join(dir, "deep", "nested", ".claude", "settings.json");
	const result = installHooks(47823, file);
	assert.equal(result.ok, true);
	assert.equal(hasCurrentHooks(JSON.parse(fs.readFileSync(file, "utf8")), 47823), true);
	assert.equal(installHooks(0, file).ok, false, "an invalid port is rejected");
});

// --- registry --------------------------------------------------------

test("register, list and unregister windows", (t) => {
	const dir = tempDir(t);
	assert.equal(registry.registerWindow(dir, { windowId: "w1", folders: ["C:\\a"] }), true);
	assert.equal(registry.registerWindow(dir, { windowId: "w2", pid: process.pid, folders: ["/b", 7], startedAt: 5 }), true);
	assert.equal(registry.registerWindow(dir, { windowId: "../evil" }), false, "path traversal is rejected");
	assert.equal(registry.registerWindow(dir, null), false);

	const windows = registry.listWindows(dir, () => true);
	assert.deepEqual(
		windows.map((w) => w.windowId),
		["w2", "w1"],
		"sorted by startedAt"
	);
	const w2 = windows[0];
	assert.deepEqual(w2.folders, ["/b"]);
	assert.equal(w2.pid, process.pid);
	assert.equal(w2.startedAt, 5);
	assert.equal(typeof windows[1].startedAt, "number");

	assert.equal(registry.unregisterWindow(dir, "w2"), true);
	assert.deepEqual(
		registry.listWindows(dir, () => true).map((w) => w.windowId),
		["w1"]
	);
	assert.equal(registry.unregisterWindow(dir, "w2"), false);
});

test("listWindows deletes files of dead pids and corrupt files", (t) => {
	const dir = tempDir(t);
	writeJson(path.join(dir, "dead.json"), { windowId: "dead", pid: 2147483646, folders: [], startedAt: 1 });
	fs.writeFileSync(path.join(dir, "corrupt.json"), "{oops", "utf8");
	fs.writeFileSync(path.join(dir, "notes.txt"), "keep me", "utf8");
	writeJson(path.join(dir, "live.json"), { windowId: "live", pid: 1234, folders: [], startedAt: 1 });

	const windows = registry.listWindows(dir, (pid) => pid === 1234);
	assert.deepEqual(
		windows.map((w) => w.windowId),
		["live"]
	);
	assert.equal(fs.existsSync(path.join(dir, "dead.json")), false);
	assert.equal(fs.existsSync(path.join(dir, "corrupt.json")), false);
	assert.equal(fs.existsSync(path.join(dir, "notes.txt")), true, "unrelated files are left alone");
	assert.deepEqual(registry.listWindows(path.join(dir, "missing")), []);
});

test("pidAlive recognises this process", () => {
	assert.equal(registry.pidAlive(process.pid), true);
	assert.equal(registry.pidAlive(0), false);
	assert.equal(registry.pidAlive(-1), false);
	assert.equal(registry.pidAlive("nope"), false);
	assert.equal(registry.pidAlive(2147483646), false);
});

test("ownerForCwd matches the longest folder prefix on win32", () => {
	const windows = [
		{ windowId: "outer", folders: ["C:\\Users\\Me"] },
		{ windowId: "inner", folders: ["C:\\Users\\Me\\proj"] },
		{ windowId: "sibling", folders: ["C:\\Users\\Me\\ab"] }
	];
	assert.equal(registry.ownerForCwd(windows, "C:\\Users\\Me\\proj\\src", "win32"), "inner");
	assert.equal(registry.ownerForCwd(windows, "c:/users/me/PROJ/SRC", "win32"), "inner");
	assert.equal(registry.ownerForCwd(windows, "C:\\Users\\Me\\proj\\", "win32"), "inner");
	assert.equal(registry.ownerForCwd(windows, "C:\\Users\\Me\\abc", "win32"), "outer", "prefix must end on a boundary");
	assert.equal(registry.ownerForCwd(windows, "C:\\Users\\Me\\ab\\x", "win32"), "sibling");
	assert.equal(registry.ownerForCwd(windows, "D:\\Other", "win32"), null);
	assert.equal(registry.ownerForCwd(windows, "", "win32"), null);
	assert.equal(registry.ownerForCwd(null, "C:\\x", "win32"), null);
});

test("ownerForCwd is case-sensitive off win32", () => {
	const windows = [{ windowId: "w", folders: ["/home/me/proj/"] }];
	assert.equal(registry.ownerForCwd(windows, "/home/me/proj/src", "linux"), "w");
	assert.equal(registry.ownerForCwd(windows, "/home/me/PROJ/src", "linux"), null);
	assert.equal(registry.ownerForCwd(windows, "/home/me/proj2", "linux"), null);
});

// --- server ----------------------------------------------------------

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = http.createServer();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

async function waitFor(predicate, timeoutMs, label) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`timed out waiting for ${label || "condition"}`);
}

async function startLeader(port, callbacks = {}) {
	const server = startServer({ port, ...callbacks });
	await waitFor(() => server.role === "leader", 3000, "leader");
	return server;
}

function request(port, { method = "GET", path: requestPath = "/", headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () =>
				resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
			);
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

test("two servers on one port elect exactly one leader and fail over", async () => {
	const port = await freePort();
	const roleA = [];
	const roleB = [];
	const a = startServer({ port, onRoleChange: (role) => roleA.push(role) });
	const b = startServer({ port, onRoleChange: (role) => roleB.push(role) });
	try {
		await waitFor(() => a.role !== b.role, 3000, "one leader");
		const leader = a.role === "leader" ? a : b;
		const follower = leader === a ? b : a;
		assert.equal(leader.role, "leader");
		assert.equal(follower.role, "follower");
		assert.equal(port, leader.port);

		leader.stop();
		await waitFor(() => follower.role === "leader", 7000, "failover");
		assert.equal(follower.role, "leader");
	} finally {
		a.stop();
		b.stop();
	}
});

test("events are acknowledged with an empty 204 and handed over with their headers", async () => {
	const port = await freePort();
	let received = null;
	const leader = await startLeader(port, {
		onEvent: (event) => {
			received = event;
		}
	});
	try {
		const res = await request(port, {
			method: "POST",
			path: "/claude-companion/v1/event",
			headers: {
				"Content-Type": "application/json",
				"X-Companion-Window": "abc123",
				"X-Companion-Nested": "1"
			},
			body: JSON.stringify({ hook_event_name: "Stop", session_id: "s1" })
		});
		assert.equal(res.status, 204);
		assert.equal(res.body, "", "hook output must be empty");
		await waitFor(() => received !== null, 2000, "onEvent");
		assert.deepEqual(received.input, { hook_event_name: "Stop", session_id: "s1" });
		assert.equal(received.windowId, "abc123");
		assert.equal(received.nested, "1");

		received = null;
		await request(port, {
			method: "POST",
			path: "/claude-companion/v1/event",
			body: JSON.stringify({ hook_event_name: "Stop" })
		});
		await waitFor(() => received !== null, 2000, "onEvent without headers");
		assert.equal(received.windowId, "");
		assert.equal(received.nested, "");
	} finally {
		leader.stop();
	}
});

test("control messages reach onControl", async () => {
	const port = await freePort();
	let control = null;
	const leader = await startLeader(port, {
		onControl: (payload) => {
			control = payload;
		}
	});
	try {
		const ok = await sendControl(port, { action: "seen", sessionId: "s1" });
		assert.equal(ok, true);
		await waitFor(() => control !== null, 2000, "onControl");
		assert.deepEqual(control, { action: "seen", sessionId: "s1" });
	} finally {
		leader.stop();
	}
});

test("ping reports the leader", async () => {
	const port = await freePort();
	const leader = await startLeader(port);
	try {
		const res = await request(port, { path: "/claude-companion/v1/ping" });
		assert.equal(res.status, 200);
		const body = JSON.parse(res.body);
		assert.equal(body.app, "claude-companion");
		assert.equal(body.pid, process.pid);
	} finally {
		leader.stop();
	}
});

test("bad JSON is 400 and unknown routes are 404", async () => {
	const port = await freePort();
	const leader = await startLeader(port);
	try {
		const bad = await request(port, { method: "POST", path: "/claude-companion/v1/event", body: "{not json" });
		assert.equal(bad.status, 400);
		const empty = await request(port, { method: "POST", path: "/claude-companion/v1/control" });
		assert.equal(empty.status, 400);
		assert.equal((await request(port, { path: "/claude-companion/v1/event" })).status, 404, "GET on the event route");
		assert.equal((await request(port, { path: "/" })).status, 404);
		assert.equal((await request(port, { method: "POST", path: "/claude-companion/v1/ping" })).status, 404);
		assert.equal((await request(port, { method: "DELETE", path: "/claude-companion/v1/control" })).status, 404);
	} finally {
		leader.stop();
	}
});

test("a body over 1 MB is rejected with 413", async () => {
	const port = await freePort();
	let events = 0;
	const leader = await startLeader(port, {
		onEvent: () => {
			events += 1;
		}
	});
	try {
		let response = null;
		try {
			response = await request(port, {
				method: "POST",
				path: "/claude-companion/v1/event",
				headers: { "Content-Type": "application/json" },
				body: "x".repeat(1024 * 1024 + 1024)
			});
		} catch (err) {
			// The server drops the connection after answering, so a reset is a valid outcome.
			assert.match(String(err.code), /ECONNRESET|EPIPE/);
		}
		if (response) {
			assert.equal(response.status, 413);
			assert.equal(response.body, "");
		}
		assert.equal(events, 0, "an oversized event is never delivered");
	} finally {
		leader.stop();
	}
});

test("sendControl resolves false when nobody listens and never rejects", async () => {
	const port = await freePort();
	assert.equal(await sendControl(port, { action: "dismiss", sessionId: "s1" }), false);
	assert.equal(await sendControl(0, {}), false);
	assert.equal(await sendControl(port, undefined), false);
});

test("sendControl gives up on a leader that never answers", async () => {
	const port = await freePort();
	const silent = http.createServer(() => {
		// accept the request and never reply
	});
	await new Promise((resolve) => silent.listen(port, "127.0.0.1", resolve));
	try {
		assert.equal(await sendControl(port, { action: "seen", sessionId: "s1" }), false);
	} finally {
		if (typeof silent.closeAllConnections === "function") silent.closeAllConnections();
		await new Promise((resolve) => silent.close(resolve));
	}
});

test("callbacks that throw do not kill the server", async () => {
	const port = await freePort();
	const logs = [];
	const leader = await startLeader(port, {
		onEvent: () => {
			throw new Error("boom");
		},
		onControl: () => {
			throw new Error("boom");
		},
		log: (line) => logs.push(line)
	});
	try {
		assert.equal(
			(await request(port, { method: "POST", path: "/claude-companion/v1/event", body: "{}" })).status,
			204
		);
		await waitFor(() => logs.some((line) => line.includes("onEvent failed")), 2000, "logged onEvent error");
		assert.equal(await sendControl(port, { action: "seen" }), true);
		assert.equal((await request(port, { path: "/claude-companion/v1/ping" })).status, 200);
	} finally {
		leader.stop();
	}
});

// --- uninstall -------------------------------------------------------

test("uninstall.js removes our hooks and exits 0", (t) => {
	const dir = tempDir(t);
	const file = writeJson(path.join(dir, "settings.json"), FOREIGN);
	assert.equal(installHooks(47823, file).ok, true);
	const uninstall = path.join(__dirname, "..", "uninstall.js");
	const result = spawnSync(process.execPath, [uninstall], {
		cwd: os.tmpdir(),
		env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
		encoding: "utf8",
		timeout: 20000
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(FOREIGN, null, 2) + "\n");
});
