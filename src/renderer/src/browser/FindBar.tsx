import type { FindState } from './useFindInPage'

// The find bar both browsing surfaces show. Pure presentation over the
// useFindInPage state.

export default function FindBar({ find }: { find: FindState }): JSX.Element {
  const { findText, findResult, inputRef, runFind, closeFind } = find
  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        autoFocus
        placeholder="Find in page…"
        value={findText}
        onChange={(e) => runFind(e.target.value, false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            closeFind()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            runFind(findText, true, !e.shiftKey)
          }
        }}
      />
      <span className="find-count">
        {findText
          ? findResult && findResult.matches > 0
            ? `${findResult.activeMatch}/${findResult.matches}`
            : findResult
              ? 'no matches'
              : '…'
          : ''}
      </span>
      <button
        className="nav-btn"
        title="Previous (Shift+Enter)"
        onClick={() => runFind(findText, true, false)}
      >
        ↑
      </button>
      <button className="nav-btn" title="Next (Enter)" onClick={() => runFind(findText, true, true)}>
        ↓
      </button>
      <button className="nav-btn" title="Close (Esc)" onClick={closeFind}>
        ✕
      </button>
    </div>
  )
}
