// Right-click menu for a tab. A NATIVE menu, not an HTML dropdown:
// WebContentsViews paint above every bit of app DOM, so a menu anchored to
// the tab strip would open underneath the page it belongs to (invariant 2).
//
// One builder for both surfaces so the menus can't drift; the caller
// dispatches on the returned id.

export type TabMenuChoice =
  | 'reload'
  | 'duplicate'
  | 'copy'
  | 'external'
  | 'move'
  | 'close'
  | 'others'
  | 'right'

export async function showTabMenu({
  url,
  canReload,
  count,
  index,
  canMove = false
}: {
  /** The tab's current address; '' disables the URL-based items. */
  url: string
  canReload: boolean
  /** How many tabs share this strip. */
  count: number
  /** This tab's position in the strip. */
  index: number
  /** Splits only: show "Move to other side". */
  canMove?: boolean
}): Promise<TabMenuChoice | null> {
  const items: Parameters<typeof window.asit.ui.contextMenu>[0] = [
    { id: 'reload', label: 'Reload', enabled: canReload },
    { id: 'duplicate', label: 'Duplicate tab', enabled: !!url },
    { separator: true },
    { id: 'copy', label: 'Copy address', enabled: !!url },
    { id: 'external', label: 'Open in your default browser', enabled: !!url }
  ]
  if (canMove) {
    items.push({ separator: true }, { id: 'move', label: 'Move to other side' })
  }
  items.push(
    { separator: true },
    { id: 'close', label: 'Close tab' },
    { id: 'others', label: 'Close other tabs', enabled: count > 1 },
    { id: 'right', label: 'Close tabs to the right', enabled: index < count - 1 }
  )
  return (await window.asit.ui.contextMenu(items)) as TabMenuChoice | null
}
