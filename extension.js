// Claude Code Companion — the VS Code integration layer: activation, status bar, tooltip, menu,
// commands, sounds, notifications and i18n. All transport/session/usage logic is pure Node in src/.
const vscode = require("vscode");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const deepseekMode = require("./src/deepseek-mode");
const hooksConfig = require("./src/hooks-config");
const registry = require("./src/registry");
const server = require("./src/server");
const sessions = require("./src/sessions");
const usage = require("./src/usage");
const patch = require("./src/patch");

const CLAUDE_EXT_ID = "anthropic.claude-code";
const OPEN_COMMAND = "claude-vscode.editor.open";
const WINDOW_ID_KEY = "claudeCompanion.windowId";
const ALERT_LATCH_KEY = "claudeCompanion.alertLatch";
const REPORT_SCHEME = "claude-companion";
const USAGE_URI = "claude-companion://report/Usage.txt";
const DIAG_URI = "claude-companion://report/Diagnostics.txt";
const STATE_FILE = "state.json";
const USAGE_FILE = "usage.json";
const WINDOWS_DIR = "windows";
const DEFAULT_PORT = 47823;

const SAVE_COALESCE_MS = 100;
const WATCH_DEBOUNCE_MS = 60;
const POLL_MS = 1000;
const PRUNE_MS = 60000;
const USAGE_REFRESH_MS = 5 * 60 * 1000;
const USAGE_START_DELAY_MS = 3000;
const USAGE_START_JITTER_MS = 12000;
const DONE_REFRESH_MIN_MS = 90000;
const SOUND_GAP_MS = 1500;
const TEST_SOUND_GAP_MS = 900;
const STATUS_TICK_MS = 1000;
const TOOLTIP_TITLE_MAX = 80;
const REPORT_TITLE_MAX = 60;

const ICON = "$(claude-companion-logo)";
const STATUS_ICONS = {
	working: "$(sync~spin)",
	waiting: "$(question)",
	done: "$(check)",
	error: "$(error)",
	idle: "$(circle-outline)"
};

const SOUND_FILES = {
	done: path.join(__dirname, "resources", "done.wav"),
	waiting: path.join(__dirname, "resources", "waiting.wav"),
	error: path.join(__dirname, "resources", "error.wav")
};
// The file travels in an env var on Windows: a quoted path inside -Command is easy to get wrong.
const SOUND_COMMAND = {
	win32: [
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-WindowStyle",
			"Hidden",
			"-Command",
			"$s=New-Object System.Media.SoundPlayer($env:CLAUDE_COMPANION_SOUND); $s.PlaySync()"
		]
	],
	darwin: ["/usr/bin/afplay", []],
	linux: ["paplay", []]
};

// --- i18n ---------------------------------------------------------------

function pluralEn(n, one, many) {
	return n === 1 ? one : many;
}

function pluralRu(n, one, few, many) {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 === 1 && mod100 !== 11) return one;
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
	return many;
}

