"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const patch = require(path.join(__dirname, "..", "src", "patch.js"));

// Shaped like the minified Claude Code 2.1.301 bundle around both anchors.
const SAMPLE =
	'class P{async processRequest($,J){if($.request.type==="rename_tab"){if(this.panelTab&&typeof $.request.title==="string")' +
	"this.panelTab.title=n3($.request.title),this.lastRenameTabFlags={a:1},this.applyTabIcon();" +
	'return{type:"rename_tab_response"}}}applyTabIcon(){if(!this.panelTab)return;this.icon="x"}}';

test("applyUnits patches both anchors once and is idempotent", () => {
	const first = patch.applyUnits(SAMPLE);
	assert.deepEqual(first.applied, ["__claudeCompanionTabTitle", "__claudeCompanionTabSeen"]);
	assert.deepEqual(first.missing, []);
	const second = patch.applyUnits(first.text);
	assert.deepEqual(second.applied, []);
	assert.deepEqual(second.present, ["__claudeCompanionTabTitle", "__claudeCompanionTabSeen"]);
	assert.equal(second.text, first.text);
});

test("anchors survive renamed minified locals", () => {
	const renamed = SAMPLE.replaceAll("n3(", "zQ(").replaceAll("$.request", "_a.request");
	const res = patch.applyUnits(renamed);
	assert.deepEqual(res.missing, []);
	assert.match(res.text, /this\.__ccTitle=zQ\(_a\.request\.title\)/);
});

test("a missing or ambiguous anchor is reported, never half-applied by patchFile", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-patch-"));
	const file = path.join(dir, "extension.js");
	const broken = SAMPLE.replace("applyTabIcon(){if(!this.panelTab)return;", "applyTabIcon(){");
	fs.writeFileSync(file, broken);
	const res = await patch.patchFile(file);
	assert.equal(res.ok, false);
	assert.deepEqual(res.missing, ["__claudeCompanionTabSeen"]);
	assert.equal(fs.readFileSync(file, "utf8"), broken);
	assert.equal(fs.existsSync(file + patch.BACKUP_SUFFIX), false);

	const twice = SAMPLE + SAMPLE;
	assert.deepEqual(patch.applyUnits(twice).missing, ["__claudeCompanionTabTitle", "__claudeCompanionTabSeen"]);
});

test("patchFile writes once, keeps the pristine backup and reports already patched", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-patch-"));
	const file = path.join(dir, "extension.js");
	fs.writeFileSync(file, SAMPLE);
	const first = await patch.patchFile(file);
	assert.equal(first.ok, true);
	assert.equal(first.changed, true);
	assert.equal(fs.readFileSync(file + patch.BACKUP_SUFFIX, "utf8"), SAMPLE);
	const second = await patch.patchFile(file);
	assert.deepEqual(second, { ok: true, changed: false });
});

test("patched code calls the companion hooks and falls back without them", () => {
	const code = patch.applyUnits(SAMPLE).text;
	const run = (globals) => {
		const ctx = vm.createContext(Object.assign({}, globals));
		ctx.globalThis = ctx;
		vm.runInContext(`${code}; var host = new P(); host.panelTab = { title: "" }; function n3(t) { return t; }`, ctx);
		vm.runInContext('host.processRequest({ request: { type: "rename_tab", title: "Fix parser" } })', ctx);
		return ctx;
	};
	const plain = run({});
	assert.equal(plain.host.panelTab.title, "Fix parser");
	assert.equal(plain.host.__ccTitle, "Fix parser");

	const seen = [];
	const hooked = run({
		__claudeCompanionTabTitle: (h, raw) => `[~] ${raw}`,
		__claudeCompanionTabSeen: (h) => seen.push(h)
	});
	assert.equal(hooked.host.panelTab.title, "[~] Fix parser");
	assert.equal(seen.length, 1);
});

test("decorateTitle and stripMarker", () => {
	assert.equal(patch.decorateTitle("Fix parser", "working"), "[~] Fix parser");
	assert.equal(patch.decorateTitle("[~] Fix parser", "done"), "[V] Fix parser");
	assert.equal(patch.decorateTitle("[?] Fix parser", "idle"), "Fix parser");
	assert.equal(patch.decorateTitle("Fix parser", "error", false), "Fix parser");
	assert.equal(patch.stripMarker("[!] x"), "x");
	assert.equal(patch.stripMarker("[x] y"), "[x] y");
});
