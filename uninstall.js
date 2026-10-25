// Runs from the `vscode:uninstall` script. VS Code may start it with any working directory,
// so the module is resolved relative to this file and every failure is swallowed: uninstall
// must always finish with exit code 0.
const path = require("path");

try {
	const { removeHooks } = require(path.join(__dirname, "src", "hooks-config"));
	const result = removeHooks();
	if (result && !result.ok && result.error) console.error(`claude-companion: hooks not removed: ${result.error}`);
} catch (err) {
	console.error(`claude-companion: uninstall failed: ${err && err.message ? err.message : err}`);
}

process.exit(0);
