import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { Reminder, ReminderCapabilities, ReminderRepeat } from '../types'
import { defaultWall, describeReminder, systemZone, toInputs } from '../utils/reminderTime'

const REPEATS: { id: ReminderRepeat; label: string }[] = [
  { id: 'none', label: 'Una vez' }, { id: 'daily', label: 'Cada día' }, { id: 'weekly', label: 'Cada semana' }, { id: 'monthly', label: 'Cada mes' },
]

function zones(current: string): string[] {
  const all = (() => { try { return Intl.supportedValuesOf('timeZone') } catch { return [] } })()
  return [...new Set([current, systemZone(), ...all])]
}

function platformNote(capabilities: ReminderCapabilities | null): { text: string; warning: boolean } {
  if (!capabilities) return { text: '', warning: false }
  if (capabilities.platform === 'web') return { text: 'En el modo navegador no hay avisos del sistema: los recordatorios vencidos se marcan al abrir la app.', warning: true }
  if (capabilities.permission === 'denied') return { text: 'Las notificaciones de MazmiNotas están desactivadas en los ajustes del sistema.', warning: true }
  if (!capabilities.worksWhenClosed) return { text: 'En este sistema los avisos solo aparecen con MazmiNotas abierta.', warning: true }
  return { text: 'El sistema te avisará aunque MazmiNotas esté cerrada.', warning: false }
}

interface Props {
  reminder: Reminder | null
  capabilities: ReminderCapabilities | null
  disabled: boolean
  onSave: (localTime: string, timeZone: string, repeat: ReminderRepeat) => Promise<boolean>
  onClear: () => void
}

function ReminderControlView({ reminder, capabilities, disabled, onSave, onClear }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const initialZone = reminder?.timeZone ?? systemZone()
  const initial = toInputs(reminder && reminder.status === 'scheduled' ? reminder.localTime : defaultWall(initialZone))
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  const [repeat, setRepeat] = useState<ReminderRepeat>(reminder?.repeat ?? 'none')
  const [zone, setZone] = useState(initialZone)
  const zoneList = useMemo(() => open ? zones(zone) : [], [open, zone])
  const active = reminder && reminder.status === 'scheduled'

  useEffect(() => {
    if (!open) return
    const values = toInputs(active ? reminder.localTime : defaultWall(reminder?.timeZone ?? systemZone()))
    setDate(values.date); setTime(values.time); setRepeat(reminder?.repeat ?? 'none'); setZone(reminder?.timeZone ?? systemZone())
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.reminder-trigger')?.focus() } }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
    // Re-seed only when the popover opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const note = platformNote(capabilities)
  return <div className="reminder-control" ref={root}>
    <button type="button" className={'icon-button reminder-trigger' + (active ? ' active' : '') + (reminder?.needsAttention ? ' attention' : '')}
      aria-label={active ? 'Recordatorio: ' + describeReminder(reminder) : 'Añadir recordatorio'} data-tip={active ? describeReminder(reminder) : 'Recordatorio'}
      aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}><Icon name="bell" size={17} /></button>
    {open && <form className="reminder-panel" role="dialog" aria-label="Recordatorio"
      onSubmit={(event) => {
        event.preventDefault()
        void onSave(`${date}T${time}`, zone, repeat).then((ok) => { if (ok) setOpen(false) })
      }}>
      <p className="panel-label">Recordatorio</p>
      <div className="reminder-when">
        <label><span className="sr-only">Fecha</span><input type="date" required value={date} onChange={(event) => setDate(event.target.value)} aria-label="Fecha" /></label>
        <label><span className="sr-only">Hora</span><input type="time" required value={time} onChange={(event) => setTime(event.target.value)} aria-label="Hora" /></label>
      </div>
      <div className="choice-row reminder-repeat" role="radiogroup" aria-label="Repetición">
        {REPEATS.map((entry) => <button key={entry.id} type="button" role="radio" aria-checked={repeat === entry.id} onClick={() => setRepeat(entry.id)}>{entry.label}</button>)}
      </div>
      <label className="reminder-zone"><span>Zona horaria</span>
        <select value={zone} onChange={(event) => setZone(event.target.value)} aria-label="Zona horaria">
          {zoneList.map((entry) => <option key={entry} value={entry}>{entry.replace(/_/g, ' ')}</option>)}
        </select>
      </label>
      {note.text && <p className={'reminder-note' + (note.warning ? ' warning' : '')}>{note.text}</p>}
      <div className="reminder-actions">
        {reminder && <button type="button" className="danger-text" onClick={() => { setOpen(false); onClear() }}>Quitar</button>}
        <button type="submit" className="primary">{active ? 'Guardar cambios' : 'Programar'}</button>
      </div>
    </form>}
  </div>
}

export const ReminderControl = memo(ReminderControlView)

/** Shown inside a note whose reminder fired and has not been dealt with yet. */
export function ReminderAttention({ reminder, onDone, onSnooze }: { reminder: Reminder; onDone: () => void; onSnooze: (minutes: number) => void }) {
  const fired = reminder.lastFiredAt ? describeReminder({ ...reminder, nextFireAt: null, snoozedUntil: null }) : ''
  return <div className="reminder-attention" role="status">
    <Icon name="bell" size={15} /><span>Recordatorio{fired ? ' · ' + fired.split(' · ')[0] : ''}</span>
    <div className="reminder-attention-actions">
      <button type="button" onClick={() => onSnooze(10)}>10 min</button>
      <button type="button" onClick={() => onSnooze(60)}>1 hora</button>
      <button type="button" onClick={() => onSnooze(60 * 24)}>Mañana</button>
      <button type="button" className="primary" onClick={onDone}>{reminder.repeat === 'none' ? 'Hecho' : 'Visto'}</button>
    </div>
  </div>
}