const STR = {
	en: {
		open: "Open",
		untitled: "Untitled session",
		heading: "Claude Code Companion",
		states: { working: "working", waiting: "waiting", done: "done", error: "error", idle: "idle" },
		reasons: { permission: "permission", question: "question", plan: "plan", input: "input" },
		waitingFor: (reason) => `waiting for ${reason}`,
		ago: (duration) => `${duration} ago`,
		others: (n) => `${n} ${pluralEn(n, "session", "sessions")} in other windows`,
		pace: "pace",
		paceLabels: { fast: "fast", normal: "normal", slow: "slow", idle: "idle" },
		paceOnTrack: (pct) => `on track (~${pct}% by reset)`,
		paceDepletes: (duration) => `runs out in ~${duration}`,
		paceResets: (duration) => `resets in ${duration}`,
		resets: "resets",
		noUsageYet: "Claude usage not fetched yet",
		usageHttp: (status) =>
			status === 429 ? "Claude limits endpoint is rate limited (HTTP 429)" : `Claude usage request failed (HTTP ${status})`,
		usageNetwork: "Claude usage request failed — network or proxy unavailable",
		usageStale: (time) => `Showing data from ${time}`,
		usageRetry: (time) => `next attempt at ${time}`,
		patchReload: "Claude Code Companion patched the Claude Code tabs (status markers, project names) — reload the window to see them.",
		reloadWindow: "Reload Window",
		patchFailed: (v) => `Claude Code Companion: tab status markers and project names are unavailable for Claude Code ${v} (its code changed). Everything else keeps working.`,
		tabMarkersLabel: "Tab markers",
		tabsTracked: (n) => `${n} tab(s) tracked`,
		tokenExpired: "Claude login token expired — it refreshes when Claude Code is next used",
		noCredentials: "No Claude login found — sign in to Claude Code",
		unauthorized: "Claude usage request was rejected — sign in to Claude Code",
		usageFailed: (reason) => `Claude usage unavailable (${reason})`,
		deepseek: "DeepSeek",
		deepseekUnavailable: "unavailable",
		today: "today",
		days7: "7 days",
		runs: (n) => `${n} ${pluralEn(n, "run", "runs")}`,
		usageReport: "Usage report",
		refresh: "Refresh",
		diagnostics: "Diagnostics",
		contextWarning: (title, tokens) =>
			`Context of «${title}» is ${tokens} tokens — consider starting a fresh session`,
		doneNotice: (title) => `Claude finished «${title}»`,
		waitingNotice: (title) => `Claude is waiting for you in «${title}»`,
		errorNotice: (title) => `Claude stopped with an error in «${title}»`,
		alert5h: (pct, reset) => `Claude 5-hour limit at ${pct}% — resets ${reset}`,
		alert7d: (pct, reset) => `Claude weekly limit at ${pct}% — resets ${reset}`,
		alertDeepseek: (amount) => `DeepSeek balance is low: ${amount}`,
		hookInstallFailed: (error) => `Claude Code Companion could not install hooks: ${error}`,
		hookRemoveFailed: (error) => `Claude Code Companion could not remove hooks: ${error}`,
		hooksInstalled: "Claude Code hooks installed.",
		hooksRemoved: "Claude Code hooks removed.",
		hooksRemovedManaged:
			'Hooks removed. They come back on the next start while "Manage Hooks" is on — turn that setting off to keep them removed.',
		menuOtherWindows: "Other windows",
		menuNewSession: "New Claude session",
		menuRefresh: "Refresh limits",
		menuUsage: "Usage report",
		menuSounds: "Test sounds",
		menuDiagnostics: "Diagnostics",
		sessionElsewhere: "This session is open in another VS Code window.",
		claudeMissing: "The Claude Code extension (anthropic.claude-code) is not installed.",
		openFailed: "Could not open the Claude session.",
		weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
		diagTitle: "Claude Code Companion — diagnostics",
		updated: "Updated",
		versions: "Versions",
		vscodeVersion: "VS Code",
		companionVersion: "companion",
		claudeExtension: "anthropic.claude-code",
		notInstalled: "not installed",
		windowSection: "Window",
		roleLabel: "role",
		leader: "leader",
		follower: "follower",
		portLabel: "port",
		hooksInstalledLabel: "hooks installed",
		settingsFileLabel: "settings file",
		yes: "yes",
		no: "no",
		unknown: "unknown",
		liveWindows: (n) => `Live windows (${n})`,
		none: "none",
		foldersLabel: "folders",
		sessionsSummary: (total, c) =>
			`Sessions (${total}: working ${c.working}, waiting ${c.waiting}, done ${c.done}, error ${c.error}, idle ${c.idle})`,
		ownerLabel: "owner",
		statusLabel: "status",
		titleLabel: "title",
		lastEventLabel: "lastEvent",
		usageSection: "Usage",
		lastFetchLabel: "last fetch",
		never: "never",
		proxyLabel: "proxy",
		direct: "direct (no proxy)",
		soundSection: "Sound",
		soundUnavailable: "no sound player for this platform",
		soundAvailable: (command) => `player: ${command}`,
		soundFiles: (files) => `files: ${files}`,
		missing: "missing",
		reportTitle: "Claude Code Companion — usage",
		fetched: "Fetched",
		claudeLimits: "Claude limits",
		noLimitData: "The usage response contains no limit data.",
		usageRequestFailed: (reason) => `Claude usage request failed: ${reason}`,
		deepseekSection: "DeepSeek",
		balance: "Balance",
		deepseekRouting: "DeepSeek routing",
		deepseekSwitchedOn: "DeepSeek is on — new Claude chats go through api.deepseek.com.",
		deepseekSwitchedOff: "DeepSeek is off — new Claude chats use the Claude subscription.",
		deepseekToggleHint: "Turn the DeepSeek routing on or off for new chats",
		deepseekOn: "on",
		deepseekOff: "off",
		deepseekNote: "applies to new chats",
		deepseekNoWorkspace:
			'Open a folder to switch DeepSeek for this project, or set "claudeCompanion.deepseekScope" to "user".',
		deepseekScriptMissing: (file) =>
			`claude-ds was not found at ${file}. Set "claudeCompanion.deepseekScript" to its path.`,
		deepseekFailed: (action, detail) => `claude-ds ${action} failed: ${detail}`,
		deepseekScopeProject: "project",
		deepseekScopeUser: "all projects",
		deepseekTargetLabel: "target",
		deepseekScriptLabel: "claude-ds"
	},
	ru: {
		open: "Открыть",
		untitled: "Сессия без названия",
		heading: "Claude Code Companion",
		states: { working: "работа", waiting: "ожидание", done: "готово", error: "ошибка", idle: "простой" },
		reasons: { permission: "разрешение", question: "ответ", plan: "план", input: "ввод" },
		waitingFor: (reason) => `ожидает: ${reason}`,
		ago: (duration) => `${duration} назад`,
		others: (n) => `${n} ${pluralRu(n, "сессия", "сессии", "сессий")} в других окнах`,
		pace: "темп",
		paceLabels: { fast: "быстрый", normal: "обычный", slow: "медленный", idle: "простой" },
		paceOnTrack: (pct) => `в графике (~${pct}% к сбросу)`,
		paceDepletes: (duration) => `исчерпание через ~${duration}`,
		paceResets: (duration) => `сброс через ${duration}`,
		resets: "сброс",
		noUsageYet: "Лимиты Claude ещё не получены",
		usageHttp: (status) =>
			status === 429
				? "Сервер лимитов Claude ограничил частоту запросов (HTTP 429)"
				: `Не удалось получить лимиты Claude (HTTP ${status})`,
		usageNetwork: "Не удалось получить лимиты Claude — нет сети или прокси недоступен",
		usageStale: (time) => `Показаны данные на ${time}`,
		usageRetry: (time) => `следующая попытка в ${time}`,
		patchReload: "Claude Code Companion доработал вкладки Claude Code (статусы, имя проекта) — перезагрузите окно, чтобы их увидеть.",
		reloadWindow: "Перезагрузить окно",
		patchFailed: (v) => `Claude Code Companion: статусы и имя проекта во вкладках недоступны для Claude Code ${v} (изменился его код). Остальное работает.`,
		tabMarkersLabel: "Статусы во вкладках",
		tabsTracked: (n) => `отслеживается вкладок: ${n}`,
		tokenExpired: "Токен входа Claude истёк — он обновится при следующем использовании Claude Code",
		noCredentials: "Вход в Claude не найден — войдите в Claude Code",
		unauthorized: "Запрос лимитов Claude отклонён — войдите в Claude Code",
		usageFailed: (reason) => `Лимиты Claude недоступны (${reason})`,
		deepseek: "DeepSeek",
		deepseekUnavailable: "недоступен",
		today: "сегодня",
		days7: "7 дней",
		runs: (n) => `${n} ${pluralRu(n, "запуск", "запуска", "запусков")}`,
		usageReport: "Отчёт по лимитам",
		refresh: "Обновить",
		diagnostics: "Диагностика",
		contextWarning: (title, tokens) =>
			`Контекст «${title}» — ${tokens} токенов; стоит начать новую сессию`,
		doneNotice: (title) => `Claude завершил работу: «${title}»`,
		waitingNotice: (title) => `Claude ждёт вас: «${title}»`,
		errorNotice: (title) => `Claude остановился с ошибкой: «${title}»`,
		alert5h: (pct, reset) => `5-часовой лимит Claude на ${pct}% — сброс ${reset}`,
		alert7d: (pct, reset) => `Недельный лимит Claude на ${pct}% — сброс ${reset}`,
		alertDeepseek: (amount) => `Баланс DeepSeek низкий: ${amount}`,
		hookInstallFailed: (error) => `Не удалось установить хуки Claude Code Companion: ${error}`,
		hookRemoveFailed: (error) => `Не удалось удалить хуки Claude Code Companion: ${error}`,
		hooksInstalled: "Хуки Claude Code установлены.",
		hooksRemoved: "Хуки Claude Code удалены.",
		hooksRemovedManaged:
			"Хуки удалены. При включённой настройке «Управлять хуками» они вернутся при следующем запуске — отключите её, чтобы они остались удалёнными.",
		menuOtherWindows: "Другие окна",
		menuNewSession: "Новая сессия Claude",
		menuRefresh: "Обновить лимиты",
		menuUsage: "Отчёт по лимитам",
		menuSounds: "Проверить звуки",
		menuDiagnostics: "Диагностика",
		sessionElsewhere: "Эта сессия открыта в другом окне VS Code.",
		claudeMissing: "Расширение Claude Code (anthropic.claude-code) не установлено.",
		openFailed: "Не удалось открыть сессию Claude.",
		weekdays: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"],
		diagTitle: "Claude Code Companion — диагностика",
		updated: "Обновлено",
		versions: "Версии",
		vscodeVersion: "VS Code",
		companionVersion: "companion",
		claudeExtension: "anthropic.claude-code",
		notInstalled: "не установлено",
		windowSection: "Окно",
		roleLabel: "роль",
		leader: "лидер",
		follower: "ведомое",
		portLabel: "порт",
		hooksInstalledLabel: "хуки установлены",
		settingsFileLabel: "файл настроек",
		yes: "да",
		no: "нет",
		unknown: "неизвестно",
		liveWindows: (n) => `Живые окна (${n})`,
		none: "нет",
		foldersLabel: "папки",
		sessionsSummary: (total, c) =>
			`Сессии (${total}: работа ${c.working}, ожидание ${c.waiting}, готово ${c.done}, ошибка ${c.error}, простой ${c.idle})`,
		ownerLabel: "окно",
		statusLabel: "состояние",
		titleLabel: "заголовок",
		lastEventLabel: "последнее событие",
		usageSection: "Лимиты",
		lastFetchLabel: "последнее обновление",
		never: "никогда",
		proxyLabel: "прокси",
		direct: "напрямую (без прокси)",
		soundSection: "Звук",
		soundUnavailable: "для этой платформы нет проигрывателя",
		soundAvailable: (command) => `проигрыватель: ${command}`,
		soundFiles: (files) => `файлы: ${files}`,
		missing: "отсутствует",
		reportTitle: "Claude Code Companion — лимиты",
		fetched: "Получено",
		claudeLimits: "Лимиты Claude",
		noLimitData: "В ответе нет данных о лимитах.",
		usageRequestFailed: (reason) => `Запрос лимитов Claude не удался: ${reason}`,
		deepseekSection: "DeepSeek",
		balance: "Баланс",
		deepseekRouting: "Маршрутизация DeepSeek",
		deepseekSwitchedOn: "DeepSeek включён — новые чаты Claude идут через api.deepseek.com.",
		deepseekSwitchedOff: "DeepSeek выключен — новые чаты Claude работают через подписку.",
		deepseekToggleHint: "Включить или выключить DeepSeek для новых чатов",
		deepseekOn: "включён",
		deepseekOff: "выключен",
		deepseekNote: "применится в новом чате",
		deepseekNoWorkspace:
			'Откройте папку, чтобы переключить DeepSeek для проекта, или задайте "claudeCompanion.deepseekScope" = "user".',
		deepseekScriptMissing: (file) =>
			`claude-ds не найден: ${file}. Укажите путь в "claudeCompanion.deepseekScript".`,
		deepseekFailed: (action, detail) => `claude-ds ${action}: ошибка — ${detail}`,
		deepseekScopeProject: "проект",
		deepseekScopeUser: "все проекты",
		deepseekTargetLabel: "файл",
		deepseekScriptLabel: "claude-ds"
	},
	zh: {
		open: "打开",
		untitled: "未命名会话",
		heading: "Claude Code Companion",
		states: { working: "工作", waiting: "等待", done: "完成", error: "错误", idle: "空闲" },
		reasons: { permission: "权限", question: "问题", plan: "计划", input: "输入" },
		waitingFor: (reason) => `等待${reason}`,
		ago: (duration) => `${duration}前`,
		others: (n) => `其他窗口中有 ${n} 个会话`,
		pace: "进度",
		paceLabels: { fast: "偏快", normal: "正常", slow: "偏慢", idle: "空闲" },
		paceOnTrack: (pct) => `进度正常（到重置约 ${pct}%）`,
		paceDepletes: (duration) => `约 ${duration}后耗尽`,
		paceResets: (duration) => `${duration}后重置`,
		resets: "重置",
		noUsageYet: "尚未获取 Claude 用量",
		usageHttp: (status) => `获取 Claude 用量失败（HTTP ${status}）`,
		usageNetwork: "获取 Claude 用量失败——网络或代理不可用",
		usageStale: (time) => `显示的是 ${time} 的数据`,
		usageRetry: (time) => `下次尝试时间 ${time}`,
		patchReload: "Claude Code Companion 已修改 Claude Code 标签页（状态标记、项目名称）——重新加载窗口后可见。",
		reloadWindow: "重新加载窗口",
		patchFailed: (v) => `Claude Code Companion：Claude Code ${v} 的代码已变化，标签页状态标记和项目名称不可用，其余功能正常。`,
		tabMarkersLabel: "标签页状态标记",
		tabsTracked: (n) => `已跟踪 ${n} 个标签页`,
		tokenExpired: "Claude 登录令牌已过期——下次使用 Claude Code 时会自动刷新",
		noCredentials: "未找到 Claude 登录信息——请登录 Claude Code",
		unauthorized: "Claude 用量请求被拒绝——请登录 Claude Code",
		usageFailed: (reason) => `Claude 用量不可用（${reason}）`,
		deepseek: "DeepSeek",
		deepseekUnavailable: "不可用",
		today: "今日",
		days7: "7 天",
		runs: (n) => `${n} 次`,
		usageReport: "用量报告",
		refresh: "刷新",
		diagnostics: "诊断",
		contextWarning: (title, tokens) => `「${title}」的上下文已达 ${tokens} tokens——建议开启新会话`,
		doneNotice: (title) => `Claude 已完成「${title}」`,
		waitingNotice: (title) => `Claude 在「${title}」中等待你`,
		errorNotice: (title) => `Claude 在「${title}」中出错停止`,
		alert5h: (pct, reset) => `Claude 5 小时限额已达 ${pct}%——重置时间 ${reset}`,
		alert7d: (pct, reset) => `Claude 每周限额已达 ${pct}%——重置时间 ${reset}`,
		alertDeepseek: (amount) => `DeepSeek 余额偏低：${amount}`,
		hookInstallFailed: (error) => `无法安装 Claude Code Companion 钩子：${error}`,
		hookRemoveFailed: (error) => `无法移除 Claude Code Companion 钩子：${error}`,
		hooksInstalled: "Claude Code 钩子已安装。",
		hooksRemoved: "Claude Code 钩子已移除。",
		hooksRemovedManaged: "钩子已移除。当“管理钩子”设置开启时，它们会在下次启动时恢复——请关闭该设置以保持移除状态。",
		menuOtherWindows: "其他窗口",
		menuNewSession: "新建 Claude 会话",
		menuRefresh: "刷新限额",
		menuUsage: "用量报告",
		menuSounds: "测试声音",
		menuDiagnostics: "诊断",
		sessionElsewhere: "该会话已在另一个 VS Code 窗口中打开。",
		claudeMissing: "未安装 Claude Code 扩展（anthropic.claude-code）。",
		openFailed: "无法打开 Claude 会话。",
		weekdays: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
		diagTitle: "Claude Code Companion — 诊断",
		updated: "更新时间",
		versions: "版本",
		vscodeVersion: "VS Code",
		companionVersion: "companion",
		claudeExtension: "anthropic.claude-code",
		notInstalled: "未安装",
		windowSection: "窗口",
		roleLabel: "角色",
		leader: "主窗口",
		follower: "从窗口",
		portLabel: "端口",
		hooksInstalledLabel: "钩子已安装",
		settingsFileLabel: "设置文件",
		yes: "是",
		no: "否",
		unknown: "未知",
		liveWindows: (n) => `活动窗口（${n}）`,
		none: "无",
		foldersLabel: "文件夹",
		sessionsSummary: (total, c) =>
			`会话（${total}：工作 ${c.working}，等待 ${c.waiting}，完成 ${c.done}，错误 ${c.error}，空闲 ${c.idle}）`,
		ownerLabel: "窗口",
		statusLabel: "状态",
		titleLabel: "标题",
		lastEventLabel: "最后事件",
		usageSection: "用量",
		lastFetchLabel: "上次获取",
		never: "从未",
		proxyLabel: "代理",
		direct: "直连（无代理）",
		soundSection: "声音",
		soundUnavailable: "此平台没有声音播放器",
		soundAvailable: (command) => `播放器：${command}`,
		soundFiles: (files) => `文件：${files}`,
		missing: "缺失",
		reportTitle: "Claude Code Companion — 用量",
		fetched: "获取时间",
		claudeLimits: "Claude 限额",
		noLimitData: "响应中没有限额数据。",
		usageRequestFailed: (reason) => `Claude 用量请求失败：${reason}`,
		deepseekSection: "DeepSeek",
		balance: "余额",
		deepseekRouting: "DeepSeek 路由",
		deepseekSwitchedOn: "DeepSeek 已开启 — 新的 Claude 会话经由 api.deepseek.com。",
		deepseekSwitchedOff: "DeepSeek 已关闭 — 新的 Claude 会话使用 Claude 订阅。",
		deepseekToggleHint: "为新会话开启或关闭 DeepSeek 路由",
		deepseekOn: "已开启",
		deepseekOff: "已关闭",
		deepseekNote: "对新会话生效",
		deepseekNoWorkspace:
			'请先打开文件夹以切换本项目的 DeepSeek，或将 "claudeCompanion.deepseekScope" 设为 "user"。',
		deepseekScriptMissing: (file) => `未找到 claude-ds：${file}。请在 "claudeCompanion.deepseekScript" 中设置路径。`,
		deepseekFailed: (action, detail) => `claude-ds ${action} 失败：${detail}`,
		deepseekScopeProject: "项目",
		deepseekScopeUser: "所有项目",
		deepseekTargetLabel: "目标",
		deepseekScriptLabel: "claude-ds"
	}
};

const T = (() => {
	const lang = String((vscode.env && vscode.env.language) || "en").toLowerCase();
	return STR[lang.startsWith("ru") ? "ru" : lang.startsWith("zh") ? "zh" : "en"];
})();

// --- Small shared helpers ----------------------------------------------

const safe = (fn, fallback) => {
	try {
		return fn();
	} catch {
		return fallback;
	}
};

function errorText(err) {
	return err && err.message ? err.message : String(err);
}

function pad2(n) {
	return String(n).padStart(2, "0");
}

