// Usage data: Claude subscription limits (OAuth usage endpoint, optionally through an HTTP
// CONNECT proxy), DeepSeek balance and the local spend ledger, plus pure helpers shared with
// the tooltip (pace, alerts, tiny PNG bars). Pure Node — no "vscode" require.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const zlib = require("zlib");

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEFAULT_PROXY_HOST = "api.anthropic.com";
// A token this close to expiry is treated as expired: the request would race the deadline.
const EXPIRY_MARGIN_MS = 30000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// The ledger grows forever; only the last 4 MB (~tens of thousands of runs) can matter.
const LEDGER_TAIL_BYTES = 4 * 1024 * 1024;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// --- Config paths -------------------------------------------------------

function claudeDir(env, home) {
	const custom = env && typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
	return custom || path.join(home, ".claude");
}

function claudeSettingsPath(env = process.env, home = os.homedir()) {
	return path.join(claudeDir(env, home), "settings.json");
}

// Missing or unparsable settings are normal (fresh install); callers just get null.
function readClaudeSettings(env = process.env, home = os.homedir()) {
	try {
		const json = JSON.parse(fs.readFileSync(claudeSettingsPath(env, home), "utf8"));
		return json && typeof json === "object" ? json : null;
	} catch {
		return null;
	}
}

// --- Claude OAuth credentials ------------------------------------------

// Returns { accessToken, expiresAt (epoch ms|null), subscriptionType } or null.
// The token is only ever placed in a request header — never in errors or logs.
function readOauth(env = process.env, home = os.homedir()) {
	let raw;
	try {
		raw = fs.readFileSync(path.join(claudeDir(env, home), ".credentials.json"), "utf8");
	} catch {
		return null;
	}
	let json;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const oauth = json && json.claudeAiOauth;
	if (!oauth || typeof oauth !== "object") return null;
	const accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
	if (!accessToken) return null;
	const expiresAt = Number(oauth.expiresAt);
	return {
		accessToken,
		expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
		subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null
	};
}

// --- Proxy resolution ---------------------------------------------------

