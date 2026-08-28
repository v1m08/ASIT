import { useStore } from '../store/useStore'

// Tab groups.
//
// ASIT used to have two screens: a "home" dashboard and a "workspace". They
// held two different tab systems, and opening a workspace threw away whatever
// you were browsing. That is not how a browser behaves, and it is why the app
// felt like a launcher wearing a browser costume.
//
// So workspaces became what they always were in spirit: TAB GROUPS. This strip
// is the only navigation in the app. Every chip is a group; the group you are
// in owns the tab strip below. Switching parks the outgoing panes (they stay
// alive and revive instantly) and swaps the content — no screen change, no
// lost tabs. "Browse" is the scratchpad: the group you land in when you have
// not committed to anything, which is most of the time.

/** Stable per-group colour, the way Chrome colours a tab group. */
const GROUP_COLORS = [
  '#6ea8fe',
  '#8bd17c',
  '#f7b955',
  '#e07a9b',
  '#a78bfa',
  '#5ecfcf',
  '#f0836b',
  '#9db4c0'
]

export function groupColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return GROUP_COLORS[h % GROUP_COLORS.length]
}

export default function GroupBar(): JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const activeTask = useStore((s) => s.activeTask)
  const scratch = useStore((s) => s.scratchTask)
  const switchGroup = useStore((s) => s.switchGroup)

  // The scratchpad is archived in the task table (it is not a "workspace" you
  // manage), so it is prepended explicitly rather than filtered for.
  const groups = [
    ...(scratch ? [{ task: scratch, label: 'Browse', pinned: true }] : []),
    ...tasks
      .filter((t) => t.status === 'active')
      .map((t) => ({ task: t, label: t.title, pinned: false }))
  ]

  // Everything you can do TO a group. This is the only home for it: the app
  // used to manage workspaces from a home screen, and retiring that screen
  // would otherwise have taken the per-workspace AI switches (private, coding,
  // terminal read) and deletion with it. Native, because panes paint above all
  // renderer DOM (invariant 2) and a DOM menu would open underneath the page.
  async function groupMenu(id: string, pinned: boolean): Promise<void> {
    const store = useStore.getState()
    if (pinned) {
      if ((await window.asit.ui.contextMenu([{ id: 'new', label: 'New group…' }])) === 'new') {
        void newGroup()
      }
      return
    }
    const t = store.tasks.find((x) => x.id === id)
    if (!t) return
    const tick = (on: boolean): string => (on ? '✓ ' : '    ')
    const picked = await window.asit.ui.contextMenu([
      { id: 'rename', label: 'Rename group…' },
      { id: 'due', label: t.dueDate ? `Due ${t.dueDate} — change…` : 'Set a due date…' },
      { id: 'priority', label: `Priority: ${['', 'High', 'Normal', 'Low'][t.priority] ?? 'Normal'} — change…` },
      { separator: true },
      { id: 'private', label: `${tick(t.aiDisabled)}Private (no AI in this group)` },
      { id: 'coding', label: `${tick(!!t.coding)}Coding mode (agent may run commands)` },
      { id: 'terminal', label: `${tick(!!t.terminalAiRead)}Agent may READ this group's terminal` },
      { separator: true },
      { id: 'new', label: 'New group…' },
      { id: 'archive', label: 'Close group (keeps everything)' },
      { id: 'delete', label: 'Delete group…' }
    ])
    if (!picked) return
    const reload = async (): Promise<void> => {
      await store.loadTasks()
      // The open group's own copy must refresh too, or the header keeps
      // showing the old title / privacy state.
      if (store.activeTask?.id === id) {
        const fresh = await window.asit.tasks.open(id)
        if (fresh) useStore.setState({ activeTask: fresh.task, activeResources: fresh.resources })
      }
    }
    // Leaving the user on a group that is no longer in the strip is how you
    // get a shell pointing at nothing.
    const leaveIfActive = async (): Promise<void> => {
      if (store.activeTask?.id === id && store.scratchTask) {
        await store.switchGroup(store.scratchTask.id)
      }
    }

    if (picked === 'new') return void newGroup()
    if (picked === 'rename') {
      const name = window.prompt('Rename group', t.title)
      if (name?.trim()) {
        await window.asit.tasks.update(id, { title: name.trim() })
        await reload()
      }
    } else if (picked === 'due') {
      const v = window.prompt('Due date (YYYY-MM-DD, blank to clear)', t.dueDate ?? '')
      if (v !== null) {
        const clean = v.trim()
        if (clean && !/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
          store.pushNotice('Use YYYY-MM-DD, e.g. 2026-09-14.', 'error')
        } else {
          await window.asit.tasks.update(id, { dueDate: clean || null })
          await reload()
        }
      }
    } else if (picked === 'priority') {
      const p = await window.asit.ui.contextMenu([
        { id: 'p1', label: 'High' },
        { id: 'p2', label: 'Normal' },
        { id: 'p3', label: 'Low' }
      ])
      if (p) {
        await window.asit.tasks.update(id, { priority: Number(p.slice(1)) })
        await reload()
      }
    } else if (picked === 'private') {
      // Turning privacy ON physically moves the folder outside every AI cwd
      // (invariant 8) — worth confirming, and worth saying what it does.
      const next = !t.aiDisabled
      const ok = window.confirm(
        next
          ? `Make “${t.title}” private?\n\nIts folder moves outside every AI working directory, so no agent — including the universal one — can read it.`
          : `Turn AI back on for “${t.title}”?\n\nIts folder moves back where agents can read it.`
      )
      if (ok) {
        await window.asit.tasks.setPrivacy(id, next)
        await reload()
      }
    } else if (picked === 'coding') {
      await window.asit.tasks.setCoding(id, !t.coding)
      await reload()
    } else if (picked === 'terminal') {
      await window.asit.tasks.setTerminalAiRead(id, !t.terminalAiRead)
      await reload()
    } else if (picked === 'archive') {
      await window.asit.tasks.update(id, { status: 'archived' })
      await store.loadTasks()
      await leaveIfActive()
    } else if (picked === 'delete') {
      if (
        !window.confirm(
          `Delete “${t.title}”?\n\nIts tabs, notes and chats go with it. The files themselves are moved to ASIT's trash folder, never erased.`
        )
      )
        return
      const r = await window.asit.tasks.delete(id)
      if (!r.ok) {
        store.pushNotice(`Couldn't delete that group — ${r.reason ?? 'unknown'}`, 'error')
        return
      }
      await store.loadTasks()
      await leaveIfActive()
    }
  }

  // A group is created from what you are ALREADY doing: scratchSave hands the
  // open tabs to the new group, so "this browsing turned into a project" is
  // one click rather than a form plus re-opening everything.
  async function newGroup(): Promise<void> {
    const store = useStore.getState()
    const name = window.prompt('Name this group')
    if (!name?.trim()) return
    const inScratch = store.activeTask?.id === store.scratchTask?.id
    try {
      const task = inScratch
        ? await window.asit.tasks.scratchSave(name.trim())
        : await window.asit.tasks.create({ title: name.trim() })
      await store.loadTasks()
      if (inScratch) {
        // scratchSave moved the tabs into the new group and reset the
        // scratchpad; re-read it so "Browse" is not showing stale tabs.
        await store.bootShell()
      }
      await store.switchGroup(task.id)
    } catch (err) {
      store.pushNotice(
        `Couldn't create that group — ${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
    }
  }

  return (
    <div className="group-bar" data-focus-zone="Groups">
      {groups.map(({ task, label, pinned }) => {
        const on = task.id === activeTask?.id
        return (
          <button
            key={task.id}
            className={`group-chip ${on ? 'group-chip-on' : ''}`}
            title={pinned ? 'Browsing — tabs with no project attached' : label}
            style={{ ['--group-color' as string]: groupColor(task.id) }}
            onClick={() => void switchGroup(task.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              void groupMenu(task.id, pinned)
            }}
          >
            <span className="group-dot" />
            {task.aiDisabled && (
              <span className="private-lock" title="Private — AI disabled here">
                ⚿
              </span>
            )}
            <span className="group-name">{label}</span>
          </button>
        )
      })}
      <button className="group-add" title="New group" onClick={() => void newGroup()}>
        +
      </button>
    </div>
  )
}