function localStamp(d) {
	return (
		`${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ` +
		`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
	);
}

function resetStamp(ms, withWeekday, t = T) {
	if (!Number.isFinite(ms)) return null;
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return null;
	const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	if (!withWeekday) return time;
	const days = Array.isArray(t && t.weekdays) ? t.weekdays : [];
	return `${days[d.getDay()] || ""} ${time}`.trim();
}

// Minutes unpadded to match the compact status bar: 3:12, 1:02:03.
function formatTurn(ms) {
	const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const mm = pad2(m);
	const ss = pad2(s);
	return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function formatTokens(tokens) {
	const n = Number(tokens);
	if (!Number.isFinite(n) || n <= 0) return "";
	if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}K`;
	return String(Math.round(n));
}

// Claude truncates tab labels to 25 characters: 24 characters plus an ellipsis.
function truncateTitle(title) {
	const t = String(title == null ? "" : title);
	return t.length > 25 ? t.slice(0, 24) + "…" : t;
}

function truncatePlain(value, max) {
	let s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
	if (max > 0 && s.length > max) s = s.slice(0, max - 1) + "…";
	return s;
}

// The tooltip is a trusted MarkdownString; a session title or an API label must never become a
// link, image or HTML tag. Backslash-escaping every CommonMark punctuation character does that.
const MD_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

function escapeMarkdown(value, max = TOOLTIP_TITLE_MAX) {
	return truncatePlain(value, max).replace(MD_PUNCTUATION, "\\$&");
}

function money(amount, currency) {
	const value = Number(amount);
	const code = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "USD";
	const symbol = code === "USD" ? "$" : code === "RUB" ? "₽" : code === "CNY" ? "¥" : `${code} `;
	return `${symbol}${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
}

function formatProxy(value) {
	if (!value) return T.direct;
	try {
		const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : "http://" + value;
		const url = new URL(raw);
		if (!url.hostname) return T.direct;
		return url.port ? `${url.hostname}:${url.port}` : url.hostname;
	} catch {
		return T.unknown;
	}
}

// --- Status bar text ----------------------------------------------------

function slotPercent(slot) {
	const ratio = Number(slot && slot.ratio);
	return Math.round((Number.isFinite(ratio) ? ratio : 0) * 100);
}

function findSlot(slots, id) {
	if (!Array.isArray(slots)) return null;
	return slots.find((slot) => slot && slot.id === id) || null;
}

function buildSessionPart(counts, longestWorkingMs, enabled) {
	if (!enabled) return "";
	const c = counts || {};
	const working = Number(c.working) || 0;
	const waiting = Number(c.waiting) || 0;
	const done = Number(c.done) || 0;
	const errors = Number(c.error) || 0;
	const parts = [];
	if (working > 0) parts.push(`~${working}`);
	if (working > 0 && Number(longestWorkingMs) > 0) parts.push(formatTurn(longestWorkingMs));
	if (waiting > 0) parts.push(`?${waiting}`);
	if (done > 0) parts.push(`V${done}`);
	if (errors > 0) parts.push(`!${errors}`);
	return parts.join(" ");
}

function buildUsagePart(slots, enabled) {
	if (!enabled) return "";
	const five = findSlot(slots, "5h");
	const seven = findSlot(slots, "7d");
	const parts = [];
	if (five) parts.push(`5h ${slotPercent(five)}%`);
	if (seven) parts.push(`7d ${slotPercent(seven)}%`);
	return parts.join(" · ");
}

// Balance first, then what the DeepSeek workers spent today — "(−$0.18)" reads as a cost, not as
// a negative balance, and the tooltip spells both out.
function buildDeepseekPart(balance, todayUsd) {
	const total = balance ? Number(balance.total) : NaN;
	if (!Number.isFinite(total)) return "";
	const bits = [money(total, balance.currency)];
	const spent = Number(todayUsd);
	if (Number.isFinite(spent) && spent > 0) bits.push(`(−${spent >= 0.01 ? money(spent, "USD") : "<$0.01"})`);
	return `DS ${bits.join(" ")}`;
}

function buildStatusText(options) {
	const opts = options || {};
	const parts = [];
	const sessionPart = buildSessionPart(opts.counts, opts.longestWorkingMs, opts.sessionStatus !== false);
	if (sessionPart) parts.push(sessionPart);
	const usagePart = buildUsagePart(opts.slots, opts.usageInStatusBar !== false);
	if (usagePart) parts.push(usagePart);
	if (opts.deepseek) parts.push(opts.deepseek);
	// With nothing to report the button still has to read as the Claude menu, not a stray glyph.
	return parts.length > 0 ? `${ICON} ${parts.join(" · ")}` : `${ICON} Claude`;
}

// --- Session presentation ----------------------------------------------

function stateText(session, t = T) {
	if (!session) return "";
	if (session.status === "waiting" && session.waitingReason) {
		const reason = (t.reasons && t.reasons[session.waitingReason]) || session.waitingReason;
		return t.waitingFor(reason);
	}
	return (t.states && t.states[session.status]) || session.status || t.unknown;
}

function sessionTime(session, now, withAgo = true, t = T) {
	if (!session) return "";
	if (session.status === "working") {
		const start = Number.isFinite(session.turnStart) ? session.turnStart : session.since;
		if (!Number.isFinite(start)) return "";
		return formatTurn(Math.max(0, now - start));
	}
	const since = Number.isFinite(session.since) ? session.since : session.lastEvent;
	if (!Number.isFinite(since)) return "";
	const duration = usage.formatDuration(Math.max(0, now - since));
	if (!duration) return "";
	return withAgo ? t.ago(duration) : duration;
}

function sessionDetail(session) {
	const parts = [];
	if (session && session.cwd) {
		const folder = safe(() => path.basename(session.cwd), "");
		if (folder) parts.push(folder);
	}
	const context = formatTokens(session && session.contextTokens);
	if (context) parts.push(context);
	return parts.join(" · ");
}

// --- Tooltip ------------------------------------------------------------

function hotThresholdFor(slot) {
	const config = slot && Number(slot.durationMinutes) > 1440 ? "alertThreshold7d" : "alertThreshold5h";
	const fallback = config === "alertThreshold7d" ? 0.9 : 0.8;
	return usage.fractionSetting(setting(config, fallback), fallback);
}

function paceLine(slot, now, t = T) {
	const summary = usage.paceSummary(slot, now, hotThresholdFor(slot));
	if (!summary) return "";
	const label = (t.paceLabels && t.paceLabels[summary.label]) || summary.label;
	const parts = [`${t.pace} ${label}`];
	if (summary.depletesInMs != null) parts.push(t.paceDepletes(usage.formatDuration(summary.depletesInMs)));
	else parts.push(t.paceOnTrack(Math.min(999, Math.round(summary.pace * 100))));
	if (Number.isFinite(summary.resetInMs) && summary.resetInMs > 0) {
		parts.push(t.paceResets(usage.formatDuration(summary.resetInMs)));
	}
	return parts.join(" · ");
}

function usageReasonText(reason, t = T, status) {
	if (reason === "token-expired") return t.tokenExpired;
	if (reason === "no-credentials") return t.noCredentials;
	if (reason === "unauthorized") return t.unauthorized;
	if (reason === "http" && Number.isFinite(Number(status))) return t.usageHttp(Number(status));
	if (reason === "network") return t.usageNetwork;
	if (!reason) return t.unknown;
	return String(reason).slice(0, 40);
}

// The failure reason plus, when older numbers are still shown, the time they are from.
function usageFailureText(claude, t = T) {
	const parts = [usageReasonText(claude.reason, t, claude.status)];
	if (Number.isFinite(claude.okAt) && Array.isArray(claude.slots) && claude.slots.length) {
		parts.push(t.usageStale(resetStamp(claude.okAt, false, t)));
	}
	if (Number.isFinite(claude.retryAt) && claude.retryAt > Date.now()) {
		parts.push(t.usageRetry(resetStamp(claude.retryAt, false, t)));
	}
	return parts.join(" · ");
}

function usageSlotsOf(cache) {
	return cache && cache.claude && Array.isArray(cache.claude.slots) ? cache.claude.slots : [];
}

// Pure: the test suite builds the tooltip text without a VS Code MarkdownString.
function buildTooltipMarkdown(model) {
	const t = model.t || T;
	const now = Number.isFinite(model.now) ? model.now : Date.now();
	const blocks = [`**${t.heading}**`];

	const mine = Array.isArray(model.mine) ? model.mine : [];
	if (mine.length > 0) {
		const lines = [];
		for (const session of mine) {
			const icon = STATUS_ICONS[session.status] || STATUS_ICONS.idle;
			const bits = [stateText(session, t), sessionTime(session, now, true, t)];
			const context = formatTokens(session.contextTokens);
			if (context) bits.push(context);
			lines.push(
				`${icon} **${escapeMarkdown(session.title || t.untitled)}** — ${bits.filter(Boolean).join(" · ")}`
			);
		}
		blocks.push(lines.join("\n\n"));
	}
	const others = Number(model.others) || 0;
	if (others > 0) blocks.push(t.others(others));

	const cache = model.cache;
	const slots = usageSlotsOf(cache);
	for (const slot of slots) {
		const reset = resetStamp(slot.resetAt, false, t);
		const pct = slotPercent(slot);
		const label = escapeMarkdown(slot.label || slot.id, 30);
		const heading = `**${label}${reset ? ` · ${t.resets} ${reset}` : ""}**`;
		const hot = Number(slot.ratio) >= hotThresholdFor(slot);
		const bar = `![${pct}%](${usage.barPngDataUri(Number(slot.ratio) || 0, hot)})`;
		const pace = paceLine(slot, now, t);
		blocks.push([heading, `### **${pct}%**`, bar, pace].filter(Boolean).join("\n\n"));
	}
	if (cache && cache.claude && cache.claude.ok === false) {
		blocks.push(usageFailureText(cache.claude, t));
	} else if (!cache) {
		blocks.push(t.noUsageYet);
	}

	const deepseek = cache && cache.deepseek;
	if (deepseek) {
		let line = `**${t.deepseek}:** ${money(deepseek.total, deepseek.currency)}`;
		if (deepseek.available === false) line += ` — ${t.deepseekUnavailable}`;
		const ledger = cache.ledger;
		if (ledger && ledger.today && ledger.week) {
			line +=
				` · ${t.today} ${money(ledger.today.usd, "USD")} (${t.runs(Number(ledger.today.runs) || 0)})` +
				` · ${t.days7} ${money(ledger.week.usd, "USD")}`;
		}
		blocks.push(line);
	}

	const routing = model.deepseek;
	if (routing) {
		const target = routing.target || {};
		const icon = routing.on ? "$(circle-filled)" : "$(circle-outline)";
		const scope = target.scope === "user" ? t.deepseekScopeUser : t.deepseekScopeProject;
		blocks.push(
			`[${icon} ${t.deepseekRouting}: ${routing.on ? t.deepseekOn : t.deepseekOff}]` +
				`(command:claudeCompanion.deepseekToggle "${t.deepseekToggleHint}") · ${scope} · ${t.deepseekNote}`
		);
	}

	blocks.push(
		`[$(graph) ${t.usageReport}](command:claudeCompanion.usage "${t.usageReport}") · ` +
			`[$(refresh) ${t.refresh}](command:claudeCompanion.refresh "${t.refresh}") · ` +
			`[$(pulse) ${t.diagnostics}](command:claudeCompanion.diagnostics "${t.diagnostics}")`
	);
	return blocks.join("\n\n---\n\n");
}

// --- Runtime state ------------------------------------------------------

let appContext = null;
let log = null;
let windowId = "";
let storageDir = "";
let registryDir = "";
let storeFile = "";
let usageFile = "";
let windowStartedAt = 0;

let role = "follower";
let store = null;
let snapshot = null;
let maxSeq = -1;
let leaderReady = Promise.resolve();
let srv = null;
let serverGeneration = 0;

let usageCache = null;
let lastUsageRefreshAt = 0;
let usageRefreshChain = Promise.resolve();
let usageQueued = false;

let lastSoundAt = 0;
let soundTimer = null;
let saveTimer = null;
let saveDirty = false;
let saveChain = Promise.resolve();
let watcher = null;
let pollTimer = null;
let pruneTimer = null;
let tickTimer = null;
let renderTimer = null;
let snapshotReloadTimer = null;
let usageReloadTimer = null;
let usageTimer = null;
let startupTimer = null;
let lastStateMtime = 0;
let lastUsageMtime = 0;

let statusItem = null;
let reportProvider = null;

// --- Settings & logging -------------------------------------------------

function logLine(text) {
	try {
		if (log) log.appendLine(text);
	} catch {
		// logging must never break a background path
	}
}

function setting(key, fallback) {
	return safe(() => vscode.workspace.getConfiguration("claudeCompanion").get(key, fallback), fallback);
}

