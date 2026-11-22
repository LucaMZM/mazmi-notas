import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Fragment, Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import type { Root, RootContent } from 'mdast'
import type { NoteDraft } from '../types'
import { canEditRich, deriveContentPlain, markdownToRichJson, normalizeRichJson, resolveEditorRichJson, richJsonToMarkdown } from '../utils/content'
import { createEditorExtensions } from '../editor/extensions'
import { FormatBubble } from '../editor/FormatBubble'
import { SlashMenu, type SlashController } from '../editor/SlashMenu'
import { TypographyMenu } from '../editor/TypographyMenu'
import type { EditorMode, EditorPreferences } from '../editor/preferences'
import { altFromFileName, attachmentName, MAX_ATTACHMENT_BYTES } from '../utils/attachments'
import { attachmentUrl, pickImages, saveAttachment } from '../services/notesService'

/** Typing never waits for serialization: commits are coalesced and bounded. */
const COMMIT_DELAY = 220
const COMMIT_MAX_WAIT = 1200

const previewSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'u'],
  // Managed images only; remote images are never loaded (see the img renderer below).
  protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), 'attachment'] },
}
const previewUrl = (url: string) => attachmentName(url) ? url : defaultUrlTransform(url)

/** A stored image in the preview; anything else shows as its description. */
function PreviewImage({ src, alt }: { src?: string; alt?: string }) {
  const name = attachmentName(src)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!name) return
    let live = true
    attachmentUrl(name).then((value) => { if (live) setUrl(value) }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [name])
  if (!name || failed) return <span className="muted">[Imagen{name ? ' no disponible' : ''}: {alt || 'sin descripción'}]</span>
  return url ? <img className="preview-image" src={url} alt={alt ?? ''} onError={() => setFailed(true)} /> : <span className="preview-image pending" />
}

const imageFiles = (list: FileList | undefined | null) => [...(list ?? [])].filter((file) => file.type.startsWith('image/'))

