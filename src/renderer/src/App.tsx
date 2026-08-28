import { useEffect, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import { useStore } from './store/useStore'
import Shell from './screens/Shell'
import AccountsModal from './components/AccountsModal'
import AssistantPanel from './components/AssistantPanel'
import StatusListener from './components/StatusListener'
import { useFocusRing } from './hooks/useFocusRing'
import { useFileDropGuard } from './hooks/useFileDrop'
import HistoryModal from './components/HistoryModal'
import AutomationsModal from './components/AutomationsModal'
import CommandPalette from './components/CommandPalette'
import ShortcutsModal from './components/ShortcutsModal'
import SettingsModal from './components/SettingsModal'

function SettingsGate(): JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  if (!open) return null
  return <SettingsModal onClose={() => setOpen(false)} />
}

export default function App(): JSX.Element {
  const loadTasks = useStore((s) => s.loadTasks)
  const loadSettings = useStore((s) => s.loadSettings)
  const bootShell = useStore((s) => s.bootShell)
  const [showWelcome, setShowWelcome] = useState(false)

  // Tab / Shift+Tab move between real zones; Ctrl+1…9 jump; Ctrl+K assistant.
  useFocusRing()
  // A file dropped anywhere that isn't a real target would otherwise navigate
  // the window to it, replacing the entire app with a PDF viewer.
  useFileDropGuard()

  // ONE owner for the right-column reservation (invariant 2: the docked panel
  // needs real layout space or panes paint over it).
  const assistantOpen = useStore((s) => s.assistantOpen)
  useEffect(() => {
    document.body.classList.toggle('assistant-open', assistantOpen)
    return () => document.body.classList.remove('assistant-open')
  }, [assistantOpen])

  // The phone can drive the desktop: "open this workspace" arrives as an app
  // event and switches the real app, optionally straight to a resource.
  useEffect(() => {
    return window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      const p = args[0] as { type: string; taskId?: string; resourceId?: string }
      if (p.type !== 'open-workspace' || !p.taskId) return
      const store = useStore.getState()
      if (p.resourceId) void store.openTaskAndResource(p.taskId, p.resourceId)
      else void store.openTask(p.taskId)
    })
  }, [])

  useEffect(() => {
    loadTasks()
    loadSettings()
    // The shell cannot render without a group, so this is what makes the
    // window appear at all.
    void bootShell()
    window.asit.settings.get().then((s) => {
      if (!s.onboarded) setShowWelcome(true)
    })
  }, [loadTasks, loadSettings, bootShell])

  async function closeWelcome(): Promise<void> {
    setShowWelcome(false)
    await window.asit.settings.set({ onboarded: true })
  }

  return (
    <>
      <Shell />
      <AssistantPanel />
      <StatusListener />
      {/* Mounted at the top so Ctrl+H reaches it from Home and a workspace. */}
      <HistoryModal />
      <AutomationsModal />
      <CommandPalette />
      <ShortcutsModal />
      {/* Same reason: Ctrl+, used to set settingsOpen from a workspace, but
          the modal only existed on Home — nothing appeared until you went
          home, where it then popped open unexpectedly. */}
      <SettingsGate />
      {showWelcome && <AccountsModal welcome onClose={closeWelcome} />}
    </>
  )
}