function readPort() {
	const value = Number(setting("port", DEFAULT_PORT));
	return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : DEFAULT_PORT;
}

function claudeExtension() {
	return safe(
		() =>
			vscode.extensions && typeof vscode.extensions.getExtension === "function"
				? vscode.extensions.getExtension(CLAUDE_EXT_ID)
				: null,
		null
	);
}

// A host without the extensions API (tests, future web host) must not block opening.
function claudeAvailable() {
	if (!vscode.extensions || typeof vscode.extensions.getExtension !== "function") return true;
	return !!claudeExtension();
}

function extensionVersion() {
	return (
		safe(() => (appContext && appContext.extension ? appContext.extension.packageJSON.version : "?"), "?") || "?"
	);
}

// --- Window registry & hooks -------------------------------------------

function windowFolders() {
	const folders = vscode.workspace.workspaceFolders;
	if (!Array.isArray(folders)) return [];
	return folders.map((folder) => (folder && folder.uri ? folder.uri.fsPath : "")).filter(Boolean);
}

function registerSelf() {
	if (!registryDir) return;
	const ok = registry.registerWindow(registryDir, {
		windowId,
		pid: process.pid,
		folders: windowFolders(),
		startedAt: windowStartedAt
	});
	if (!ok) logLine("[registry] this window could not be registered");
}

function ensureWindowId(context) {
	let id = safe(() => context.workspaceState.get(WINDOW_ID_KEY), null);
	if (typeof id !== "string" || !/^[0-9a-f]{12}$/.test(id)) {
		id = crypto.randomBytes(6).toString("hex");
		try {
			const updated = context.workspaceState.update(WINDOW_ID_KEY, id);
			if (updated && typeof updated.catch === "function") updated.catch(() => {});
		} catch {
			// the in-memory id still works for this session
		}
	}
	return id;
}

function installManagedHooks(reason) {
	let result;
	try {
		result = hooksConfig.installHooks(readPort());
	} catch (err) {
		result = { ok: false, error: errorText(err) };
	}
	if (result.ok) {
		logLine(`[hooks] ${reason}: installed=${result.changed}`);
	} else {
		logLine(`[hooks] ${reason}: FAILED ${result.error}`);
		void vscode.window.showWarningMessage(T.hookInstallFailed(result.error || T.unknown));
	}
	return result;
}

function commandInstallHooks() {
	const result = installManagedHooks("command");
	if (result.ok) void vscode.window.showInformationMessage(T.hooksInstalled);
}

function commandRemoveHooks() {
	const result = safe(() => hooksConfig.removeHooks(), { ok: false, error: T.unknown });
	if (!result.ok) {
		logLine(`[hooks] remove FAILED ${result.error}`);
		void vscode.window.showWarningMessage(T.hookRemoveFailed(result.error || T.unknown));
		return;
	}
	logLine(`[hooks] removed=${result.changed}`);
	if (setting("manageHooks", true) !== false) void vscode.window.showWarningMessage(T.hooksRemovedManaged);
	else void vscode.window.showInformationMessage(T.hooksRemoved);
}

function hooksInstalledStatus() {
	try {
		const raw = fs.readFileSync(hooksConfig.settingsPath(), "utf8");
		const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
		const json = JSON.parse(text);
		return hooksConfig.hasCurrentHooks(json, readPort()) ? T.yes : T.no;
	} catch {
		return T.unknown;
	}
}

// --- Server & leader ----------------------------------------------------

function startCompanionServer() {
	stopCompanionServer();
	role = "follower";
	store = null;
	leaderReady = Promise.resolve();
	const generation = ++serverGeneration;
	const port = readPort();
	srv = server.startServer({
		port,
		log: (text) => logLine(`[server] ${text}`),
		onEvent: (payload) => {
			if (generation !== serverGeneration) return;
			void handleEvent(payload, generation);
		},
		onControl: (payload) => {
			if (generation !== serverGeneration) return;
			void handleControl(payload, generation);
		},
		onRoleChange: (next) => {
			if (generation !== serverGeneration) return;
			onRoleChanged(next, generation);
		}
	});
	logLine(`[server] trying 127.0.0.1:${port}`);
}

function stopCompanionServer() {
	serverGeneration++;
	if (role === "leader") void flushStore();
	const current = srv;
	srv = null;
	if (current) safe(() => current.stop());
	stopPrune();
	role = "follower";
}

function onRoleChanged(next, generation) {
	if (generation !== serverGeneration) return;
	role = next;
	logLine(`[role] ${next}`);
	if (next === "leader") {
		leaderReady = becomeLeader(generation).catch((err) => {
			logLine(`[leader] load failed: ${errorText(err)}`);
			if (generation === serverGeneration) store = sessions.emptyStore();
		});
	} else {
		stopPrune();
	}
	scheduleRender();
}

async function becomeLeader(generation) {
	const loaded = await sessions.loadStore(storeFile).catch(() => sessions.emptyStore());
	if (generation !== serverGeneration || role !== "leader") return;
	store = loaded;
	const windows = registryDir ? registry.listWindows(registryDir) : [];
	const pruned = registryDir ? sessions.prune(store, windows, Date.now()) : false;
	observeStore(store);
	if (pruned) scheduleSave();
	ensurePrune();
	checkAlerts();
	logLine(`[leader] sessions=${Object.keys(store.sessions).length} seq=${store.seq}`);
}

function ensurePrune() {
	if (pruneTimer || !registryDir) return;
	pruneTimer = setInterval(runPrune, PRUNE_MS);
	if (pruneTimer.unref) pruneTimer.unref();
}

function stopPrune() {
	if (pruneTimer) {
		clearInterval(pruneTimer);
		pruneTimer = null;
	}
}

function runPrune() {
	if (role !== "leader" || !store || !registryDir) return;
	try {
		const changed = sessions.prune(store, registry.listWindows(registryDir), Date.now());
		if (changed) {
			observeStore(store);
			scheduleSave();
		}
	} catch (err) {
		logLine(`[prune] ${errorText(err)}`);
	}
}

async function handleEvent(payload, generation) {
	if (!payload || generation !== serverGeneration) return;
	await leaderReady;
	if (generation !== serverGeneration || role !== "leader" || !store) return;
	const input = payload.input;
	const headers = {
		"x-companion-window": typeof payload.windowId === "string" ? payload.windowId : "",
		"x-companion-nested": typeof payload.nested === "string" ? payload.nested : ""
	};
	const ev = sessions.normalizeEvent(input, headers);
	if (!ev) return;
	if (ev.nested && !setting("trackNestedSessions", false)) return;

	const windows = registryDir ? registry.listWindows(registryDir) : [];
	const owner = sessions.resolveOwner(ev, windows, registry.ownerForCwd);
	const doneSoundMinMs = Math.max(0, Number(setting("doneSoundMinSeconds", 20)) || 0) * 1000;
	const result = sessions.applyEvent(store, ev, Date.now(), { owner, doneSoundMinMs });
	if (!result.changed) return;
	observeStore(store);
	scheduleSave();
	if (ev.name === "Stop") {
		void enrichAfterStop(ev, generation);
		// Only the leader fetches limits, so it reacts to every finished turn, not just its own.
		maybeRefreshAfterDone();
	}
}

// The Stop hook fires before the transcript's last assistant record is necessarily flushed;
// the context warning is a follow-up, so a short read after the event is safe.
async function enrichAfterStop(ev, generation) {
	try {
		const session = store && store.sessions ? store.sessions[ev.sessionId] : null;
		if (!session) return;
		const transcript = ev.transcript || session.transcript || "";
		if (!transcript) return;
		const [tokens, title] = await Promise.all([
			sessions.readContextTokens(transcript).catch(() => null),
			sessions.readTitle(transcript).catch(() => null)
		]);
		if (generation !== serverGeneration || role !== "leader" || !store) return;
		const current = store.sessions[ev.sessionId];
		if (!current) return;
		let changed = false;
		if (title && title !== current.title) {
			current.title = title;
			changed = true;
		}
		if (Number.isFinite(tokens)) {
			const warnTokens = Math.max(0, Number(setting("contextWarnTokens", 300000)) || 0);
			const recorded = sessions.recordContext(store, ev.sessionId, tokens, Date.now(), warnTokens);
			changed = changed || recorded.changed;
		}
		if (changed) {
			observeStore(store);
			scheduleSave();
		}
	} catch (err) {
		logLine(`[context] ${errorText(err)}`);
	}
}

async function handleControl(payload, generation) {
	if (!payload || typeof payload !== "object" || generation !== serverGeneration) return;
	await leaderReady;
	if (generation !== serverGeneration || role !== "leader" || !store) return;
	const id = typeof payload.sessionId === "string" ? payload.sessionId : "";
	if (!id) return;
	let changed = false;
	if (payload.action === "seen") changed = sessions.markSeen(store, id);
	else if (payload.action === "dismiss") changed = sessions.dismiss(store, id);
	if (changed) {
		observeStore(store);
		scheduleSave();
	}
}

// --- Effects ------------------------------------------------------------

// Returns the effects the caller has not handled yet. A negative previousMax means "window just
// started": record the current seq so old effects are never replayed.
function collectNewEffects(next, previousMax) {
	const seq = Number.isFinite(next && next.seq) ? next.seq : 0;
	let highest = Number.isFinite(previousMax) && previousMax >= 0 ? previousMax : seq;
	const effects = next && Array.isArray(next.effects) ? next.effects : [];
	const fresh = [];
	for (const effect of effects) {
		if (!effect || !Number.isFinite(effect.seq)) continue;
		if (effect.seq > highest) fresh.push(effect);
	}
	for (const effect of effects) {
		if (Number.isFinite(effect.seq)) highest = Math.max(highest, effect.seq);
	}
	fresh.sort((a, b) => a.seq - b.seq);
	return { effects: fresh, maxSeq: Math.max(highest, seq) };
}

function effectApplies(effect, isLeader, ownerWindowId = windowId) {
	if (!effect || typeof effect !== "object") return false;
	if (effect.owner === null || effect.owner === undefined || effect.owner === "") return !!isLeader;
	return effect.owner === ownerWindowId;
}

function observeStore(next) {
	if (!next || typeof next !== "object") return;
	snapshot = next;
	const result = collectNewEffects(next, maxSeq);
	maxSeq = result.maxSeq;
	for (const effect of result.effects) {
		try {
			handleEffect(effect);
		} catch (err) {
			logLine(`[effect] ${errorText(err)}`);
		}
	}
	scheduleRender();
}

function handleEffect(effect) {
	if (!effectApplies(effect, role === "leader")) return;
	switch (effect.kind) {
		case "done":
			playEffectSound("done");
			notifyEffect(effect);
			maybeRefreshAfterDone();
			break;
		case "waiting":
			playEffectSound("waiting");
			notifyEffect(effect);
			break;
		case "error":
			playEffectSound("error");
			notifyEffect(effect);
			break;
		case "context":
			warnAboutContext(effect);
			break;
		default:
			break;
	}
}

function notifyEffect(effect) {
	if (!setting("notifications", false)) return;
	const title = effect.title || T.untitled;
	const message =
		effect.kind === "done"
			? T.doneNotice(title)
			: effect.kind === "waiting"
				? T.waitingNotice(title)
				: T.errorNotice(title);
	void vscode.window.showInformationMessage(message, T.open).then(
		(choice) => {
			if (choice === T.open) void openSession(effect.sessionId);
		},
		() => {}
	);
}

function warnAboutContext(effect) {
	const title = effect.title || T.untitled;
	const tokens = formatTokens(effect.tokens) || String(Number(effect.tokens) || 0);
	void vscode.window.showWarningMessage(T.contextWarning(title, tokens), T.open).then(
		(choice) => {
			if (choice === T.open) void openSession(effect.sessionId);
		},
		() => {}
	);
}

async function openSession(sessionId) {
	if (!sessionId) return false;
	if (!claudeAvailable()) {
		void vscode.window.showErrorMessage(T.claudeMissing);
		return false;
	}
	try {
		await vscode.commands.executeCommand(OPEN_COMMAND, sessionId);
		return true;
	} catch (err) {
		logLine(`[open] ${errorText(err)}`);
		void vscode.window.showErrorMessage(T.openFailed);
		return false;
	}
}

