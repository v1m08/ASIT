import { useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import type { Settings } from '@shared/types'
import { useOverlay } from '../hooks/useOverlay'
import { useStore } from '../store/useStore'
import AccountsModal from './AccountsModal'

function SnippetAdder({ onAdd }: { onAdd: (key: string, value: string) => void }): JSX.Element {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')

  function add(): void {
    const cleanKey = key.replace(/^\//, '').replace(/[^A-Za-z0-9_-]/g, '')
    if (!cleanKey || !value.trim()) return
    onAdd(cleanKey, value.trim())
    setKey('')
    setValue('')
  }

  return (
    <div className="snippet-add">
      <input placeholder="/GTID" value={key} onChange={(e) => setKey(e.target.value)} />
      <input placeholder="value to insert" value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="button" className="btn" onClick={add} disabled={!key || !value.trim()}>
        +
      </button>
    </div>
  )
}

// A newline-separated list, edited as text. Local state so a half-typed line
// (or a trailing newline) doesn't get mangled on every keystroke.
function ListField({
  label,
  hint,
  placeholder,
  value,
  onChange
}: {
  label: string
  hint: string
  placeholder: string
  value: string[]
  onChange: (next: string[]) => void
}): JSX.Element {
  const [text, setText] = useState(value.join('\n'))
  return (
    <label className="settings-field">
      {label}
      <textarea
        rows={3}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          onChange(
            e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
          )
        }}
      />
      <span className="field-hint">{hint}</span>
    </label>
  )
}

function GuardrailsSection({
  settings,
  setSettings
}: {
  settings: Settings
  setSettings: (s: Settings) => void
}): JSX.Element {
  return (
    <div className="snippets-section">
      <div className="rail-header">Guardrails — what the assistant may never touch</div>
      <p className="transfer-note"> Enforced in the app, not in the prompt. Blocked searches never run, so protected mail never
        reaches the model; sending is off unless the message you just typed asks for it.
      </p>
      <ListField
        label="Protected topics (extra)"
        hint="Any assistant email search containing one of these is refused outright, and matching results are stripped from anything it does read. Built-ins already cover passwords, taxes, SSN/bank/card numbers, medical, legal, and passports — one per line."
        placeholder={'landlord\nvenmo'}
        value={settings.sensitiveTerms ?? []}
        onChange={(sensitiveTerms) => setSettings({ ...settings, sensitiveTerms })}
      />
      <ListField
        label="Send allowlist"
        hint="Leave empty to allow any recipient (still only when you explicitly ask). Add names or numbers to restrict messaging to just those — one per line."
        placeholder={'Mom\n+1404…'}
        value={settings.sendAllowlist ?? []}
        onChange={(sendAllowlist) => setSettings({ ...settings, sendAllowlist })}
      />
    </div>
  )
}

interface VaultRow {
  id: string
  origin: string
  username: string
  title: string
  updatedAt: string
}

