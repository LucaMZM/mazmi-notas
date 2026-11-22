import { describe, expect, it } from 'vitest'
import {
  applyWikilinkCompletion,
  deriveDailyNoteTitle,
  detectWikilinkQuery,
  normalizeTags,
  parseWikilinks,
  sortNotes,
} from '../../src/utils/notes'
import type { NoteSummary } from '../../src/types'

describe('normalizeTags', () => {
  it('normaliza, recorta y deduplica tags', () => {
    const tags = normalizeTags(['  Trabajo', 'ideas', 'trabajo', '', '   URGENTE '])
    expect(tags).toEqual(['trabajo', 'ideas', 'urgente'])
  })

  it('acepta string separado por comas', () => {
    const tags = normalizeTags(' backend, docs ,backend, qa ')
    expect(tags).toEqual(['backend', 'docs', 'qa'])
  })
})

describe('wikilinks', () => {
  it('parsea wikilinks sin duplicados', () => {
    const links = parseWikilinks('Conecta [[Alpha]] con [[Beta]] y [[Alpha]]')
    expect(links).toEqual(['Alpha', 'Beta'])
  })

  it('detecta query de autocompletado', () => {
    const input = 'texto [[Pro'
    const query = detectWikilinkQuery(input, input.length)
    expect(query).toEqual({ query: 'Pro', start: 6 })
  })

  it('aplica autocompletado de wikilink', () => {
    const base = 'texto [[Pro'
    const result = applyWikilinkCompletion(base, base.length, 'Project')
    expect(result.text).toBe('texto [[Project]]')
    expect(result.cursor).toBe(result.text.length)
  })
})

describe('sortNotes', () => {
  const notes: NoteSummary[] = [
    {
      id: 'a',
      title: 'Zeta',
      createdAt: 1,
      updatedAt: 10,
      isDeleted: false,
      deletedAt: null,
      tags: [],
    },
    {
      id: 'b',
      title: 'Alfa',
      createdAt: 1,
      updatedAt: 15,
      isDeleted: false,
      deletedAt: null,
      tags: [],
    },
  ]

  it('ordena por recientes', () => {
    expect(sortNotes(notes, 'recent').map((entry) => entry.id)).toEqual(['b', 'a'])
  })

  it('ordena alfabéticamente', () => {
    expect(sortNotes(notes, 'alphabetical').map((entry) => entry.id)).toEqual(['b', 'a'])
  })
})

describe('daily title', () => {
  it('genera título daily en formato yyyy-mm-dd', () => {
    const result = deriveDailyNoteTitle(new Date('2026-03-05T10:30:00.000Z'))
    expect(result).toBe('Daily 2026-03-05')
  })
})