function envValue(src, ...keys) {
	if (!src || typeof src !== "object") return "";
	for (const key of keys) {
		const value = src[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function bypassedByNoProxy(list, host) {
	const target = String(host || "").toLowerCase().replace(/\.$/, "");
	if (!target) return false;
	for (let entry of String(list || "").split(",")) {
		entry = entry.trim().toLowerCase();
		if (!entry) continue;
		if (entry === "*") return true;
		entry = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
		entry = entry.replace(/\/.*$/, ""); // path
		entry = entry.replace(/:\d+$/, ""); // port — NO_PROXY entries ignore it
		entry = entry.replace(/^\[|\]$/g, ""); // IPv6 brackets
		entry = entry.replace(/^\*?\./, ""); // leading dot / wildcard
		if (!entry) continue;
		if (target === entry || target.endsWith("." + entry)) return true;
	}
	return false;
}

// override "none" = direct; a non-empty override wins over env and NO_PROXY.
function resolveProxy(env = process.env, claudeSettings = null, override = "", targetHost = DEFAULT_PROXY_HOST) {
	const chosen = typeof override === "string" ? override.trim() : "";
	if (chosen.toLowerCase() === "none") return null;
	if (chosen) return chosen;
	const settingsEnv =
		claudeSettings && claudeSettings.env && typeof claudeSettings.env === "object" ? claudeSettings.env : {};
	const proxy =
		envValue(env, "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy") ||
		envValue(settingsEnv, "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy");
	if (!proxy) return null;
	const noProxy = envValue(env, "NO_PROXY", "no_proxy") || envValue(settingsEnv, "NO_PROXY", "no_proxy");
	return bypassedByNoProxy(noProxy, targetHost) ? null : proxy;
}

// --- HTTP helper --------------------------------------------------------

// Underlying error messages can embed arbitrary text; expose at most the code.
function netError(prefix, err) {
	const code = err && typeof err.code === "string" && err.code ? err.code : "";
	const message = code || (err && typeof err.message === "string" ? err.message.slice(0, 200) : "unknown error");
	return new Error(`${prefix}: ${message}`);
}

function parseProxyUrl(proxy) {
	let raw = String(proxy || "").trim();
	if (!raw) return null;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "http://" + raw;
	let url;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (!url.hostname) return null;
	let auth = null;
	if (url.username) {
		try {
			const user = decodeURIComponent(url.username);
			const pass = decodeURIComponent(url.password);
			auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
		} catch {
			auth = null;
		}
	}
	return { hostname: url.hostname, port: Number(url.port) || 80, auth };
}

// CONNECT tunnel: http.request(CONNECT) -> tls.connect over the raw socket.
function openTunnel(proxy, host, port, hooks = {}) {
	return new Promise((resolve, reject) => {
		const target = parseProxyUrl(proxy);
		if (!target) {
			reject(new Error("invalid proxy URL"));
			return;
		}
		const authority = `${host}:${port}`;
		const headers = { Host: authority };
		if (target.auth) headers["Proxy-Authorization"] = target.auth;
		const req = http.request({
			host: target.hostname,
			port: target.port,
			method: "CONNECT",
			path: authority,
			headers,
			agent: false
		});
		if (hooks.onRequest) hooks.onRequest(req);
		req.once("connect", (res, socket, head) => {
			if (hooks.onSocket) hooks.onSocket(socket);
			if (res.statusCode !== 200) {
				socket.destroy();
				reject(new Error(`proxy CONNECT failed with HTTP ${res.statusCode}`));
				return;
			}
			if (head && head.length) socket.unshift(head);
			const tlsOptions = { socket };
			// SNI must be a hostname; an IP literal would make tls.connect warn or fail.
			if (!net.isIP(host)) tlsOptions.servername = host;
			let tlsSocket;
			try {
				tlsSocket = tls.connect(tlsOptions);
			} catch (err) {
				socket.destroy();
				reject(netError("tunnel failed", err));
				return;
			}
			// A late socket error must never become an uncaught exception; the request reports it.
			tlsSocket.on("error", () => {});
			tlsSocket.once("error", (err) => reject(netError("tunnel TLS failed", err)));
			tlsSocket.once("secureConnect", () => resolve(tlsSocket));
		});
		req.once("error", (err) => reject(netError("proxy connection failed", err)));
		req.end();
	});
}

// GET a URL. Direct, or through an HTTP CONNECT proxy when `proxy` is set.
// Never follows redirects. Resolves { status, json (object|null), text }.
function httpsJson(url, options = {}) {
	const { headers = {}, proxy = null, timeoutMs = 15000 } = options;
	return new Promise((resolve, reject) => {
		let target;
		try {
			target = new URL(url);
		} catch {
			reject(new Error("invalid URL"));
			return;
		}
		let settled = false;
		let timer = null;
		let tunnelReq = null;
		let tunnelSocket = null;
		let activeReq = null;
		const finish = (err, value) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (activeReq) {
				try {
					activeReq.destroy();
				} catch {}
			}
			if (tunnelReq) {
				try {
					tunnelReq.destroy();
				} catch {}
			}
			if (tunnelSocket) {
				try {
					tunnelSocket.destroy();
				} catch {}
			}
			if (err) reject(err);
			else resolve(value);
		};
		timer = setTimeout(() => finish(new Error(`request timed out after ${timeoutMs} ms`)), timeoutMs);
		const send = (socket) => {
			const port = Number(target.port) || 443;
			const hostname = target.hostname.replace(/^\[|\]$/g, "");
			const requestOptions = {
				method: "GET",
				host: hostname,
				port,
				path: target.pathname + target.search,
				headers: { ...headers, Host: target.host }
			};
			if (socket) {
				const agent = new https.Agent({ keepAlive: false });
				agent.createConnection = (opts, cb) => {
					cb(null, socket);
					return socket;
				};
				requestOptions.agent = agent;
			}
			let req;
			try {
				req = https.request(requestOptions, (res) => {
					const chunks = [];
					let size = 0;
					res.on("data", (chunk) => {
						size += chunk.length;
						if (size > MAX_RESPONSE_BYTES) {
							res.destroy();
							finish(new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`));
							return;
						}
						chunks.push(chunk);
					});
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						let json = null;
						try {
							json = JSON.parse(text);
						} catch {
							json = null;
						}
						finish(null, { status: res.statusCode || 0, json, text });
					});
					res.on("aborted", () => finish(new Error("response aborted")));
					res.on("error", (err) => finish(netError("response failed", err)));
				});
			} catch (err) {
				finish(netError("request failed", err));
				return;
			}
			activeReq = req;
			req.on("error", (err) => finish(netError("request failed", err)));
			req.end();
		};
		if (!proxy) {
			send(null);
			return;
		}
		openTunnel(proxy, target.hostname.replace(/^\[|\]$/g, ""), Number(target.port) || 443, {
			onRequest: (req) => {
				tunnelReq = req;
			},
			onSocket: (socket) => {
				tunnelSocket = socket;
			}
		}).then(
			(socket) => {
				tunnelReq = null;
				if (settled) {
					socket.destroy();
					return;
				}
				tunnelSocket = socket;
				send(socket);
			},
			(err) => finish(err)
		);
	});
}

// --- Claude usage -------------------------------------------------------

function toMs(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function clamp01(n) {
	return Math.max(0, Math.min(1, n));
}

// Parses the usage endpoint's JSON into slots ordered 5h, 7d, extras.
function parseClaudeUsage(json, now = Date.now()) {
	const slots = [];
	if (!json || typeof json !== "object") return slots;
	const limits = Array.isArray(json.limits) ? json.limits : [];
	const limitFor = (kind) =>
		limits.find((l) => l && l.kind === kind && typeof l.percent === "number" && Number.isFinite(l.percent)) || null;
	const push = (id, label, minutes, ratio, resetAt) => {
		slots.push({ id, label, ratio: clamp01(ratio), resetAt, durationMinutes: minutes });
	};
	// five_hour/seven_day are the real fields; limits[] is only their fallback.
	const addMain = (key, id, label, minutes, limitKind) => {
		const obj = json[key];
		if (obj && typeof obj === "object" && typeof obj.utilization === "number" && Number.isFinite(obj.utilization)) {
			push(id, label, minutes, obj.utilization / 100, toMs(obj.resets_at));
			return;
		}
		const limit = limitFor(limitKind);
		if (!limit) return;
		push(id, label, minutes, limit.percent / 100, toMs(limit.resets_at));
	};
	addMain("five_hour", "5h", "5h", 300, "session");
	addMain("seven_day", "7d", "7d", 10080, "weekly_all");
	for (const key of Object.keys(json)) {
		if (!key.startsWith("seven_day_")) continue;
		const obj = json[key];
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
		if (typeof obj.utilization !== "number" || !Number.isFinite(obj.utilization)) continue;
		const label = "7d " + key.slice("seven_day_".length).replace(/_/g, " ");
		push(key, label, 10080, obj.utilization / 100, toMs(obj.resets_at));
	}
	return slots;
}

async function fetchClaudeUsage(options = {}) {
	const { env = process.env, home = os.homedir(), proxy = null, timeoutMs = 15000, now = Date.now() } = options;
	const oauth = readOauth(env, home);
	if (!oauth) return { ok: false, slots: [], reason: "no-credentials" };
	if (oauth.expiresAt != null && oauth.expiresAt < now + EXPIRY_MARGIN_MS) {
		return { ok: false, slots: [], reason: "token-expired" };
	}
	let res;
	try {
		res = await httpsJson(USAGE_URL, {
			proxy,
			timeoutMs,
			headers: {
				Authorization: `Bearer ${oauth.accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": "claude-companion",
				Accept: "application/json"
			}
		});
	} catch (err) {
		return { ok: false, slots: [], reason: "network", message: err && err.message ? err.message : "network error" };
	}
	if (res.status === 401) return { ok: false, slots: [], reason: "unauthorized" };
	if (res.status < 200 || res.status >= 300) return { ok: false, slots: [], reason: "http", status: res.status };
	if (!res.json) return { ok: false, slots: [], reason: "bad-response", status: res.status };
	const slots = parseClaudeUsage(res.json, now);
	if (!slots.length) return { ok: false, slots: [], reason: "no-data", status: res.status };
	return { ok: true, slots };
}

// --- DeepSeek -----------------------------------------------------------

function deepseekKeyFromToml(text) {
	let inTable = false;
	for (const raw of String(text || "").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const table = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
		if (table) {
			inTable = table[1].trim() === "providers.deepseek";
			continue;
		}
		if (!inTable) continue;
		const kv = line.match(/^api_key\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/);
		if (kv) return kv[2].trim() || null;
	}
	return null;
}

// $DEEPSEEK_API_KEY -> ~/.claude/secrets/deepseek.json -> ~/.kimi-code/config.toml.
function deepseekApiKey(env = process.env, home = os.homedir()) {
	const fromEnv = env && typeof env.DEEPSEEK_API_KEY === "string" ? env.DEEPSEEK_API_KEY.trim() : "";
	if (fromEnv) return fromEnv;
	try {
		const json = JSON.parse(fs.readFileSync(path.join(home, ".claude", "secrets", "deepseek.json"), "utf8"));
		const key = json && typeof json.api_key === "string" ? json.api_key.trim() : "";
		if (key) return key;
	} catch {}
	try {
		const toml = fs.readFileSync(path.join(home, ".kimi-code", "config.toml"), "utf8");
		const key = deepseekKeyFromToml(toml);
		if (key) return key;
	} catch {}
	return null;
}

async function fetchDeepseekBalance(options = {}) {
	const { env = process.env, home = os.homedir(), key = null, timeoutMs = 15000 } = options;
	const apiKey = key || deepseekApiKey(env, home);
	if (!apiKey) return null;
	try {
		// Balance is fetched directly: a CONNECT proxy would add a failure mode for no gain.
		const res = await httpsJson(BALANCE_URL, {
			proxy: null,
			timeoutMs,
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
		});
		if (res.status !== 200 || !res.json) return null;
		const infos = Array.isArray(res.json.balance_infos) ? res.json.balance_infos : [];
		const info = infos[0];
		if (!info || typeof info !== "object") return null;
		const total = Number(info.total_balance);
		return {
			available: res.json.is_available !== false,
			currency: String(info.currency || "USD").toUpperCase(),
			total: Number.isFinite(total) ? total : 0
		};
	} catch {
		return null;
	}
}

// --- Spend ledger -------------------------------------------------------

// Last ≤ 4 MB of JSONL; the partial first line is dropped. null when unreadable.
function readLedger(file) {
	let fd = null;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return null;
		const start = Math.max(0, stat.size - LEDGER_TAIL_BYTES);
		const length = stat.size - start;
		const buffer = Buffer.alloc(length);
		fd = fs.openSync(file, "r");
		let read = 0;
		while (read < length) {
			const n = fs.readSync(fd, buffer, read, length - read, start + read);
			if (!n) break;
			read += n;
		}
		let text = buffer.subarray(0, read).toString("utf8");
		if (start > 0) {
			const nl = text.indexOf("\n");
			text = nl < 0 ? "" : text.slice(nl + 1);
		}
		const records = [];
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const rec = JSON.parse(trimmed);
				if (rec && typeof rec === "object") records.push(rec);
			} catch {}
		}
		return records;
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
	}
}

function parseLedgerEntry(entry) {
	if (entry && typeof entry === "object") return entry;
	if (typeof entry !== "string") return null;
	try {
		const rec = JSON.parse(entry);
		return rec && typeof rec === "object" ? rec : null;
	} catch {
		return null;
	}
}

function sameLocalDay(a, b) {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// today = current LOCAL calendar day; week = the last 7×24 h, both ends enforced.
function ledgerSpend(lines, now = Date.now()) {
	const today = { usd: 0, runs: 0 };
	const week = { usd: 0, runs: 0 };
	const nowMs = Number(now);
	if (!Number.isFinite(nowMs)) return { today, week };
	const nowDate = new Date(nowMs);
	const weekStart = nowMs - WEEK_MS;
	const list = Array.isArray(lines) ? lines : [];
	for (const entry of list) {
		const rec = parseLedgerEntry(entry);
		if (!rec || (rec.cmd !== "run" && rec.cmd !== "ask")) continue;
		if (typeof rec.usd !== "number" || !Number.isFinite(rec.usd)) continue;
		const ts = typeof rec.ts === "string" ? Date.parse(rec.ts) : NaN;
		if (!Number.isFinite(ts)) continue;
		if (sameLocalDay(new Date(ts), nowDate)) {
			today.usd += rec.usd;
			today.runs++;
		}
		if (ts > weekStart && ts <= nowMs) {
			week.usd += rec.usd;
			week.runs++;
		}
	}
	return { today, week };
}

// --- Pace, alerts, bars (ported from kimi-companion) --------------------

function formatDuration(ms) {
	if (!isFinite(ms) || ms < 0) return null;
	const m = Math.round(ms / 60000);
	if (m < 60) return `${m}m`;
	if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
	return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

function paceInfo(slot, nowMs) {
	if (!slot.resetAt || !slot.durationMinutes) return null;
	const resetMs = new Date(slot.resetAt).getTime();
	if (isNaN(resetMs)) return null;
	const windowMs = slot.durationMinutes * 60000;
	const elapsedMs = nowMs - (resetMs - windowMs);
	if (elapsedMs <= 0 || elapsedMs >= windowMs) return null;
	const pace = slot.ratio / (elapsedMs / windowMs); // 1.0 = exactly on track
	let depletesInMs = null;
	if (slot.ratio > 0 && slot.ratio < 1) {
		const t = (1 - slot.ratio) / (slot.ratio / elapsedMs);
		if (nowMs + t < resetMs) depletesInMs = t;
	}
	return { pace, depletesInMs, resetInMs: resetMs - nowMs };
}

// Thresholds are fractions 0..1; a percent typed by hand (80) is read as 0.8 instead of
// silently disabling the alert and the red highlight.
function fractionSetting(value, fallback) {
	let n = Number(value);
	if (!isFinite(n) || n < 0) return fallback;
	if (n > 1) n = n <= 100 ? n / 100 : 1;
	return n;
}

function paceLabel(pace) {
	return pace >= 1.25 ? "fast" : pace >= 0.8 ? "normal" : pace > 0.01 ? "slow" : "idle";
}

function paceSummary(slot, nowMs, hotThreshold = 0.8) {
	const info = paceInfo(slot, nowMs);
	if (!info) return null;
	const label = paceLabel(info.pace);
	const parts = [`pace ${label}`];
	if (info.depletesInMs != null) parts.push(`depletes in ~${formatDuration(info.depletesInMs)}`);
	else parts.push(`on track (~${Math.min(999, Math.round(info.pace * 100))}% by reset)`);
	parts.push(`resets in ${formatDuration(info.resetInMs)}`);
	// Only the raw ratio paints the bar hot; a fast pace never flips the colour early.
	const hot = slot.durationMinutes <= 1440 && slot.ratio >= fractionSetting(hotThreshold, 0.8);
	return {
		text: parts.join(" · "),
		hot,
		pace: info.pace,
		label,
		depletesInMs: info.depletesInMs,
		resetInMs: info.resetInMs
	};
}

// Pure: returns the alerts to show and a NEW latch. Slots are latched per reset window, so a
// fresh resetAt fires again; DeepSeek re-arms once the balance recovers to 1.5× the threshold.
const RESET_TOLERANCE_MS = 5 * 60 * 1000;

function sameResetWindow(a, b) {
	return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < RESET_TOLERANCE_MS;
}

function computeAlerts(slots, deepseek, cfg, latch) {
	const config = cfg && typeof cfg === "object" ? cfg : {};
	const state = { ...(latch && typeof latch === "object" ? latch : {}) };
	if (config.alerts === false) return { alerts: [], latch: state };
	const t5h = fractionSetting(config.threshold5h, 0.8);
	const t7d = fractionSetting(config.threshold7d, 0.9);
	const belowRaw = Number(config.deepseekBelowUsd);
	const below = Number.isFinite(belowRaw) && belowRaw >= 0 ? belowRaw : 1;
	const alerts = [];
	const list = Array.isArray(slots) ? slots : [];
	const fire = (kind, slot) => {
		const window = slot.resetAt != null ? slot.resetAt : "?";
		// The API's resets_at jitters by fractions of a second between calls (18:49:59.96 vs
		// 18:50:00.35): the same window must not re-fire the alert on every refresh.
		if (state[kind] === window || sameResetWindow(state[kind], window)) return;
		state[kind] = window;
		const alert = { key: kind, kind, ratio: slot.ratio };
		if (slot.resetAt != null) alert.resetAt = slot.resetAt;
		alerts.push(alert);
	};
	const fiveHour = list.find((s) => s && s.id === "5h");
	if (fiveHour && typeof fiveHour.ratio === "number" && fiveHour.ratio >= t5h) fire("5h", fiveHour);
	const sevenDay = list.find((s) => s && s.id === "7d");
	if (sevenDay && typeof sevenDay.ratio === "number" && sevenDay.ratio >= t7d) fire("7d", sevenDay);
	if (deepseek && typeof deepseek === "object" && deepseek.available !== false) {
		const total = Number(deepseek.total);
		if (Number.isFinite(total)) {
			if (total < below) {
				if (state.deepseek !== "low") {
					state.deepseek = "low";
					alerts.push({
						key: "deepseek",
						kind: "deepseek",
						total,
						currency: typeof deepseek.currency === "string" && deepseek.currency ? deepseek.currency : "USD"
					});
				}
			} else if (state.deepseek && total >= below * 1.5) {
				delete state.deepseek;
			}
		}
	}
	return { alerts, latch: state };
}

let crcTable = null;
function crc32(buf) {
	if (typeof zlib.crc32 === "function") return Number(zlib.crc32(buf) >>> 0);
	if (!crcTable) {
		crcTable = new Int32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c;
		}
	}
	let c = ~0;
	for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 255];
	return (~c) >>> 0;
}

function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}

function barPngDataUri(ratio, hot) {
	const W = 260;
	const H = 8;
	const r = Math.max(0, Math.min(1, ratio));
	const fg = hot ? [0xe5, 0x4a, 0x4a] : [0x2f, 0x81, 0xd6];
	const bg = [0x42, 0x45, 0x4a];
	const fillPx = Math.round(W * r);
	const raw = Buffer.alloc(H * (1 + W * 4));
	for (let y = 0; y < H; y++) {
		const ro = y * (1 + W * 4);
		for (let x = 0; x < W; x++) {
			const c = x < fillPx ? fg : bg;
			const o = ro + 1 + x * 4;
			raw[o] = c[0];
			raw[o + 1] = c[1];
			raw[o + 2] = c[2];
			raw[o + 3] = 255;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(W, 0);
	ihdr.writeUInt32BE(H, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlib.deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0))
	]);
	return "data:image/png;base64," + png.toString("base64");
}

// --- Cache + refresh ----------------------------------------------------

function loadUsageCache(file) {
	try {
		const cache = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!cache || typeof cache !== "object" || !Number.isFinite(cache.at)) return null;
		return cache;
	} catch {
		return null;
	}
}

function saveUsageCache(file, cache) {
	const tmp = `${file}.tmp`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", "utf8");
		try {
			fs.renameSync(tmp, file);
		} catch {
			// Windows can refuse the replace while another window has the file open; retry once.
			try {
				fs.rmSync(file, { force: true });
			} catch {}
			fs.renameSync(tmp, file);
		}
		return true;
	} catch {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {}
		return false;
	}
}

// Last good data older than this is dropped instead of shown as stale.
const STALE_KEEP_MS = 2 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;

// A failed refresh (429 while several windows start at once, a proxy hiccup) must not wipe the
// last good numbers: they are kept, marked by `ok: false` + `okAt`, until they get too old.
function mergeUsageCache(prev, next) {
	if (!next || typeof next !== "object") return next;
	const out = Object.assign({}, next);
	const now = Number(next.at) || Date.now();
	const prevOkAt = prev && prev.claude ? Number(prev.claude.okAt) || (prev.claude.ok ? Number(prev.at) : 0) : 0;
	// HTTP 429 is shared by every window and by Claude Code itself: back off 5, 10, 20, 30 min.
	if (out.claude && !out.claude.ok && out.claude.reason === "http" && Number(out.claude.status) === 429) {
		const fails = (prev && prev.claude && Number(prev.claude.failCount)) || 0;
		const failCount = fails + 1;
		out.claude = Object.assign({}, out.claude, {
			failCount,
			retryAt: now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failCount - 1))
		});
	}
	if (out.claude && out.claude.ok) {
		out.claude = Object.assign({}, out.claude, { okAt: now });
	} else if (prevOkAt && now - prevOkAt < STALE_KEEP_MS && Array.isArray(prev.claude.slots) && prev.claude.slots.length) {
		out.claude = Object.assign({}, out.claude || { ok: false, reason: "error" }, { slots: prev.claude.slots, okAt: prevOkAt });
	}
	if (!out.deepseek && prev && prev.deepseek && now - (Number(prev.at) || 0) < STALE_KEEP_MS) out.deepseek = prev.deepseek;
	return out;
}

