import type { HTMLAttributes, ReactNode } from 'react'
import { useRef, useState } from 'react'

// The one tab strip. The scratchpad browser and the workspace grid each grew
// their own copy of this markup (strip, favicon/spinner, close button,
// middle-click close, scroll-into-view on activation), and the two drifted.
// Presentational only: the owner decides what a tab IS; this renders it.
//
// Two orientations. `vertical` is the Arc-style sidebar list (the default in
// the shell): "+ New Tab" leads, rows are full-width, close appears on hover.
// Horizontal is the compact fallback used while the sidebar is hidden.

export interface TabDescriptor {
  id: string
  label: string
  /** Hover text; defaults to the label. */
  tooltip?: string
  loading?: boolean
  favicon?: string | null
  /** Fallback icon when there's no favicon (kind glyphs, '◍' for pages). */
  glyph?: string
}

export default function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onContextMenu,
  onNewTab,
  onMoveTab,
  leading,
  trailing,
  stripProps,
  vertical = false,
  heading
}: {
  tabs: TabDescriptor[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onContextMenu: (id: string) => void
  onNewTab: () => void
  /** When given, each tab shows the ⇄ "move to other side" button (splits). */
  onMoveTab?: (id: string) => void
  /** Rendered before the tabs (e.g. a drop hint). */
  leading?: ReactNode
  /** Rendered after the + button (e.g. split/collapse controls). */
  trailing?: ReactNode
  /** Extra props for the strip container (drag-over handlers, className). */
  stripProps?: HTMLAttributes<HTMLDivElement>
  /** Sidebar list instead of a horizontal strip. */
  vertical?: boolean
  /** Sidebar only: a small label above the list (split view names its sides). */
  heading?: ReactNode
}): JSX.Element {
  // Which tab was last auto-scrolled into view. Once per activation — inline
  // refs re-run on every render, and nav-state pushes would otherwise yank
  // the strip back while the user is scrolling it.
  const scrolledToRef = useRef<string | null>(null)
  const { className: extraClass, ...restStrip } = stripProps ?? {}

  return (
    <div
      className={`tab-strip ${vertical ? 'tab-strip-vertical' : ''} ${extraClass ?? ''}`}
      {...restStrip}
    >
      {vertical && heading && (
        <div className="tab-strip-heading">
          {heading}
          {trailing}
        </div>
      )}
      {vertical && (
        <button className="tab-btn tab-new tab-new-row" title="New tab (Ctrl+T)" onClick={onNewTab}>
          <span className="tab-new-plus">+</span>
          <span>New Tab</span>
        </button>
      )}
      {leading}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeId ? 'tab-active' : ''}`}
          ref={(el) => {
            if (el && tab.id === activeId && scrolledToRef.current !== tab.id) {
              scrolledToRef.current = tab.id
              el.scrollIntoView({ inline: 'nearest', block: 'nearest' })
            }
          }}
          onClick={() => onSelect(tab.id)}
          // Middle-click closes, like every browser since 2004.
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(tab.id)
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu(tab.id)
          }}
          title={tab.tooltip ?? tab.label}
        >
          <span className="tab-icon">
            {tab.loading ? <span className="tab-spinner" /> : <TabIcon tab={tab} />}
          </span>
          <span className="tab-title">{tab.label}</span>
          {onMoveTab && (
            <button
              className="tab-btn"
              title="Move to other side"
              onClick={(e) => {
                e.stopPropagation()
                onMoveTab(tab.id)
              }}
            >
              ⇄
            </button>
          )}
          <button
            className="tab-btn"
            title="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose(tab.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
      {!vertical && (
        <button className="tab-btn tab-new" title="New tab (Ctrl+T)" onClick={onNewTab}>
          +
        </button>
      )}
      {!vertical && trailing}
    </div>
  )
}

/** Favicon, or the kind glyph when there is none — or it fails to load
 *  (a hidden broken image used to leave an empty gap in the row). */
function TabIcon({ tab }: { tab: TabDescriptor }): JSX.Element {
  const [failedFor, setFailedFor] = useState<string | null>(null)
  if (tab.favicon && failedFor !== tab.favicon) {
    return (
      <img
        className="tab-favicon"
        src={tab.favicon}
        alt=""
        onError={() => setFailedFor(tab.favicon ?? null)}
      />
    )
  }
  return <>{tab.glyph ?? '◍'}</>
}
