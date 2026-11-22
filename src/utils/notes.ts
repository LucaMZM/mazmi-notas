import type {
  Backlink,
  Note,
  NoteDraft,
  NoteSummary,
  SortOrder,
} from '../types'

export const TAG_SEPARATOR = '\u001f'

export function normalizeTags(input: string | string[]): string[] {
  const values = Array.isArray(input) ? input : input.split(',')

  const deduped = new Set<string>()
  for (const value of values) {
    const normalized = value.trim().toLowerCase()
    if (normalized.length > 0) {
      deduped.add(normalized)
    }
  }

  return [...deduped]
}

export function splitTagBlob(tagsBlob: string): string[] {
  if (!tagsBlob) {
    return []
  }
  return normalizeTags(tagsBlob.split(TAG_SEPARATOR))
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

export function formatUnix(unix: number): string {
  return new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(unix * 1000))
}

export function toNoteSummary(note: Note): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    tags: note.tags,
    isDeleted: note.isDeleted,
    deletedAt: note.deletedAt,
    folderId: note.folderId ?? null,
  }
}

export function matchesSearch(note: Pick<Note, 'title' | 'contentPlain' | 'tags'>, search: string): boolean {
  const query = search.trim().toLowerCase()
  if (!query) {
    return true
  }

  if (note.title.toLowerCase().includes(query)) {
    return true
  }

  if (note.contentPlain.toLowerCase().includes(query)) {
    return true
  }

  return note.tags.some((tag) => tag.includes(query))
}

export function sortNotes(notes: NoteSummary[], sortOrder: SortOrder): NoteSummary[] {
  const cloned = [...notes]

  if (sortOrder === 'alphabetical') {
    cloned.sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }))
    return cloned
  }

  cloned.sort((a, b) => b.updatedAt - a.updatedAt)
  return cloned
}

export function parseWikilinks(text: string): string[] {
  const matches = text.match(/\[\[([^\]]+)\]\]/g) ?? []
  const deduped = new Set<string>()

  for (const match of matches) {
    const value = match.slice(2, -2).trim()
    if (value) {
      deduped.add(value)
    }
  }

  return [...deduped]
}

export function detectWikilinkQuery(text: string, cursor: number): { query: string; start: number } | null {
  const prefix = text.slice(0, cursor)
  const match = prefix.match(/\[\[([^\]\n]*)$/)
  if (!match) {
    return null
  }

  const query = match[1] ?? ''
  const start = prefix.length - match[0].length

  return { query, start }
}

export function applyWikilinkCompletion(
  text: string,
  cursor: number,
  completionTitle: string,
): { text: string; cursor: number } {
  const query = detectWikilinkQuery(text, cursor)
  if (!query) {
    return { text, cursor }
  }

  const insertion = `[[${completionTitle}]]`
  const next = `${text.slice(0, query.start)}${insertion}${text.slice(cursor)}`

  return {
    text: next,
    cursor: query.start + insertion.length,
  }
}

export function markdownExportContent(note: Pick<Note, 'title' | 'contentMd' | 'contentPlain'>): string {
  const title = note.title.trim()
  const body = note.contentMd.trim() ? note.contentMd : note.contentPlain

  if (!title) {
    return body
  }

  return `# ${title}\n\n${body}`
}

export function deriveDailyNoteTitle(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `Daily ${year}-${month}-${day}`
}

export function backlinksToMap(backlinks: Backlink[]): Map<string, Backlink[]> {
  const map = new Map<string, Backlink[]>()

  for (const item of backlinks) {
    const existing = map.get(item.fromNoteId) ?? []
    existing.push(item)
    map.set(item.fromNoteId, existing)
  }

  return map
}

export function buildDraftFromNote(note: Note): NoteDraft {
  return {
    title: note.title,
    contentRichJson: note.contentRichJson,
    contentMd: note.contentMd,
    contentPlain: note.contentPlain,
    tags: [...note.tags],
  }
}
