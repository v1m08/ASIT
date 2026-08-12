import { syntaxTree } from '@codemirror/language'
import { type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'

// Obsidian-style live preview: markdown renders in place (headings sized, `###`
// / `**` / link plumbing hidden, images shown) EXCEPT on the line the cursor is
// on, which falls back to raw source so it stays editable. Clicking an image
// puts the cursor on its line, which reveals the markdown — same as Obsidian.

const imageCache = new Map<string, string>()

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly basePath: string
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  // Let clicks through to the editor so clicking an image moves the cursor
  // onto that line and reveals the source.
  ignoreEvent(): boolean {
    return false
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-image'
    const img = document.createElement('img')
    img.alt = this.alt
    img.title = this.alt || this.src
    wrap.appendChild(img)

    const fail = (): void => {
      wrap.classList.add('cm-md-image-missing')
      wrap.textContent = `🖼 ${this.alt || this.src}`
    }

    const cached = imageCache.get(this.src)
    if (cached) {
      img.src = cached
    } else if (/^(data:|https?:|blob:)/i.test(this.src)) {
      img.src = this.src
    } else {
      window.asit.notes
        .readImage(this.basePath, this.src)
        .then((url) => {
          if (!url) return fail()
          imageCache.set(this.src, url)
          img.src = url
        })
        .catch(fail)
    }
    return wrap
  }
}

const HIDDEN_MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'QuoteMark',
  'LinkMark'
])

export function livePreview(opts: {
  basePath: string
  onLink: (href: string) => void
}): Extension {
  const hidden = Decoration.replace({})

  function build(view: EditorView): DecorationSet {
    const { state } = view
    const ranges: { from: number; to: number; deco: Decoration }[] = []
    const sel = state.selection.ranges

    // A node is "revealed" (left as raw text) when the cursor or selection
    // touches any line the node spans.
    const revealed = (from: number, to: number): boolean => {
      const lineFrom = state.doc.lineAt(from).from
      const lineTo = state.doc.lineAt(to).to
      return sel.some((r) => r.from <= lineTo && r.to >= lineFrom)
    }

    const push = (from: number, to: number, deco: Decoration): void => {
      ranges.push({ from, to, deco })
    }
    // Zero-length mark/replace decorations are invalid — line decorations are
    // the only empty ranges allowed.
    const hide = (from: number, to: number): void => {
      if (to > from) push(from, to, hidden)
    }

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from,
        to,
        enter: (node) => {
          const name = node.name

          if (/^ATXHeading[1-6]$/.test(name)) {
            const level = name.slice(-1)
            const line = state.doc.lineAt(node.from)
            push(line.from, line.from, Decoration.line({ class: `cm-md-h${level}` }))
            return
          }

          if (name === 'Blockquote') {
            for (let pos = node.from; pos <= node.to; ) {
              const line = state.doc.lineAt(pos)
              push(line.from, line.from, Decoration.line({ class: 'cm-md-quote' }))
              if (line.to >= node.to) break
              pos = line.to + 1
            }
            return
          }

          if (name === 'Image') {
            if (revealed(node.from, node.to)) return false
            const text = state.doc.sliceString(node.from, node.to)
            const m = text.match(/^!\[([^\]]*)\]\(([^)\s]+)/)
            if (!m) return false
            push(
              node.from,
              node.to,
              Decoration.replace({
                widget: new ImageWidget(decodeURI(m[2]), m[1], opts.basePath)
              })
            )
            return false
          }

          if (name === 'Link') {
            if (revealed(node.from, node.to)) return false
            let labelFrom = -1
            let labelTo = -1
            let href = ''
            for (let ch = node.node.firstChild; ch; ch = ch.nextSibling) {
              if (ch.name === 'URL') {
                href = state.doc.sliceString(ch.from, ch.to)
                hide(ch.from, ch.to)
              } else if (ch.name === 'LinkMark') {
                hide(ch.from, ch.to)
                if (labelFrom < 0) labelFrom = ch.to
                else if (labelTo < 0) labelTo = ch.from
              }
            }
            if (labelFrom >= 0 && labelTo > labelFrom) {
              push(
                labelFrom,
                labelTo,
                Decoration.mark({ class: 'cm-md-link', attributes: { 'data-href': href } })
              )
            }
            return false
          }

          if (name === 'InlineCode') {
            push(node.from, node.to, Decoration.mark({ class: 'cm-md-code' }))
            return
          }

          if (HIDDEN_MARKS.has(name) && !revealed(node.from, node.to)) {
            // Swallow the space after "###" / ">" too, so the text starts flush.
            let to = node.to
            if (
              (name === 'HeaderMark' || name === 'QuoteMark') &&
              state.doc.sliceString(to, to + 1) === ' '
            )
              to += 1
            hide(node.from, to)
          }
          return
        }
      })
    }

    // Decoration.set sorts with the correct side-aware comparator — a manual
    // RangeSetBuilder would reject line decorations sharing a position.
    return Decoration.set(
      ranges.map((r) => r.deco.range(r.from, r.to)),
      true
    )
  }

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = build(view)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.viewportChanged)
          this.decorations = build(update.view)
      }
    },
    { decorations: (v) => v.decorations }
  )

  return [
    plugin,
    EditorView.domEventHandlers({
      mousedown: (e) => {
        const el = (e.target as HTMLElement | null)?.closest?.('.cm-md-link') as HTMLElement | null
        const href = el?.getAttribute('data-href')
        if (!href) return false
        e.preventDefault()
        opts.onLink(href)
        return true
      }
    })
  ]
}
