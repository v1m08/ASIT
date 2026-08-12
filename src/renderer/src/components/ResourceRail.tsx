import { useState } from 'react'
import type { Resource, Task } from '@shared/types'
import { BUILTIN_NOTES, BUILTIN_REVIEW } from './PaneGrid'

function railIcon(kind: string): string {
  return kind === 'url' ? '🌐' : kind === 'pdf' ? '📄' : kind === 'file' ? '📎' : '📝'
}

interface LibraryFile {
  name: string
  sizeBytes: number
  modifiedAt: string
}

export default function ResourceRail({
  task,
  resources,
  onOpen,
  onSearch,
  onResourcesChanged
}: {
  task: Task
  resources: Resource[]
  onOpen: (id: string) => void
  onSearch: (query: string) => void
  onResourcesChanged: () => Promise<void>
}): JSX.Element {
  const [showAddUrl, setShowAddUrl] = useState(false)
  const [urlTitle, setUrlTitle] = useState('')
  const [urlValue, setUrlValue] = useState('')
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('asit-rail-collapsed') === '1'
  )
  const [aiMenuFor, setAiMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [showLibrary, setShowLibrary] = useState(false)

  async function commitRename(): Promise<void> {
    if (!renaming) return
    const { id, value } = renaming
    setRenaming(null)
    if (value.trim()) {
      await window.asit.resources.rename(id, task.id, value)
      await onResourcesChanged()
    }
  }
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([])

  function requestQuestions(resourceId: string, mode: 'generate' | 'extract'): void {
    window.asit.questions.generate(task.id, resourceId, mode)
    setAiMenuFor(null)
  }

  async function openLibrary(): Promise<void> {
    setLibraryFiles(await window.asit.library.list())
    setShowLibrary(true)
  }

  async function attachFromLibrary(name: string): Promise<void> {
    const r = await window.asit.library.attach(task.id, name)
    setShowLibrary(false)
    if (r) {
      await onResourcesChanged()
      onOpen(r.id)
    }
  }

  async function addFilesToLibrary(): Promise<void> {
    const updated = await window.asit.library.add()
    if (updated) setLibraryFiles(updated)
  }

  async function removeFromLibrary(name: string): Promise<void> {
    if (!confirm(`Remove "${name}" from your library? (Copies already attached to tasks stay.)`)) return
    setLibraryFiles(await window.asit.library.remove(name))
  }

  function toggleCollapsed(): void {
    setCollapsed((prev) => {
      localStorage.setItem('asit-rail-collapsed', prev ? '0' : '1')
      return !prev
    })
  }

  async function handleAddUrl(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const value = urlValue.trim()
    if (!value) return
    setUrlTitle('')
    setUrlValue('')
    setShowAddUrl(false)
    // A real URL becomes a resource; anything else opens an in-app web search
    // (browse to the page, then 📌 pin it to the task).
    const looksLikeUrl = !/\s/.test(value) && value.includes('.')
    if (looksLikeUrl) {
      const r = await window.asit.resources.addUrl(task.id, urlTitle.trim(), value)
      await onResourcesChanged()
      onOpen(r.id)
    } else {
      onSearch(value)
    }
  }

  async function handleAddPdf(): Promise<void> {
    const added = await window.asit.resources.addPdf(task.id)
    if (added && added.length > 0) {
      await onResourcesChanged()
      onOpen(added[0].id)
    }
  }

  async function handleRemove(r: Resource): Promise<void> {
    if (!confirm(`Remove "${r.title}" from this task? Files stay in the task folder.`)) return
    await window.asit.resources.remove(r.id, task.id)
    await onResourcesChanged()
  }

  if (collapsed) {
    return (
      <aside className="resource-rail rail-mini">
        <button className="rail-btn rail-toggle" title="Expand resources" onClick={toggleCollapsed}>
          »
        </button>
        <div className="rail-item rail-item-mini" title="Notes" onClick={() => onOpen(BUILTIN_NOTES)}>
          📝
        </div>
        <div className="rail-item rail-item-mini" title="Review questions" onClick={() => onOpen(BUILTIN_REVIEW)}>
          🧠
        </div>
        {resources.map((r) => (
          <div
            key={r.id}
            className="rail-item rail-item-mini"
            title={r.title}
            onClick={() => onOpen(r.id)}
          >
            {railIcon(r.kind)}
          </div>
        ))}
      </aside>
    )
  }

  return (
    <aside className="resource-rail">
      <div className="rail-section">
        <div className="rail-header">
          Resources
          <button className="rail-btn rail-toggle" title="Collapse" onClick={toggleCollapsed}>
            «
          </button>
        </div>

        <div className="rail-item" onClick={() => onOpen(BUILTIN_NOTES)}>
          <span className="rail-icon">📝</span>
          <span className="rail-title">Notes</span>
        </div>
        <div className="rail-item" onClick={() => onOpen(BUILTIN_REVIEW)}>
          <span className="rail-icon">🧠</span>
          <span className="rail-title">Review</span>
        </div>

        {resources.map((r) => (
          <div key={r.id} className="rail-item" onClick={() => renaming?.id !== r.id && onOpen(r.id)}>
            <span className="rail-icon">{railIcon(r.kind)}</span>
            {renaming?.id === r.id ? (
              <input
                className="rail-rename"
                autoFocus
                value={renaming.value}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenaming({ id: r.id, value: e.target.value })}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <span
                className="rail-title"
                title={`${r.title} — double-click to rename`}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  setRenaming({ id: r.id, value: r.title })
                }}
              >
                {r.title}
              </span>
            )}
            <button
              className="rail-btn"
              title="Rename"
              onClick={(e) => {
                e.stopPropagation()
                setRenaming({ id: r.id, value: r.title })
              }}
            >
              ✏
            </button>
            {r.kind === 'pdf' && !task.aiDisabled && (
              <span className="ai-menu-anchor">
                <button
                  className="rail-btn"
                  title="Questions from this PDF"
                  onClick={(e) => {
                    e.stopPropagation()
                    setAiMenuFor(aiMenuFor === r.id ? null : r.id)
                  }}
                >
                  ✨
                </button>
                {aiMenuFor === r.id && (
                  <div className="ai-menu" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => requestQuestions(r.id, 'extract')}>
                      Extract questions
                      <small>pull existing problems/exercises out of the PDF</small>
                    </button>
                    <button onClick={() => requestQuestions(r.id, 'generate')}>
                      Generate questions
                      <small>create new recall questions from the content</small>
                    </button>
                  </div>
                )}
              </span>
            )}
            <button
              className="rail-btn"
              title="Open externally"
              onClick={(e) => {
                e.stopPropagation()
                window.asit.resources.openExternal(
                  r.kind === 'url' ? { url: r.url ?? undefined } : { filePath: r.filePath ?? undefined }
                )
              }}
            >
              ↗
            </button>
            <button
              className="rail-btn"
              title="Remove from task"
              onClick={(e) => {
                e.stopPropagation()
                handleRemove(r)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="rail-section rail-actions">
        {showAddUrl ? (
          <form className="rail-form" onSubmit={handleAddUrl}>
            <input
              autoFocus
              placeholder="URL — or search terms (e.g. “hackharvard”)"
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
            />
            <input
              placeholder="Label (optional, URLs only)"
              value={urlTitle}
              onChange={(e) => setUrlTitle(e.target.value)}
            />
            <div className="rail-form-row">
              <button type="submit" className="btn btn-primary">
                Go
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowAddUrl(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <button className="btn rail-add" title="Add a website or search the web" onClick={() => setShowAddUrl(true)}>
              + Web
            </button>
            <button className="btn rail-add" onClick={handleAddPdf}>
              + PDF
            </button>
            <button className="btn rail-add" title="Attach from your global file library" onClick={openLibrary}>
              📎
            </button>
          </>
        )}
        {showLibrary && (
          <div className="library-popover">
            <div className="library-head">
              <span>File library</span>
              <button className="rail-btn rail-toggle" onClick={() => setShowLibrary(false)}>
                ✕
              </button>
            </div>
            {libraryFiles.length === 0 && (
              <p className="library-empty">
                Your library is empty. Add files you reuse across tasks — resume, transcript,
                formula sheets…
              </p>
            )}
            {libraryFiles.map((f) => (
              <div key={f.name} className="rail-item" onClick={() => attachFromLibrary(f.name)}>
                <span className="rail-icon">{/\.pdf$/i.test(f.name) ? '📄' : '📎'}</span>
                <span className="rail-title" title={`Attach ${f.name} to this task`}>
                  {f.name}
                </span>
                <button
                  className="rail-btn"
                  title="Remove from library"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeFromLibrary(f.name)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button className="btn rail-add library-add" onClick={addFilesToLibrary}>
              + Add files to library…
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}