async function openNewSession() {
	if (!claudeAvailable()) {
		void vscode.window.showErrorMessage(T.claudeMissing);
		return;
	}
	try {
		await vscode.commands.executeCommand(OPEN_COMMAND);
	} catch (err) {
		logLine(`[open] ${errorText(err)}`);
		void vscode.window.showErrorMessage(T.openFailed);
	}
}

// --- Sounds -------------------------------------------------------------

// 0 = play now, -1 = drop it, >0 = play after this many ms.
// The waiting chime is the one that matters at a glance, so it is delayed instead of swallowed.
function soundDelay(kind, now, lastAt, minGap) {
	const gap = Number.isFinite(minGap) && minGap > 0 ? minGap : SOUND_GAP_MS;
	const last = Number(lastAt) || 0;
	if (!last) return 0;
	const elapsed = now - last;
	if (elapsed >= gap) return 0;
	if (kind !== "waiting") return -1;
	return gap - elapsed;
}

function soundSettingKey(kind) {
	return kind === "done" ? "soundDone" : kind === "waiting" ? "soundWaiting" : "soundError";
}

function playEffectSound(kind) {
	try {
		if (!SOUND_FILES[kind] || setting(soundSettingKey(kind), true) === false) return;
		const now = Date.now();
		const wait = soundDelay(kind, now, lastSoundAt, SOUND_GAP_MS);
		if (wait < 0) {
			logLine(`[sound] ${kind} skipped (gap)`);
			return;
		}
		if (wait === 0) {
			lastSoundAt = now;
			playSound(kind);
			return;
		}
		if (soundTimer) return;
		// One delayed waiting chime covers a burst of them.
		soundTimer = setTimeout(() => {
			soundTimer = null;
			if (setting(soundSettingKey(kind), true) === false) return;
			playSound(kind);
			lastSoundAt = Date.now();
		}, wait);
		if (soundTimer.unref) soundTimer.unref();
	} catch (err) {
		logLine(`[sound] ${errorText(err)}`);
	}
}

function playSound(kind) {
	try {
		if (vscode.UIKind && vscode.env.uiKind !== vscode.UIKind.Desktop) return;
		if (vscode.env.remoteName) return;
		const file = SOUND_FILES[kind];
		const spec = SOUND_COMMAND[process.platform];
		if (!file || !spec) return;
		const args = process.platform === "win32" ? spec[1].slice() : spec[1].concat(file);
		const options = { stdio: "ignore", windowsHide: true };
		if (process.platform === "win32") options.env = { ...process.env, CLAUDE_COMPANION_SOUND: file };
		const child = spawn(spec[0], args, options);
		child.on("error", (err) => logLine(`[sound] ${kind} FAILED: ${errorText(err)}`));
		if (typeof child.unref === "function") child.unref();
	} catch (err) {
		logLine(`[sound] ${kind} FAILED: ${errorText(err)}`);
	}
}

function testSounds() {
	const kinds = ["done", "waiting", "error"];
	kinds.forEach((kind, index) => {
		if (index === 0) {
			lastSoundAt = Date.now();
			playSound(kind);
			return;
		}
		const timer = setTimeout(() => {
			lastSoundAt = Date.now();
			playSound(kind);
		}, index * TEST_SOUND_GAP_MS);
		if (timer.unref) timer.unref();
	});
}

// --- Store persistence --------------------------------------------------

function scheduleSave() {
	if (role !== "leader" || !store) return;
	saveDirty = true;
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		flushStore();
	}, SAVE_COALESCE_MS);
	if (saveTimer.unref) saveTimer.unref();
}

// Serialised: state.json.tmp is a single path, so two overlapping writes would collide.
function flushStore() {
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	if (!saveDirty || !store) return saveChain;
	const data = store;
	saveDirty = false;
	saveChain = saveChain
		.then(() => sessions.saveStore(storeFile, data))
		.then((ok) => {
			if (!ok) logLine("[store] save failed");
		})
		.catch((err) => logLine(`[store] save failed: ${errorText(err)}`));
	return saveChain;
}

// --- File watchers ------------------------------------------------------

function fileMtime(file) {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

function startWatchers(context) {
	try {
		watcher = fs.watch(storageDir, { persistent: false }, (_event, filename) => {
			const name = filename ? String(filename) : "";
			if (!name || name === STATE_FILE || name.startsWith(STATE_FILE + ".")) scheduleSnapshotReload();
			if (!name || name === USAGE_FILE || name.startsWith(USAGE_FILE + ".")) scheduleUsageReload();
		});
		watcher.on("error", (err) => logLine(`[watch] ${errorText(err)}`));
	} catch (err) {
		logLine(`[watch] cannot watch ${storageDir}: ${errorText(err)}`);
	}
	lastStateMtime = fileMtime(storeFile);
	lastUsageMtime = fileMtime(usageFile);
	pollTimer = setInterval(pollFiles, POLL_MS);
	if (pollTimer.unref) pollTimer.unref();
	context.subscriptions.push({
		dispose: () => {
			if (watcher) {
				try {
					watcher.close();
				} catch {
					// already closed
				}
				watcher = null;
			}
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			if (snapshotReloadTimer) {
				clearTimeout(snapshotReloadTimer);
				snapshotReloadTimer = null;
			}
			if (usageReloadTimer) {
				clearTimeout(usageReloadTimer);
				usageReloadTimer = null;
			}
		}
	});
}

// The 1 s poll is the fallback for platforms where fs.watch on a directory misses renames.
function pollFiles() {
	try {
		const stateMtime = fileMtime(storeFile);
		if (stateMtime !== lastStateMtime) {
			lastStateMtime = stateMtime;
			scheduleSnapshotReload();
		}
		const usageMtime = fileMtime(usageFile);
		if (usageMtime !== lastUsageMtime) {
			lastUsageMtime = usageMtime;
			scheduleUsageReload();
		}
	} catch (err) {
		logLine(`[poll] ${errorText(err)}`);
	}
}

function scheduleSnapshotReload() {
	if (snapshotReloadTimer) return;
	snapshotReloadTimer = setTimeout(() => {
		snapshotReloadTimer = null;
		void reloadSnapshot();
	}, WATCH_DEBOUNCE_MS);
	if (snapshotReloadTimer.unref) snapshotReloadTimer.unref();
}

function scheduleUsageReload() {
	if (usageReloadTimer) return;
	usageReloadTimer = setTimeout(() => {
		usageReloadTimer = null;
		reloadUsageCache();
	}, WATCH_DEBOUNCE_MS);
	if (usageReloadTimer.unref) usageReloadTimer.unref();
}

async function reloadSnapshot() {
	try {
		// The leader owns the in-memory store; the file can only be stale in that window.
		if (role === "leader" && store) {
			scheduleRender();
			return;
		}
		let raw = null;
		try {
			raw = await fs.promises.readFile(storeFile, "utf8");
		} catch {
			raw = null;
		}
		if (raw === null) {
			// Missing while a rename is in flight: never wipe what is already on screen.
			if (snapshot) return;
		} else {
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return; // a partial write: keep the last good snapshot
			}
			if (!parsed || typeof parsed !== "object" || parsed.version !== sessions.STORE_VERSION) return;
		}
		const loaded = await sessions.loadStore(storeFile).catch(() => null);
		if (!loaded || loaded.version !== sessions.STORE_VERSION) return;
		if (role === "leader" && store) return;
		observeStore(loaded);
	} catch (err) {
		logLine(`[store] reload failed: ${errorText(err)}`);
	}
}

function reloadUsageCache() {
	const cache = safe(() => usage.loadUsageCache(usageFile), null);
	if (!cache) return;
	if (usageCache && Number(cache.at) <= Number(usageCache.at)) return;
	setUsageCache(cache);
}

// --- Rendering ----------------------------------------------------------

let renderScheduled = false;

function scheduleRender() {
	if (renderScheduled) return;
	renderScheduled = true;
	renderTimer = setTimeout(() => {
		renderScheduled = false;
		renderTimer = null;
		renderStatusBar();
		retitleAllTabs();
	}, 0);
	if (renderTimer.unref) renderTimer.unref();
}

function activeStore() {
	return role === "leader" && store ? store : snapshot;
}

function currentSummary(now) {
	return sessions.summarize(activeStore(), windowId, now);
}

function statusOptions(summary) {
	return {
		sessionStatus: setting("sessionStatus", true) !== false,
		usageInStatusBar: setting("usageInStatusBar", true) !== false,
		counts: summary.counts,
		longestWorkingMs: summary.longestWorkingMs,
		slots: usageSlotsOf(usageCache),
		deepseek: deepseekStatusPart()
	};
}

function statusBackground(summary) {
	const five = findSlot(usageSlotsOf(usageCache), "5h");
	const threshold = usage.fractionSetting(setting("alertThreshold5h", 0.8), 0.8);
	if (five && Number(five.ratio) >= threshold) return new vscode.ThemeColor("statusBarItem.errorBackground");
	if (summary.counts.waiting > 0) return new vscode.ThemeColor("statusBarItem.warningBackground");
	return undefined;
}

function renderStatusBar() {
	if (!statusItem) return;
	try {
		if (setting("statusBar", true) === false) {
			statusItem.hide();
			stopTick();
			return;
		}
		statusItem.show();
		const summary = currentSummary(Date.now());
		statusItem.text = buildStatusText(statusOptions(summary));
		statusItem.backgroundColor = statusBackground(summary);
		try {
			statusItem.tooltip = buildTooltip(Date.now());
		} catch (err) {
			logLine(`[tooltip] ${errorText(err)}`);
			statusItem.tooltip = T.heading;
		}
		if (summary.counts.working > 0 && !tickTimer) {
			tickTimer = setInterval(tickStatusBar, STATUS_TICK_MS);
			if (tickTimer.unref) tickTimer.unref();
		}
		if (summary.counts.working === 0) stopTick();
	} catch (err) {
		logLine(`[render] ${errorText(err)}`);
	}
}

// The second-by-second tick only rewrites text and colour; the tooltip (with PNG bars) is rebuilt
// on real state changes, not every second.
function tickStatusBar() {
	if (!statusItem) return;
	try {
		const summary = currentSummary(Date.now());
		statusItem.text = buildStatusText(statusOptions(summary));
		statusItem.backgroundColor = statusBackground(summary);
		if (summary.counts.working === 0) stopTick();
	} catch (err) {
		logLine(`[tick] ${errorText(err)}`);
		stopTick();
	}
}

function stopTick() {
	if (tickTimer) {
		clearInterval(tickTimer);
		tickTimer = null;
	}
}

function buildTooltip(now) {
	const summary = currentSummary(now);
	const md = new vscode.MarkdownString(undefined, true);
	md.supportThemeIcons = true;
	md.supportHtml = true;
	md.isTrusted = {
		enabledCommands: [
			"claudeCompanion.usage",
			"claudeCompanion.refresh",
			"claudeCompanion.diagnostics",
			"claudeCompanion.deepseekToggle"
		]
	};
	md.appendMarkdown(
		buildTooltipMarkdown({
			now,
			mine: summary.mine,
			others: summary.others.length,
			cache: usageCache,
			deepseek: deepseekToggleEnabled() ? deepseekState() : null,
			t: T
		})
	);
	return md;
}

// --- DeepSeek routing ---------------------------------------------------

// The switch is a property of a settings file, and the status bar renders on every tick, so the
// state is cached for a couple of seconds instead of being read on each render.
const DEEPSEEK_CACHE_MS = 2000;

let deepseekCache = { at: 0, key: "", state: null };

function deepseekToggleEnabled() {
	return setting("deepseekToggle", true) !== false;
}

function deepseekScope() {
	return String(setting("deepseekScope", "project") || "project") === "user" ? "user" : "project";
}

function deepseekWorkspaceDir() {
	const folders = safe(() => vscode.workspace.workspaceFolders, null) || [];
	const folder = folders.find((item) => item && item.uri && item.uri.scheme === "file");
	return folder ? folder.uri.fsPath : "";
}

