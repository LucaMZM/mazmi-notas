import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { applyBlock, BLOCK_OPTIONS } from './extensions'
import { keys } from '../utils/platform'

export interface SlashController { onKeyDown: (event: KeyboardEvent) => boolean }
interface SlashState { from: number; to: number; query: string }

const MENU_HEIGHT = 340
const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** «/» at the start of a paragraph or after a space opens the block inserter. */
function readSlash(editor: Editor): SlashState | null {
  const { selection } = editor.state
  if (!editor.isEditable || !selection.empty) return null
  const { $from } = selection
  if ($from.parent.type.name !== 'paragraph') return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const match = /(^|\s)\/([\p{L}\p{N}]{0,24})$/u.exec(before)
  if (!match) return null
  return { from: $from.pos - match[0].length + match[1].length, to: $from.pos, query: match[2] }
}

function SlashMenuView({ editor, controllerRef, containerRef }: {
  editor: Editor
  controllerRef: RefObject<SlashController | null>
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const slash = useEditorState({ editor, selector: ({ editor: current }) => readSlash(current) })
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [index, setIndex] = useState(0)
  const [place, setPlace] = useState<{ left: number; top: number; above: boolean; maxHeight: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo(() => {
    if (!slash) return []
    const query = normalize(slash.query)
    return BLOCK_OPTIONS.filter((entry) => !query || normalize(entry.label + ' ' + entry.keywords).includes(query))
  }, [slash])
  const open = !!slash && dismissedAt !== slash.from && items.length > 0
  const query = slash?.query

  useEffect(() => { setIndex(0) }, [query])
  useEffect(() => { if (!slash) setDismissedAt(null) }, [slash])

  useLayoutEffect(() => {
    if (!open || !slash || !containerRef.current) { setPlace(null); return }
    const caret = editor.view.coordsAtPos(slash.from)
    const box = containerRef.current.getBoundingClientRect()
    // Flip against the scrolling writing area (not the window), so the footer never clips the menu.
    const area = containerRef.current.closest('.document-body')?.getBoundingClientRect()
    const spaceBelow = (area?.bottom ?? window.innerHeight) - caret.bottom
    const spaceAbove = caret.top - (area?.top ?? 0)
    const above = spaceBelow < MENU_HEIGHT && spaceAbove > spaceBelow
    const maxHeight = Math.max(160, Math.min(MENU_HEIGHT - 10, (above ? spaceAbove : spaceBelow) - 18))
    setPlace({ left: Math.max(0, caret.left - box.left - 6), top: (above ? caret.top : caret.bottom) - box.top, above, maxHeight })
  }, [containerRef, editor, open, slash])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const choose = (position: number) => {
    const entry = items[position]
    if (!entry || !slash) return
    editor.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run()
    applyBlock(editor, entry.id)
  }

  useEffect(() => {
    controllerRef.current = open ? {
      onKeyDown(event) {
        if (event.key === 'ArrowDown') { setIndex((value) => (value + 1) % items.length); return true }
        if (event.key === 'ArrowUp') { setIndex((value) => (value - 1 + items.length) % items.length); return true }
        if (event.key === 'Enter' || event.key === 'Tab') { choose(index); return true }
        if (event.key === 'Escape') { setDismissedAt(slash?.from ?? null); return true }
        return false
      },
    } : null
    return () => { controllerRef.current = null }
  })

  if (!open || !place) return null
  return <div ref={listRef} className={'slash-menu' + (place.above ? ' above' : '')} role="listbox" aria-label="Insertar bloque"
    style={{ left: place.left, top: place.top, maxHeight: place.maxHeight }}>
    <p className="slash-heading">Bloques</p>
    {items.map((entry, position) => <div key={entry.id} role="option" aria-selected={position === index} className="slash-item"
      onMouseDown={(event) => { event.preventDefault(); choose(position) }} onMouseEnter={() => setIndex(position)}>
      <span className="block-glyph" aria-hidden="true">{entry.glyph}</span>
      <span className="slash-text"><strong>{entry.label}</strong><span>{entry.hint}</span></span>
      {entry.shortcut && <kbd>{keys(entry.shortcut)}</kbd>}
    </div>)}
  </div>
}

export const SlashMenu = memo(SlashMenuView)