function VaultSection(): JSX.Element {
  const [rows, setRows] = useState<VaultRow[]>([])
  const [encrypted, setEncrypted] = useState(true)
  const [site, setSite] = useState('')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})

  const refresh = async (): Promise<void> => setRows(await window.asit.vault.list())

  useEffect(() => {
    void refresh()
    void window.asit.vault.status().then((s) => setEncrypted(s.encrypted))
  }, [])

  async function add(): Promise<void> {
    const res = await window.asit.vault.save({ origin: site, username: user, password: pass })
    if (res?.error) {
      setMsg(res.error)
      return
    }
    setSite('')
    setUser('')
    setPass('')
    setMsg(null)
    await refresh()
  }

  return (
    <div className="snippets-section">
      <div className="rail-header">Passwords — autofill inside ASIT's browser</div>
      <p className="transfer-note"> Stored on this machine only, encrypted with Windows’ own account protection, and kept
        outside every folder the AI can read. <strong>No agent can see these</strong> — there is no
        action that reaches them, and password fields are hidden from the page snapshots agents
        read. Focus a login box on a saved site and it fills; signing in stays your click.
      </p>
      {!encrypted && (
        <p className="transfer-note" style={{ color: 'var(--danger)' }}>
          ⚠ Windows encryption is unavailable on this system, so entries are only obfuscated.
          Avoid storing important passwords until this is resolved.
        </p>
      )}
      {rows.map((r) => (
        <div key={r.id} className="snippet-row">
          <code>{r.title}</code>
          <span className="snippet-value" title={`${r.origin} · ${r.username}`}>
            {r.username || '(no username)'}
            {revealed[r.id] ? ` · ${revealed[r.id]}` : ''}
          </span>
          <button
            className="rail-btn rail-toggle"
            title="Reveal password"
            onClick={async () => {
              if (revealed[r.id]) {
                setRevealed((p) => {
                  const n = { ...p }
                  delete n[r.id]
                  return n
                })
                return
              }
              const value = await window.asit.vault.reveal(r.id)
              if (value) setRevealed((p) => ({ ...p, [r.id]: value }))
            }}
          >
            ◉
          </button>
          <button
            className="rail-btn rail-toggle"
            title="Delete"
            onClick={async () => {
              if (!confirm(`Delete the saved password for ${r.title}?`)) return
              await window.asit.vault.delete(r.id)
              await refresh()
            }}
          >
            ×
          </button>
        </div>
      ))}
      <div className="snippet-add">
        <input placeholder="https://site.edu" value={site} onChange={(e) => setSite(e.target.value)} />
        <input placeholder="username" value={user} onChange={(e) => setUser(e.target.value)} />
        <input
          type="password"
          placeholder="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        <button type="button" className="btn" onClick={add} disabled={!site || !pass}>
          +
        </button>
      </div>
      {msg && <p className="transfer-note" style={{ color: 'var(--danger)' }}>{msg}</p>}
    </div>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl+T', 'New tab'],
  ['Ctrl+W', 'Close tab'],
  ['Ctrl+Shift+T', 'Reopen closed tab'],
  ['Ctrl+Tab', 'Next tab'],
  ['Ctrl+Shift+Tab', 'Previous tab'],
  ['Ctrl+R  ·  F5', 'Reload'],
  ['Alt+←  ·  Alt+→', 'Back / forward'],
  ['Ctrl+F', 'Find in page'],
  ['Ctrl+= · Ctrl+- · Ctrl+0', 'Zoom in / out / reset'],
  ['Ctrl+L', 'Address bar'],
  ['Ctrl+1…9', 'Jump to panel'],
  ['Tab / Shift+Tab', 'Move between panels'],
  ['Ctrl+K  ·  Ctrl+J', 'Quick assistant · Jarvis'],
  ['Ctrl+Space', 'Talk to Jarvis'],
  ['Ctrl+B', 'Show / hide chat'],
  ['Ctrl+Shift+E', 'Show / hide notes'],
  ['Ctrl+H', 'Back to home'],
  ['Ctrl+,', 'Settings'],
  ['Ctrl+E', 'Notes: live preview ↔ raw']
]