function expandHome(value) {
	const asked = String(value || "").trim();
	if (!asked) return "";
	if (asked === "~") return os.homedir();
	if (asked.startsWith("~/") || asked.startsWith("~\\")) return path.join(os.homedir(), asked.slice(2));
	return asked;
}

function deepseekScript() {
	return expandHome(setting("deepseekScript", "")) || deepseekMode.defaultScript();
}

function deepseekScopeText(target) {
	return target && target.scope === "user" ? T.deepseekScopeUser : T.deepseekScopeProject;
}

// `{ on, exists, baseUrl, model, hasToken, error, target }`; never throws.
function deepseekState() {
	const target = deepseekMode.target({ scope: deepseekScope(), workspaceDir: deepseekWorkspaceDir() });
	const key = `${target.scope}|${target.file || ""}`;
	const now = Date.now();
	if (deepseekCache.state && deepseekCache.key === key && now - deepseekCache.at < DEEPSEEK_CACHE_MS) {
		return deepseekCache.state;
	}
	const state = { ...deepseekMode.readState(target.file), target };
	deepseekCache = { at: now, key, state };
	return state;
}

function resetDeepseekCache() {
	deepseekCache = { at: 0, key: "", state: null };
}

// The file also changes behind the companion (the CLI, another window), and the tooltip is built
// at render time, so the folder is watched instead of polled: an external switch repaints at once.
let deepseekWatcher = null;

function watchDeepseekFile() {
	try {
		if (deepseekWatcher) deepseekWatcher.close();
	} catch {
		// already closed
	}
	deepseekWatcher = null;
	const target = deepseekMode.target({ scope: deepseekScope(), workspaceDir: deepseekWorkspaceDir() });
	if (!target.file) return;
	const folder = path.dirname(target.file);
	const name = path.basename(target.file).toLowerCase();
	if (!safe(() => fs.existsSync(folder), false)) return;
	try {
		const watcher = fs.watch(folder, { persistent: false }, (_event, changed) => {
			if (changed && String(changed).toLowerCase() !== name) return;
			resetDeepseekCache();
			scheduleRender();
		});
		watcher.on("error", () => {
			try {
				watcher.close();
			} catch {
				// already closed
			}
		});
		deepseekWatcher = watcher;
	} catch (err) {
		logLine(`[deepseek] watch failed: ${errorText(err)}`);
	}
}

function stopDeepseekWatch() {
	try {
		if (deepseekWatcher) deepseekWatcher.close();
	} catch {
		// already closed
	}
	deepseekWatcher = null;
}

// Only while the routing is on: a balance badge for someone whose chats never reach DeepSeek
// would be noise, and the tooltip has the full picture anyway.
function deepseekStatusPart() {
	if (setting("deepseekInStatusBar", true) === false) return "";
	if (!deepseekToggleEnabled() || !deepseekState().on) return "";
	const cache = usageCache || {};
	const today = cache.ledger && cache.ledger.today ? cache.ledger.today.usd : NaN;
	return buildDeepseekPart(cache.deepseek, today);
}

function deepseekMenuItem() {
	const state = deepseekState();
	const icon = state.on ? "$(circle-filled)" : "$(circle-outline)";
	const target = state.target && state.target.file;
	return {
		label: `${icon} ${T.deepseekRouting}: ${state.on ? T.deepseekOn : T.deepseekOff}`,
		detail: target
			? `${deepseekScopeText(state.target)}: ${target} · ${T.deepseekNote}`
			: T.deepseekNoWorkspace,
		action: "deepseek"
	};
}

// The profile is written by `claude-ds`, not here: the key, the backups and the `.gitignore`
// guard stay in the one place that already owns them.
async function toggleDeepseek() {
	if (!deepseekToggleEnabled()) return;
	const state = deepseekState();
	const target = state.target;
	if (!target || !target.file) {
		void vscode.window.showWarningMessage(T.deepseekNoWorkspace);
		return;
	}
	const script = deepseekScript();
	if (!safe(() => fs.existsSync(script), false)) {
		void vscode.window.showErrorMessage(T.deepseekScriptMissing(script));
		return;
	}
	const action = state.on ? "off" : "on";
	const result = await deepseekMode.run(script, action, { dir: target.dir });
	resetDeepseekCache();
	scheduleRender();
	if (!result.ok) {
		const raw = result.stderr || result.error || (result.code === null ? T.unknown : `exit ${result.code}`);
		// The script masks the key on success; a stray line must still never reach the Output panel.
		const detail = truncatePlain(String(raw).replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***"), 300);
		logLine(`[deepseek] ${action} failed: ${detail}`);
		void vscode.window.showErrorMessage(T.deepseekFailed(action, detail));
		return;
	}
	watchDeepseekFile();
	logLine(`[deepseek] ${action} ok (${deepseekScopeText(target)})`);
	void vscode.window.showInformationMessage(action === "on" ? T.deepseekSwitchedOn : T.deepseekSwitchedOff);
}

// --- Menu ---------------------------------------------------------------

function separatorKind() {
	return vscode.QuickPickItemKind && typeof vscode.QuickPickItemKind.Separator === "number"
		? vscode.QuickPickItemKind.Separator
		: -1;
}

function menuItemFor(session, now) {
	return {
		label: `${STATUS_ICONS[session.status] || STATUS_ICONS.idle} ${session.title || T.untitled}`,
		description: [stateText(session), sessionTime(session, now, false)].filter(Boolean).join(" · "),
		detail: sessionDetail(session),
		sessionId: session.id
	};
}

async function showMenu() {
	const now = Date.now();
	const summary = sessions.summarize(activeStore(), windowId, now);
	const items = summary.mine.map((session) => Object.assign(menuItemFor(session, now), { mine: true }));
	if (summary.others.length > 0) {
		items.push({ label: T.menuOtherWindows, kind: separatorKind() });
		for (const session of summary.others) {
			items.push(Object.assign(menuItemFor(session, now), { other: true }));
		}
	}
	if (deepseekToggleEnabled()) items.push(deepseekMenuItem());
	items.push(
		{ label: `$(add) ${T.menuNewSession}`, action: "new" },
		{ label: `$(refresh) ${T.menuRefresh}`, action: "refresh" },
		{ label: `$(graph) ${T.menuUsage}`, action: "usage" },
		{ label: `$(unmute) ${T.menuSounds}`, action: "sounds" },
		{ label: `$(pulse) ${T.menuDiagnostics}`, action: "diagnostics" }
	);

	const picked = await vscode.window.showQuickPick(items, { title: T.heading });
	if (!picked) return;
	if (picked.mine) {
		const opened = await openSession(picked.sessionId);
		if (opened) markSeen(picked.sessionId);
		return;
	}
	if (picked.other) {
		void vscode.window.showInformationMessage(T.sessionElsewhere);
		return;
	}
	switch (picked.action) {
		case "deepseek":
			await toggleDeepseek();
			break;
		case "new":
			await openNewSession();
			break;
		case "refresh":
			await refreshUsageNow("menu");
			break;
		case "usage":
			await showUsageReport();
			break;
		case "sounds":
			testSounds();
			break;
		case "diagnostics":
			await showDiagnostics();
			break;
		default:
			break;
	}
}

function markSeen(sessionId) {
	if (!sessionId) return;
	if (role === "leader" && store) {
		if (sessions.markSeen(store, sessionId)) {
			observeStore(store);
			scheduleSave();
		}
		return;
	}
	void server.sendControl(readPort(), { action: "seen", sessionId }).catch(() => {});
}

// --- Tab status markers -------------------------------------------------

// Claude's panel hosts, registered by the two hooks patched into Claude's bundle (src/patch.js).
// Both extensions run in the same extension host, so globalThis is shared.
const tabHosts = new Set();

function tabMarkersEnabled() {
	return setting("tabStatusMarkers", true) !== false;
}

// "always" | "untitled" | "off"; a boolean from an early build maps to always / off.
function projectTabTitleMode() {
	const value = setting("projectTabTitle", "always");
	if (value === false || value === "off") return "off";
	return value === "untitled" ? "untitled" : "always";
}

function projectTabTitlesEnabled() {
	return projectTabTitleMode() !== "off";
}

// The project name a Claude tab is called instead of Claude's own title (see projectTabTitleMode).
function projectTabTitle() {
	if (!projectTabTitlesEnabled()) return "";
	return safe(() => {
		let name = String(vscode.workspace.name || "");
		// A multi-root workspace is named "<file> (Workspace)"; the suffix is noise in a tab.
		if (vscode.workspace.workspaceFile) name = name.replace(/\s*\([^)]*\)$/, "");
		name = name.trim();
		return name ? truncateTitle(name) : "";
	}, "");
}

function hostSessionId(host) {
	const anchor = host && host.tabBadgeAnchor;
	return anchor && typeof anchor.sessionId === "string" ? anchor.sessionId : "";
}

function hostStatus(host) {
	const id = hostSessionId(host);
	const current = activeStore();
	const session = id && current && current.sessions ? current.sessions[id] : null;
	return session ? session.status : "";
}

// Re-applies the marker of one host; drops hosts whose panel is gone.
function retitleHost(host) {
	try {
		const panel = host.panelTab;
		if (!panel) return;
		// Until Claude's first rename the panel still carries its creation title, which is raw.
		if (typeof host.__ccTitle !== "string") {
			if (typeof panel.title !== "string") return;
			host.__ccTitle = patch.stripMarker(panel.title);
		}
		const title = patch.decorateTitle(
			host.__ccTitle,
			hostStatus(host),
			tabMarkersEnabled(),
			projectTabTitle(),
			projectTabTitleMode()
		);
		if (panel.title !== title) panel.title = title;
	} catch {
		tabHosts.delete(host);
	}
}

function retitleAllTabs() {
	for (const host of Array.from(tabHosts)) retitleHost(host);
}

function installTabHooks() {
	globalThis.__claudeCompanionTabTitle = (host, raw) => {
		try {
			tabHosts.add(host);
			return patch.decorateTitle(raw, hostStatus(host), tabMarkersEnabled(), projectTabTitle(), projectTabTitleMode());
		} catch {
			return raw;
		}
	};
	globalThis.__claudeCompanionTabSeen = (host) => {
		try {
			tabHosts.add(host);
			retitleHost(host);
		} catch {
			// a marker is cosmetic; never break Claude's own icon update
		}
	};
}

// On deactivate the plain titles go back, so a reload never restores stale markers.
function removeTabHooks() {
	delete globalThis.__claudeCompanionTabTitle;
	delete globalThis.__claudeCompanionTabSeen;
	for (const host of Array.from(tabHosts)) {
		try {
			if (host.panelTab && typeof host.__ccTitle === "string") host.panelTab.title = host.__ccTitle;
		} catch {
			// panel already disposed
		}
	}
	tabHosts.clear();
}

let patchState = "not checked";

// Claude updates often and each version is a new folder, so this runs on every start and whenever
// the set of installed extensions changes.
async function ensureClaudePatched(reason) {
	if (!tabMarkersEnabled() && !projectTabTitlesEnabled()) {
		patchState = "disabled";
		return;
	}
	const ext = vscode.extensions.getExtension(CLAUDE_EXT_ID);
	if (!ext) {
		patchState = "Claude Code not installed";
		return;
	}
	const version = String((ext.packageJSON && ext.packageJSON.version) || "?");
	const file = path.join(ext.extensionPath, "extension.js");
	const result = await patch.patchFile(file);
	if (result.ok && !result.changed) {
		patchState = `patched (Claude ${version})`;
		logLine(`[patch] ${reason}: already patched, Claude ${version}`);
		return;
	}
	if (result.ok && result.changed) {
		patchState = `patched (Claude ${version}), reload pending`;
		logLine(`[patch] ${reason}: patched Claude ${version}`);
		const choice = await vscode.window.showInformationMessage(T.patchReload, T.reloadWindow);
		if (choice === T.reloadWindow) void vscode.commands.executeCommand("workbench.action.reloadWindow");
		return;
	}
	patchState = result.missing ? `anchors not found in Claude ${version}: ${result.missing.join(", ")}` : result.error;
	logLine(`[patch] ${reason}: FAILED ${patchState}`);
	// One warning per Claude version, not one per window and start.
	const key = "claudeCompanion.patchWarned";
	if (safe(() => appContext.globalState.get(key), "") === version) return;
	void safe(() => appContext.globalState.update(key, version));
	void vscode.window.showWarningMessage(T.patchFailed(version));
}

