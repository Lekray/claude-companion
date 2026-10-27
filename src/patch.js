// Self-healing patch of the Claude Code extension bundle for tab status markers.
// VS Code gives no extension access to another extension's webview tab titles, so two tiny hooks
// are inserted into Claude's extension.js. Anchors are regular expressions because the bundle is
// minified and local names (`n3`, `$`) change from build to build; the class field names
// (`panelTab`, `applyTabIcon`) are stable.
const fs = require("fs");

const BACKUP_SUFFIX = ".bak-claude-companion";

const UNITS = [
	{
		// Every webview-driven rename of a session tab goes through here; the raw title is kept on
		// the panel host so the companion can re-decorate it whenever the session status changes.
		marker: "__claudeCompanionTabTitle",
		anchor: /this\.panelTab\.title=([\w$]+)\(([\w$]+)\.request\.title\)/g,
		replace: (_m, cap, req) =>
			`this.__ccTitle=${cap}(${req}.request.title),this.panelTab.title=globalThis.__claudeCompanionTabTitle?` +
			"globalThis.__claudeCompanionTabTitle(this,this.__ccTitle):this.__ccTitle"
	},
	{
		// Runs whenever Claude refreshes the tab icon (session bound, state or permissions changed):
		// registers the panel host and lets the companion re-apply the marker.
		marker: "__claudeCompanionTabSeen",
		anchor: /applyTabIcon\(\)\{if\(!this\.panelTab\)return;/g,
		replace: (m) => `${m}globalThis.__claudeCompanionTabSeen&&globalThis.__claudeCompanionTabSeen(this);`
	}
];

// Pure: returns the patched text plus which units were applied, already present or not found.
function applyUnits(text, units = UNITS) {
	let out = String(text);
	const applied = [];
	const present = [];
	const missing = [];
	for (const unit of units) {
		if (out.includes(unit.marker)) {
			present.push(unit.marker);
			continue;
		}
		const matches = out.match(unit.anchor);
		if (!matches || matches.length !== 1) {
			missing.push(unit.marker);
			continue;
		}
		out = out.replace(unit.anchor, unit.replace);
		applied.push(unit.marker);
	}
	return { text: out, applied, present, missing };
}

// Patches the bundle on disk. All-or-nothing: if any anchor is missing nothing is written, so a
// half-patched bundle can never exist. Never throws.
async function patchFile(file, units = UNITS) {
	let src;
	try {
		src = await fs.promises.readFile(file, "utf8");
	} catch (err) {
		return { ok: false, changed: false, error: `cannot read ${file}: ${err && err.message ? err.message : err}` };
	}
	const result = applyUnits(src, units);
	if (result.missing.length) return { ok: false, changed: false, missing: result.missing };
	if (!result.applied.length) return { ok: true, changed: false };
	try {
		// COPYFILE_EXCL keeps the first, pristine backup when one already exists.
		await fs.promises.copyFile(file, file + BACKUP_SUFFIX, fs.constants.COPYFILE_EXCL).catch((err) => {
			if (!err || err.code !== "EEXIST") throw err;
		});
		const tmp = `${file}.tmp-${process.pid}`;
		await fs.promises.writeFile(tmp, result.text, "utf8");
		await fs.promises.rename(tmp, file);
	} catch (err) {
		return { ok: false, changed: false, error: `cannot write ${file}: ${err && err.message ? err.message : err}` };
	}
	return { ok: true, changed: true, applied: result.applied };
}

// Status markers shown in front of the tab title, same notation as kimi-companion.
const STATUS_MARKERS = { working: "[~]", done: "[V]", error: "[!]", waiting: "[?]" };
const MARKER_RE = /^(?:\[~]|\[V]|\[!]|\[\?])\s+/;

// Claude's own title for a tab whose session has no title yet (a new chat).
const UNTITLED_TAB_TITLE = "Claude Code";

function stripMarker(title) {
	return String(title || "").replace(MARKER_RE, "");
}

// `project` (already truncated) replaces every title in mode "always" and only Claude's
// placeholder in mode "untitled"; the raw title itself stays untouched.
function baseTitle(raw, project = "", mode = "untitled") {
	const base = stripMarker(raw);
	if (!project) return base;
	if (mode === "always" || (mode === "untitled" && base === UNTITLED_TAB_TITLE)) return project;
	return base;
}

function decorateTitle(raw, status, enabled = true, project = "", mode = "untitled") {
	const base = baseTitle(raw, project, mode);
	const marker = enabled ? STATUS_MARKERS[status] : null;
	return marker ? `${marker} ${base}` : base;
}

module.exports = {
	BACKUP_SUFFIX,
	UNITS,
	applyUnits,
	patchFile,
	STATUS_MARKERS,
	UNTITLED_TAB_TITLE,
	stripMarker,
	baseTitle,
	decorateTitle
};