function BrowserSection({
  settings,
  setSettings
}: {
  settings: Settings
  setSettings: (s: Settings) => void
}): JSX.Element {
  const [blocked, setBlocked] = useState(0)
  const [exts, setExts] = useState<{ name: string; id: string; path: string }[]>([])
  const [extMsg, setExtMsg] = useState<string | null>(null)
  const [showKeys, setShowKeys] = useState(false)

  const refreshExts = async (): Promise<void> => setExts(await window.asit.browser.extList())

  useEffect(() => {
    void window.asit.browser.stats().then((s) => setBlocked(s.blocked))
    void refreshExts()
  }, [])

  const toggle = (key: keyof Settings, label: string, hint?: string): JSX.Element => (
    <label className="settings-check" title={hint}>
      <input
        type="checkbox"
        checked={Boolean(settings[key])}
        onChange={(e) => setSettings({ ...settings, [key]: e.target.checked })}
      />
      {label}
    </label>
  )

  return (
    <div className="snippets-section">
      <div className="rail-header">Browser</div>

      {toggle('adBlock', `Block ads & trackers${blocked ? ` — ${blocked} blocked so far` : ''}`,
        'Blocks known ad and tracking domains in every embedded page.')}
      <ListField
        label="Also block these domains"
        hint="One per line. Added to the built-in ad/tracker list."
        placeholder={'ads.example.com'}
        value={settings.blockedDomains ?? []}
        onChange={(blockedDomains) => setSettings({ ...settings, blockedDomains })}
      />

      <div className="rail-header" style={{ marginTop: 14 }}>Hide what you don’t use</div>
      {toggle('hidePin', 'Hide ⌾ save-page button', 'The closest thing to bookmarks.')}
      {toggle('hideReview', 'Hide Review tab')}
      {toggle('hideTerminal', 'Hide Terminal tab')}
      {toggle('hideAppWindow', 'Hide App window tab')}

      <div className="rail-header" style={{ marginTop: 14 }}>Extensions</div>
      <p className="transfer-note"> Unpacked Chrome extensions only — there is no Web Store install, and Electron implements
        just part of the extension API, so content-script extensions (blockers, restylers) work
        while ones relying on background service workers often don’t.
      </p>
      {exts.map((e) => (
        <div key={e.id} className="snippet-row">
          <code>{e.name}</code>
          <span className="snippet-value" title={e.path}>
            {e.path}
          </span>
          <button
            className="rail-btn rail-toggle"
            title="Remove (takes effect next launch)"
            onClick={async () => {
              await window.asit.browser.extRemove(e.path)
              setExtMsg('Removed — restart ASIT to unload it.')
              await refreshExts()
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="btn"
        onClick={async () => {
          const r = await window.asit.browser.extAdd()
          if (r.message) setExtMsg(r.message)
          await refreshExts()
        }}
      >
        + Load unpacked extension…
      </button>
      {extMsg && <p className="transfer-note">{extMsg}</p>}

      <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => setShowKeys((v) => !v)}>
        ⌗ {showKeys ? 'Hide' : 'Show'} keyboard shortcuts
      </button>
      {showKeys && (
        <div className="shortcut-table">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="shortcut-row">
              <code>{keys}</code>
              <span>{what}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PhoneSection(): JSX.Element {
  const [status, setStatus] = useState<import('@shared/types').CompanionStatus | null>(null)
  const [qr, setQr] = useState<{ url: string | null; dataUrl: string | null } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    const s = await window.asit.companion.status()
    setStatus(s)
    if (s.running) setQr(await window.asit.companion.qr())
  }

  const statusRef = useRef<import('@shared/types').CompanionStatus | null>(null)
  statusRef.current = status

  useEffect(() => {
    refresh()
    // Keep polling while the panel is open: the user may be installing
    // Tailscale or a phone may request pairing right now. Once everything is
    // settled (tailscale ok, nothing pending) slow way down — each poll
    // spawns a `tailscale status` process.
    // Tick-counted, not wall-clock: `Date.now() % 20000` at a 4s cadence is a
    // constant phase — most mounts would either never slow-refresh or never
    // stop, and a pairing request could sit invisible.
    let tick = 0
    const t = setInterval(() => {
      tick++
      const s = statusRef.current
      const settled = s && s.tailscale === 'ok' && !s.pendingPair
      if (!settled || tick % 5 === 0) refresh()
    }, 4000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!status) return <div />

  async function toggle(): Promise<void> {
    setBusy(true)
    try {
      setStatus(await window.asit.companion.setEnabled(!status!.enabled))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function serve(): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      setMsg(await window.asit.companion.tailscaleServe())
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="phone-section">
      <div className="row-between">
        <span>
          ▯ Phone companion{' '}
          {status.running && <span className="badge badge-accent">running</span>}
        </span>
        <button className="btn" disabled={busy} onClick={toggle}>
          {status.enabled ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      {status.pendingPair && (
        <div className="pair-request">
          <span>
            ▯ A phone wants to pair — confirm it shows code <b>{status.pendingPair.code}</b>
          </span>
          <span className="pair-request-actions">
            <button
              className="btn btn-primary"
              onClick={async () =>
                setStatus(await window.asit.companion.pairApprove(status.pendingPair!.requestId))
              }
            > Approve
            </button>
            <button
              className="btn btn-ghost"
              onClick={async () =>
                setStatus(await window.asit.companion.pairDeny(status.pendingPair!.requestId))
              }
            > Deny
            </button>
          </span>
        </div>
      )}
      {status.enabled && (
        <>
          {status.tailscale === 'not-installed' && (
            <p className="transfer-note"> Install <b>Tailscale</b> on this PC and your phone (free —{' '}
              <a
                href="https://tailscale.com/download"
                onClick={(e) => {
                  e.preventDefault()
                  window.asit.resources.openExternal({ url: 'https://tailscale.com/download' })
                }}
              >
                tailscale.com/download
              </a>
              ), sign both into the same account, then come back here. Your phone connects over
              your private encrypted network — nothing is exposed to the internet.
            </p>
          )}
          {status.tailscale === 'not-running' && (
            <p className="transfer-note">Tailscale is installed but not running — start it, then reopen Settings.</p>
          )}
          {status.tailscale === 'ok' && (
            <>
              <div className="transfer-buttons">
                <button className="btn" disabled={busy} onClick={serve}>
                  ◍ Expose on my tailnet
                </button>
                <button
                  className="btn"
                  disabled={busy || status.subscriptions === 0}
                  title={status.subscriptions === 0 ? 'Pair a phone first' : ''}
                  onClick={() => window.asit.companion.testPush()}
                >
                  ◔ Test notification
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  title="Invalidates the QR link and disconnects all paired phones"
                  onClick={async () => setStatus(await window.asit.companion.revoke())}
                > Revoke pairing
                </button>
              </div>
              {qr?.dataUrl && (
                <div className="phone-qr">
                  <img src={qr.dataUrl} alt="Pairing QR" width={180} height={180} />
                  <p className="transfer-note"> On your phone (Tailscale connected): scan this, then in Safari{' '}
                    <b>Share → Add to Home Screen</b> and open it from the home-screen icon. It
                    will show a 6-digit code — approve it here when it appears. Then tap ◔
                    Enable for notifications.{' '}
                    {status.subscriptions > 0 && `Paired devices with push: ${status.subscriptions}.`}
                  </p>
                </div>
              )}
            </>
          )}
          {msg && <p className="transfer-msg">{msg}</p>}
        </>
      )}
    </div>
  )
}

function VoiceSection(): JSX.Element {
  const [stt, setStt] = useState<boolean | null>(null)
  const [tts, setTts] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pct, setPct] = useState<number | null>(null)

  useEffect(() => {
    window.asit.voice.status().then((s) => setStt(s.modelsReady))
    window.asit.voice.ttsStatus().then((s) => setTts(s.ready))
    const off = window.asit.on(IPC.VOICE_TTS_PROGRESS, (...a: unknown[]) =>
      setPct((a[0] as { pct: number }).pct)
    )
    const off2 = window.asit.on(IPC.VOICE_DOWNLOAD_PROGRESS, (...a: unknown[]) =>
      setPct((a[0] as { pct: number }).pct)
    )
    return () => {
      off()
      off2()
    }
  }, [])

  async function getStt(): Promise<void> {
    setBusy('stt')
    setPct(0)
    try {
      await window.asit.voice.download()
      setStt(true)
    } finally {
      setBusy(null)
      setPct(null)
    }
  }
  async function getTts(): Promise<void> {
    setBusy('tts')
    setPct(0)
    try {
      await window.asit.voice.ttsDownload()
      setTts(true)
    } finally {
      setBusy(null)
      setPct(null)
    }
  }

  return (
    <div className="phone-section">
      <div className="row-between">
        <span>◉ Voice (talk to Jarvis — Ctrl+Space)</span>
      </div>
      <p className="transfer-note"> Speech recognition and the spoken voice both run fully on your machine. Models download
        once.
      </p>
      <div className="transfer-buttons">
        <button className="btn" disabled={!!busy || stt === true} onClick={getStt}>
          {stt ? '✓ Recognition ready' : busy === 'stt' ? `Downloading… ${pct ?? 0}%` : '↓ Speech recognition (~130MB)'}
        </button>
        <button className="btn" disabled={!!busy || tts === true} onClick={getTts}>
          {tts ? '✓ Natural voice ready' : busy === 'tts' ? `Downloading… ${pct ?? 0}%` : '＋ Natural voice (~370MB)'}
        </button>
      </div>
      {tts !== true && (
        <p className="transfer-note"> Until the natural voice is installed, replies use the built-in Windows voice.
        </p>
      )}
    </div>
  )
}

export default function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  useOverlay(true)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [showAccounts, setShowAccounts] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [transferMsg, setTransferMsg] = useState<string | null>(null)
  const [transferBusy, setTransferBusy] = useState(false)

  async function handleExport(): Promise<void> {
    setTransferBusy(true)
    setTransferMsg(null)
    try {
      const result = await window.asit.transfer.export()
      if (result) setTransferMsg(`Exported ${result.tasks} tasks, ${result.questions} questions ✓`)
    } catch (err) {
      setTransferMsg(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setTransferBusy(false)
    }
  }

  async function handleImport(): Promise<void> {
    setTransferBusy(true)
    setTransferMsg(null)
    try {
      const result = await window.asit.transfer.import()
      if (result) {
        setTransferMsg(`Imported ${result.tasks} tasks, ${result.questions} questions ✓ (as new tasks)`)
        await useStore.getState().loadTasks()
      }
    } catch (err) {
      setTransferMsg(err instanceof Error ? err.message : 'Import failed — is this an ASIT backup zip?')
    } finally {
      setTransferBusy(false)
    }
  }

  useEffect(() => {
    window.asit.settings.get().then(setSettings)
  }, [])

  async function save(): Promise<void> {
    if (!settings) return
    // Clamp numerics — a cleared input would otherwise persist 0 and make
    // hold-to-quit instant (defeating the lockdown's whole point).
    const clamp = (v: number, min: number, max: number, fallback: number): number => Number.isFinite(v) && v >= min ? Math.min(max, v) : fallback
    await window.asit.settings.set({
      ...settings,
      workMin: clamp(settings.workMin, 1, 240, 25),
      breakMin: clamp(settings.breakMin, 1, 60, 5),
      holdToQuitSeconds: clamp(settings.holdToQuitSeconds, 5, 120, 30)
    })
    setSaved(true)
    setTimeout(onClose, 600)
  }

  if (!settings) return <div />

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <label className="settings-field"> Work minutes
          <input
            type="number"
            min={5}
            max={120}
            value={settings.workMin}
            onChange={(e) => setSettings({ ...settings, workMin: Number(e.target.value) })}
          />
        </label>

        <label className="settings-field"> Break minutes
          <input
            type="number"
            min={1}
            max={60}
            value={settings.breakMin}
            onChange={(e) => setSettings({ ...settings, breakMin: Number(e.target.value) })}
          />
        </label>

        <BrowserSection settings={settings} setSettings={setSettings} />

        <VaultSection />

        <PhoneSection />

        <button
          className="btn btn-ghost advanced-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? '▾' : '▸'} Advanced
        </button>
        {showAdvanced && (
          <div className="advanced-group">
        <label className="settings-field"> Hold-to-quit seconds
          <input
            type="number"
            min={5}
            max={120}
            value={settings.holdToQuitSeconds}
            onChange={(e) => setSettings({ ...settings, holdToQuitSeconds: Number(e.target.value) })}
          />
        </label>

        <label className="settings-field"> Escape phrase
          <textarea
            rows={2}
            value={settings.escapePhrase}
            onChange={(e) => setSettings({ ...settings, escapePhrase: e.target.value })}
          />
        </label>

        <label className="settings-field"> Claude CLI path
          <input
            value={settings.claudePath}
            onChange={(e) => setSettings({ ...settings, claudePath: e.target.value })}
          />
        </label>

        <div className="snippets-section">
          <div className="rail-header">Quick snippets — type /KEY + space anywhere in ASIT</div>
          {Object.entries(settings.snippets ?? {}).map(([key, value]) => (
            <div key={key} className="snippet-row">
              <code>/{key}</code>
              <span className="snippet-value" title={value}>
                {value}
              </span>
              <button
                className="rail-btn rail-toggle"
                onClick={() => {
                  const next = { ...settings.snippets }
                  delete next[key]
                  setSettings({ ...settings, snippets: next })
                }}
              >
                ×
              </button>
            </div>
          ))}
          <SnippetAdder
            onAdd={(key, value) =>
              setSettings({ ...settings, snippets: { ...settings.snippets, [key]: value } })
            }
          />
        </div>

        <GuardrailsSection settings={settings} setSettings={setSettings} />

        <button className="btn" onClick={() => setShowAccounts(true)}>
          ⚿ Connected accounts…
        </button>

        <VoiceSection />

        <div className="transfer-section">
          <div className="transfer-buttons">
            <button className="btn" disabled={transferBusy} onClick={handleExport}>
              ↑ Export backup…
            </button>
            <button className="btn" disabled={transferBusy} onClick={handleImport}>
              ↓ Import backup…
            </button>
          </div>
          <p className="transfer-note"> Backups include tasks, notes, PDFs, questions, and timer settings — never your logins,
            chat history, escape phrase, or usage data. Safe to share. Importing always adds new
            tasks; it never overwrites.
          </p>
          {transferMsg && <p className="transfer-msg">{transferMsg}</p>}
        </div>

          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}> Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
      {showAccounts && <AccountsModal onClose={() => setShowAccounts(false)} />}
    </div>
  )
}