// --- Seen detection -----------------------------------------------------

// Exact when the patch is active: the active panel host knows its session.
function seenFromHosts(reason) {
	for (const host of tabHosts) {
		let active = false;
		try {
			active = !!(host.panelTab && host.panelTab.active);
		} catch {
			continue;
		}
		if (!active) continue;
		const id = hostSessionId(host);
		const status = hostStatus(host);
		if (id && (status === "done" || status === "error")) {
			logLine(`[seen] ${reason}: ${id.slice(0, 8)}`);
			markSeen(id);
		}
		return true;
	}
	return false;
}

function activeTab() {
	const groups = vscode.window.tabGroups;
	if (!groups) return null;
	const group = groups.activeTabGroup;
	return group ? group.activeTab || null : null;
}

function checkActiveTab(reason) {
	try {
		if (vscode.window.state && vscode.window.state.focused === false) return;
		if (seenFromHosts(reason)) return;
		const tab = activeTab();
		if (!tab) return;
		const input = tab.input;
		const viewType = input && typeof input.viewType === "string" ? input.viewType : "";
		if (!viewType.endsWith("claudeVSCodePanel")) return;
		const label = typeof tab.label === "string" ? patch.stripMarker(tab.label) : "";
		if (!label) return;
		const current = activeStore();
		const list = current && current.sessions ? Object.values(current.sessions) : [];
		for (const session of list) {
			if (!session || session.owner !== windowId) continue;
			if (session.status !== "done" && session.status !== "error") continue;
			if (!session.title) continue;
			if (truncateTitle(session.title) === label) {
				logLine(`[seen] ${reason}: ${String(session.id).slice(0, 8)}`);
				markSeen(session.id);
				return;
			}
		}
	} catch (err) {
		logLine(`[seen] ${reason} failed: ${errorText(err)}`);
	}
}

// --- Usage refresh & alerts --------------------------------------------

function refreshUsageNow(reason) {
	if (usageQueued) return usageRefreshChain;
	usageQueued = true;
	const run = () =>
		doRefreshUsage(reason).finally(() => {
			usageQueued = false;
		});
	usageRefreshChain = usageRefreshChain.then(run, run);
	return usageRefreshChain;
}

// Automatic refreshes run in every window; when another window has just fetched, its shared cache
// is adopted instead of hitting the endpoint again (six windows starting together got HTTP 429).
const AUTO_REFRESH_FRESH_MS = {
	start: USAGE_REFRESH_MS - 30000,
	timer: USAGE_REFRESH_MS - 30000,
	done: DONE_REFRESH_MIN_MS
};

// A manual refresh within this time of the last attempt (any window) only re-reads the cache.
const MANUAL_REFRESH_MIN_MS = 60000;

// The usage endpoint is rate limited per account and Claude Code polls it too: six windows each
// fetching on their own got HTTP 429 for good. Only the leader fetches automatically; followers
// read the shared cache, and a 429 backoff recorded in the cache is honoured by everyone.
function shouldFetch(reason, shared, now) {
	const freshMs = AUTO_REFRESH_FRESH_MS[reason];
	if (freshMs) {
		if (role !== "leader") return false;
		if (usage.retryAfter(shared, now)) return false;
		return !usage.isFreshUsage(shared, freshMs, now);
	}
	return !(shared && Number.isFinite(shared.at) && now - shared.at < MANUAL_REFRESH_MIN_MS);
}

async function doRefreshUsage(reason) {
	const started = Date.now();
	const shared = usageFile ? safe(() => usage.loadUsageCache(usageFile), null) : null;
	if (!shouldFetch(reason, shared, started)) {
		if (shared) setUsageCache(shared);
		return;
	}
	try {
		const cache = await usage.refreshUsage({
			env: process.env,
			home: os.homedir(),
			proxyOverride: String(setting("proxy", "") || ""),
			timeoutMs: 15000,
			file: usageFile
		});
		logLine(
			`[usage] ${reason}: claude=${cache.claude.ok ? "ok" : cache.claude.reason || "failed"}` +
				` deepseek=${cache.deepseek ? "ok" : "none"} ${Date.now() - started} ms`
		);
		setUsageCache(cache);
	} catch (err) {
		logLine(`[usage] ${reason} failed: ${errorText(err)}`);
	}
}

function setUsageCache(cache) {
	if (!cache || !Number.isFinite(cache.at)) return;
	if (usageCache && Number(usageCache.at) > Number(cache.at)) return;
	usageCache = cache;
	lastUsageRefreshAt = Math.max(lastUsageRefreshAt, Number(cache.at) || 0);
	scheduleRender();
	checkAlerts();
}

function maybeRefreshAfterDone() {
	if (Date.now() - lastUsageRefreshAt >= DONE_REFRESH_MIN_MS) void refreshUsageNow("done");
}

function alertText(alert) {
	if (!alert || typeof alert !== "object") return "";
	const pct = Math.round((Number(alert.ratio) || 0) * 100);
	if (alert.kind === "5h") return T.alert5h(pct, resetStamp(alert.resetAt, false) || T.unknown);
	if (alert.kind === "7d") return T.alert7d(pct, resetStamp(alert.resetAt, true) || T.unknown);
	if (alert.kind === "deepseek") return T.alertDeepseek(money(alert.total, alert.currency));
	return "";
}

// Only the leader shows limit alerts: every window sees the same cache, so otherwise a quiet
// profile would get one identical toast per open window.
let alertLatchMemo = null;

function checkAlerts(cache) {
	if (role !== "leader" || !appContext) return;
	const data = cache || usageCache;
	if (!data || !data.claude) return;
	const config = {
		alerts: setting("alerts", true) !== false,
		threshold5h: setting("alertThreshold5h", 0.8),
		threshold7d: setting("alertThreshold7d", 0.9),
		deepseekBelowUsd: setting("alertDeepseekBelowUsd", 1)
	};
	// The in-memory copy guards against two checks racing ahead of globalState's async update.
	const latch = alertLatchMemo || safe(() => appContext.globalState.get(ALERT_LATCH_KEY, {}), {});
	let result;
	try {
		result = usage.computeAlerts(usageSlotsOf(data), data.deepseek || null, config, latch);
	} catch (err) {
		logLine(`[alerts] ${errorText(err)}`);
		return;
	}
	alertLatchMemo = result.latch;
	if (JSON.stringify(result.latch) !== JSON.stringify(latch)) {
		try {
			const updated = appContext.globalState.update(ALERT_LATCH_KEY, result.latch);
			if (updated && typeof updated.catch === "function") updated.catch(() => {});
		} catch {
			// a lost latch only means one repeated alert
		}
	}
	for (const alert of result.alerts) {
		const text = alertText(alert);
		if (text) {
			logLine(`[alerts] ${alert.key}`);
			void vscode.window.showWarningMessage(text);
		}
	}
}

// --- Virtual documents --------------------------------------------------

class ReportProvider {
	constructor() {
		this.emitter = new vscode.EventEmitter();
		this.onDidChange = this.emitter.event;
		this.docs = new Map();
	}
	provideTextDocumentContent(uri) {
		return this.docs.get(uri.toString()) || "";
	}
	show(uri, text) {
		const target = typeof uri === "string" ? vscode.Uri.parse(uri) : uri;
		this.docs.set(target.toString(), text);
		this.emitter.fire(target);
		return vscode.window.showTextDocument(target, {
			preview: false,
			viewColumn: vscode.ViewColumn.Beside
		});
	}
	dispose() {
		this.emitter.dispose();
	}
}

function showReport(uri, text) {
	if (!reportProvider) return Promise.resolve(undefined);
	return reportProvider.show(uri, text).then(
		() => undefined,
		(err) => {
			logLine(`[report] cannot open ${uri}: ${errorText(err)}`);
			return undefined;
		}
	);
}

function usageReportText(cache) {
	const lines = [
		T.reportTitle,
		`${T.fetched}: ${cache && Number.isFinite(cache.at) ? localStamp(new Date(cache.at)) : T.never}`,
		""
	];
	if (!cache) {
		lines.push(T.noUsageYet);
		return lines.join("\n") + "\n";
	}
	const claude = cache.claude || {};
	const slots = Array.isArray(claude.slots) ? claude.slots : [];
	if (!claude.ok) lines.push(T.usageRequestFailed(usageFailureText(claude)));
	if (claude.ok || slots.length) {
		lines.push(T.claudeLimits);
		if (slots.length === 0) lines.push(`  ${T.noLimitData}`);
		for (const slot of slots) {
			const reset = resetStamp(slot.resetAt, false);
			lines.push(
				`  ${truncatePlain(slot.label || slot.id, 30)}: ${slotPercent(slot)}%` +
					(reset ? ` — ${T.resets} ${reset}` : "")
			);
			const pace = paceLine(slot, Date.now());
			if (pace) lines.push(`    ${pace}`);
		}
	}
	if (cache.deepseek) {
		lines.push("", T.deepseekSection);
		lines.push(
			`  ${T.balance}: ${money(cache.deepseek.total, cache.deepseek.currency)}` +
				(cache.deepseek.available === false ? ` — ${T.deepseekUnavailable}` : "")
		);
		const ledger = cache.ledger;
		if (ledger && ledger.today && ledger.week) {
			lines.push(`  ${T.today}: ${money(ledger.today.usd, "USD")} (${T.runs(Number(ledger.today.runs) || 0)})`);
			lines.push(`  ${T.days7}: ${money(ledger.week.usd, "USD")} (${T.runs(Number(ledger.week.runs) || 0)})`);
		}
	}
	return lines.join("\n") + "\n";
}

async function showUsageReport() {
	return showReport(USAGE_URI, usageReportText(usageCache));
}

function effectiveProxy() {
	return safe(() => {
		const settings = usage.readClaudeSettings(process.env, os.homedir());
		return usage.resolveProxy(process.env, settings, String(setting("proxy", "") || ""));
	}, null);
}

function lastFetchText(now) {
	if (!usageCache) return T.never;
	const age = usage.formatDuration(Math.max(0, now - Number(usageCache.at)));
	const status =
		usageCache.claude && usageCache.claude.ok
			? "ok"
			: usageFailureText(usageCache.claude || {});
	return `${T.ago(age || "0m")} — ${status}`;
}

