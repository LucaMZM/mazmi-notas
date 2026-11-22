import { Extension, Mark, mergeAttributes } from '@tiptap/core'

/**
 * Visual formatting is stored as class tokens, never inline styles: the production CSP
 * (`style-src 'self'`) blocks style attributes, and tokens keep old notes stable when the
 * palette is refined. The token names are persisted in Rich JSON, so they must not change.
 */
function tokenMark(name: string, dataAttribute: string, classPrefix: string) {
  return Mark.create({
    name,

    addAttributes() {
      return {
        token: {
          default: `${classPrefix}-1`,
          parseHTML: (element: HTMLElement) => element.getAttribute(dataAttribute) ?? `${classPrefix}-1`,
          renderHTML: (attributes: { token?: string }) => ({
            [dataAttribute]: attributes.token ?? `${classPrefix}-1`,
            class: attributes.token ?? `${classPrefix}-1`,
          }),
        },
      }
    },

    parseHTML() {
      return [{ tag: `span[${dataAttribute}]` }]
    },

    renderHTML({ HTMLAttributes }) {
      return ['span', mergeAttributes(HTMLAttributes), 0]
    },
  })
}

export const ScribeColorMark = tokenMark('sdColor', 'data-sd-color', 'sd-color')
export const ScribeHighlightMark = tokenMark('sdHighlight', 'data-sd-hl', 'sd-hl').extend({
  addKeyboardShortcuts() {
    return { 'Mod-Shift-h': () => this.editor.commands.toggleMark(this.name, { token: 'sd-hl-1' }) }
  },
})
export const ScribeSizeMark = tokenMark('sdSize', 'data-sd-size', 'sd-size')

export type BlockAlign = 'left' | 'center' | 'right' | 'justify'
const ALIGNMENTS: BlockAlign[] = ['left', 'center', 'right', 'justify']

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockAlign: { setBlockAlign: (value: BlockAlign) => ReturnType }
  }
}

/** Paragraph and heading alignment as a class token; Markdown ignores it, Rich JSON keeps it. */
export const BlockAlignment = Extension.create({
  name: 'blockAlign',

  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        sdAlign: {
          default: null,
          parseHTML: (element: HTMLElement) => {
            const value = element.getAttribute('data-sd-align')
            return ALIGNMENTS.includes(value as BlockAlign) && value !== 'left' ? value : null
          },
          renderHTML: (attributes: { sdAlign?: string | null }) => attributes.sdAlign
            ? { 'data-sd-align': attributes.sdAlign, class: `sd-align-${attributes.sdAlign}` } : {},
        },
      },
    }]
  },

  addCommands() {
    return {
      setBlockAlign: (value) => ({ commands }) => {
        const sdAlign = value === 'left' ? null : value
        return ['paragraph', 'heading'].map((type) => commands.updateAttributes(type, { sdAlign })).some(Boolean)
      },
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-l': () => this.editor.commands.setBlockAlign('left'),
      'Mod-Shift-e': () => this.editor.commands.setBlockAlign('center'),
      'Mod-Shift-r': () => this.editor.commands.setBlockAlign('right'),
      'Mod-Shift-j': () => this.editor.commands.setBlockAlign('justify'),
    }
  },
})
