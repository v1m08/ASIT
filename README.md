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

**Jarvis — the universal agent.** 🤖 (Ctrl+J) opens the agent that works *across* workspaces and acts, not just answers: "add the syllabus link to CS 1331", "what's due anywhere this week?", "generate questions from the bio slides". It reads every AI-enabled workspace, drives the app through the same action protocol as workspace chats (with explicit per-workspace targeting only it is allowed to use), and keeps a deliberately bounded rolling session — context stays cheap. Also available on the phone (Ask tab → 🤖). Voice is the planned next mouth for the same core.

**Quick assistant.** ⚡ (Ctrl+K) opens a compact cross-workspace assistant on the fastest model. `?keywords` greps your logged-in mail without an agent, `?otp` grabs a login code straight to clipboard, `?g query` does an instant extractive Google answer.

**Keyboard-first.** Tab / Shift+Tab cycle a focus ring of the zones that matter (panes → notes → chat), Ctrl+1…9 jump directly, Ctrl+K assistant, Ctrl+L address bar — all working even while an embedded page holds focus.

**Private workspaces.** 🔒 disables AI entirely: no chat, no generation, excluded from the assistant, backups, and indexes — enforced physically (the folder lives outside every AI-readable directory), not by prompt.

**Phone companion.** Settings → 📱 Phone serves a small web app to your phone over your own [Tailscale](https://tailscale.com) network (free, WireGuard-encrypted, nothing exposed to the internet). Scan the QR, *Add to Home Screen*, and you get: global to-dos, spaced-repetition review on the go, quick capture into the scratchpad (with `to-do:` auto-capture), and the quick assistant (`?g` / `?otp` included). Push notifications — watches firing, question jobs finishing, chat replies landing while you're away — arrive via standard Web Push, whose payloads are end-to-end encrypted (RFC 8291), so relays only ever see ciphertext. Pairing is a random token in the QR; revoke it any time.

**Backup.** Settings → Export produces a zip of workspaces, files, and questions with SR state; sensitive data (escape phrase, logins, usage) is excluded. Import restores everything as new workspaces.

## Cheat sheet

### Keyboard

| Keys | Where | What |
|---|---|---|
| `Tab` / `Shift+Tab` | everywhere (even inside an embedded page) | Cycle the focus ring — only the zones that matter: panes → notes → chat, wrapping around. Landing on the chat puts the caret in the message box. Inside dialogs and small forms, Tab stays field-to-field. |
| `Ctrl+1` … `Ctrl+9` | everywhere | Jump straight to zone N. Workspace: `1` left pane, `2` right pane, `3` chat. Home: `1` workspace list, `2` browser, `3` notes, `4` chat. |
| `Ctrl+K` | everywhere | Toggle the ⚡ quick assistant — opens with the cursor ready; pressing it again (or `Esc`) closes it and returns focus where you were. |
| `Ctrl+J` | everywhere | Toggle 🤖 Jarvis, the universal agent (same return-focus behavior). |
| `Ctrl+L` | home | Focus the browser address bar, text selected. `Esc` returns. |
| `↑` / `↓`, `Enter` | workspace list | Walk the list, open the selected workspace. |
| `Enter` / `Shift+Enter` | chat + assistant | Send / newline. While a `/` or `./` popup is open, `↑↓` pick, `Enter` or `Tab` insert, `Esc` dismisses. |
| `Ctrl+E` | notes | Toggle live preview ↔ raw markdown (also the `⟨⟩` hover button, top-right). |
| 30-second hold, or typed escape phrase | lockdown | The only two ways out of a focus session. |

### Text triggers

| Type | Where | What happens |
|---|---|---|
| `to-do: buy poster board` | any notes line | Captured into the global to-do list (sidebar ☑). Checking it off strikes the line through; deleting the line removes the to-do. Works after bullets, `#` headings, and `- [ ]` checkboxes too. |
| `Polymorphism: one interface, many types` | any notes line | Becomes a key term in the workspace's 🧠 Review → Key terms tab (blur-to-reveal, one click to add all to spaced repetition). |
| `/` | notes, chat | Reference popup: workspace files (inserts a clickable link that opens the file) and snippets. |
| `/KEY ` (trailing space) | chat, notes, assistant, **and any web form in a pane** | Expands the snippet you defined in Settings → Snippets (e.g. `/gtem ` → your email). |
| `./` | chat | Skill popup. ⚡ skills replay a saved flow instantly with zero tokens; 🤖 skills brief the agent. The agent saves new skills after a successful run. |
| `?keywords` | assistant | Agentless grep of your default mail source (Gmail) in a hidden logged-in page — no tokens. First word = source name to target another (`?outlook interview time`). |
| `?otp` | assistant | Pulls the newest login code from mail → clipboard, and auto-types it into the visible page. |
| `?g query` | assistant | Instant Google answer, extractive (built for speed: deadlines, dates, numbers). |
| paste an image | notes | Saved into the workspace's `files/` and shown inline. |

### Places

| Name | What it is |
|---|---|
| **Scratchpad** (home) | The free browser + notes + chat on the home screen. 💾 *Save session* turns it into a named workspace and resets it. |
| **Status cluster** (header, right side) | Running background work (click a pill to jump to its workspace), question-job progress, transient results, and the ⚡ assistant launcher. |
| **Resource rail** (workspace, left edge) | The workspace's tabs/PDFs/notes/files; ✨ on a PDF for question extraction/generation; 📎 attaches from the global library. |
| **🧠 Review** (workspace tab) | Due questions, all questions, key terms. |
| **⋯ menu** (workspace row) | Rename, due date, priority, 🔒 private (no-AI), coding mode, archive, delete (files go to a trash folder, never erased). |
| **`Documents\ASIT\`** | All your real data: `tasks\` (one folder per workspace — also the AI's context), `private\`, `library\`, `skills\`, `.trash\`. The app's database and logins live in `%APPDATA%\asit`. Neither is part of this repo. |

## Honest lockdown limitations (by design)

Alt+Tab briefly escapes before the window re-grabs focus (~1s). Ctrl+Alt+Del, Task Manager, and Win+L are untouched — this is strong friction, not a jail. Lockdown state is never persisted, so a crash can never lock you out of your machine.

## Smoke tests (headless)

```bash
npm run build
```

Then run `npx electron out/main/index.js` with one of: `ASIT_SMOKE=1` (data layer, privacy, to-dos, scratchpad), `ASIT_SMOKE_CHAT=1` (Claude streaming + context + resume), `ASIT_SMOKE_QGEN=1` (question generation + SM-2 + usage), `ASIT_SMOKE_AGENT=1` (agent file tools + app actions), `ASIT_SMOKE_TRANSFER=1` (backup round trip + leak audit), `ASIT_SMOKE_PANES=1` (pane ownership: an agent can only see/drive its own workspace's tabs), `ASIT_SMOKE_COMPANION=1` (phone server: token auth, to-dos, capture, push subscriptions, static whitelist). Smoke runs are isolated from real user data.

## License

MIT
