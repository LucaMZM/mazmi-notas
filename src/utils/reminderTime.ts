import type { Reminder, ReminderRepeat } from '../types'

/** The system zone as an IANA name (falls back to UTC). */
export function systemZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

export function isValidZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true } catch { return false }
}

/** Offset (ms) of `zone` from UTC at instant `at`. */
function offset(at: number, zone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]))
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - at
}

interface Wall { year: number; month: number; day: number; hour: number; minute: number }

export function parseWall(value: string): Wall | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const [year, month, day, hour, minute] = match.slice(1).map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59) return null
  return { year, month, day, hour, minute }
}

/** UTC milliseconds of a wall-clock time in `zone` (non-existent times move forward). */
export function wallToInstant(wall: Wall, zone: string): number {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  let at = guess - offset(guess, zone)
  at = guess - offset(at, zone)
  return at
}

function daysIn(year: number, month: number) { return new Date(Date.UTC(year, month, 0)).getUTCDate() }

function occurrence(start: Wall, repeat: ReminderRepeat, k: number): Wall {
  if (repeat === 'monthly') {
    const months = start.month - 1 + k
    const year = start.year + Math.floor(months / 12)
    const month = ((months % 12) + 12) % 12 + 1
    return { ...start, year, month, day: Math.min(start.day, daysIn(year, month)) }
  }
  const step = repeat === 'weekly' ? 7 * k : repeat === 'daily' ? k : 0
  const date = new Date(Date.UTC(start.year, start.month - 1, start.day + step))
  return { ...start, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

/** First occurrence strictly after `after` (ms), or null for a past one-off reminder. */
export function nextAfter(localTime: string, zone: string, repeat: ReminderRepeat, after: number): number | null {
  const start = parseWall(localTime)
  if (!start) return null
  if (repeat === 'none') { const at = wallToInstant(start, zone); return at > after ? at : null }
  for (let k = 0; k < 5000; k += 1) {
    const at = wallToInstant(occurrence(start, repeat, k), zone)
    if (at > after) return at
  }
  return null
}

const REPEAT_LABEL: Record<ReminderRepeat, string> = { none: '', daily: 'cada día', weekly: 'cada semana', monthly: 'cada mes' }

/** «Hoy, 9:00», «mañana, 18:30», «jue 20 nov, 9:00» — in the viewer's zone, plus the zone when it differs. */
export function describeReminder(reminder: Pick<Reminder, 'nextFireAt' | 'snoozedUntil' | 'lastFiredAt' | 'repeat' | 'timeZone'>, now = Date.now()): string {
  const target = reminder.snoozedUntil ?? reminder.nextFireAt ?? reminder.lastFiredAt
  if (!target) return 'Sin fecha'
  const date = new Date(target * 1000)
  const zone = reminder.timeZone
  const day = new Intl.DateTimeFormat('es-ES', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const today = day.format(new Date(now))
  const tomorrow = day.format(new Date(now + 86_400_000))
  const time = new Intl.DateTimeFormat('es-ES', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(date)
  const label = day.format(date) === today ? 'hoy' : day.format(date) === tomorrow ? 'mañana'
    : new Intl.DateTimeFormat('es-ES', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }).format(date)
  const repeat = REPEAT_LABEL[reminder.repeat]
  const zoneNote = zone !== systemZone() ? ` (${zone.split('/').pop()?.replace(/_/g, ' ')})` : ''
  return `${label}, ${time}${zoneNote}${repeat ? ' · ' + repeat : ''}`
}

/** Splits a stored wall time into the date and time inputs' values. */
export function toInputs(localTime: string): { date: string; time: string } {
  const [date = '', time = ''] = localTime.split('T')
  return { date, time }
}

/** A sensible default: the next full hour, in the given zone. */
export function defaultWall(zone: string, now = Date.now()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(new Date(now + 3_600_000)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`
}
