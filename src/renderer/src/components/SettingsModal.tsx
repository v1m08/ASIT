import { useEffect, useState } from 'react'
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

export default function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  useOverlay(true)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [showAccounts, setShowAccounts] = useState(false)
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
    const clamp = (v: number, min: number, max: number, fallback: number): number =>
      Number.isFinite(v) && v >= min ? Math.min(max, v) : fallback
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

        <label className="settings-field">
          Work minutes
          <input
            type="number"
            min={5}
            max={120}
            value={settings.workMin}
            onChange={(e) => setSettings({ ...settings, workMin: Number(e.target.value) })}
          />
        </label>

        <label className="settings-field">
          Break minutes
          <input
            type="number"
            min={1}
            max={60}
            value={settings.breakMin}
            onChange={(e) => setSettings({ ...settings, breakMin: Number(e.target.value) })}
          />
        </label>

        <label className="settings-field">
          Hold-to-quit seconds
          <input
            type="number"
            min={5}
            max={120}
            value={settings.holdToQuitSeconds}
            onChange={(e) => setSettings({ ...settings, holdToQuitSeconds: Number(e.target.value) })}
          />
        </label>

        <label className="settings-field">
          Escape phrase
          <textarea
            rows={2}
            value={settings.escapePhrase}
            onChange={(e) => setSettings({ ...settings, escapePhrase: e.target.value })}
          />
        </label>

        <label className="settings-field">
          Claude CLI path
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

        <button className="btn" onClick={() => setShowAccounts(true)}>
          🔑 Connected accounts…
        </button>

        <div className="transfer-section">
          <div className="transfer-buttons">
            <button className="btn" disabled={transferBusy} onClick={handleExport}>
              ⬆ Export backup…
            </button>
            <button className="btn" disabled={transferBusy} onClick={handleImport}>
              ⬇ Import backup…
            </button>
          </div>
          <p className="transfer-note">
            Backups include tasks, notes, PDFs, questions, and timer settings — never your logins,
            chat history, escape phrase, or usage data. Safe to share. Importing always adds new
            tasks; it never overwrites.
          </p>
          {transferMsg && <p className="transfer-msg">{transferMsg}</p>}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
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
