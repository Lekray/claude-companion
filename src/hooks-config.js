// Add and remove our HTTP hook entries in Claude Code's settings.json.
// Pure object transforms are separated from the (atomic) file IO so both are testable offline.
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK_EVENTS = [
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PermissionRequest",
	"Notification",
	"Elicitation",
	"Stop",
	"StopFailure",
	"SessionEnd"
];
const HOOK_PATH = "/claude-companion/v1/event";
// Every hook entry we ever write carries this marker in its URL.
const OUR_URL_MARKER = "/claude-companion/";

function hookUrl(port) {
	return `http://127.0.0.1:${port}${HOOK_PATH}`;
}

function settingsPath(env = process.env, home = os.homedir()) {
	const dir = env && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude");
	return path.join(dir, "settings.json");
}

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
	if (Array.isArray(value)) return value.map(clone);
	if (isPlainObject(value)) {
		const out = {};
		for (const key of Object.keys(value)) out[key] = clone(value[key]);
		return out;
	}
	return value;
}

function message(err) {
	return err && err.message ? err.message : String(err);
}

// A settings entry is a matcher group `{ matcher?, hooks: [...] }`; tolerate flattened variants too.
function isOurs(entry) {
	if (!isPlainObject(entry)) return false;
	if (typeof entry.url === "string" && entry.url.includes(OUR_URL_MARKER)) return true;
	if (!Array.isArray(entry.hooks)) return false;
	return entry.hooks.some((hook) => isPlainObject(hook) && typeof hook.url === "string" && hook.url.includes(OUR_URL_MARKER));
}

function ourEntry(port) {
	return {
		hooks: [
			{
				type: "http",
				url: hookUrl(port),
				timeout: 5,
				headers: {
					"X-Companion-Window": "$CLAUDE_COMPANION_WINDOW",
					"X-Companion-Nested": "$CLAUDECODE"
				},
				allowedEnvVars: ["CLAUDE_COMPANION_WINDOW", "CLAUDECODE"]
			}
		]
	};
}

// Returns a copy of `hooks` with our entries stripped, dropping arrays that become empty.
function stripHooks(hooks) {
	const out = {};
	for (const event of Object.keys(hooks)) {
		const list = hooks[event];
		if (!Array.isArray(list)) {
			out[event] = clone(list);
			continue;
		}
		const kept = list.filter((entry) => !isOurs(entry));
		if (kept.length) out[event] = kept;
	}
	return out;
}

function withHooks(settingsObj, port) {
	if (!isPlainObject(settingsObj)) throw new TypeError("settings must be a JSON object");
	const out = clone(settingsObj);
	let hooks;
	if (out.hooks === undefined) {
		hooks = {};
	} else {
		if (!isPlainObject(out.hooks)) throw new TypeError("settings.hooks must be a JSON object");
		hooks = stripHooks(out.hooks);
	}
	for (const event of HOOK_EVENTS) {
		if (hooks[event] === undefined) hooks[event] = [];
		if (!Array.isArray(hooks[event])) throw new TypeError(`settings.hooks.${event} must be an array`);
		hooks[event].push(ourEntry(port));
	}
	out.hooks = hooks;
	return out;
}

function withoutHooks(settingsObj) {
	if (!isPlainObject(settingsObj)) throw new TypeError("settings must be a JSON object");
	const out = clone(settingsObj);
	if (!isPlainObject(out.hooks)) return out;
	const hooks = stripHooks(out.hooks);
	if (Object.keys(hooks).length) out.hooks = hooks;
	else delete out.hooks;
	return out;
}

function hasCurrentHooks(settingsObj, port) {
	if (!isPlainObject(settingsObj) || !isPlainObject(settingsObj.hooks)) return false;
	const url = hookUrl(port);
	for (const event of HOOK_EVENTS) {
		const list = settingsObj.hooks[event];
		if (!Array.isArray(list)) return false;
		const found = list.some(
			(entry) =>
				isPlainObject(entry) &&
				Array.isArray(entry.hooks) &&
				entry.hooks.some((hook) => isPlainObject(hook) && hook.url === url)
		);
		if (!found) return false;
	}
	return true;
}

function readSettingsFile(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (err && err.code === "ENOENT") return { ok: true, missing: true, settings: {} };
		return { ok: false, error: `cannot read ${file}: ${message(err)}` };
	}
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	if (!text.trim()) return { ok: true, missing: false, settings: {} };
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { ok: false, error: `invalid JSON in ${file}: ${message(err)}` };
	}
	if (!isPlainObject(parsed)) return { ok: false, error: `${file} does not contain a JSON object` };
	return { ok: true, missing: false, settings: parsed };
}

// The .tmp-<pid> suffix keeps concurrent windows from clobbering each other's temp file.
function writeSettingsFile(file, settings) {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// the temp file may not exist if the write itself failed
		}
		throw err;
	}
}

function installHooks(port, file = settingsPath()) {
	const num = Number(port);
	if (!Number.isInteger(num) || num < 1 || num > 65535) {
		return { ok: false, changed: false, error: `invalid port: ${port}` };
	}
	let read;
	try {
		read = readSettingsFile(file);
	} catch (err) {
		return { ok: false, changed: false, error: message(err) };
	}
	if (!read.ok) return { ok: false, changed: false, error: read.error };
	let next;
	try {
		next = withHooks(read.settings, num);
	} catch (err) {
		return { ok: false, changed: false, error: message(err) };
	}
	if (!read.missing && JSON.stringify(next) === JSON.stringify(read.settings)) {
		return { ok: true, changed: false };
	}
	try {
		writeSettingsFile(file, next);
	} catch (err) {
		return { ok: false, changed: false, error: message(err) };
	}
	return { ok: true, changed: true };
}

function removeHooks(file = settingsPath()) {
	let read;
	try {
		read = readSettingsFile(file);
	} catch (err) {
		return { ok: false, changed: false, error: message(err) };
	}
	if (!read.ok) return { ok: false, changed: false, error: read.error };
	if (read.missing) return { ok: true, changed: false };
	let next;
	try {
		next = withoutHooks(read.settings);
	} catch (err) {
		return { ok: false, changed: false, error: message(err) };
	}
	if (JSON.stringify(next) === JSON.stringify(read.settings)) {
		return { ok: true, changed: false };
	}
	try {
		writeSettingsFile(file, next);
	} catch (err) {
		return { ok: false, changed: false, error: message(err) };
	}
	return { ok: true, changed: true };
}

module.exports = {
	HOOK_EVENTS,
	HOOK_PATH,
	hookUrl,
	settingsPath,
	withHooks,
	withoutHooks,
	hasCurrentHooks,
	installHooks,
	removeHooks
};
