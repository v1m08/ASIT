import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getTask } from './tasks'
import { paneManager } from './panes'

// Page-aware by default: a ~200-token header prepended to every agent turn
// telling the model WHAT is open (titles + full URLs + which pane is on
// screen) and how fresh the on-disk snapshots are. This closes the "the model
// must think to dispatch page_snapshot" gap without inlining page text —
// content stays pull-based on disk, framed as untrusted data, and costs
// nothing unless read.
//
// Built in main from paneManager state the model never controls, owner-
// filtered like every AI-facing pane method (invariant 6). Private tasks
// return nothing, ever.

export function buildPaneContext(taskId: string): string {
  const task = getTask(taskId)
  if (!task || task.aiDisabled) return ''
  const panes = paneManager.listForOwner(taskId)
  if (panes.length === 0) return ''

  const lines = [`## APP CONTEXT (auto-generated): open pages in "${task.title}"`]
  panes.forEach((p, i) => {
    const title = p.title.replace(/\s+/g, ' ').trim().slice(0, 80)
    lines.push(`${i + 1}. ${title || '(untitled)'} — ${p.url}${p.visible ? '  [on screen]' : ''}`)
  })

  try {
    const pagesDir = join(task.folderPath, '.asit', 'pages')
    const files = readdirSync(pagesDir).filter((f) => f.endsWith('.md'))
    if (files.length > 0) {
      const newest = Math.max(...files.map((f) => statSync(join(pagesDir, f)).mtimeMs))
      const ageSec = Math.max(0, Math.round((Date.now() - newest) / 1000))
      lines.push(
        `Snapshots of these pages (text + clickable refs) are in .asit/pages/ — refreshed ${ageSec}s ago.`
      )
    } else {
      lines.push(
        'No page snapshots on disk yet — dispatch {"action":"page_snapshot"} before reading page content.'
      )
    }
  } catch {
    lines.push(
      'No page snapshots on disk yet — dispatch {"action":"page_snapshot"} before reading page content.'
    )
  }
  return lines.join('\n')
}
