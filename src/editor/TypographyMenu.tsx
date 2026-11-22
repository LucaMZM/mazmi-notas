import { memo, useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { keys } from '../utils/platform'
import { FONT_OPTIONS, LEADING_OPTIONS, MEASURE_OPTIONS, SIZE_RANGE, type EditorPreferences } from './preferences'

const SHORTCUTS: [string, string][] = [
  ['⌘B · ⌘I · ⌘U', 'Negrita, cursiva, subrayado'], ['⌘⇧S', 'Tachado'], ['⌘⇧H', 'Resaltar'],
  ['⌘⌥1–3', 'Encabezados'], ['⌘⇧7 · 8 · 9', 'Lista numerada, viñetas, tareas'], ['⌘⇧E', 'Centrar párrafo'],
  ['/', 'Insertar bloque'], ['⌘Z · ⌘⇧Z', 'Deshacer, rehacer'],
]

function TypographyMenuView({ preferences, update }: {
  preferences: EditorPreferences
  update: (patch: Partial<EditorPreferences>) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); root.current?.querySelector('button')?.focus() } }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [open])

  const step = (delta: number) => update({ size: Math.min(SIZE_RANGE.max, Math.max(SIZE_RANGE.min, preferences.size + delta)) })

  return <div className="typography" ref={root}>
    <button type="button" className="typography-trigger" aria-expanded={open} aria-haspopup="dialog"
      aria-label="Tipografía y lectura" data-tip="Tipografía y lectura" onClick={() => setOpen(!open)}>
      <Icon name="type" size={18} />
    </button>
    {open && <div className="typography-panel" role="dialog" aria-label="Tipografía y lectura">
      <p className="panel-label">Familia</p>
      <div className="font-grid" role="radiogroup" aria-label="Familia tipográfica">
        {FONT_OPTIONS.map((entry) => <button key={entry.id} type="button" role="radio" aria-checked={preferences.font === entry.id}
          className={'font-choice font-' + entry.id} onClick={() => update({ font: entry.id })}>
          <span className="font-sample" aria-hidden="true">Ag</span><span>{entry.label}</span>
        </button>)}
      </div>
      <div className="panel-row">
        <p className="panel-label">Tamaño</p>
        <div className="stepper" role="group" aria-label="Tamaño de letra">
          <button type="button" aria-label="Reducir tamaño" disabled={preferences.size <= SIZE_RANGE.min} onClick={() => step(-1)}>−</button>
          <output aria-live="polite">{preferences.size} pt</output>
          <button type="button" aria-label="Aumentar tamaño" disabled={preferences.size >= SIZE_RANGE.max} onClick={() => step(1)}>+</button>
        </div>
      </div>
      <p className="panel-label">Interlineado</p>
      <div className="choice-row" role="radiogroup" aria-label="Interlineado">
        {LEADING_OPTIONS.map((entry) => <button key={entry.id} type="button" role="radio" aria-checked={preferences.leading === entry.id}
          onClick={() => update({ leading: entry.id })}>{entry.label}</button>)}
      </div>
      <p className="panel-label">Ancho del texto</p>
      <div className="choice-row" role="radiogroup" aria-label="Ancho del texto">
        {MEASURE_OPTIONS.map((entry) => <button key={entry.id} type="button" role="radio" aria-checked={preferences.measure === entry.id}
          onClick={() => update({ measure: entry.id })}>{entry.label}</button>)}
      </div>
      <details className="shortcut-list">
        <summary>Atajos de teclado</summary>
        <dl>{SHORTCUTS.map(([combo, label]) => <div key={combo}><dt><kbd>{keys(combo)}</kbd></dt><dd>{label}</dd></div>)}</dl>
      </details>
      <p className="panel-foot">Se aplica en este equipo. No modifica el contenido de tus notas.</p>
    </div>}
  </div>
}

export const TypographyMenu = memo(TypographyMenuView)
