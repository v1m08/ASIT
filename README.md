# ASIT — A Study Tool

**A local-first study & work companion for macOS.** One click on a *workspace* reopens everything that work needs — course sites, Overleaf, PDFs, your notes — exactly where you left them, then a focus timer locks you in. An AI that already knows your context (because every workspace *is* a folder it works inside) can read your material, answer questions, generate recall questions, and even drive the app for you. It runs on your existing [Claude Code](https://claude.com/claude-code) subscription — **no API keys, no cloud, nothing leaves your machine.**

---

## Install

**[⬇ Download ASIT](https://github.com/v1m08/ASIT/releases/latest)**

**macOS (Apple silicon)** — grab `ASIT-*-arm64.dmg` and drag ASIT to
Applications. ASIT is ad-hoc signed but not notarized (that needs a paid Apple
Developer account), so the first launch needs **right-click → Open** rather
than a double-click. If macOS still refuses, clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/ASIT.app
```

ASIT is Mac-first. Windows builds are paused for now (the code still runs
there); Intel Macs aren't shipped because the native voice/terminal modules
are built per-architecture.

*Permissions it may ask for:* **Microphone** (voice/dictation, processed
locally) and **Accessibility** (only if you embed an app window — macOS has no
way to put another app's window inside ours, so ASIT keeps the real window
positioned exactly over the tab). Updates: download the new `.dmg` from
Releases — self-update needs a notarized app.

## Where your stuff lives (and why it's private)

Everything is on your machine, in two places **outside this repo**, shared by dev and installed builds:

- **`~/ASIT/`** — `tasks/` (one folder per workspace = the AI's context), `private/` (no-AI workspaces), `library/`, `skills/`, `.trash/`. (Older versions used `~/Documents/ASIT`; it moves here automatically — ~/Documents is privacy-gated on macOS.)
- **`~/Library/Application Support/asit`** — the SQLite database (workspaces, questions, chats, browsing history), your browser-profile logins, and the encrypted password vault. If something misbehaves, **`asit-errors.log`** in that folder has the real error and stack, rather than the one-line version the UI shows.

Uninstalling or reinstalling never erases this. The AI only ever sees a workspace's own folder (and, for Jarvis, all non-private workspaces) — private workspaces sit physically outside every AI path, and nothing is ever sent to a server.

## 🛡 Guardrails — what the assistant can never do

These are enforced in the app, not by asking the model nicely. A confused or prompt-injected agent hits the same walls.

| Wall | What it means in practice |
|---|---|
| **Protected topics are unsearchable** | Any mail search mentioning a protected term is **refused before the page is ever loaded** — passwords, taxes/IRS/1099, SSN, bank/routing/card numbers, medical, legal, passports. Matching results are also stripped out of *other* searches, so a harmless query can't accidentally surface a tax email. The model never receives the text. Add your own terms in **Settings → Guardrails** (they're added to the built-ins, which can't be removed). |
| **Sending is deny-by-default** | The assistant may freely **read, search, summarize and draft** — but it can only *send* when the message you just typed asked it to ("text Mom that I'm late", "reply to that email saying yes"). "Summarize my inbox" grants nothing. Authority expires with the turn. |
| **Email is stricter still** | Even when authorized, the **Send button and Ctrl+Enter are dead** in an embedded Gmail/Outlook tab unless you explicitly asked for a send. Drafting always works. |
| **Recipient allowlist** *(optional)* | Add names/numbers in Settings to limit messaging to just those people. |
| **Every send is announced** | A toast names the exact recipient — including blocked attempts. |

Actions are shown in plain language as they happen (*"📨 Sending WhatsApp to Mom", "🌐 Opening canvas.gatech.edu", "🖱 Clicking Submit"*), not as raw file writes or shell commands.

**A note on safety.** The AI can read untrusted content (web pages, PDFs) while holding your logged-in sessions, so it's hardened against prompt-injection: it can't reach local files, can't run custom URL schemes, every page navigation it makes is shown to you, messaging requires your explicit ask, and instruction files are regenerated each turn so tampering can't persist. For anything sensitive (banking, personal docs), use a 🔒 **private workspace** — it's outside the AI's reach entirely. Coding-mode workspaces get a real terminal (with a confirmation), so treat those as fully trusted.

## Honest lockdown limitations (by design)

Alt+Tab briefly escapes before the window re-grabs focus (~1s). Ctrl+Alt+Del, Task Manager, and Win+L are untouched — this is strong friction, not a jail. Lockdown state is never persisted, so a crash can never lock you out of your machine.

---

## For developers

```bash
npm install
npm run dev        # HMR dev
npm run typecheck  # both tsconfigs
npm run icon       # regenerate build/icon.ico from the app's own logo mark
npm run dist       # Windows installer → dist/  (nothing published)
```

**Requirements:** Windows or macOS, Node 22+. `npm run smoke` runs every test that doesn't need a logged-in CLI — that is what CI runs on both platforms.

**Shipping a version.** Tag it and push — CI builds the installer, attaches it
to a GitHub Release, and that release *is* the update feed every installed copy
polls, so releasing and delivering are one action:

```bash
npm version patch && git push --follow-tags
```

`npm run release` does the same thing from your own machine if you'd rather
(needs `GH_TOKEN`). The icon is generated rather than committed, so it can
never drift from the mark the app actually draws.

**Architecture** lives in [`CLAUDE.md`](CLAUDE.md) — the load-bearing invariants (task-folder-as-context, WebContentsView z-order, pane ownership, private-task isolation, agent containment) are documented there.

**Smoke tests** (after `npm run build`, run `npx electron out/main/index.js` with one env var):
`ASIT_SMOKE=1` (data layer, privacy, to-dos, scratchpad) · `ASIT_SMOKE_CHAT=1` (Claude streaming + resume) · `ASIT_SMOKE_QGEN=1` (question generation + SM-2) · `ASIT_SMOKE_AGENT=1` (agent file tools + app actions) · `ASIT_SMOKE_TRANSFER=1` (backup round trip + leak audit) · `ASIT_SMOKE_PANES=1` (pane ownership) · `ASIT_SMOKE_COMPANION=1` (phone server) · `ASIT_SMOKE_JARVIS=1` (universal agent — needs a logged-in CLI) · `ASIT_SMOKE_VOICE=1` (speech round-trip) · `ASIT_SMOKE_SECURITY=1` (agent-containment invariants) · `ASIT_SMOKE_TERMINAL=1` (terminal containment; spawns a real pty) · `ASIT_SMOKE_UI=1` (boots the real renderer and checks controls are actually clickable). Smoke runs are isolated from real user data.

## License

MIT
