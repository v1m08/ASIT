import { lazy, memo, Suspense } from 'react'

// react-markdown + remark-gfm are ~a third of the startup bundle, but no
// markdown renders until a chat/assistant reply or notes preview exists —
// load them on first use. Fallback shows the raw text so streaming never
// flashes blank while the chunk loads (a one-time, sub-second event).
const Impl = lazy(() => import('./MarkdownImpl'))

// memo matters: chat panels re-render on every stream delta / status tick /
// elapsed-timer second, and without it every HISTORICAL message re-ran a full
// remark parse each time. Props are two strings — comparison is free.
function Markdown(props: { text: string; basePath?: string }): JSX.Element {
  return (
    <Suspense fallback={<div className="md" style={{ whiteSpace: 'pre-wrap' }}>{props.text}</div>}>
      <Impl {...props} />
    </Suspense>
  )
}

export default memo(Markdown)
