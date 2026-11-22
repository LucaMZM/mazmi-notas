import { Node, mergeAttributes } from '@tiptap/core'
import { attachmentName } from '../utils/attachments'

export type ResolveImage = (name: string) => Promise<string>

export interface NoteImageOptions {
  resolve: ResolveImage
  /** Opens the image picker; resolves to stored attachment names. */
  pick: () => Promise<string[]>
  onError: (message: string) => void
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    noteImage: {
      /** Inserts managed images (`attachment:<name>`) at the selection, or at `position`. */
      insertNoteImages: (images: { name: string; alt?: string }[], position?: number) => ReturnType
      /** Opens the image picker and inserts what the person chooses. */
      pickNoteImages: () => ReturnType
    }
  }
}

/**
 * A block image that points at a managed attachment. The document keeps `attachment:<name>`;
 * the node view resolves it to a loadable URL, so the URL scheme never leaks into notes.
 */
export const NoteImage = Node.create<NoteImageOptions>({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { resolve: () => Promise.reject(new Error('Sin almacén de imágenes')), pick: () => Promise.resolve([]), onError: () => {} }
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'img[data-attachment]', getAttrs: (element) => {
      const src = (element as HTMLElement).getAttribute('data-attachment')
      return attachmentName(src) ? { src, alt: (element as HTMLElement).getAttribute('alt') || null } : false
    } }]
  },

  renderHTML({ HTMLAttributes }) {
    const { src, alt } = HTMLAttributes as { src?: string; alt?: string }
    return ['img', mergeAttributes({ 'data-attachment': src, alt: alt ?? '' })]
  },

  addCommands() {
    return {
      insertNoteImages: (images, position) => ({ chain }) => {
        const content = images.filter((image) => attachmentName('attachment:' + image.name))
          .map((image) => ({ type: this.name, attrs: { src: 'attachment:' + image.name, alt: image.alt || null } }))
        if (!content.length) return false
        return position === undefined ? chain().insertContent(content).run() : chain().insertContentAt(position, content).run()
      },
      pickNoteImages: () => ({ editor }) => {
        const { from } = editor.state.selection
        this.options.pick().then((names) => {
          if (!names.length || editor.isDestroyed) return
          const position = Math.min(from, editor.state.doc.content.size)
          editor.chain().focus().insertNoteImages(names.map((name) => ({ name })), position).run()
        }, (error: unknown) => this.options.onError(error instanceof Error ? error.message : String(error)))
        return true
      },
    }
  },

  addNodeView() {
    return ({ node }) => {
      const figure = document.createElement('figure')
      figure.className = 'note-image'
      figure.contentEditable = 'false'
      const image = document.createElement('img')
      image.draggable = false
      image.decoding = 'async'
      image.loading = 'lazy'
      const fallback = document.createElement('span')
      fallback.className = 'note-image-missing'
      figure.append(image)
      let current = ''
      const render = (src: string, alt: string) => {
        image.alt = alt
        figure.title = alt
        if (src === current) return
        current = src
        figure.classList.remove('missing')
        fallback.remove()
        const name = attachmentName(src)
        const fail = () => {
          figure.classList.add('missing')
          fallback.textContent = `Imagen no disponible${alt ? ': ' + alt : ''}`
          figure.append(fallback)
        }
        if (!name) { fail(); return }
        image.onerror = fail
        this.options.resolve(name).then((url) => { if (current === src) image.src = url }, fail)
      }
      render(String(node.attrs.src ?? ''), String(node.attrs.alt ?? ''))
      return {
        dom: figure,
        update: (next) => {
          if (next.type.name !== this.name) return false
          render(String(next.attrs.src ?? ''), String(next.attrs.alt ?? ''))
          return true
        },
      }
    }
  },
})
