import type { HTMLAttributes, ReactNode } from 'react'
import { useRef } from 'react'

// The one tab strip. The scratchpad browser and the workspace grid each grew
// their own copy of this markup (strip, favicon/spinner, close button,
// middle-click close, scroll-into-view on activation), and the two drifted.
// Presentational only: the owner decides what a tab IS; this renders it.

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
  stripProps
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
}): JSX.Element {
  // Which tab was last auto-scrolled into view. Once per activation — inline
  // refs re-run on every render, and nav-state pushes would otherwise yank
  // the strip back while the user is scrolling it.
  const scrolledToRef = useRef<string | null>(null)
  const { className: extraClass, ...restStrip } = stripProps ?? {}

  return (
    <div className={`tab-strip ${extraClass ?? ''}`} {...restStrip}>
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
            {tab.loading ? (
              <span className="tab-spinner" />
            ) : tab.favicon ? (
              <img
                className="tab-favicon"
                src={tab.favicon}
                alt=""
                onError={(e) => (e.currentTarget.style.display = 'none')}
              />
            ) : (
              (tab.glyph ?? '◍')
            )}
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
      <button className="tab-btn tab-new" title="New tab (Ctrl+T)" onClick={onNewTab}>
        +
      </button>
      {trailing}
    </div>
  )
}
