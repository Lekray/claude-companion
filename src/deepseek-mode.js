// DeepSeek routing (`claude-ds`) for the companion UI.
//
// The companion never writes Claude Code's settings itself: the API key, the backup files and the
// `.gitignore` guard all live in the `claude-ds` script, so the secret keeps exactly one owner.
// This module only reads the resulting settings file to show the state and runs the script for
// `on` / `off`.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// DeepSeek's Anthropic-compatible endpoint — the value `claude-ds` writes into `ANTHROPIC_BASE_URL`.
const BASE_URL = "https://api.deepseek.com/anthropic";
const MAX_OUTPUT = 8192;

function text(value) {
	return value && value.message ? value.message : String(value);
}

function claudeDir(env = process.env, home = os.homedir()) {
	const configured = env && typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
	return configured || path.join(home, ".claude");
}

function defaultScript(env = process.env, home = os.homedir()) {
	return path.join(claudeDir(env, home), "deepseek", "claude-ds.mjs");
}

// `project` is <folder>/.claude/settings.local.json — the file `claude-ds on <folder>` writes.
// `user` is <claude-dir>/settings.json — what `claude-ds on --user` writes.
function target(options = {}) {
	const { scope = "project", workspaceDir = "", env = process.env, home = os.homedir() } = options;
	if (scope === "user") {
		return { scope: "user", dir: null, file: path.join(claudeDir(env, home), "settings.json") };
	}
	const dir = String(workspaceDir || "");
	return {
		scope: "project",
		dir: dir || null,
		file: dir ? path.join(dir, ".claude", "settings.local.json") : null
	};
}

// Never throws: a missing file is "off", an unreadable one is "off" plus the reason.
function readState(file) {
	const empty = { on: false, exists: false, baseUrl: "", model: "", hasToken: false, error: null };
	if (!file) return empty;
	let source;
	try {
		source = fs.readFileSync(file, "utf8");
	} catch (err) {
		// ENOENT is the normal "nothing set up yet", not an error worth showing.
		return { ...empty, error: err && err.code === "ENOENT" ? null : text(err) };
	}
	if (!source.trim()) return { ...empty, exists: true };
	let settings;
	try {
		settings = JSON.parse(source);
	} catch (err) {
		return { ...empty, exists: true, error: `not JSON: ${text(err)}` };
	}
	const env =
		settings && typeof settings === "object" && settings.env && typeof settings.env === "object"
			? settings.env
			: {};
	const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL.trim() : "";
	const model = typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL.trim() : "";
	const token = typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN.trim() : "";
	// The base URL is the switch: a profile without it never reaches DeepSeek, however many of the
	// other keys happen to be there.
	return { on: baseUrl === BASE_URL, exists: true, baseUrl, model, hasToken: token !== "", error: null };
}

// Runs `<script> <action> [dir]`. The script is an ES module, and from the extension host
// `process.execPath` is the Electron binary itself — ELECTRON_RUN_AS_NODE makes it behave as node,
// which is why the command does not depend on node being on PATH.
function run(script, action, options = {}) {
	const spawnImpl = options.spawn || spawn;
	const execPath = options.execPath || process.execPath;
	const dir = options.dir || null;
	const env = { ...(options.env || process.env), ELECTRON_RUN_AS_NODE: "1" };
	const args = [script, action].concat(dir ? [dir] : []);
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnImpl(execPath, args, {
				cwd: dir || undefined,
				env,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"]
			});
		} catch (err) {
			resolve({ ok: false, code: null, stdout: "", stderr: "", error: text(err) });
			return;
		}
		let stdout = "";
		let stderr = "";
		const collect = (buffer, chunk) => (buffer + String(chunk)).slice(0, MAX_OUTPUT);
		if (child.stdout) child.stdout.on("data", (chunk) => (stdout = collect(stdout, chunk)));
		if (child.stderr) child.stderr.on("data", (chunk) => (stderr = collect(stderr, chunk)));
		let settled = false;
		const done = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		child.on("error", (err) =>
			done({ ok: false, code: null, stdout: stdout.trim(), stderr: stderr.trim(), error: text(err) })
		);
		child.on("close", (code) =>
			done({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim(), error: null })
		);
	});
}

module.exports = { BASE_URL, MAX_OUTPUT, claudeDir, defaultScript, target, readState, run };
