import { describe, expect, it } from 'vitest'
import { defaultWall, describeReminder, isValidZone, nextAfter, parseWall, toInputs, wallToInstant } from '../../src/utils/reminderTime'

describe('reminderTime', () => {
  it('parses and validates wall times', () => {
    expect(parseWall('2026-11-18T09:30')).toEqual({ year: 2026, month: 11, day: 18, hour: 9, minute: 30 })
    expect(parseWall('2026-02-30T09:00')).toBeNull()
    expect(parseWall('2026-11-18T24:00')).toBeNull()
    expect(parseWall('mañana')).toBeNull()
    expect(toInputs('2026-11-18T09:30')).toEqual({ date: '2026-11-18', time: '09:30' })
  })

  it('validates IANA zones', () => {
    expect(isValidZone('Europe/Madrid')).toBe(true)
    expect(isValidZone('Mars/Olympus')).toBe(false)
  })

  it('converts wall time in a zone across DST', () => {
    // Madrid: CET (+1) in winter, CEST (+2) in summer.
    expect(wallToInstant(parseWall('2026-01-15T09:00')!, 'Europe/Madrid')).toBe(Date.UTC(2026, 0, 15, 8, 0))
    expect(wallToInstant(parseWall('2026-07-15T09:00')!, 'Europe/Madrid')).toBe(Date.UTC(2026, 6, 15, 7, 0))
    // 02:30 on 29 March 2026 does not exist in Madrid: it moves forward.
    expect(wallToInstant(parseWall('2026-03-29T02:30')!, 'Europe/Madrid')).toBe(Date.UTC(2026, 2, 29, 1, 30))
  })

  it('keeps the wall-clock hour for repeats across DST', () => {
    const before = Date.UTC(2026, 2, 27, 12, 0)
    const next = nextAfter('2026-03-20T09:00', 'Europe/Madrid', 'daily', before)
    expect(next).toBe(Date.UTC(2026, 2, 28, 8, 0))
    expect(nextAfter('2026-03-20T09:00', 'Europe/Madrid', 'daily', next!)).toBe(Date.UTC(2026, 2, 29, 7, 0))
  })

  it('clamps monthly repeats to the end of short months', () => {
    expect(nextAfter('2026-01-31T09:00', 'UTC', 'monthly', Date.UTC(2026, 1, 1))).toBe(Date.UTC(2026, 1, 28, 9, 0))
    expect(nextAfter('2026-01-31T09:00', 'UTC', 'monthly', Date.UTC(2026, 2, 1))).toBe(Date.UTC(2026, 2, 31, 9, 0))
  })

  it('returns null for a past one-off reminder', () => {
    expect(nextAfter('2020-01-01T09:00', 'UTC', 'none', Date.now())).toBeNull()
    expect(nextAfter('2026-11-18T09:00', 'UTC', 'weekly', Date.UTC(2026, 10, 18, 9, 0))).toBe(Date.UTC(2026, 10, 25, 9, 0))
  })

  it('describes reminders relative to today', () => {
    const now = Date.UTC(2026, 10, 18, 10, 0)
    const at = (ms: number) => Math.floor(ms / 1000)
    const base = { snoozedUntil: null, lastFiredAt: null, repeat: 'none' as const, timeZone: 'UTC' }
    expect(describeReminder({ ...base, nextFireAt: at(Date.UTC(2026, 10, 18, 18, 30)) }, now)).toMatch(/^hoy, 18:30/)
    expect(describeReminder({ ...base, nextFireAt: at(Date.UTC(2026, 10, 19, 9, 0)), repeat: 'daily' }, now)).toMatch(/^mañana, 9:00.* · cada día$/)
    expect(describeReminder({ ...base, nextFireAt: at(Date.UTC(2026, 10, 19, 9, 0)), snoozedUntil: at(Date.UTC(2026, 10, 18, 11, 0)) }, now)).toMatch(/^hoy, 11:00/)
    expect(describeReminder({ ...base, nextFireAt: null }, now)).toBe('Sin fecha')
  })

  it('defaults to the next full hour', () => {
    expect(defaultWall('UTC', Date.UTC(2026, 10, 18, 10, 20))).toBe('2026-11-18T11:00')
    expect(defaultWall('UTC', Date.UTC(2026, 11, 31, 23, 20))).toBe('2027-01-01T00:00')
  })
})
