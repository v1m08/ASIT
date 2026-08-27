import { useStore } from '../store/useStore'

// The tab-group switcher: every screen's header starts with where you ARE
// ("Browse" = the scratchpad, or a workspace name) and one click lists
// everywhere you could be. A NATIVE menu, not a DOM dropdown — panes paint
// above all renderer DOM (invariant 2), so a DOM menu would open underneath
// the page it floats over.
//
// Workspace→workspace switching parks the current panes first, exactly like
// going Home does — pages stay alive and revive without reloading.

export default function WorkspaceSwitcher(): JSX.Element {
  const view = useStore((s) => s.view)
  const activeTask = useStore((s) => s.activeTask)
  const tasks = useStore((s) => s.tasks)

  const inWorkspace = view === 'workspace' && !!activeTask
  const current = inWorkspace ? activeTask.title : 'Browse'

  async function menu(): Promise<void> {
    const store = useStore.getState()
    const active = tasks.filter((t) => t.status === 'active')
    const items: { id?: string; label?: string; separator?: boolean }[] = [
      { id: 'browse', label: `◍ Browse${inWorkspace ? '' : '   ✓'}` }
    ]
    if (active.length > 0) items.push({ separator: true })
    for (const t of active) {
      items.push({
        id: `t:${t.id}`,
        label: `${t.aiDisabled ? '⚿ ' : ''}${t.title}${
          inWorkspace && t.id === activeTask.id ? '   ✓' : ''
        }`
      })
    }
    const picked = await window.asit.ui.contextMenu(items)
    if (!picked) return
    if (picked === 'browse') {
      if (inWorkspace) {
        await window.asit.panes.park()
        store.goHome()
      }
      return
    }
    const id = picked.slice(2)
    if (inWorkspace && id === activeTask.id) return
    if (inWorkspace) await window.asit.panes.park()
    void store.openTask(id)
  }

  return (
    <button
      className="btn btn-ghost shell-switcher"
      title="Switch workspace"
      onClick={() => void menu()}
    >
      {inWorkspace && activeTask.aiDisabled && (
        <span title="Private — AI disabled for this task" className="private-lock">
          ⚿{' '}
        </span>
      )}
      <span className="shell-switcher-name">{current}</span> ▾
    </button>
  )
}
