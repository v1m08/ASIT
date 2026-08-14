import { useEffect, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useStore } from '../store/useStore'

// Proper markdown rendering for AI replies — headings, bold, lists, tables,
// code blocks with copy buttons, checkboxes. Raw HTML in model output is NOT
// rendered (react-markdown default), so replies can't inject markup.

function CodeBlock({ children }: { children?: React.ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false)

  function extractText(node: React.ReactNode): string {
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(extractText).join('')
    if (node && typeof node === 'object' && 'props' in node) {
      return extractText((node as { props: { children?: React.ReactNode } }).props.children)
    }
    return ''
  }

  function copy(): void {
    navigator.clipboard.writeText(extractText(children).replace(/\n$/, ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="md-codeblock">
      <button className="md-code-copy" title="Copy code" onClick={copy}>
        {copied ? '✓' : '⧉'}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

// Images written by the notes editor are relative to the note ("files/img-1.png").
// The renderer can't load file:// subresources, so the bytes come back as a
// data: URL from main.
function NoteImage({
  src,
  alt,
  basePath
}: {
  src?: string
  alt?: string
  basePath?: string
}): JSX.Element | null {
  const [resolved, setResolved] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setFailed(false)
    if (!src) return
    if (/^(data:|https?:|blob:)/i.test(src)) {
      setResolved(src)
      return
    }
    if (!basePath) {
      setFailed(true)
      return
    }
    window.asit.notes.readImage(basePath, src).then((url) => {
      if (!live) return
      if (url) setResolved(url)
      else setFailed(true)
    })
    return () => {
      live = false
    }
  }, [src, basePath])

  if (failed) return <span className="md-img-missing">🖼 {alt || src}</span>
  if (!resolved) return null
  return <img className="md-img" src={resolved} alt={alt ?? ''} />
}

export default function Markdown({
  text,
  basePath
}: {
  text: string
  /** Note file the markdown came from — enables relative image + asit:// links. */
  basePath?: string
}): JSX.Element {
  const openTaskAndResource = useStore((s) => s.openTaskAndResource)

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith('asit://') ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (!href) return
                const m = href.match(/^asit:\/\/open\/([^/]+)\/([^/?#]+)/)
                if (m) openTaskAndResource(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
                else window.asit.resources.openExternal({ url: href })
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <NoteImage src={typeof src === 'string' ? src : undefined} alt={alt} basePath={basePath} />
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
