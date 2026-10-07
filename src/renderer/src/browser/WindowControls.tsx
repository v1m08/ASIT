// Minimise / maximise / close for the frameless window on Windows and Linux.
// The OS title bar is gone (the sidebar runs to the top edge, Arc-style), so
// the sidebar draws these itself — at its top-left, where Arc puts them, as
// three quiet dots that show their glyph on hover. macOS keeps its native
// traffic lights instead (main: titleBarStyle 'hiddenInset').

export default function WindowControls({ maximized }: { maximized: boolean }): JSX.Element {
  return (
    <div className="win-controls">
      <button
        className="win-ctl win-ctl-close"
        title="Close"
        aria-label="Close window"
        onClick={() => void window.asit.ui.windowControl('close')}
      >
        <span>×</span>
      </button>
      <button
        className="win-ctl win-ctl-min"
        title="Minimise"
        aria-label="Minimise window"
        onClick={() => void window.asit.ui.windowControl('minimize')}
      >
        <span>–</span>
      </button>
      <button
        className="win-ctl win-ctl-max"
        title={maximized ? 'Restore' : 'Maximise'}
        aria-label={maximized ? 'Restore window' : 'Maximise window'}
        onClick={() => void window.asit.ui.windowControl('maximize')}
      >
        <span>{maximized ? '❐' : '+'}</span>
      </button>
    </div>
  )
}