/** Stores dropped or pasted image files; reports what could not be added. */
async function storeImages(files: File[], report: (message: string) => void): Promise<{ name: string; alt: string }[]> {
  const stored: { name: string; alt: string }[] = []
  for (const file of files.slice(0, 20)) {
    try {
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`«${file.name}» supera el límite de ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
      stored.push({ name: await saveAttachment(new Uint8Array(await file.arrayBuffer())), alt: altFromFileName(file.name) })
    } catch (error) {
      report(error instanceof Error ? error.message : String(error))
    }
  }
  return stored
}

/** Turns balanced `<u>…</u>` raw HTML into a sanitized element; any other HTML stays inert text. */
function remarkUnderline() {
  return (tree: Root) => {
    const visit = (node: { children?: RootContent[] }) => {
      if (!node.children) return
      const output: RootContent[] = []
      const stack: { children: RootContent[] }[] = []
      for (const child of node.children) {
        visit(child as { children?: RootContent[] })
        const target = stack.at(-1)?.children ?? output
        if (child.type === 'html' && child.value === '<u>') {
          const element = { type: 'emphasis', children: [], data: { hName: 'u' } } as unknown as RootContent & { children: RootContent[] }
          target.push(element)
          stack.push(element)
        } else if (child.type === 'html' && child.value === '</u>' && stack.length) {
          stack.pop()
        } else {
          target.push(child)
        }
      }
      node.children = output
    }
    visit(tree)
  }
}

export const MarkdownPreview = memo(function MarkdownPreview({ text, openLink }: { text: string; openLink?: (title: string) => void }) {
  const source = text.replace(/\[\[([^\]\n]+)\]\]/g, (_, title: string) => '[' + title + '](#note-' + encodeURIComponent(title) + ')')
  return <div className="document-preview">
    <ReactMarkdown urlTransform={previewUrl} remarkPlugins={[remarkGfm, remarkUnderline]} rehypePlugins={[[rehypeSanitize, previewSchema]]} components={{
      img: ({ src, alt }) => <PreviewImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
      a: ({ href, children }) => href?.startsWith('#note-') && openLink
        ? <button className="inline-link" onClick={() => openLink(decodeURIComponent(href.slice(6)))}>{children}</button>
        : <span title={href} className="external-reference">{children}</span>,
    }}>{source || '*Esta nota todavía no tiene contenido.*'}</ReactMarkdown>
  </div>
})

/** Clipboard HTML is never trusted: paste plain text, keeping line breaks as paragraphs. */
function pastePlainText(view: EditorView, event: ClipboardEvent): boolean {
  const text = event.clipboardData?.getData('text/plain')
  if (text === undefined || text === '') return false
  event.preventDefault()
  const { state } = view
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.includes('\n') || state.selection.$from.parent.type.spec.code) {
    view.dispatch(state.tr.insertText(normalized).scrollIntoView())
    return true
  }
  const paragraphs = normalized.split('\n').map((line) =>
    state.schema.nodes.paragraph.create(null, line ? state.schema.text(line) : null))
  view.dispatch(state.tr.replaceSelection(new Slice(Fragment.from(paragraphs), 1, 1)).scrollIntoView())
  return true
}

const hasVisualTokens = (rich: string) => /"type":"sd(Color|Highlight|Size)"|"sdAlign":"/.test(rich)

type Change = (patch: Partial<NoteDraft>, noteId?: string) => void
interface Props {
  noteId: string
  draft: NoteDraft
  readonly: boolean
  change: Change
  touch: () => void
  registerPending: (commit: () => void) => () => void
  openLink: (title: string) => void
  preferences: EditorPreferences
  updatePreferences: (patch: Partial<EditorPreferences>) => void
}

const MODE_LABELS: Record<EditorMode, string> = { rich: 'Escritura', markdown: 'Markdown', preview: 'Vista previa' }

function NoteEditorView({ noteId, draft, readonly, change, touch, registerPending, openLink, preferences, updatePreferences }: Props) {
  const [richAllowed, setRichAllowed] = useState(() => canEditRich(draft.contentMd))
  const [mode, setMode] = useState<EditorMode>(() => preferences.mode === 'rich' && !richAllowed ? 'markdown' : preferences.mode)
  const [markdown, setMarkdown] = useState(draft.contentMd)
  // The Markdown/Rich pair the rich editor is built from: once per note, again only after source edits.
  const [editorSource, setEditorSource] = useState(() => ({ contentMd: draft.contentMd, contentRichJson: draft.contentRichJson }))
  const [notice, setNotice] = useState('')
  const [previewMd, setPreviewMd] = useState(draft.contentMd)
  const latest = useRef({ contentMd: draft.contentMd, contentRichJson: draft.contentRichJson })
  const pending = useRef<(() => Partial<NoteDraft>) | null>(null)
  const timer = useRef(0)
  const firstPendingAt = useRef(0)
  const slashController = useRef<SlashController | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const sourceEdited = useRef(false)
  // Never disabled during operations: toggling contenteditable would drop focus mid-sentence.
  const editable = !readonly

  const commit = useCallback(() => {
    window.clearTimeout(timer.current)
    firstPendingAt.current = 0
    const compute = pending.current
    pending.current = null
    if (!compute) return
    const patch = compute()
    latest.current = { contentMd: patch.contentMd ?? latest.current.contentMd, contentRichJson: patch.contentRichJson ?? latest.current.contentRichJson }
    change(patch, noteId)
  }, [change, noteId])

  const schedule = useCallback((compute: () => Partial<NoteDraft>) => {
    pending.current = compute
    touch()
    const now = performance.now()
    if (!firstPendingAt.current) firstPendingAt.current = now
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(commit, Math.max(0, Math.min(COMMIT_DELAY, firstPendingAt.current + COMMIT_MAX_WAIT - now)))
  }, [commit, touch])

  // Saving, navigation and window close flush the latest keystrokes before reading the draft.
  useEffect(() => {
    const unregister = registerPending(commit)
    return () => { commit(); unregister() }
  }, [commit, registerPending])

  // Never re-parsed on keystrokes: only when the source pair changes.
  const initialContent = useMemo(() => JSON.parse(resolveEditorRichJson(editorSource.contentRichJson, editorSource.contentMd)), [editorSource])

  // `openLink` is stable (App reads the latest notes through a ref), so extensions are built once.
  const extensions = useMemo(() => createEditorExtensions(openLink, {
    resolve: attachmentUrl, pick: pickImages, onError: setNotice,
  }), [openLink])
  const editor = useEditor({
    injectCSS: false,
    immediatelyRender: true,
    extensions,
    content: initialContent,
    editable,
    editorProps: {
      attributes: { class: 'mazmi-editor', role: 'textbox', 'aria-label': 'Contenido con formato', 'aria-multiline': 'true', spellcheck: 'true' },
      handlePaste: (view, event) => {
        // Text wins (a copied Word paragraph also carries a picture of itself); a screenshot has none.
        const files = imageFiles(event.clipboardData?.files)
        if (files.length && !event.clipboardData?.getData('text/plain')) {
          event.preventDefault()
          const at = view.state.selection.from
          void storeImages(files, setNotice).then((images) => {
            if (images.length && editor && !editor.isDestroyed) editor.chain().focus().insertNoteImages(images, Math.min(at, editor.state.doc.content.size)).run()
          })
          return true
        }
        return pastePlainText(view, event)
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = imageFiles(event.dataTransfer?.files)
        if (moved || !files.length || !view.editable) return false
        event.preventDefault()
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from
        void storeImages(files, setNotice).then((images) => {
          if (images.length && editor && !editor.isDestroyed) editor.chain().focus().insertNoteImages(images, Math.min(at, editor.state.doc.content.size)).run()
        })
        return true
      },
      handleKeyDown: (_view, event) => slashController.current?.onKeyDown(event) ?? false,
      scrollThreshold: { top: 80, bottom: 120, left: 0, right: 0 },
      scrollMargin: { top: 80, bottom: 120, left: 0, right: 0 },
    },
    onUpdate({ editor: current, transaction }) {
      // Plugin-appended changes (e.g. the trailing paragraph after a code block, added on the first
      // click) are not edits: committing them would silently rewrite and re-date untouched notes.
      if (!transaction.docChanged) return
      schedule(() => {
        const rich = normalizeRichJson(JSON.stringify(current.getJSON()))
        const md = richJsonToMarkdown(rich)
        return { contentRichJson: rich, contentMd: md, contentPlain: deriveContentPlain(rich, md) }
      })
    },
  }, [editorSource])

  useEffect(() => { if (editor && editor.isEditable !== editable) editor.setEditable(editable, false) }, [editable, editor])

  const switchMode = (next: EditorMode) => {
    if (next === mode) return
    commit()
    setNotice('')
    const { contentMd } = latest.current
    if (next === 'rich') {
      if (!canEditRich(contentMd)) {
        setRichAllowed(false)
        setNotice('Esta nota usa estructuras que la escritura con formato no puede conservar (tablas, imágenes externas o HTML). Sigue en Markdown para no perder nada.')
        return
      }
      setRichAllowed(true)
      // The rich document is rebuilt only when the Markdown source was edited meanwhile.
      if (sourceEdited.current) { sourceEdited.current = false; setEditorSource({ ...latest.current }) }
    }
    if (next === 'markdown') {
      setMarkdown(contentMd)
      if (hasVisualTokens(latest.current.contentRichJson) && !readonly) {
        setNotice('Esta nota tiene colores, resaltados, tamaños o alineaciones. Markdown no puede expresarlos: si editas aquí se quitarán. Para conservarlos, edita en Escritura.')
      }
    }
    if (next === 'preview') setPreviewMd(contentMd)
    if (next !== 'preview') updatePreferences({ mode: next })
    setMode(next)
    if (next === 'rich') window.requestAnimationFrame(() => { if (editor && !editor.isDestroyed) editor.commands.focus() })
  }

  return <section className="editor-region" aria-label="Editor de la nota">
    <div className="editor-bar">
      <div className="segmented" role="group" aria-label="Modo de edición">
        {(['rich', 'markdown', 'preview'] as const).map((entry) => <button key={entry} type="button" aria-pressed={mode === entry}
          data-testid={entry === 'rich' ? 'toggle-mode-btn' : undefined} onClick={() => switchMode(entry)}>{MODE_LABELS[entry]}</button>)}
      </div>
      <span className="editor-hint" aria-hidden="true">{mode === 'markdown' && !richAllowed ? 'Tablas, imágenes externas y HTML se conservan en Markdown' : ''}</span>
      <TypographyMenu preferences={preferences} update={updatePreferences} />
    </div>
    {notice && <p className="editor-notice" role="status">{notice}</p>}
    <div className="document-body">
      {mode === 'rich' && editor && <div className="rich-surface" ref={surface}>
        <EditorContent editor={editor} data-testid="rich-editor" />
        <FormatBubble editor={editor} />
        <SlashMenu editor={editor} controllerRef={slashController} containerRef={surface} />
      </div>}
      {mode === 'markdown' && <textarea
        data-testid="note-content-input" aria-label="Contenido Markdown" spellCheck={false}
        className="markdown-input" value={markdown} readOnly={readonly}
        placeholder="Empieza a escribir. Las ideas encuentran su sitio aquí."
        onChange={(event) => {
          const value = event.target.value
          setMarkdown(value)
          sourceEdited.current = true
          schedule(() => {
            const rich = markdownToRichJson(value)
            return { contentMd: value, contentRichJson: rich, contentPlain: deriveContentPlain(rich, value) }
          })
        }}
        onBlur={commit}
      />}
      {mode === 'preview' && <MarkdownPreview text={previewMd} openLink={openLink} />}
    </div>
  </section>
}

/**
 * `draft` only seeds the editor: content replaced from outside (load, recovery, restore) remounts
 * it through its key. Re-rendering on every committed keystroke would make TipTap re-apply its
 * options and resync the DOM selection, collapsing a selection the user is still extending.
 */
export const NoteEditor = memo(NoteEditorView, (previous, next) =>
  (Object.keys(next) as (keyof Props)[]).every((key) => key === 'draft' || previous[key] === next[key]))
