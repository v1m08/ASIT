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

  async function groupMenu(id: string, pinned: boolean): Promise<void> {
    const store = useStore.getState()
    const picked = await window.asit.ui.contextMenu(
      pinned
        ? [{ id: 'new', label: 'New group…' }]
        : [
            { id: 'rename', label: 'Rename group…' },
            { id: 'new', label: 'New group…' },
            { separator: true },
            { id: 'archive', label: 'Close group (keeps everything)' }
          ]
    )
    if (picked === 'new') {
      void newGroup()
    } else if (picked === 'rename') {
      const t = store.tasks.find((x) => x.id === id)
      const name = window.prompt('Rename group', t?.title ?? '')
      if (name?.trim()) {
        await window.asit.tasks.update(id, { title: name.trim() })
        await store.loadTasks()
      }
    } else if (picked === 'archive') {
      await window.asit.tasks.update(id, { status: 'archived' })
      await store.loadTasks()
      // Never strand the user on a group that is no longer in the strip.
      if (store.activeTask?.id === id && store.scratchTask) {
        await store.switchGroup(store.scratchTask.id)
      }
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
