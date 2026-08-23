import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/base.css'
import { useOverlay } from './hooks/useOverlay'

// The crash screen is an overlay like any other, so it claims the panes
// through the sanctioned hook (invariant 2). A hook also wins the ordering
// race a one-shot hide loses: when the crash happens inside an open modal,
// that modal's useOverlay cleanup runs in the same passive-effect flush —
// main's hide count is refcounted, so claim and release stay balanced.
function CrashCard({ error }: { error: Error }): JSX.Element {
  useOverlay(true)
  return (
    <div className="crash-screen">
      <div className="crash-card">
        <h1>Something went wrong</h1>
        <p>The screen hit an error it couldn't recover from. Your work is safe on disk.</p>
        <code>{String(error.message ?? error).slice(0, 400)}</code>
        <button
          className="btn"
          onClick={() => {
            // Release our overlay claim first: page unload never runs React
            // cleanups, and a leaked claim would leave every pane hidden
            // after the reload.
            void window.asit.panes
              .setVisible(null, true)
              .catch(() => undefined)
              .then(() => location.reload())
          }}
        >
          Reload ASIT
        </button>
      </div>
    </div>
  )
}

// One render throw anywhere used to white-screen the whole app with no
// message and no way back. Catch it, show what happened, offer a reload —
// timers, agents and panes in the main process keep running throughout.
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('render crash:', error)
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return <CrashCard error={this.state.error} />
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
