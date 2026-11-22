import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'

/**
 * Like TipTap's `useEditorState`, but React renders at most once per animation frame and never
 * synchronously inside a ProseMirror transaction. Typing and native selection stay untouched by
 * toolbar updates; the toolbar catches up on the next frame.
 */
export function useFrameEditorState<T>(editor: Editor, selector: (editor: Editor) => T): T {
  const [value, setValue] = useState(() => selector(editor))
  useEffect(() => {
    let frame = 0
    let last = JSON.stringify(selector(editor))
    const schedule = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (editor.isDestroyed) return
        const next = selector(editor)
        const serialized = JSON.stringify(next)
        if (serialized !== last) { last = serialized; setValue(next) }
      })
    }
    editor.on('transaction', schedule)
    editor.on('focus', schedule)
    editor.on('blur', schedule)
    return () => {
      editor.off('transaction', schedule)
      editor.off('focus', schedule)
      editor.off('blur', schedule)
      window.cancelAnimationFrame(frame)
    }
  }, [editor, selector])
  return value
}
