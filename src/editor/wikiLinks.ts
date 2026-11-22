import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const WIKILINK = /\[\[([^\]\n]+)\]\]/g
const key = new PluginKey('mazmiWikiLinks')
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** `[[título]]` stays plain text in the document; only its presentation changes. */
function decorate(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, position) => {
    if (!node.isText || !node.text || node.marks.some((mark) => mark.type.name === 'code')) return
    for (const match of node.text.matchAll(WIKILINK)) {
      const from = position + (match.index ?? 0)
      decorations.push(Decoration.inline(from, from + match[0].length, {
        class: 'wikilink', 'data-wikilink': match[1].trim(),
        title: `Abrir «${match[1].trim()}» · ${isMac ? '⌘' : 'Ctrl'} + clic`,
      }))
    }
  })
  return DecorationSet.create(doc, decorations)
}

export const WikiLinks = Extension.create<{ open: (title: string) => void }>({
  name: 'mazmiWikiLinks',

  addOptions() {
    return { open: () => {} }
  },

  addProseMirrorPlugins() {
    const open = (title: string) => this.options.open(title)
    return [new Plugin({
      key,
      state: {
        init: (_, state) => decorate(state.doc),
        apply: (transaction, previous) => transaction.docChanged ? decorate(transaction.doc) : previous,
      },
      props: {
        decorations: (state) => key.getState(state) as DecorationSet,
        handleClick: (_view, _position, event) => {
          if (!(event.metaKey || event.ctrlKey)) return false
          const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-wikilink]')
          if (!target?.dataset.wikilink) return false
          open(target.dataset.wikilink)
          return true
        },
      },
    })]
  },
})
