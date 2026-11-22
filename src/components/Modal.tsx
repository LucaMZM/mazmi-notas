import { Icon } from './Icon'
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

const EXIT_MS = 130
const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function Modal({ title, children, close, className = '', initialFocus }: {
  title: string; children: ReactNode; close: () => void; className?: string; initialFocus?: RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [closing, setClosing] = useState(false)
  const timer = useRef(0)

  useEffect(() => {
    const dialog = ref.current
    const previous = document.activeElement as HTMLElement | null
    dialog?.showModal()
    initialFocus?.current?.focus()
    return () => { window.clearTimeout(timer.current); dialog?.close(); previous?.focus() }
  }, [initialFocus])

  // A short exit animation for user-initiated closes; the parent still decides (busy guards).
  const dismiss = useCallback(() => {
    if (closing) return
    if (prefersReducedMotion()) { close(); return }
    setClosing(true)
    timer.current = window.setTimeout(() => { setClosing(false); close() }, EXIT_MS)
  }, [close, closing])

  return <dialog ref={ref} aria-label={title} className={'modal ' + className + (closing ? ' closing' : '')}
    onCancel={(event) => { event.preventDefault(); dismiss() }}
    onClick={(event) => { if (event.target === event.currentTarget) dismiss() }}>
    <div className="modal-surface">
      <header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="Cerrar diálogo" onClick={dismiss}><Icon name="close" size={17} /></button></header>
      {children}
    </div>
  </dialog>
}