// When a 429 backoff is in force, the time the next automatic attempt is allowed; else 0.
function retryAfter(cache, now = Date.now()) {
	const at = cache && cache.claude ? Number(cache.claude.retryAt) : 0;
	return Number.isFinite(at) && at > now ? at : 0;
}

// True when another window already refreshed recently enough with a successful Claude answer.
function isFreshUsage(cache, maxAgeMs, now = Date.now()) {
	return !!(cache && cache.claude && cache.claude.ok && Number.isFinite(cache.at) && now - cache.at < maxAgeMs);
}

// Never throws and never logs secrets: every source is best-effort and lands as null.
async function refreshUsage(options = {}) {
	const { env = process.env, home = os.homedir(), proxyOverride = "", timeoutMs = 15000, file = null } = options;
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	let claude = { ok: false, slots: [], reason: "error" };
	let deepseek = null;
	let ledger = null;
	try {
		const settings = readClaudeSettings(env, home);
		const proxy = resolveProxy(env, settings, proxyOverride);
		const key = deepseekApiKey(env, home);
		const results = await Promise.allSettled([
			fetchClaudeUsage({ env, home, proxy, timeoutMs, now }),
			key ? fetchDeepseekBalance({ key, timeoutMs }) : Promise.resolve(null),
			Promise.resolve().then(() => {
				const records = readLedger(path.join(home, ".claude", "deepseek-ledger.jsonl"));
				return records ? ledgerSpend(records, now) : null;
			})
		]);
		if (results[0].status === "fulfilled" && results[0].value) claude = results[0].value;
		if (results[1].status === "fulfilled" && results[1].value) deepseek = results[1].value;
		if (results[2].status === "fulfilled" && results[2].value) ledger = results[2].value;
	} catch {
		// A background refresh must never take the extension down.
	}
	const cache = mergeUsageCache(file ? loadUsageCache(file) : null, { at: now, claude, deepseek, ledger });
	if (file) saveUsageCache(file, cache);
	return cache;
}

module.exports = {
	USAGE_URL,
	BALANCE_URL,
	LEDGER_TAIL_BYTES,
	claudeDir,
	claudeSettingsPath,
	readClaudeSettings,
	readOauth,
	resolveProxy,
	httpsJson,
	parseClaudeUsage,
	fetchClaudeUsage,
	deepseekApiKey,
	fetchDeepseekBalance,
	readLedger,
	ledgerSpend,
	formatDuration,
	paceInfo,
	fractionSetting,
	paceLabel,
	paceSummary,
	computeAlerts,
	crc32,
	pngChunk,
	barPngDataUri,
	loadUsageCache,
	saveUsageCache,
	mergeUsageCache,
	isFreshUsage,
	retryAfter,
	refreshUsage
};
