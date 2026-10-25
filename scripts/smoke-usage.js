// Manual live check of the usage pipeline: `node scripts/smoke-usage.js`
// Reads the real ~/.claude credentials and DeepSeek key. Prints slot ratios, the balance and the
// ledger spend only — never the OAuth token, the DeepSeek key or the proxy URL.
const usage = require("../src/usage.js");

function pct(ratio) {
	return `${Math.round(ratio * 100)}%`;
}

function reset(slot) {
	if (!slot.resetAt) return "no reset time";
	const d = new Date(slot.resetAt);
	return `resets ${d.toLocaleString()} (${usage.formatDuration(slot.resetAt - Date.now()) || "?"})`;
}

async function main() {
	const cache = await usage.refreshUsage({});
	console.log(`refreshed: ${new Date(cache.at).toLocaleString()}`);
	const claude = cache.claude || {};
	if (claude.ok) {
		for (const slot of claude.slots) {
			console.log(`  ${slot.label.padEnd(10)} ${pct(slot.ratio).padStart(5)}  ${reset(slot)}`);
		}
	} else {
		console.log(`  claude: ${claude.reason || "unknown"}${claude.message ? ` (${claude.message})` : ""}`);
	}
	if (cache.deepseek) {
		const d = cache.deepseek;
		console.log(`deepseek: ${d.total.toFixed(2)} ${d.currency}${d.available ? "" : " (unavailable)"}`);
	} else {
		console.log("deepseek: no key or no answer");
	}
	if (cache.ledger) {
		const { today, week } = cache.ledger;
		console.log(`spend: today $${today.usd.toFixed(4)} (${today.runs} runs) · week $${week.usd.toFixed(4)} (${week.runs} runs)`);
	} else {
		console.log("spend: no ledger");
	}
}

main().catch((err) => {
	console.error(`smoke failed: ${err && err.message ? err.message : err}`);
	process.exitCode = 1;
});
