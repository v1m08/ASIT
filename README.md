# ASIT — A Study Tool

**A local-first study & work companion for Windows.** One click on a *workspace* reopens everything that work needs — course sites, Overleaf, PDFs, your notes — exactly where you left them, then a focus timer locks you in. An AI that already knows your context (because every workspace *is* a folder it works inside) can read your material, answer questions, generate recall questions, and even drive the app for you. It runs on your existing [Claude Code](https://claude.com/claude-code) subscription — **no API keys, no cloud, nothing leaves your machine.**

---

## Get started in 3 minutes

1. **Install & sign in to the AI.** ASIT uses the [Claude Code CLI](https://claude.com/claude-code) (`claude` → `/login`, once). Everything works without it except the AI features.
2. **Open ASIT** (desktop icon / Start menu). You land on the **scratchpad** — a browser with your workspace sidebar.
3. **Make your first workspace.** Browse to a course page or open a PDF, then hit **💾 Save session** — or click **+ New workspace** in the sidebar. That folder is now the AI's context; you never paste or explain anything.
4. **Try the AI.** Open a PDF in the workspace, press **`Ctrl+K`**, and ask a question about it. Or press **`Ctrl+Space`** and just *talk* to it.

That's the whole loop: **gather → focus → study → ask.** Everything below is detail you can pick up as you go.

---

## What you can do

### 📚 Study & organize
| Feature | How |
|---|---|
| **Workspaces** | Each is a folder of everything one task needs — tabs, PDFs, notes, chats — reopened in one click, laid out how you left it. |
| **Embedded panes** | Websites & PDFs open *inside* the app; split left/right or top/bottom, resize, collapse. Logins persist (sign in once per site). Pages are *parked, not closed* when you leave — no reloads. |
| **Live-preview notes** | Markdown that renders as you type (Obsidian-style): headings, **bold**, links, pasted images. `Ctrl+E` for raw. |
| **Recall questions** | On any PDF's ✨ menu: *extract* existing questions or *generate* new ones (multiple-choice supported). Surfaced by spaced repetition (SM-2) on the home screen and during breaks. |
| **🧠 Review tab** | Due questions, all questions, and **key terms** (write `Term: definition` in notes → they appear here). |
| **Global to-dos** | A sidebar list. Writing `to-do: …` in any note auto-captures it; checking it off strikes the note line through. |

### 🎯 Focus
| Feature | How |
|---|---|
| **Focus session** | `▶ Focus` starts a stopwatch and **lockdown** — fullscreen, always-on-top, focus re-grab. |
| **Deliberate exit** | Leave only via a **30-second hold** or a typed **escape phrase** — enough friction to beat the impulse, never a jail (see limitations below). |
| **Pomodoro** | `⏱` is the optional work/break variant; breaks unlock the screen and surface due questions. |

### 🤖 AI that acts, not just answers
| Feature | How |
|---|---|
| **Chat** (per workspace) | Reads your PDFs & notes automatically. Can also **drive the app**: open resources, fill & click page elements, generate questions — and reports back what it did. |
| **⚡ Quick assistant** (`Ctrl+K`) | Fast, read-only, cross-workspace lookups. Also the home of the `?`/`>` commands below. |
| **🤖 Jarvis** (`Ctrl+J`) | The universal agent — works *across* all workspaces and takes action: *"add the syllabus link to CS 1331", "what's due anywhere this week?", "generate 10 questions from the bio slides."* |
| **🎙 Voice** (`Ctrl+Space`) | **Talk** to Jarvis. Speech recognition is 100% local (one-time ~130MB model download); pause to send, replies spoken back. |
| **⚡ Skills** | The agent saves successful procedures as `./name`. Deterministic ones replay instantly with zero tokens. |
| **👁 Watches** | *"When the Continue button appears, click it"* — the agent resumes work when a page changes, even while you're away. |

### 🔌 Connect
| Feature | How |
|---|---|
| **📱 Phone companion** | Serve a phone web-app over your own [Tailscale](https://tailscale.com) network (free, private, nothing exposed to the internet). Get to-dos, review, quick capture, and the assistant on your phone — with **offline support** (study on the bus; changes sync when the PC is back) and **push notifications** (watches firing, jobs finishing). |
| **💬 WhatsApp** | Send messages from your own linked account without opening WhatsApp: type `> name: message`. See *Commands* below. |
| **🔎 Quick fetch** | `?keywords` greps your logged-in mail for a value; `?otp` grabs a login code to clipboard; `?g query` gives an instant answer. |
| **🔑 OTP autofill** | Click a verification-code box on any site and the code from your mail lands in it — split-digit boxes included. Or type `/otp ` anywhere. Nothing is stored; it's fetched at that moment. |
| **🛡 Guardrails** | Protected topics (passwords, taxes, SSN/bank, medical, legal…) are **unsearchable** by the assistant, and sending is **off unless you ask for it in that message**. See below. |
| **📎 Library & 🔒 privacy** | A global file library to attach into workspaces; 🔒 **private workspaces** disable AI entirely (physically outside every AI-readable folder). |

---

## Commands (in the ⚡ assistant bar / phone Ask tab)

| Type this | What happens |
|---|---|
| `?g when is the hackathon deadline` | Instant extractive answer from Google — built for speed. |
| `?otp` | Pulls the newest login code from your mail → clipboard. Usually unnecessary: focusing a code field on any page autofills it. |
| `?keywords` | Greps your default mail source (Gmail) for those words. First word can target another source: `?outlook interview`. |
| `> Mom: running 10 late` | Sends that WhatsApp message from your own account. No AI touches the text; it reports exactly who it went to. |

*(In notes and chat, `/` references a file or snippet, `./` runs a skill, and `/KEY ` expands a saved snippet — set snippets in Settings.)*

## Keyboard

| Keys | What |
|---|---|
| `Tab` / `Shift+Tab` | Move between the panes/notes/chat that matter (not every DOM element). |
| `Ctrl+1…9` | Jump straight to a zone. |
| `Ctrl+K` / `Ctrl+J` | Toggle the ⚡ quick assistant / 🤖 Jarvis. |
| `Ctrl+Space` | Talk to Jarvis (pause to send). |
| `Ctrl+L` | Focus the scratchpad address bar. |
| `Ctrl+E` | Notes: toggle live-preview ↔ raw markdown. |
| 30-sec hold / escape phrase | The two ways out of a focus session. |

---

## Where your stuff lives (and why it's private)

Everything is on your machine, in two places **outside this repo**, shared by dev and installed builds:

- **`Documents\ASIT\`** — `tasks\` (one folder per workspace = the AI's context), `private\` (no-AI workspaces), `library\`, `skills\`, `.trash\`.
- **`%APPDATA%\asit`** — the SQLite database, your browser-profile logins.

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
npm run dist       # Windows installer → dist/
```

**Requirements:** Windows, Node 22+.

**Architecture** lives in [`CLAUDE.md`](CLAUDE.md) — the load-bearing invariants (task-folder-as-context, WebContentsView z-order, pane ownership, private-task isolation, agent containment) are documented there.

**Smoke tests** (after `npm run build`, run `npx electron out/main/index.js` with one env var):
`ASIT_SMOKE=1` (data layer, privacy, to-dos, scratchpad) · `ASIT_SMOKE_CHAT=1` (Claude streaming + resume) · `ASIT_SMOKE_QGEN=1` (question generation + SM-2) · `ASIT_SMOKE_AGENT=1` (agent file tools + app actions) · `ASIT_SMOKE_TRANSFER=1` (backup round trip + leak audit) · `ASIT_SMOKE_PANES=1` (pane ownership) · `ASIT_SMOKE_COMPANION=1` (phone server) · `ASIT_SMOKE_JARVIS=1` (universal agent — needs a logged-in CLI) · `ASIT_SMOKE_VOICE=1` (speech round-trip) · `ASIT_SMOKE_SECURITY=1` (agent-containment invariants). Smoke runs are isolated from real user data.

## License

MIT
