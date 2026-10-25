// Live-window registry: one small JSON file per VS Code window in <storageDir>/windows/.
// Windows come and go (crashes included), so a reader prunes files whose process is gone.
const fs = require("fs");
const path = require("path");

const WINDOW_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function validWindowId(windowId) {
	return typeof windowId === "string" && WINDOW_ID_RE.test(windowId) && windowId !== "." && windowId !== "..";
}

function windowFile(dir, windowId) {
	return path.join(dir, `${windowId}.json`);
}

function pidAlive(pid) {
	const num = Number(pid);
	if (!Number.isInteger(num) || num <= 0) return false;
	try {
		process.kill(num, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but belongs to someone else.
		return !!err && err.code === "EPERM";
	}
}

// Atomic write, same pattern as the settings file, so a reader never sees a half-written file.
function writeWindowFile(file, info) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n", "utf8");
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// nothing to clean up
		}
		throw err;
	}
}

function normaliseInfo(raw, fallbackId) {
	const folders = Array.isArray(raw.folders) ? raw.folders.filter((f) => typeof f === "string") : [];
	return {
		windowId: typeof raw.windowId === "string" && raw.windowId ? raw.windowId : fallbackId,
		pid: Number(raw.pid) || 0,
		folders,
		startedAt: Number(raw.startedAt) || 0
	};
}

function registerWindow(dir, info) {
	try {
		if (!isPlainObject(info) || !validWindowId(info.windowId)) return false;
		const record = normaliseInfo(
			{
				windowId: info.windowId,
				pid: info.pid === undefined ? process.pid : info.pid,
				folders: info.folders,
				startedAt: info.startedAt === undefined ? Date.now() : info.startedAt
			},
			info.windowId
		);
		writeWindowFile(windowFile(dir, record.windowId), record);
		return true;
	} catch {
		return false;
	}
}

function unregisterWindow(dir, windowId) {
	try {
		if (!validWindowId(windowId)) return false;
		fs.unlinkSync(windowFile(dir, windowId));
		return true;
	} catch {
		return false;
	}
}

function removeFile(file) {
	try {
		fs.unlinkSync(file);
	} catch {
		// already gone
	}
}

function listWindows(dir, isAlive = pidAlive) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const alive = typeof isAlive === "function" ? isAlive : pidAlive;
	const windows = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(dir, name);
		let raw;
		let info;
		try {
			raw = JSON.parse(fs.readFileSync(file, "utf8"));
			if (!isPlainObject(raw) || typeof raw.windowId !== "string" || !Number(raw.pid)) throw new Error("corrupt");
			info = normaliseInfo(raw, name.slice(0, -5));
		} catch {
			// A file we cannot read describes no live window — drop it.
			removeFile(file);
			continue;
		}
		let live;
		try {
			live = alive(info.pid);
		} catch {
			live = false;
		}
		if (!live) {
			removeFile(file);
			continue;
		}
		windows.push(info);
	}
	windows.sort((a, b) => a.startedAt - b.startedAt || a.windowId.localeCompare(b.windowId));
	return windows;
}

// Windows paths are case-insensitive and accept either separator; POSIX paths are neither.
function normalisePath(value, win32) {
	let s = typeof value === "string" ? value : "";
	if (!s) return "";
	if (win32) s = s.replace(/\\/g, "/").toLowerCase();
	if (s === "/") return s;
	s = s.replace(/\/+$/, "");
	// "C:/" collapses to "C:"; the prefix check below re-adds the separator.
	return s;
}

function isPrefix(folder, cwd) {
	if (!folder) return false;
	if (folder === "/") return cwd.startsWith("/");
	return cwd === folder || cwd.startsWith(folder + "/");
}

function ownerForCwd(windows, cwd, platform = process.platform) {
	if (!Array.isArray(windows) || typeof cwd !== "string" || !cwd) return null;
	const win32 = platform === "win32";
	const target = normalisePath(cwd, win32);
	if (!target) return null;
	let best = null;
	let bestLength = -1;
	for (const window of windows) {
		if (!isPlainObject(window) || !Array.isArray(window.folders)) continue;
		for (const folder of window.folders) {
			const normalised = normalisePath(folder, win32);
			if (!isPrefix(normalised, target)) continue;
			if (normalised.length > bestLength) {
				best = window.windowId || null;
				bestLength = normalised.length;
			}
		}
	}
	return best;
}

module.exports = {
	registerWindow,
	unregisterWindow,
	listWindows,
	pidAlive,
	ownerForCwd
};
