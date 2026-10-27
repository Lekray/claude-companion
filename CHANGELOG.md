# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Claude Code tabs are named after the project (workspace) instead of "Claude Code" and the generated session titles (setting `claudeCompanion.projectTabTitle`: `always` by default, `untitled` = only until the session gets its own title, `off`). It uses the same Claude Code patch as the tab status markers, which is now applied while either feature is on.

## [0.3.0] - 2026-10-24

### Added

- DeepSeek routing switch. The Companion menu (click the status bar item) and the status bar tooltip show whether new Claude chats go through `api.deepseek.com`, and one click switches it either way. The switch runs the `claude-ds` script — which owns the API key, the backup files and the `.gitignore` guard — through the extension host's own Node, so the companion never handles that secret. While the routing is on, the status bar also carries the DeepSeek balance and today's worker spend (`DS $3.42 (−$0.18)`, setting `claudeCompanion.deepseekInStatusBar`).
New settings: `claudeCompanion.deepseekToggle`, `claudeCompanion.deepseekScope` (`project` = `.claude/settings.local.json` of the first folder, `user` = `~/.claude/settings.json`) and `claudeCompanion.deepseekScript`. New command: `Claude Companion: Toggle DeepSeek`. The state is read from the settings file (cached for 2 s), and the switch applies to new chats, because Claude Code reads the profile when its CLI starts.

## [0.2.2] - 2026-10-18

### Fixed

- Limits stopped updating: the usage endpoint answered HTTP 429 for good because every window fetched on its own (plus Claude Code itself). Now only the leader window fetches automatically (every 5 min and after any finished turn); followers read the shared cache. A 429 starts a shared backoff of 5 → 10 → 20 → 30 min shown in the tooltip ("next attempt at …"), and a manual refresh within 60 s of the last attempt only re-reads the cache.

## [0.2.1] - 2026-10-18

### Fixed

- The 5-hour limit alert repeated on every refresh: the API's `resets_at` jitters by fractions of a second between calls, so each answer looked like a new limit window. Reset times within 5 minutes now count as the same window, and the alert latch is also kept in memory so two quick checks cannot both fire.
- The session store could fail to save on Windows while another window was reading it; the replace is now retried briefly.

## [0.2.0] - 2026-10-18

### Added

- Status markers in Claude Code tab titles: `[~]` working, `[?]` waiting for you, `[V]` done, `[!]` error (setting `claudeCompanion.tabStatusMarkers`). VS Code gives no access to another extension's tabs, so two small hooks are patched into Claude Code's `extension.js` (a pristine `.bak-claude-companion` copy is kept). The patch is all-or-nothing, re-applied automatically after Claude updates (one window reload each time), and if Claude's code changes beyond recognition the markers switch off with a single warning while everything else keeps working.
- Seen detection is exact when the patch is active (the active panel knows its session).

## [0.1.1] - 2026-10-18

### Fixed

- Limits vanished from the status bar after a window reload: every window fetched at once, the endpoint answered HTTP 429 and the failure replaced the good numbers. A failed refresh now keeps the last good limits (shown with their time for up to 2 hours), automatic refreshes adopt a result another window fetched recently, and start-up fetches are spread over a few seconds.
- The idle button reads "Claude" instead of a bare glyph, and is named "Claude Code Companion" in the status bar's context menu.

## [0.1.0] - 2026-10-18

### Added

- Session statuses in the status bar (`~` working, `?` waiting for you, `V` done, `!` error) with per-window counters, the longest running turn and a session menu that focuses the Claude tab.
- Sounds for done, waiting and error, plus a minimum turn length (`doneSoundMinSeconds`) so short questions stay silent.
- Claude subscription limits (5-hour and 7-day windows, extra weekly buckets when the API reports them) with a graphical bar, pace, depletion forecast, reset countdown and per-window threshold alerts.
- DeepSeek balance and today / last-7-days worker spend from the `ds.py` ledger.
- One-time context-size warning at `contextWarnTokens`.
- Claude Code HTTP hooks written to `~/.claude/settings.json` while a window is open and removed when the last one closes; no patching of the official Claude extension.
- Leader election on `127.0.0.1` so any number of VS Code windows share one receiver, with nested sessions (DeepSeek workers, `claude -p`) hidden by default.
- Commands: Menu, Usage, Refresh Limits, Test Sounds, Install Hooks, Remove Hooks, Diagnostics.
- Localization for English, Russian and Simplified Chinese (UI strings and plugin manifest).
- Bundled original icon font, application icon and three WAV cues, generated deterministically by `scripts/gen-assets.py`.
- Offline unit tests (`node --test "test/**/*.test.js"`), a dependency-free `.vsix` builder and a CI workflow.
