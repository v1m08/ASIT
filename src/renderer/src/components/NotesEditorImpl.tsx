import { useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { IPC } from '@shared/ipc-contract'
import type { Resource, Task } from '@shared/types'
import { Compartment } from '@codemirror/state'
import { livePreview } from './livePreview'
import { useStore } from '../store/useStore'

const theme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      color: '#e6e8ee',
      height: '100%',
      fontSize: '14px'
    },
    '.cm-content': { fontFamily: "'Segoe UI', system-ui, sans-serif", padding: '16px' },
    '.cm-cursor': { borderLeftColor: '#7aa2f7' },
    '.cm-gutters': { display: 'none' },
    '&.cm-focused': { outline: 'none' },
    '.cm-activeLine': { backgroundColor: '#1a1d2666' },
    '.cm-selectionBackground': { backgroundColor: '#3d59a155 !important' }
  },
  { dark: true }
)

interface SlashOption {
  kind: 'file' | 'snippet'
  label: string
  insert: string
}

export default function NotesEditor({
  filePath,
  task,
  resources
}: {
  filePath: string
  task?: Task
  resources?: Resource[]
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const snippetsRef = useRef<Record<string, string>>({})
  const viewRef = useRef<EditorView | null>(null)

  // Live preview (Obsidian-style) is the default; the toggle drops to raw
  // markdown for when the syntax itself needs editing.
  const [raw, setRaw] = useState(false)
  const liveCompartment = useRef(new Compartment())
  const openTaskAndResource = useStore((s) => s.openTaskAndResource)

  function openLink(href: string): void {
    const m = href.match(/^asit:\/\/open\/([^/]+)\/([^/?#]+)/)
    if (m) openTaskAndResource(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
    else window.asit.resources.openExternal({ url: href })
  }
  const openLinkRef = useRef(openLink)
  openLinkRef.current = openLink

  function toggleRaw(): void {
    const next = !raw
    setRaw(next)
    viewRef.current?.dispatch({
      effects: liveCompartment.current.reconfigure(
        next
          ? []
          : livePreview({ basePath: filePath, onLink: (h) => openLinkRef.current(h) })
      )
    })
    setTimeout(() => viewRef.current?.focus(), 0)
  }
  const toggleRef = useRef(toggleRaw)
  toggleRef.current = toggleRaw

  // "/" reference popup: files (insert a clickable asit:// link) AND snippets
  // (insert the value). Both kinds shown together when they overlap.
  const [popup, setPopup] = useState<{
    options: SlashOption[]
    from: number
    to: number
    x: number
    y: number
  } | null>(null)
  const [popupIndex, setPopupIndex] = useState(0)
  const popupRef = useRef<typeof popup>(null)
  popupRef.current = popup
  const popupIndexRef = useRef(0)
  popupIndexRef.current = popupIndex
  const optionsSourceRef = useRef<{ files: SlashOption[]; snippets: SlashOption[] }>({
    files: [],
    snippets: []
  })

  useEffect(() => {
    window.asit.settings.get().then((s) => {
      snippetsRef.current = s.snippets ?? {}
      optionsSourceRef.current.snippets = Object.entries(s.snippets ?? {}).map(([k, v]) => ({
        kind: 'snippet',
        label: `/${k}`,
        insert: v
      }))
    })
  }, [])

  useEffect(() => {
    const files: SlashOption[] = []
    if (task) {
      files.push({
        kind: 'file',
        label: 'Notes',
        insert: `[Notes](asit://open/${task.id}/builtin-notes)`
      })
      for (const r of resources ?? []) {
        files.push({
          kind: 'file',
          label: r.title,
          insert: `[${r.title}](asit://open/${task.id}/${r.id})`
        })
      }
    }
    optionsSourceRef.current.files = files
  }, [task, resources])

  function applyOption(opt: SlashOption): void {
    const view = viewRef.current
    const p = popupRef.current
    if (!view || !p) return
    view.dispatch({
      changes: { from: p.from, to: p.to, insert: opt.insert },
      selection: { anchor: p.from + opt.insert.length }
    })
    setPopup(null)
    view.focus()
  }

  useEffect(() => {
    let view: EditorView | null = null
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    let latest: string | null = null
    let cancelled = false

    const flush = (): void => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = null
      if (latest !== null) {
        window.asit.notes.write(filePath, latest)
        latest = null
      }
    }

    const updateSlashPopup = (v: EditorView): void => {
      const pos = v.state.selection.main.head
      const line = v.state.doc.lineAt(pos)
      const before = v.state.doc.sliceString(line.from, pos)
      const m = before.match(/(?:^|[\s([])\/([\w-]*)$/)
      if (!m) {
        if (popupRef.current) setPopup(null)
        return
      }
      const filter = m[1].toLowerCase()
      const src = optionsSourceRef.current
      const options = [
        ...src.files.filter((f) => f.label.toLowerCase().includes(filter)),
        ...src.snippets.filter((s) => s.label.toLowerCase().includes(`/${filter}`))
      ].slice(0, 8)
      if (options.length === 0) {
        if (popupRef.current) setPopup(null)
        return
      }
      const coords = v.coordsAtPos(pos)
      const box = containerRef.current?.getBoundingClientRect()
      if (!coords || !box) return
      setPopup({
        options,
        from: pos - m[1].length - 1,
        to: pos,
        x: Math.min(coords.left - box.left, box.width - 260),
        y: coords.bottom - box.top + 4
      })
      setPopupIndex(0)
    }

    // Live-reload external edits (e.g. Claude writing to notes.md).
    window.asit.notes.watch(filePath)
    const offChanged = window.asit.on(IPC.NOTES_CHANGED, (...args: unknown[]) => {
      const p = args[0] as { filePath: string }
      if (p.filePath !== filePath || !view || latest !== null) return
      window.asit.notes.read(filePath).then((content) => {
        if (!view || latest !== null) return
        if (content === view.state.doc.toString()) return
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
      })
    })

    window.asit.notes.read(filePath).then((content) => {
      if (cancelled || !containerRef.current) return
      view = new EditorView({
        doc: content,
        extensions: [
          Prec.high(
            keymap.of([
              {
                key: 'ArrowDown',
                run: () => {
                  const p = popupRef.current
                  if (!p) return false
                  setPopupIndex((i) => (i + 1) % p.options.length)
                  return true
                }
              },
              {
                key: 'ArrowUp',
                run: () => {
                  const p = popupRef.current
                  if (!p) return false
                  setPopupIndex((i) => (i - 1 + p.options.length) % p.options.length)
                  return true
                }
              },
              {
                key: 'Enter',
                run: () => {
                  const p = popupRef.current
                  if (!p) return false
                  applyOption(p.options[popupIndexRef.current])
                  return true
                }
              },
              {
                key: 'Escape',
                run: () => {
                  if (!popupRef.current) return false
                  setPopup(null)
                  return true
                }
              },
              {
                key: 'Mod-e',
                run: () => {
                  toggleRef.current()
                  return true
                }
              }
            ])
          ),
          basicSetup,
          // GFM base: strikethrough matters here — completed to-dos are ~~struck~~.
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          theme,
          liveCompartment.current.of(
            livePreview({ basePath: filePath, onLink: (h) => openLinkRef.current(h) })
          ),
          // Paste an image → saved into the task's files/ + markdown link.
          EditorView.domEventHandlers({
            paste: (e, v) => {
              const item = [...(e.clipboardData?.items ?? [])].find((i) =>
                i.type.startsWith('image/')
              )
              if (!item) return false
              e.preventDefault()
              const file = item.getAsFile()
              if (!file) return true
              file.arrayBuffer().then(async (buf) => {
                const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
                const rel = await window.asit.notes.saveImage(filePath, new Uint8Array(buf), ext)
                const pos = v.state.selection.main.head
                v.dispatch({
                  changes: { from: pos, insert: `![image](${rel})` },
                  selection: { anchor: pos + rel.length + 11 }
                })
              })
              return true
            }
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) {
              if (update.docChanged) {
                latest = update.state.doc.toString()
                if (saveTimer) clearTimeout(saveTimer)
                saveTimer = setTimeout(flush, 800)

                // "/KEY " snippet expansion at the cursor (space-triggered).
                const pos = update.state.selection.main.head
                const line = update.state.doc.lineAt(pos)
                const before = update.state.doc.sliceString(line.from, pos)
                const m = before.match(/\/([A-Za-z0-9_-]+)(\s)$/)
                const value = m ? snippetsRef.current[m[1]] : undefined
                if (m && value !== undefined && !value.includes(`/${m[1]}`)) {
                  const from = pos - m[0].length
                  setTimeout(() => {
                    if (!cancelled) view?.dispatch({ changes: { from, to: pos, insert: value + m[2] } })
                  }, 0)
                }
              }
              updateSlashPopup(update.view)
            }
          })
        ],
        parent: containerRef.current
      })
      viewRef.current = view
    })

    return () => {
      cancelled = true
      offChanged()
      window.asit.notes.unwatch(filePath)
      flush()
      view?.destroy()
      viewRef.current = null
      setPopup(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath])

  return (
    <div className="notes-editor-wrap">
      <button
        className={`notes-raw-btn ${raw ? 'active' : ''}`}
        tabIndex={-1}
        onClick={toggleRaw}
        title={raw ? 'Back to live preview (Ctrl+E)' : 'Show raw markdown (Ctrl+E)'}
      >
        {raw ? '👁' : '⟨⟩'}
      </button>
      <div className="notes-editor" ref={containerRef} />
      {popup && (
        <div className="notes-slash-popup" style={{ left: popup.x, top: popup.y }}>
          {popup.options.map((opt, i) => (
            <button
              key={`${opt.kind}-${opt.label}`}
              className={`mention-item ${i === popupIndex ? 'mention-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                applyOption(opt)
              }}
            >
              {opt.kind === 'file' ? '📄' : '⚡'} {opt.label}
              {opt.kind === 'snippet' && (
                <span className="mention-tag">{opt.insert.slice(0, 24)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