function diagnosticsText() {
	const now = Date.now();
	const lines = [T.diagTitle, `${T.updated}: ${localStamp(new Date(now))}`, ""];

	lines.push(T.versions);
	lines.push(`  ${T.vscodeVersion}: ${safe(() => vscode.version, "?") || "?"}`);
	lines.push(`  ${T.companionVersion}: ${extensionVersion()}`);
	const claude = claudeExtension();
	lines.push(
		`  ${T.claudeExtension}: ${claude && claude.packageJSON ? claude.packageJSON.version : T.notInstalled}`
	);

	lines.push("", T.windowSection);
	lines.push(`  windowId: ${windowId}`);
	lines.push(`  ${T.roleLabel}: ${role === "leader" ? T.leader : T.follower}`);
	lines.push(`  ${T.portLabel}: ${readPort()}`);
	lines.push(`  ${T.hooksInstalledLabel}: ${hooksInstalledStatus()}`);
	lines.push(`  ${T.tabMarkersLabel}: ${patchState}; ${T.tabsTracked(tabHosts.size)}`);
	lines.push(`  ${T.settingsFileLabel}: ${safe(() => hooksConfig.settingsPath(), T.unknown) || T.unknown}`);

	const windows = (registryDir && safe(() => registry.listWindows(registryDir), [])) || [];
	lines.push("", T.liveWindows(windows.length));
	if (windows.length === 0) lines.push(`  ${T.none}`);
	for (const win of windows) {
		lines.push(`  ${win.windowId} pid=${win.pid} ${T.foldersLabel}=${win.folders.join("; ") || "-"}`);
	}

	const current = activeStore();
	const list = Object.values((current && current.sessions) || {});
	const counts = { working: 0, waiting: 0, done: 0, error: 0, idle: 0 };
	for (const session of list) {
		if (session && Object.hasOwn(counts, session.status)) counts[session.status]++;
	}
	lines.push("", T.sessionsSummary(list.length, counts));
	if (list.length === 0) lines.push(`  ${T.none}`);
	for (const session of list) {
		const age = Number.isFinite(session.lastEvent) ? usage.formatDuration(Math.max(0, now - session.lastEvent)) : null;
		lines.push(
			`  ${String(session.id).slice(0, 8)} ${T.ownerLabel}=${session.owner || "-"} ` +
				`${T.statusLabel}=${session.status} ${T.titleLabel}="${truncatePlain(session.title, REPORT_TITLE_MAX)}" ` +
				`${T.lastEventLabel}=${age ? T.ago(age) : T.unknown}`
		);
	}

	lines.push("", T.deepseekSection);
	if (!deepseekToggleEnabled()) {
		lines.push(`  ${T.deepseekOff} (claudeCompanion.deepseekToggle)`);
	} else {
		const state = deepseekState();
		lines.push(`  ${T.deepseekRouting}: ${state.on ? T.deepseekOn : T.deepseekOff} (${deepseekScopeText(state.target)})`);
		lines.push(`  ${T.deepseekTargetLabel}: ${(state.target && state.target.file) || "-"}`);
		lines.push(`  ${T.deepseekScriptLabel}: ${deepseekScript()}`);
	}

	lines.push("", T.usageSection);
	lines.push(`  ${T.lastFetchLabel}: ${lastFetchText(now)}`);
	lines.push(`  ${T.proxyLabel}: ${formatProxy(effectiveProxy())}`);

	lines.push("", T.soundSection);
	const spec = SOUND_COMMAND[process.platform];
	if (!spec) {
		lines.push(`  ${T.soundUnavailable}`);
	} else {
		const files = Object.keys(SOUND_FILES).map(
			(kind) => `${kind}${safe(() => fs.existsSync(SOUND_FILES[kind]), false) ? "" : ` (${T.missing})`}`
		);
		lines.push(`  ${T.soundAvailable(spec[0])}`);
		lines.push(`  ${T.soundFiles(files.join(", "))}`);
	}
	return lines.join("\n") + "\n";
}

async function showDiagnostics() {
	return showReport(DIAG_URI, diagnosticsText());
}

// --- Activation ---------------------------------------------------------

function registerCommands(context) {
	const handlers = {
		"claudeCompanion.menu": () => showMenu(),
		"claudeCompanion.usage": () => showUsageReport(),
		"claudeCompanion.refresh": () => refreshUsageNow("command"),
		"claudeCompanion.testSounds": () => testSounds(),
		"claudeCompanion.installHooks": () => commandInstallHooks(),
		"claudeCompanion.removeHooks": () => commandRemoveHooks(),
		"claudeCompanion.deepseekToggle": () => toggleDeepseek(),
		"claudeCompanion.diagnostics": () => showDiagnostics()
	};
	for (const [id, handler] of Object.entries(handlers)) {
		try {
			context.subscriptions.push(
				vscode.commands.registerCommand(id, () => {
					Promise.resolve()
						.then(handler)
						.catch((err) => logLine(`[command] ${id} failed: ${errorText(err)}`));
				})
			);
		} catch (err) {
			logLine(`[command] cannot register ${id}: ${errorText(err)}`);
		}
	}
}

function registerListeners(context) {
	const add = (disposable) => {
		if (disposable) context.subscriptions.push(disposable);
	};
	add(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			registerSelf();
			resetDeepseekCache();
			watchDeepseekFile();
			scheduleRender();
		})
	);
	try {
		const tabGroups = vscode.window.tabGroups;
		if (tabGroups && typeof tabGroups.onDidChangeTabs === "function") {
			add(tabGroups.onDidChangeTabs(() => checkActiveTab("tabs")));
		}
		if (tabGroups && typeof tabGroups.onDidChangeTabGroups === "function") {
			add(tabGroups.onDidChangeTabGroups(() => checkActiveTab("tabGroups")));
		}
	} catch (err) {
		logLine(`[tabs] ${errorText(err)}`);
	}
	try {
		if (typeof vscode.window.onDidChangeWindowState === "function") {
			add(
				vscode.window.onDidChangeWindowState((event) => {
					if (event && event.focused) checkActiveTab("focus");
				})
			);
		}
	} catch (err) {
		logLine(`[focus] ${errorText(err)}`);
	}
	add(
		vscode.workspace.onDidChangeConfiguration((event) => {
			try {
				handleConfigChange(event);
			} catch (err) {
				logLine(`[config] ${errorText(err)}`);
			}
		})
	);
}

function handleConfigChange(event) {
	const affects = (key) => event && typeof event.affectsConfiguration === "function" && event.affectsConfiguration(key);
	if (affects("claudeCompanion.port")) {
		logLine("[config] port changed, restarting the server");
		startCompanionServer();
		if (setting("manageHooks", true) !== false) installManagedHooks("port");
	}
	if (affects("claudeCompanion.manageHooks")) {
		if (setting("manageHooks", true) !== false) {
			installManagedHooks("config");
		} else {
			const result = safe(() => hooksConfig.removeHooks(), { ok: false, error: T.unknown });
			if (!result.ok) logLine(`[hooks] config remove failed: ${result.error}`);
			else logLine(`[hooks] config removed=${result.changed}`);
		}
	}
	if (affects("claudeCompanion.proxy")) void refreshUsageNow("config");
	if (
		affects("claudeCompanion.deepseekToggle") ||
		affects("claudeCompanion.deepseekScope") ||
		affects("claudeCompanion.deepseekScript")
	) {
		resetDeepseekCache();
		watchDeepseekFile();
	}
	if (affects("claudeCompanion.tabStatusMarkers") || affects("claudeCompanion.projectTabTitle")) {
		retitleAllTabs();
		void ensureClaudePatched("config").catch((err) => logLine(`[patch] ${errorText(err)}`));
	}
	if (
		affects("claudeCompanion.alerts") ||
		affects("claudeCompanion.alertThreshold5h") ||
		affects("claudeCompanion.alertThreshold7d") ||
		affects("claudeCompanion.alertDeepseekBelowUsd")
	) {
		checkAlerts();
	}
	scheduleRender();
}

function activate(context) {
	appContext = context;
	// Must be first: CLI processes spawned later in this window inherit it, and the hook header
	// (X-Companion-Window) names the owning window from this variable.
	windowId = ensureWindowId(context);
	process.env.CLAUDE_COMPANION_WINDOW = windowId;

	log = vscode.window.createOutputChannel("Claude Code Companion");
	context.subscriptions.push(log);
	logLine(`[activate] window=${windowId} v${extensionVersion()}`);

	const storageRoot = context.globalStorageUri && context.globalStorageUri.fsPath ? context.globalStorageUri.fsPath : "";
	storageDir = storageRoot;
	if (storageDir) {
		registryDir = path.join(storageDir, WINDOWS_DIR);
		storeFile = path.join(storageDir, STATE_FILE);
		usageFile = path.join(storageDir, USAGE_FILE);
		try {
			fs.mkdirSync(storageDir, { recursive: true });
		} catch (err) {
			logLine(`[storage] cannot create ${storageDir}: ${errorText(err)}`);
		}
	} else {
		registryDir = "";
		storeFile = "";
		usageFile = "";
		logLine("[storage] globalStorageUri is unavailable");
	}

	windowStartedAt = Date.now();
	registerSelf();

	reportProvider = new ReportProvider();
	context.subscriptions.push(
		reportProvider,
		vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, reportProvider)
	);

	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
	statusItem.name = "Claude Code Companion";
	statusItem.command = "claudeCompanion.menu";
	statusItem.text = `${ICON} Claude`;
	statusItem.show();
	context.subscriptions.push(statusItem);

	registerCommands(context);
	registerListeners(context);
	if (storageDir) startWatchers(context);
	if (deepseekToggleEnabled()) watchDeepseekFile();

	usageCache = safe(() => usage.loadUsageCache(usageFile), null);
	if (usageCache) lastUsageRefreshAt = Number(usageCache.at) || 0;

	if (setting("manageHooks", true) !== false) installManagedHooks("activate");

	installTabHooks();
	void ensureClaudePatched("activate").catch((err) => logLine(`[patch] ${errorText(err)}`));
	if (vscode.extensions && typeof vscode.extensions.onDidChange === "function") {
		context.subscriptions.push(
			vscode.extensions.onDidChange(() => {
				void ensureClaudePatched("extensions").catch((err) => logLine(`[patch] ${errorText(err)}`));
			})
		);
	}

	startCompanionServer();
	void reloadSnapshot();
	renderStatusBar();

	usageTimer = setInterval(() => void refreshUsageNow("timer"), USAGE_REFRESH_MS);
	if (usageTimer.unref) usageTimer.unref();
	context.subscriptions.push({
		dispose: () => {
			if (usageTimer) {
				clearInterval(usageTimer);
				usageTimer = null;
			}
		}
	});
	// Deferred: activation must not wait on the network.
	startupTimer = setTimeout(() => {
		startupTimer = null;
		void refreshUsageNow("start");
		// Jitter: when VS Code restarts, all windows activate together; the first one to fetch
		// shares its result and the rest adopt it.
	}, USAGE_START_DELAY_MS + Math.floor(Math.random() * USAGE_START_JITTER_MS));
	if (startupTimer.unref) startupTimer.unref();
}

async function deactivate() {
	logLine("[deactivate]");
	stopTick();
	stopPrune();
	stopDeepseekWatch();
	if (watcher) {
		try {
			watcher.close();
		} catch {
			// already closed
		}
		watcher = null;
	}
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	if (usageTimer) {
		clearInterval(usageTimer);
		usageTimer = null;
	}
	if (startupTimer) {
		clearTimeout(startupTimer);
		startupTimer = null;
	}
	if (soundTimer) {
		clearTimeout(soundTimer);
		soundTimer = null;
	}
	if (renderTimer) {
		clearTimeout(renderTimer);
		renderTimer = null;
	}
	if (snapshotReloadTimer) {
		clearTimeout(snapshotReloadTimer);
		snapshotReloadTimer = null;
	}
	if (usageReloadTimer) {
		clearTimeout(usageReloadTimer);
		usageReloadTimer = null;
	}

	const finishing = flushStore();
	removeTabHooks();
	stopCompanionServer();
	if (statusItem) {
		try {
			statusItem.dispose();
		} catch {
			// already disposed by the subscription
		}
		statusItem = null;
	}
	if (registryDir && windowId) registry.unregisterWindow(registryDir, windowId);
	try {
		const remaining = registryDir ? registry.listWindows(registryDir) : [];
		if (setting("manageHooks", true) !== false && remaining.length === 0) {
			const result = hooksConfig.removeHooks();
			if (result.ok) logLine(`[hooks] deactivate: removed=${result.changed}`);
			else logLine(`[hooks] deactivate FAILED: ${result.error}`);
		}
	} catch (err) {
		logLine(`[hooks] deactivate failed: ${errorText(err)}`);
	}
	return Promise.resolve(finishing).then(
		() => undefined,
		() => undefined
	);
}

module.exports = {
	activate,
	deactivate,
	// Pure helpers exposed for test/extension.test.js (not part of the extension API).
	_test: {
		STR,
		projectTabTitle,
		projectTabTitleMode,
		buildStatusText,
		buildSessionPart,
		buildUsagePart,
		formatTurn,
		formatTokens,
		truncateTitle,
		escapeMarkdown,
		effectApplies,
		collectNewEffects,
		soundDelay,
		buildTooltipMarkdown,
		stateText,
		sessionTime,
		sessionDetail,
		money,
		resetStamp,
		formatProxy,
		slotPercent,
		usageReportText,
		deepseekState,
		deepseekMenuItem,
		deepseekToggleEnabled,
		deepseekStatusPart,
		buildDeepseekPart,
		resetDeepseekCache
	}
};
