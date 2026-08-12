# ASIT — A Study Tool

Local-first study workspace for Windows. One click on a workspace opens everything it needs — embedded browser tabs (Overleaf, course sites), PDFs, notes — exactly where you left them. A focus timer locks the screen to the work. AI runs through your existing [Claude Code](https://claude.com/claude-code) CLI subscription: no API keys, and context is automatic because every workspace *is* a folder the AI works inside.

## Run

```bash
npm install
npm run dev
```

Build a Windows installer (output in `dist/`):

```bash
npm run dist
```

## Requirements

- Windows, Node 22+
- [Claude Code CLI](https://claude.com/claude-code) installed and logged in (`claude` → `/login`). ASIT looks for it at `%USERPROFILE%\.local\bin\claude.exe`; override in Settings. Everything works without it except the AI features.

## How it works

**Workspaces own folders.** Every workspace gets `Documents\ASIT\tasks\<slug>-<id>\` containing an auto-maintained `CLAUDE.md` (task summary, file inventory, tool guidance), `notes.md`, and your PDFs/files. That folder is the working directory for every Claude CLI call, so chat and question generation always have your context — you never paste or explain anything.

**Home is a browser.** The home screen is a scratchpad browser (tabs, address bar, pinning) plus your workspace list, global to-dos, and quick chats. Browse freely; when a session becomes real work, 💾 *Save session* turns the open tabs, notes, and chats into a named workspace.

**Workspace panes.** Websites and PDFs open in embedded browser views (logins persist in the app's own profile — one sign-in per site, like a new laptop; Chrome sessions can't be imported because Chrome's cookies are app-bound encrypted). Panes split left/right or top/bottom, resize, collapse, and are *parked, not closed* when you navigate away — pages never reload when you come back.

**Notes render live.** Obsidian-style: headings, bold, links, and pasted images render in place; the line your cursor is on shows raw markdown. `/` references files (clickable links that open them) and snippets. Lines starting with `to-do:` are captured into the global to-do list — checking one off strikes the line through in your notes. `Term: definition` lines feed the Review tab's key-terms list.

**Focus sessions.** `▶ Focus` starts a stopwatch and engages lockdown: fullscreen, always-on-top, focus re-grab. Time tracks until you deliberately exit — a 30-second hold or a typed escape phrase, both validated in the main process. `⏱` is the optional pomodoro variant; breaks unlock the screen and surface due review questions.

**Recall questions.** On-demand from any PDF's ✨ menu: *extract* existing questions from structured documents or *generate* new ones (multiple-choice supported), including cross-document pipelines ("questions from X, answers from Y"). Scheduled by simplified SM-2 spaced repetition; grade yourself or type an answer for AI grading.

**The agent can drive the app.** Chat runs with file tools scoped to the workspace folder and controls the app through an append-only action protocol — opening resources, adding URLs, filling and clicking elements on open pages (real input events, label-targeted, iframe-aware), saving reusable **skills** (`./name` replays deterministic flows instantly, zero tokens), and setting **watches** that resume work when a page changes ("when the Continue button enables…").

**Quick assistant.** ⚡ (Ctrl+K) opens a compact cross-workspace assistant on the fastest model. `?keywords` greps your logged-in mail without an agent, `?otp` grabs a login code straight to clipboard, `?g query` does an instant extractive Google answer.

**Keyboard-first.** Tab / Shift+Tab cycle a focus ring of the zones that matter (panes → notes → chat), Ctrl+1…9 jump directly, Ctrl+K assistant, Ctrl+L address bar — all working even while an embedded page holds focus.

**Private workspaces.** 🔒 disables AI entirely: no chat, no generation, excluded from the assistant, backups, and indexes — enforced physically (the folder lives outside every AI-readable directory), not by prompt.

**Backup.** Settings → Export produces a zip of workspaces, files, and questions with SR state; sensitive data (escape phrase, logins, usage) is excluded. Import restores everything as new workspaces.

## Honest lockdown limitations (by design)

Alt+Tab briefly escapes before the window re-grabs focus (~1s). Ctrl+Alt+Del, Task Manager, and Win+L are untouched — this is strong friction, not a jail. Lockdown state is never persisted, so a crash can never lock you out of your machine.

## Smoke tests (headless)

```bash
npm run build
```

Then run `npx electron out/main/index.js` with one of: `ASIT_SMOKE=1` (data layer, privacy, to-dos, scratchpad), `ASIT_SMOKE_CHAT=1` (Claude streaming + context + resume), `ASIT_SMOKE_QGEN=1` (question generation + SM-2 + usage), `ASIT_SMOKE_AGENT=1` (agent file tools + app actions), `ASIT_SMOKE_TRANSFER=1` (backup round trip + leak audit). Smoke runs are isolated from real user data.

## License

MIT
