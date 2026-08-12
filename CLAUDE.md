# ASIT — architecture notes for Claude Code

Electron (electron-vite + React + TS) study app. Windows-first.

## Structure

- `src/shared/` — `types.ts` (all domain types), `ipc-contract.ts` (every IPC channel name; single source of truth)
- `src/main/db/` — better-sqlite3, WAL, numbered migrations via `PRAGMA user_version` (append-only; never edit an existing migration)
- `src/main/services/` — one service per domain: `tasks` (CRUD, folders, CLAUDE.md, scratchpad, privacy), `resources`, `panes` (WebContentsView manager + page bridge), `claude` (CLI spawn + NDJSON parse), `chat`, `assistant` (global haiku bar), `timer` (stopwatch/pomodoro state machine), `lockdown`, `questions` (job queue + SM-2), `actions` (AI app-control protocol), `accounts`, `library`, `transfer` (backup zip), `usage` (token/cost log), `settings`
- `src/preload/index.ts` — typed `window.asit` bridge; `index.d.ts` mirrors it for the renderer
- `src/renderer/src/` — React UI; zustand store; screens `Home` / `Workspace`

## Load-bearing invariants

1. **Task folder = AI context.** Every task owns `Documents\ASIT\tasks\<slug>-<id>\` with an auto-maintained `CLAUDE.md`. All `claude` CLI spawns use `cwd = task folder`. Resource changes must call `tasks.refreshClaudeMd(taskId)`.
2. **WebContentsViews paint above ALL renderer DOM.** Any overlay/modal must hide views first — always use the `useOverlay()` hook (`src/renderer/src/hooks/useOverlay.ts`), never roll your own modal. Corollary for persistent chrome: a floating indicator over the pane area is invisible, so status UI belongs in the header row (`StatusCluster`) and anything docked must reserve layout space (`body.assistant-open` margin) — never reserve a strip just to park a floating widget.
3. **Timer + lockdown live in main.** Escape friction (30s hold, phrase) is validated in main (`timer.holdRelease`/`phraseRelease`); renderer UI is display-only. Never persist lockdown state.
4. **Claude CLI**: resolved at `%USERPROFILE%\.local\bin\claude.exe` (NOT on PATH), override via settings. `stream-json` requires `--verbose`. Prompts go via stdin. Chat spawns with `--allowedTools "Read(**),Glob,Grep(**),Edit(**),Write(**)"` — ALL file access is cwd-scoped to the task folder (`**` patterns verified to deny absolute paths outside cwd); the global assistant gets read-only `Read(**),Glob,Grep(**)` with cwd = tasks root. Private tasks (invariant 8) rely on this scoping.
5. **User files are never hard-deleted** — task deletion moves folders to `tasks\.trash\`.
6. **Agent app-control protocol** (`src/main/services/actions.ts`): chat spawns get `Edit(**),Write(**)` (cwd-scoped) and drive the app by appending JSON lines to `<task>\.asit\actions.ndjson` (open/add_url/add_questions/set_task); main watches the file and executes new lines, pushing `app:event` to the renderer. The protocol is documented for the model inside each task's generated CLAUDE.md (see `tasks.writeClaudeMd`). NotesEditor live-reloads external edits via `notes:watch`.
7. **Account logins** (`src/main/services/accounts.ts`): all embedded panes share `persist:asit-browse`; the accounts modal (first-run + Settings) opens provider login windows on that partition. Chrome session import is impossible (app-bound cookie encryption) — do not attempt it.
8. **Private (no-AI) tasks**: `tasks.ai_disabled=1` folders live under `Documents\ASIT\private\` — physically outside every AI cwd (tasks root, task folders). Chat/generation/grading/assistant/index/export must all exclude them; trash lives at `Documents\ASIT\.trash` (also outside). Never weaken this to a prompt-level exclusion.
9. **Smoke tests never touch real user data** — they run with their own userData and a temp documents dir; keep it that way when adding smoke modes.
10. **Keyboard focus is a ring, not DOM order.** `hooks/useFocusRing.ts` (installed once in `App.tsx`) owns Tab/Shift+Tab, Ctrl+1…9, Ctrl+K/Ctrl+L. New panels must declare themselves with `data-focus-zone` (+ `data-focus-pane` for a WebContentsView, `data-focus-target`/`data-focus-body` to pick the control) — nothing else is a tab stop. Focused pages swallow keys, so `panes.ts`'s `before-input-event` replays those shortcuts as `APP_EVENT`s; main only focuses panes (`panes:focus`).
11. **Never `require('./relative')` in main-process code.** Rollup leaves a bare `require` untransformed, so in the bundled `out/main/index.js` it resolves against the output directory and throws MODULE_NOT_FOUND at runtime — usually inside a `try/catch` that silently swallows it, so the feature is simply dead in the packaged app while working in dev. Use a static `import`, or `await import('./x')` (which rollup does transform) when a cycle must be broken. Node builtins are fine either way.

## Commands

- `npm run dev` — HMR dev
- `npm run typecheck` — both tsconfigs (run after changes)
- `npm run build` — production build to `out/`
- `npm run dist` — NSIS installer to `dist/`
- Headless smoke tests (after build): env `ASIT_SMOKE=1` | `ASIT_SMOKE_CHAT=1` | `ASIT_SMOKE_QGEN=1` | `ASIT_SMOKE_AGENT=1` | `ASIT_SMOKE_TRANSFER=1` with `npx electron out/main/index.js` (bottom of `src/main/index.ts`). Smoke runs are isolated: own userData (%APPDATA%\Electron) and documents redirected to temp — they must never touch real user data.
