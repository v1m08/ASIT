import { useEffect, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import { useStore } from './store/useStore'
import Home from './screens/Home'
import Workspace from './screens/Workspace'
import AccountsModal from './components/AccountsModal'
import AssistantBar from './components/AssistantBar'
import JarvisPanel from './components/JarvisPanel'
import StatusListener from './components/StatusListener'
import { useFocusRing } from './hooks/useFocusRing'
import { useFileDropGuard } from './hooks/useFileDrop'

export default function App(): JSX.Element {
  const view = useStore((s) => s.view)
  const loadTasks = useStore((s) => s.loadTasks)
  const loadSettings = useStore((s) => s.loadSettings)
  const [showWelcome, setShowWelcome] = useState(false)

  // Tab / Shift+Tab move between real zones; Ctrl+1…9 jump; Ctrl+K assistant.
  useFocusRing()
  // A file dropped anywhere that isn't a real target would otherwise navigate
  // the window to it, replacing the entire app with a PDF viewer.
  useFileDropGuard()

  // ONE owner for the right-column reservation. When both panels toggled the
  // body class themselves, switching Jarvis→assistant ran the effects in tree
  // order and the loser REMOVED the class — panes then painted over the open
  // panel (invariant 2).
  const assistantOpen = useStore((s) => s.assistantOpen)
  const jarvisOpen = useStore((s) => s.jarvisOpen)
  useEffect(() => {
    document.body.classList.toggle('assistant-open', assistantOpen || jarvisOpen)
    return () => document.body.classList.remove('assistant-open')
  }, [assistantOpen, jarvisOpen])

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
    window.asit.settings.get().then((s) => {
      if (!s.onboarded) setShowWelcome(true)
    })
  }, [loadTasks, loadSettings])

  async function closeWelcome(): Promise<void> {
    setShowWelcome(false)
    await window.asit.settings.set({ onboarded: true })
  }

  return (
    <>
      {view === 'home' ? <Home /> : <Workspace />}
      <AssistantBar />
      <JarvisPanel />
      <StatusListener />
      {showWelcome && <AccountsModal welcome onClose={closeWelcome} />}
    </>
  )
}
