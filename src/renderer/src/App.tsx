import { useEffect, useState } from 'react'
import { useStore } from './store/useStore'
import Home from './screens/Home'
import Workspace from './screens/Workspace'
import AccountsModal from './components/AccountsModal'
import AssistantBar from './components/AssistantBar'
import StatusListener from './components/StatusListener'
import { useFocusRing } from './hooks/useFocusRing'

export default function App(): JSX.Element {
  const view = useStore((s) => s.view)
  const loadTasks = useStore((s) => s.loadTasks)
  const loadSettings = useStore((s) => s.loadSettings)
  const [showWelcome, setShowWelcome] = useState(false)

  // Tab / Shift+Tab move between real zones; Ctrl+1…9 jump; Ctrl+K assistant.
  useFocusRing()

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
      <StatusListener />
      {showWelcome && <AccountsModal welcome onClose={closeWelcome} />}
    </>
  )
}
