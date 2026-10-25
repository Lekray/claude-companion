// Leader election + the loopback HTTP receiver. Every window races for the port; the winner
// (the leader) is the only one that receives hook events and mutates the shared state.
const http = require("http");

const EVENT_PATH = "/claude-companion/v1/event";
const CONTROL_PATH = "/claude-companion/v1/control";
const PING_PATH = "/claude-companion/v1/ping";
const HOST = "127.0.0.1";
const MAX_BODY = 1024 * 1024;
const RETRY_MS = 3000;
const CONTROL_TIMEOUT_MS = 2000;

function message(err) {
	return err && err.message ? err.message : String(err);
}

function respond(res, status) {
	try {
		res.writeHead(status, { "Content-Length": "0" });
		res.end();
	} catch {
		// the client may already be gone
	}
}

function respondJson(res, status, value) {
	const body = JSON.stringify(value);
	try {
		res.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": Buffer.byteLength(body)
		});
		res.end(body);
	} catch {
		// the client may already be gone
	}
}

// Parses the request body as JSON, enforcing the 1 MB cap. Calls onJson exactly once on success.
function readJsonBody(req, res, onJson) {
	let chunks = [];
	let size = 0;
	let finished = false;
	req.on("data", (chunk) => {
		if (finished) return;
		size += chunk.length;
		if (size > MAX_BODY) {
			finished = true;
			chunks = [];
			try {
				res.writeHead(413, { "Content-Length": "0" });
				// Destroy only once the 413 is flushed, so the client learns why it was cut off.
				res.end(() => {
					try {
						req.destroy();
					} catch {
						// already destroyed
					}
				});
			} catch {
				// the socket may be gone
			}
			return;
		}
		chunks.push(chunk);
	});
	req.on("end", () => {
		if (finished) return;
		finished = true;
		let parsed;
		try {
			parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			respond(res, 400);
			return;
		}
		onJson(parsed);
	});
	req.on("error", () => {
		finished = true;
	});
}

function header(req, name) {
	const value = req.headers[name];
	return typeof value === "string" ? value : "";
}

function startServer({ port, onEvent, onControl, onRoleChange, log } = {}) {
	const portNumber = Number(port);
	const logLine = (text) => {
		try {
			if (typeof log === "function") log(text);
		} catch {
			// logging must never break the server
		}
	};
	const callLogged = (label, fn, arg) => {
		if (typeof fn !== "function") return;
		try {
			fn(arg);
		} catch (err) {
			logLine(`${label} failed: ${message(err)}`);
		}
	};

	let role = "follower";
	let stopped = false;
	let current = null;
	let retryTimer = null;

	function setRole(next) {
		if (role === next) return;
		role = next;
		callLogged("onRoleChange", onRoleChange, next);
	}

	function scheduleRetry() {
		if (stopped || retryTimer) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			attemptListen();
		}, RETRY_MS);
		if (retryTimer.unref) retryTimer.unref();
	}

	function handle(req, res) {
		const pathname = (req.url || "").split("?")[0];
		if (req.method === "GET" && pathname === PING_PATH) {
			respondJson(res, 200, { app: "claude-companion", pid: process.pid });
			return;
		}
		if (pathname === EVENT_PATH) {
			if (req.method !== "POST") {
				respond(res, 404);
				return;
			}
			readJsonBody(req, res, (input) => {
				const windowId = header(req, "x-companion-window");
				const nested = header(req, "x-companion-nested");
				respond(res, 204);
				// Hook output must never inject anything, so the reply is already sent and empty.
				setImmediate(() => callLogged("onEvent", onEvent, { input, windowId, nested }));
			});
			return;
		}
		if (pathname === CONTROL_PATH) {
			if (req.method !== "POST") {
				respond(res, 404);
				return;
			}
			readJsonBody(req, res, (payload) => {
				respond(res, 204);
				setImmediate(() => callLogged("onControl", onControl, payload));
			});
			return;
		}
		respond(res, 404);
	}

	function attemptListen() {
		if (stopped) return;
		const server = http.createServer((req, res) => {
			try {
				handle(req, res);
			} catch (err) {
				logLine(`request failed: ${message(err)}`);
				try {
					res.destroy();
				} catch {
					// nothing left to close
				}
			}
		});
		current = server;
		server.once("error", (err) => {
			if (current === server) current = null;
			try {
				server.close();
			} catch {
				// the server never started listening
			}
			if (stopped) return;
			if (!err || err.code !== "EADDRINUSE") logLine(`listen failed: ${message(err)}`);
			setRole("follower");
			scheduleRetry();
		});
		server.once("listening", () => {
			if (stopped) {
				try {
					server.close();
				} catch {
					// already closed
				}
				return;
			}
			setRole("leader");
		});
		try {
			server.listen({ port: portNumber, host: HOST });
		} catch (err) {
			logLine(`listen failed: ${message(err)}`);
			if (current === server) current = null;
			setRole("follower");
			scheduleRetry();
		}
	}

	if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
		logLine(`invalid port: ${port}`);
	} else {
		attemptListen();
	}

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			if (retryTimer) {
				clearTimeout(retryTimer);
				retryTimer = null;
			}
			const server = current;
			current = null;
			if (server) {
				try {
					server.close();
				} catch {
					// never started or already closed
				}
			}
			setRole("follower");
		},
		get role() {
			return role;
		},
		get port() {
			return portNumber;
		}
	};
}

// Follower → leader control message. Loopback only: never through an HTTP proxy.
function sendControl(port, payload, timeoutMs = CONTROL_TIMEOUT_MS) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const portNumber = Number(port);
		if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
			done(false);
			return;
		}
		let body;
		try {
			body = JSON.stringify(payload === undefined ? {} : payload);
		} catch {
			done(false);
			return;
		}
		let req;
		try {
			req = http.request(
				{
					host: HOST,
					port: portNumber,
					path: CONTROL_PATH,
					method: "POST",
					timeout: timeoutMs,
					headers: {
						"Content-Type": "application/json; charset=utf-8",
						"Content-Length": Buffer.byteLength(body)
					}
				},
				(res) => {
					res.resume();
					const ok = res.statusCode >= 200 && res.statusCode < 300;
					done(ok);
				}
			);
		} catch {
			done(false);
			return;
		}
		req.on("timeout", () => {
			try {
				req.destroy();
			} catch {
				// already gone
			}
			done(false);
		});
		req.on("error", () => done(false));
		try {
			req.end(body);
		} catch {
			done(false);
		}
	});
}

module.exports = {
	EVENT_PATH,
	CONTROL_PATH,
	PING_PATH,
	MAX_BODY,
	startServer,
	sendControl
};
