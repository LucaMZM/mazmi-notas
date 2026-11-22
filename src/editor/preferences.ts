import { useCallback, useState, type CSSProperties } from 'react'

/** Per-device writing preferences. They change presentation only, never note content. */
export type EditorFont = 'system' | 'plex' | 'serif' | 'rounded' | 'mono'
export type EditorLeading = 'compact' | 'normal' | 'airy'
export type EditorMeasure = 'narrow' | 'normal' | 'wide'
export type EditorMode = 'rich' | 'markdown' | 'preview'

export interface EditorPreferences {
  font: EditorFont
  size: number
  leading: EditorLeading
  measure: EditorMeasure
  mode: EditorMode
}

export const FONT_OPTIONS: { id: EditorFont; label: string; sample: string }[] = [
  { id: 'system', label: 'Sistema', sample: 'Claridad nativa' },
  { id: 'plex', label: 'Plex', sample: 'Precisión técnica' },
  { id: 'serif', label: 'Serif', sample: 'Lectura pausada' },
  { id: 'rounded', label: 'Redonda', sample: 'Trazo amable' },
  { id: 'mono', label: 'Mono', sample: 'Ritmo constante' },
]
export const LEADING_OPTIONS: { id: EditorLeading; label: string }[] = [
  { id: 'compact', label: 'Compacto' }, { id: 'normal', label: 'Normal' }, { id: 'airy', label: 'Amplio' },
]
export const MEASURE_OPTIONS: { id: EditorMeasure; label: string }[] = [
  { id: 'narrow', label: 'Estrecho' }, { id: 'normal', label: 'Normal' }, { id: 'wide', label: 'Amplio' },
]
export const SIZE_RANGE = { min: 14, max: 24 }

const KEY = 'mazminotas-editor-preferences-v1'
export const DEFAULT_PREFERENCES: EditorPreferences = { font: 'system', size: 17, leading: 'normal', measure: 'normal', mode: 'rich' }

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

export function readPreferences(): EditorPreferences {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<EditorPreferences>
    const size = Number(raw.size)
    return {
      font: pick(raw.font, FONT_OPTIONS.map((entry) => entry.id), DEFAULT_PREFERENCES.font),
      size: Number.isFinite(size) ? Math.min(SIZE_RANGE.max, Math.max(SIZE_RANGE.min, Math.round(size))) : DEFAULT_PREFERENCES.size,
      leading: pick(raw.leading, LEADING_OPTIONS.map((entry) => entry.id), DEFAULT_PREFERENCES.leading),
      measure: pick(raw.measure, MEASURE_OPTIONS.map((entry) => entry.id), DEFAULT_PREFERENCES.measure),
      mode: pick(raw.mode, ['rich', 'markdown', 'preview'] as const, DEFAULT_PREFERENCES.mode),
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

export function useEditorPreferences() {
  const [preferences, setPreferences] = useState(readPreferences)
  const update = useCallback((patch: Partial<EditorPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch }
      try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* Preferences are optional. */ }
      return next
    })
  }, [])
  return [preferences, update] as const
}

const FONT_STACKS: Record<EditorFont, string> = {
  system: 'var(--font-ui)', plex: 'var(--font-plex)', serif: 'var(--font-serif)', rounded: 'var(--font-rounded)', mono: 'var(--font-plex-mono)',
}
const LEADINGS: Record<EditorLeading, number> = { compact: 1.55, normal: 1.78, airy: 2.02 }
const MEASURES: Record<EditorMeasure, string> = { narrow: '620px', normal: '720px', wide: '880px' }

/** CSS custom properties applied through the CSSOM, which the strict production CSP allows. */
export function preferenceStyle(preferences: EditorPreferences): CSSProperties {
  return {
    '--editor-font': FONT_STACKS[preferences.font],
    '--editor-size': preferences.size + 'px',
    '--editor-leading': LEADINGS[preferences.leading],
    '--editor-measure': MEASURES[preferences.measure],
  } as CSSProperties
}
