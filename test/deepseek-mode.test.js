const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const mode = require("../src/deepseek-mode");

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "cc-deepseek-"));
}

function write(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, "utf8");
}

test("target: project scope is <folder>/.claude/settings.local.json", () => {
	const target = mode.target({ scope: "project", workspaceDir: "C:\\work\\proj", home: "C:\\home" });
	assert.strictEqual(target.scope, "project");
	assert.strictEqual(target.dir, "C:\\work\\proj");
	assert.strictEqual(target.file, path.join("C:\\work\\proj", ".claude", "settings.local.json"));
});

test("target: project scope without a folder has no file, user scope always does", () => {
	const empty = mode.target({ scope: "project", workspaceDir: "", home: "C:\\home" });
	assert.strictEqual(empty.file, null);
	assert.strictEqual(empty.dir, null);

	const user = mode.target({ scope: "user", workspaceDir: "C:\\work\\proj", home: "C:\\home" });
	assert.strictEqual(user.scope, "user");
	assert.strictEqual(user.dir, null);
	assert.strictEqual(user.file, path.join("C:\\home", ".claude", "settings.json"));
});

test("target: CLAUDE_CONFIG_DIR wins over the home directory", () => {
	const target = mode.target({ scope: "user", env: { CLAUDE_CONFIG_DIR: "D:\\cfg" }, home: "C:\\home" });
	assert.strictEqual(target.file, path.join("D:\\cfg", "settings.json"));
	assert.strictEqual(mode.defaultScript({ CLAUDE_CONFIG_DIR: "D:\\cfg" }, "C:\\home"), path.join("D:\\cfg", "deepseek", "claude-ds.mjs"));
});

test("readState: a missing file is off, not an error", () => {
	const state = mode.readState(path.join(tempDir(), "nope.json"));
	assert.deepStrictEqual(
		{ on: state.on, exists: state.exists, error: state.error },
		{ on: false, exists: false, error: null }
	);
});

test("readState: no file at all (project scope without a folder) is off", () => {
	const state = mode.readState(null);
	assert.strictEqual(state.on, false);
	assert.strictEqual(state.exists, false);
});

test("readState: an empty file is off", () => {
	const file = path.join(tempDir(), "settings.local.json");
	write(file, "  \n");
	const state = mode.readState(file);
	assert.strictEqual(state.exists, true);
	assert.strictEqual(state.on, false);
});

test("readState: broken JSON is reported, not thrown", () => {
	const file = path.join(tempDir(), "settings.local.json");
	write(file, "{ not json");
	const state = mode.readState(file);
	assert.strictEqual(state.on, false);
	assert.strictEqual(state.exists, true);
	assert.match(state.error, /not JSON/);
});

test("readState: the DeepSeek base URL is the switch", () => {
	const file = path.join(tempDir(), "settings.local.json");
	write(
		file,
		JSON.stringify({
			env: {
				ANTHROPIC_BASE_URL: mode.BASE_URL,
				ANTHROPIC_MODEL: "deepseek-flash",
				ANTHROPIC_AUTH_TOKEN: "sk-test"
			}
		})
	);
	const state = mode.readState(file);
	assert.strictEqual(state.on, true);
	assert.strictEqual(state.model, "deepseek-flash");
	assert.strictEqual(state.hasToken, true);
	assert.strictEqual(state.error, null);
});

test("readState: a profile with the model but another endpoint is off", () => {
	const file = path.join(tempDir(), "settings.local.json");
	write(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_MODEL: "deepseek-flash" } }));
	const state = mode.readState(file);
	assert.strictEqual(state.on, false);
	assert.strictEqual(state.baseUrl, "https://api.anthropic.com");
});

test("readState: settings without an env block are off", () => {
	const file = path.join(tempDir(), "settings.local.json");
	write(file, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
	assert.strictEqual(mode.readState(file).on, false);
});

function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	return child;
}

test("run: passes the action and folder, and turns Electron into node", async () => {
	const child = fakeChild();
	const calls = [];
	const promise = mode.run(
		"C:\\claude\\claude-ds.mjs",
		"on",
		{
			dir: "C:\\work\\proj",
			execPath: "C:\\Code.exe",
			env: { PATH: "x" },
			spawn: (command, args, options) => {
				calls.push({ command, args, options });
				return child;
			}
		}
	);
	child.stdout.emit("data", "DeepSeek включён\n");
	child.emit("close", 0);
	const result = await promise;
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].command, "C:\\Code.exe");
	assert.deepStrictEqual(calls[0].args, ["C:\\claude\\claude-ds.mjs", "on", "C:\\work\\proj"]);
	assert.strictEqual(calls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
	assert.strictEqual(calls[0].options.cwd, "C:\\work\\proj");
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.code, 0);
	assert.match(result.stdout, /DeepSeek/);
});

test("run: user scope runs without a folder argument", async () => {
	const child = fakeChild();
	const calls = [];
	const promise = mode.run("script.mjs", "off", {
		dir: null,
		spawn: (command, args) => {
			calls.push(args);
			return child;
		}
	});
	child.emit("close", 0);
	await promise;
	assert.deepStrictEqual(calls[0], ["script.mjs", "off"]);
});

test("run: a non-zero exit is a failure with the script's stderr", async () => {
	const child = fakeChild();
	const promise = mode.run("script.mjs", "on", { spawn: () => child });
	child.stderr.emit("data", "claude-ds: не нашёл ключ DeepSeek");
	child.emit("close", 1);
	const result = await promise;
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.code, 1);
	assert.match(result.stderr, /ключ DeepSeek/);
});

test("run: a spawn error resolves instead of throwing", async () => {
	const promise = mode.run("script.mjs", "on", {
		spawn: () => {
			throw new Error("ENOENT");
		}
	});
	const result = await promise;
	assert.strictEqual(result.ok, false);
	assert.match(result.error, /ENOENT/);
});

test("run: the child's error event is reported once", async () => {
	const child = fakeChild();
	const promise = mode.run("script.mjs", "on", { spawn: () => child });
	child.emit("error", new Error("boom"));
	child.emit("close", 1);
	const result = await promise;
	assert.strictEqual(result.ok, false);
	assert.match(result.error, /boom/);
});
