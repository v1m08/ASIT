import type { ReactNode } from 'react'
import type { PaneNavState } from '@shared/types'
import AddressBar from '../components/AddressBar'

// Back / forward / reload-or-stop / address bar — the row every web surface
// shows above its page. Trailing children hold surface-specific actions
// (pin, find, zoom label).

export default function BrowserToolbar({
  paneId,
  nav,
  url,
  onNavigate,
  className = 'pane-toolbar',
  addressClassName = '',
  children
}: {
  /** null = no page showing; nav buttons disable, typing still navigates. */
  paneId: string | null
  nav: PaneNavState | null | undefined
  /** Shown in the address bar when the user isn't typing. */
  url: string
  /** Where typing in the address bar goes; defaults to navigating the pane. */
  onNavigate?: (target: string) => void
  className?: string
  addressClassName?: string
  children?: ReactNode
}): JSX.Element {
  const go = (nav2: 'back' | 'forward' | 'stop' | 'reload'): void => {
    if (paneId) window.asit.panes.navigate(paneId, { nav: nav2 })
  }
  return (
    <div className={className}>
      <button className="nav-btn" disabled={!nav?.canGoBack} onClick={() => go('back')}>
        ←
      </button>
      <button className="nav-btn" disabled={!nav?.canGoForward} onClick={() => go('forward')}>
        →
      </button>
      <button
        className="nav-btn"
        disabled={!paneId}
        title={nav?.loading ? 'Stop loading' : 'Reload'}
        onClick={() => go(nav?.loading ? 'stop' : 'reload')}
      >
        {nav?.loading ? '✕' : '⟳'}
      </button>
      <AddressBar
        className={addressClassName}
        url={url}
        onNavigate={
          onNavigate ??
          ((target) => paneId && window.asit.panes.navigate(paneId, { url: target }))
        }
      />
      {children}
    </div>
  )
}
