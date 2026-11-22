import { memo, useEffect, useState, type ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { BubbleMenu, type BubbleMenuProps } from '@tiptap/react/menus'
import { Icon, type IconName } from '../components/Icon'
import { keys } from '../utils/platform'
import { applyBlock, BLOCK_OPTIONS, currentBlock, HIGHLIGHTS, TEXT_COLORS, TEXT_SIZES, type BlockId } from './extensions'
import type { BlockAlign } from './tokenMarks'
import { useFrameEditorState } from './useFrameEditorState'

type Panel = 'block' | 'style' | 'align' | null
type BubbleShouldShow = NonNullable<BubbleMenuProps['shouldShow']>

// Stable references: BubbleMenu re-dispatches its options whenever these identities change.
const BUBBLE_OPTIONS = { placement: 'top', offset: 10, flip: { padding: 12 }, shift: { padding: 12 } } as const
const shouldShowBubble: BubbleShouldShow = ({ editor, element, view, state, from, to }) => {
  const focused = view.hasFocus() || element.contains(document.activeElement)
  if (!focused || !editor.isEditable || from === to) return false
  if (state.selection instanceof NodeSelection || editor.isActive('codeBlock')) return false
  return state.doc.textBetween(from, to, ' ').trim().length > 0
}

const ALIGN_OPTIONS: { id: BlockAlign; label: string; icon: IconName; shortcut: string }[] = [
  { id: 'left', label: 'Alinear a la izquierda', icon: 'align-left', shortcut: '⌘⇧L' },
  { id: 'center', label: 'Centrar', icon: 'align-center', shortcut: '⌘⇧E' },
  { id: 'right', label: 'Alinear a la derecha', icon: 'align-right', shortcut: '⌘⇧R' },
  { id: 'justify', label: 'Justificar', icon: 'align-justify', shortcut: '⌘⇧J' },
]

interface BubbleState {
  bold: boolean; italic: boolean; underline: boolean; strike: boolean; code: boolean; block: BlockId
  color: string | null; highlight: string | null; size: string | null; align: BlockAlign; selection: string
}

/** Null while the caret is collapsed, so typing never re-renders the toolbar. */
function readBubbleState(current: Editor): BubbleState | null {
  const { from, to, empty } = current.state.selection
  if (empty) return null
  return {
    bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'),
    strike: current.isActive('strike'), code: current.isActive('code'), block: currentBlock(current),
    color: (current.getAttributes('sdColor').token as string | undefined) ?? null,
    highlight: (current.getAttributes('sdHighlight').token as string | undefined) ?? null,
    size: (current.getAttributes('sdSize').token as string | undefined) ?? null,
    align: ((current.getAttributes('heading').sdAlign ?? current.getAttributes('paragraph').sdAlign) as BlockAlign | null) ?? 'left',
    selection: `${from}:${to}`,
  }
}
const IDLE: BubbleState = {
  bold: false, italic: false, underline: false, strike: false, code: false, block: 'paragraph',
  color: null, highlight: null, size: null, align: 'left', selection: '',
}

const BLOCK_SHORT: Record<BlockId, string> = {
  paragraph: 'Texto', h1: 'Título 1', h2: 'Título 2', h3: 'Título 3', bullet: 'Viñetas',
  ordered: 'Numerada', task: 'Tareas', quote: 'Cita', code: 'Código', divider: 'Texto', image: 'Texto',
}

// The plugin positions an outer host element; a class lets CSS layer and fade it.
const markHost = (element: HTMLDivElement | null) => { element?.classList.add('format-bubble-host') }

/** Buttons keep editor focus (and the selection) by cancelling mousedown. */
function ToolButton({ label, shortcut, active, onClick, children, className = '' }: {
  label: string; shortcut?: string; active?: boolean; onClick: () => void; children: ReactNode; className?: string
}) {
  return <button type="button" className={'tool ' + className} aria-label={label} aria-pressed={active}
    data-tip={shortcut ? `${label} · ${keys(shortcut)}` : label}
    onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{children}</button>
}

function FormatBubbleView({ editor }: { editor: Editor }) {
  const [panel, setPanel] = useState<Panel>(null)
  const state = useFrameEditorState(editor, readBubbleState) ?? IDLE
  const selection = state.selection
  // Sub-panels belong to one selection; moving the cursor closes them.
  useEffect(() => { setPanel(null) }, [selection])

  const toggle = (next: Panel) => setPanel((current) => current === next ? null : next)
  const chain = () => editor.chain().focus()
  const setToken = (mark: 'sdColor' | 'sdHighlight' | 'sdSize', token: string | null) => {
    if (token) chain().setMark(mark, { token }).run()
    else chain().unsetMark(mark).run()
  }
  const alignIcon = ALIGN_OPTIONS.find((entry) => entry.id === state.align)?.icon ?? 'align-left'

  return <BubbleMenu editor={editor} options={BUBBLE_OPTIONS} shouldShow={shouldShowBubble} ref={markHost}
    className="format-bubble" role="toolbar" aria-label="Formato del texto seleccionado">
    <div className="bubble-row">
      <ToolButton label="Tipo de bloque" active={panel === 'block'} onClick={() => toggle('block')} className="tool-block">
        <span>{BLOCK_SHORT[state.block]}</span><Icon name="chevron-down" size={13} />
      </ToolButton>
      <span className="bubble-divider" aria-hidden="true" />
      <ToolButton label="Negrita" shortcut="⌘B" active={state.bold} onClick={() => chain().toggleBold().run()}><b>B</b></ToolButton>
      <ToolButton label="Cursiva" shortcut="⌘I" active={state.italic} onClick={() => chain().toggleItalic().run()}><i>I</i></ToolButton>
      <ToolButton label="Subrayado" shortcut="⌘U" active={state.underline} onClick={() => chain().toggleUnderline().run()}><u>U</u></ToolButton>
      <ToolButton label="Tachado" shortcut="⌘⇧S" active={state.strike} onClick={() => chain().toggleStrike().run()}><s>S</s></ToolButton>
      <ToolButton label="Código en línea" shortcut="⌘E" active={state.code} onClick={() => chain().toggleCode().run()}><Icon name="code" size={16} /></ToolButton>
      <span className="bubble-divider" aria-hidden="true" />
      <ToolButton label="Color, resaltado y tamaño" shortcut="⌘⇧H resalta" active={panel === 'style'} onClick={() => toggle('style')} className="tool-style">
        <span className={'style-glyph ' + (state.color ?? '') + ' ' + (state.highlight ?? '')}>A</span>
      </ToolButton>
      <ToolButton label="Alineación" active={panel === 'align'} onClick={() => toggle('align')}><Icon name={alignIcon} size={16} /></ToolButton>
      <ToolButton label="Quitar formato" onClick={() => chain().unsetAllMarks().run()}><Icon name="eraser" size={16} /></ToolButton>
    </div>

    {panel === 'block' && <div className="bubble-panel block-panel" role="menu" aria-label="Convertir bloque">
      {BLOCK_OPTIONS.filter((entry) => entry.id !== 'divider' && entry.id !== 'image').map((entry) => <button key={entry.id} type="button" role="menuitemradio"
        aria-checked={state.block === entry.id} onMouseDown={(event) => event.preventDefault()}
        onClick={() => { applyBlock(editor, entry.id); setPanel(null) }}>
        <span className="block-glyph" aria-hidden="true">{entry.glyph}</span><span>{entry.label}</span>{entry.shortcut && <kbd>{keys(entry.shortcut)}</kbd>}
      </button>)}
    </div>}

    {panel === 'style' && <div className="bubble-panel style-panel">
      <p className="panel-label" id="color-label">Color del texto</p>
      <div className="swatches" role="group" aria-labelledby="color-label">
        {TEXT_COLORS.map((entry) => <button key={entry.label} type="button" className={'swatch text-swatch ' + (entry.token ?? 'ink')}
          aria-label={entry.label} data-tip={entry.label} aria-pressed={state.color === entry.token}
          onMouseDown={(event) => event.preventDefault()} onClick={() => setToken('sdColor', entry.token)}>A</button>)}
      </div>
      <p className="panel-label" id="highlight-label">Resaltado</p>
      <div className="swatches" role="group" aria-labelledby="highlight-label">
        {HIGHLIGHTS.map((entry) => <button key={entry.label} type="button" className={'swatch hl-swatch ' + (entry.token ?? 'none')}
          aria-label={entry.label} data-tip={entry.label} aria-pressed={state.highlight === entry.token}
          onMouseDown={(event) => event.preventDefault()} onClick={() => setToken('sdHighlight', entry.token)} />)}
      </div>
      <p className="panel-label" id="size-label">Tamaño</p>
      <div className="size-row" role="group" aria-labelledby="size-label">
        {TEXT_SIZES.map((entry) => <button key={entry.label} type="button" aria-label={entry.name} data-tip={entry.name}
          aria-pressed={state.size === entry.token || (!entry.token && state.size === 'sd-size-m')}
          onMouseDown={(event) => event.preventDefault()} onClick={() => setToken('sdSize', entry.token)}>{entry.label}</button>)}
      </div>
    </div>}

    {panel === 'align' && <div className="bubble-panel align-panel" role="group" aria-label="Alineación del párrafo">
      {ALIGN_OPTIONS.map((entry) => <ToolButton key={entry.id} label={entry.label} shortcut={entry.shortcut} active={state.align === entry.id}
        onClick={() => { chain().setBlockAlign(entry.id).run(); setPanel(null) }}><Icon name={entry.icon} size={16} /></ToolButton>)}
    </div>}
  </BubbleMenu>
}

export const FormatBubble = memo(FormatBubbleView)
