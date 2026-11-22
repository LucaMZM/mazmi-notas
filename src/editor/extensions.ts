import type { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import { BlockAlignment, ScribeColorMark, ScribeHighlightMark, ScribeSizeMark } from './tokenMarks'
import { WikiLinks } from './wikiLinks'
import { NoteImage, type NoteImageOptions } from './image'

export function createEditorExtensions(openLink: (title: string) => void = () => {}, images?: Partial<NoteImageOptions>) {
  return [
    StarterKit.configure({ link: { openOnClick: false, autolink: false } }),
    TaskList,
    TaskItem.configure({
      nested: true,
      a11y: { checkboxLabel: (node, checked) => (checked ? 'Hecha: ' : 'Pendiente: ') + (node.textContent || 'tarea vacía') },
    }),
    ScribeColorMark,
    ScribeHighlightMark,
    ScribeSizeMark,
    BlockAlignment,
    WikiLinks.configure({ open: openLink }),
    NoteImage.configure(images ?? {}),
    Placeholder.configure({
      includeChildren: false,
      placeholder: ({ node, editor }) => {
        if (node.type.name === 'heading') return 'Encabezado'
        return editor.isEmpty ? 'Empieza a escribir… pulsa «/» para insertar un bloque' : 'Pulsa «/» para insertar'
      },
    }),
  ]
}

export type BlockId = 'paragraph' | 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code' | 'divider' | 'image'

export interface BlockOption {
  id: BlockId
  label: string
  hint: string
  keywords: string
  glyph: string
  shortcut?: string
}

export const BLOCK_OPTIONS: BlockOption[] = [
  { id: 'paragraph', label: 'Texto', hint: 'Párrafo normal', keywords: 'texto parrafo normal p', glyph: 'Aa', shortcut: '⌘⌥0' },
  { id: 'h1', label: 'Encabezado 1', hint: 'Título de sección', keywords: 'h1 titulo encabezado heading', glyph: 'H1', shortcut: '⌘⌥1' },
  { id: 'h2', label: 'Encabezado 2', hint: 'Subtítulo', keywords: 'h2 subtitulo encabezado heading', glyph: 'H2', shortcut: '⌘⌥2' },
  { id: 'h3', label: 'Encabezado 3', hint: 'Apartado menor', keywords: 'h3 apartado encabezado heading', glyph: 'H3', shortcut: '⌘⌥3' },
  { id: 'bullet', label: 'Lista con viñetas', hint: 'Ideas sueltas', keywords: 'lista vinetas bullet ul', glyph: '•', shortcut: '⌘⇧8' },
  { id: 'ordered', label: 'Lista numerada', hint: 'Pasos en orden', keywords: 'lista numerada ordenada ol numeros', glyph: '1.', shortcut: '⌘⇧7' },
  { id: 'task', label: 'Lista de tareas', hint: 'Casillas para marcar', keywords: 'checklist tareas todo casillas check', glyph: '☐', shortcut: '⌘⇧9' },
  { id: 'quote', label: 'Cita', hint: 'Destacar un fragmento', keywords: 'cita quote blockquote', glyph: '❝', shortcut: '⌘⇧B' },
  { id: 'code', label: 'Bloque de código', hint: 'Texto monoespaciado', keywords: 'codigo code pre bloque', glyph: '{ }', shortcut: '⌘⌥C' },
  { id: 'divider', label: 'Separador', hint: 'Línea divisoria', keywords: 'separador linea divisor hr regla', glyph: '—' },
  { id: 'image', label: 'Imagen', hint: 'PNG, JPEG, GIF o WebP', keywords: 'imagen foto picture img captura', glyph: '▣' },
]

/** Converts the current block; lists toggle only when the block is not already that list. */
export function applyBlock(editor: Editor, id: BlockId) {
  const chain = editor.chain().focus()
  switch (id) {
    case 'paragraph': return chain.setParagraph().run()
    case 'h1': return chain.setHeading({ level: 1 }).run()
    case 'h2': return chain.setHeading({ level: 2 }).run()
    case 'h3': return chain.setHeading({ level: 3 }).run()
    case 'bullet': return editor.isActive('bulletList') ? chain.run() : chain.toggleBulletList().run()
    case 'ordered': return editor.isActive('orderedList') ? chain.run() : chain.toggleOrderedList().run()
    case 'task': return editor.isActive('taskList') ? chain.run() : chain.toggleTaskList().run()
    case 'quote': return editor.isActive('blockquote') ? chain.run() : chain.toggleBlockquote().run()
    case 'code': return editor.isActive('codeBlock') ? chain.run() : chain.toggleCodeBlock().run()
    case 'divider': return chain.setHorizontalRule().run()
    case 'image': return chain.pickNoteImages().run()
  }
}

export function currentBlock(editor: Editor): BlockId {
  if (editor.isActive('heading', { level: 1 })) return 'h1'
  if (editor.isActive('heading', { level: 2 })) return 'h2'
  if (editor.isActive('heading', { level: 3 })) return 'h3'
  if (editor.isActive('codeBlock')) return 'code'
  if (editor.isActive('taskList')) return 'task'
  if (editor.isActive('orderedList')) return 'ordered'
  if (editor.isActive('bulletList')) return 'bullet'
  if (editor.isActive('blockquote')) return 'quote'
  return 'paragraph'
}

export const TEXT_COLORS = [
  { token: null, label: 'Tinta' },
  { token: 'sd-color-1', label: 'Granate' },
  { token: 'sd-color-2', label: 'Teja' },
  { token: 'sd-color-6', label: 'Musgo' },
  { token: 'sd-color-4', label: 'Laguna' },
  { token: 'sd-color-3', label: 'Petróleo' },
  { token: 'sd-color-5', label: 'Noche' },
] as const

export const HIGHLIGHTS = [
  { token: null, label: 'Sin resaltado' },
  { token: 'sd-hl-1', label: 'Ámbar' },
  { token: 'sd-hl-2', label: 'Brote' },
  { token: 'sd-hl-3', label: 'Melocotón' },
  { token: 'sd-hl-4', label: 'Cielo' },
] as const

export const TEXT_SIZES = [
  { token: 'sd-size-s', label: 'S', name: 'Pequeño' },
  { token: null, label: 'M', name: 'Normal' },
  { token: 'sd-size-l', label: 'L', name: 'Grande' },
  { token: 'sd-size-xl', label: 'XL', name: 'Muy grande' },
] as const
