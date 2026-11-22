import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Note, NoteDraft, NoteVersion } from '../../src/types'
import { VERSION_SESSION_SECONDS, WebDbRepository } from '../../src/services/webDb'

/** Moves the clock past the writing-session window so the next save starts a new session. */
function later() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + (VERSION_SESSION_SECONDS + 1) * 1000)
}

const STORAGE_KEY = 'scribedock-web-store-v4'

type Snapshot = NoteVersion & { snapshotMd?: string }
interface Backup {
  id: string
  createdAt: number
  version?: number
  notes: Note[]
  versions: Snapshot[]
  links: Array<{ source: string; target: string; label: string }>
}
interface Store {
  version?: number
  notes: Note[]
  versions: Snapshot[]
  links: Backup['links']
  backups: Backup[]
}

function draft(title = 'Alpha', markdown = 'Original'): NoteDraft {
  return {
    title,
    contentRichJson: JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }],
    }),
    contentMd: markdown,
    contentPlain: markdown,
    tags: ['qa'],
  }
}

function persisted(): Store {
  return JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Store
}

function seed(store: unknown): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

let repository: WebDbRepository

beforeEach(() => {
  // Only the browser storage boundary is replaced; all repository logic is real.
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
  vi.stubGlobal('localStorage', storage)
  repository = new WebDbRepository()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('storage integrity', () => {
  it.each(['', '{truncated', 'null', '[]', '{}', '{"notes":{}}'])('rejects corrupt storage %j without overwriting it', async (raw) => {
    localStorage.setItem(STORAGE_KEY, raw)
    await expect(repository.selfCheck()).rejects.toThrow()
    await expect(repository.createNote(draft())).rejects.toThrow()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
  })

  it('accepts an absent store and persists under the existing key', async () => {
    expect(await repository.listNotes('', 'recent', false)).toEqual([])
    const note = await repository.createNote(draft())
    expect(await new WebDbRepository().getNote(note.id)).toMatchObject({ title: 'Alpha', contentMd: 'Original' })
    expect(localStorage.length).toBe(1)
    expect(localStorage.key(0)).toBe(STORAGE_KEY)
  })

  it.each(['note', 'rich-json', 'version', 'link', 'duplicate-id', 'future-version'])('rejects invalid %s data without writing', async (kind) => {
    const note = await repository.createNote(draft())
    const store = persisted()
    if (kind === 'note') Reflect.set(store.notes[0], 'tags', [17])
    if (kind === 'rich-json') store.notes[0].contentRichJson = '{broken}'
    if (kind === 'version') Reflect.set(store.versions[0], 'snapshotPlain', null)
    if (kind === 'link') store.links.push({ source: note.id, target: 'missing', label: 'Missing' })
    if (kind === 'duplicate-id') store.notes.push({ ...store.notes[0] })
    if (kind === 'future-version') store.version = 999
    seed(store)
    const before = localStorage.getItem(STORAGE_KEY)
    await expect(repository.createNote(draft('Other'))).rejects.toThrow()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
  })

  it('recovers Markdown when a legacy note has empty rich content without rewriting storage on read', async () => {
    const note = await repository.createNote(draft('Legacy', '# Recovered\n\nBody'))
    const store = persisted()
    delete store.version
    store.notes[0].contentRichJson = ''
    seed(store)
    const before = localStorage.getItem(STORAGE_KEY)
    const recovered = await repository.getNote(note.id)
    expect(recovered!.contentRichJson).toContain('Recovered')
    expect(JSON.parse(recovered!.contentRichJson).content[0]).toMatchObject({ type: 'heading' })
    expect(recovered!.contentMd).toBe('# Recovered\n\nBody')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
  })

  it('recovers rich content from Markdown in incoming legacy drafts', async () => {
    const incoming = { ...draft('Legacy', '# Heading'), contentRichJson: '' }
    const note = await repository.createNote(incoming)
    expect(JSON.parse(note.contentRichJson).content[0].type).toBe('heading')
    await repository.updateNote(note.id, { ...incoming, contentMd: '# Changed' })
    expect((await repository.getNote(note.id))!.contentRichJson).toContain('Changed')
  })

  it('propagates write failures while keeping the previous persisted state', async () => {
    const note = await repository.createNote(draft())
    const before = localStorage.getItem(STORAGE_KEY)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    await expect(repository.updateNote(note.id, draft('Changed'))).rejects.toThrow('quota exceeded')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
  })
})

describe('writes and versions', () => {
  it.each(['missing', 'trashed'])('rejects updates to a %s note without writing', async (kind) => {
    const note = await repository.createNote(draft())
    if (kind === 'trashed') await repository.moveToTrash(note.id)
    const before = localStorage.getItem(STORAGE_KEY)
    await expect(repository.updateNote(kind === 'missing' ? 'missing' : note.id, draft('Wrong'))).rejects.toThrow()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
  })

  it('does not duplicate snapshots for unchanged content or metadata-only edits', async () => {
    const note = await repository.createNote(draft())
    await repository.updateNote(note.id, draft())
    await repository.updateNote(note.id, { ...draft('Renamed'), tags: ['other'] })
    expect(await repository.listVersions(note.id)).toHaveLength(1)
  })

  it('stores and restores the exact Markdown snapshot, including whitespace-only content', async () => {
    const markdown = '  # Heading\r\n\r\n**bold**  \r\n'
    const note = await repository.createNote(draft('Exact', markdown))
    const original = (await repository.listVersions(note.id))[0] as Snapshot
    expect(original.snapshotMd).toBe(markdown)
    later()
    await repository.updateNote(note.id, { ...draft('Exact', ' \n\t '), contentRichJson: '' })
    expect((await repository.getNote(note.id))!.contentMd).toBe(' \n\t ')
    later()
    await repository.updateNote(note.id, draft('Exact', 'Next session'))
    const whitespace = (await repository.listVersions(note.id) as Snapshot[]).find((entry) => entry.snapshotMd === ' \n\t ') as Snapshot
    await repository.restoreVersion(note.id, original.id)
    expect((await repository.getNote(note.id))!.contentMd).toBe(markdown)
    await repository.restoreVersion(note.id, whitespace.id)
    expect((await repository.getNote(note.id))!.contentMd).toBe(' \n\t ')
  })

  it('falls back to rich serialization for old snapshots without snapshotMd', async () => {
    const note = await repository.createNote(draft())
    const store = persisted()
    delete store.versions[0].snapshotMd
    const oldId = store.versions[0].id
    seed(store)
    await repository.updateNote(note.id, draft('Alpha', 'Later'))
    await repository.restoreVersion(note.id, oldId)
    expect((await repository.getNote(note.id))!.contentMd).toBe('Original')
  })

  it('does not reconstruct an intentionally empty Markdown snapshot from rich content', async () => {
    const note = await repository.createNote({ ...draft(), contentMd: '' })
    const version = (await repository.listVersions(note.id))[0] as Snapshot
    expect(version.snapshotMd).toBe('')
    await repository.updateNote(note.id, draft('Alpha', 'Later'))
    await repository.restoreVersion(note.id, version.id)
    expect((await repository.getNote(note.id))!.contentMd).toBe('')
  })

  it('adds a version for a Markdown-only change and not for restoring the current version', async () => {
    const note = await repository.createNote(draft())
    later()
    await repository.updateNote(note.id, { ...draft(), contentMd: 'Original\n' })
    later()
    await repository.updateNote(note.id, { ...draft(), contentMd: 'Original\n' })
    const versions = await repository.listVersions(note.id) as Snapshot[]
    expect(versions).toHaveLength(2)
    const current = versions.find((entry) => entry.snapshotMd === 'Original\n')!
    await repository.restoreVersion(note.id, current.id)
    expect(await repository.listVersions(note.id)).toHaveLength(2)
  })

  it.each(['missing-note', 'trashed-note', 'missing-version', 'other-note'])('rejects restoring %s without writing', async (kind) => {
    const note = await repository.createNote(draft())
    const other = await repository.createNote(draft('Other'))
    const version = (await repository.listVersions(note.id))[0]
    if (kind === 'trashed-note') await repository.moveToTrash(note.id)
    const before = localStorage.getItem(STORAGE_KEY)
    const id = kind === 'missing-note' ? 'missing' : kind === 'other-note' ? other.id : note.id
    await expect(repository.restoreVersion(id, kind === 'missing-version' ? 'missing' : version.id)).rejects.toThrow()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
  })

  it('retains earlier snapshots beyond 100 saves and records revisited content', async () => {
    const note = await repository.createNote(draft())
    const originalId = (await repository.listVersions(note.id))[0].id
    for (let index = 0; index < 105; index += 1) {
      later()
      await repository.updateNote(note.id, draft('Alpha', `Revision ${index}`))
    }
    await repository.restoreVersion(note.id, originalId)
    const versions = await repository.listVersions(note.id)
    expect(versions).toHaveLength(107)
    expect(versions.some((entry) => entry.id === originalId)).toBe(true)
    expect(persisted().versions).toHaveLength(107)
  })
})

describe('writing sessions', () => {
  it('coalesces autosaves within a session into the snapshot taken before it', async () => {
    const note = await repository.createNote(draft('Alpha', 'Inicio'))
    for (let index = 0; index < 50; index += 1) await repository.updateNote(note.id, draft('Alpha', `Tecla ${index}`))
    expect((await repository.listVersions(note.id) as Snapshot[]).map((entry) => entry.snapshotMd)).toEqual(['Inicio'])
    later()
    await repository.updateNote(note.id, draft('Alpha', 'Otra sesión'))
    await repository.updateNote(note.id, draft('Alpha', 'Otra sesión, más'))
    expect((await repository.listVersions(note.id) as Snapshot[]).map((entry) => entry.snapshotMd).sort()).toEqual(['Inicio', 'Tecla 49'])
    expect((await repository.getNote(note.id))!.contentMd).toBe('Otra sesión, más')
  })
})

describe('backups and restore', () => {
  it('keeps deep snapshots isolated from edits, returned objects and later restores', async () => {
    const note = await repository.createNote(draft())
    await repository.backupNow()
    const backupId = (await repository.listBackups())[0]
    note.tags.push('mutated')
    await repository.updateNote(note.id, { ...draft('Alpha', 'Later'), tags: ['later'] })
    await repository.restoreBackup(backupId)
    const restored = await repository.getNote(note.id)
    expect(restored).toMatchObject({ contentMd: 'Original', tags: ['qa'] })
    await repository.updateNote(note.id, draft('Alpha', 'After restore'))
    await repository.restoreBackup(backupId)
    expect(await repository.getNote(note.id)).toMatchObject({ contentMd: 'Original', tags: ['qa'] })
  })

  it('creates a recoverable pre-restore backup with unique ids even in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const note = await repository.createNote(draft())
    await repository.backupNow()
    const originalId = (await repository.listBackups())[0]
    await repository.updateNote(note.id, draft('Alpha', 'Before restore'))
    const before = persisted()
    await repository.restoreBackup(originalId)
    const backups = await repository.listBackups()
    expect(backups).toHaveLength(2)
    expect(new Set(backups).size).toBe(2)
    const recoveryId = backups.find((id) => id !== originalId)!
    const recovery = persisted().backups.find((entry) => entry.id === recoveryId)!
    expect(recovery.notes).toEqual(before.notes)
    expect(recovery.versions).toEqual(before.versions)
    expect(recovery.links).toEqual(before.links)
    await repository.restoreBackup(recoveryId)
    expect((await repository.getNote(note.id))!.contentMd).toBe('Before restore')
  })

  it.each(['version', 'schema', 'note', 'snapshot', 'link'])('rejects an invalid backup %s without losing current data', async (kind) => {
    const note = await repository.createNote(draft())
    await repository.backupNow()
    await repository.updateNote(note.id, draft('Alpha', 'Current'))
    const store = persisted()
    const backup = store.backups[0]
    if (kind === 'version') backup.version = 999
    if (kind === 'schema') Reflect.set(backup, 'notes', null)
    if (kind === 'note') Reflect.set(backup.notes[0], 'contentMd', 42)
    if (kind === 'snapshot') Reflect.set(backup.versions[0], 'snapshotMd', 42)
    if (kind === 'link') backup.links.push({ source: note.id, target: 'absent', label: 'Absent' })
    seed(store)
    const before = localStorage.getItem(STORAGE_KEY)
    await expect(repository.restoreBackup(backup.id)).rejects.toThrow()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
  })

  it('restores legacy unversioned backups', async () => {
    const note = await repository.createNote(draft())
    await repository.backupNow()
    const store = persisted()
    delete store.version
    delete store.backups[0].version
    const id = store.backups[0].id
    seed(store)
    await repository.updateNote(note.id, draft('Alpha', 'Later'))
    await repository.restoreBackup(id)
    expect((await repository.getNote(note.id))!.contentMd).toBe('Original')
  })

  it('rebuilds outdated backup links from restored note content', async () => {
    const target = await repository.createNote(draft('Target'))
    const source = await repository.createNote(draft('Source', '[[Target]]'))
    await repository.backupNow()
    const store = persisted()
    const id = store.backups[0].id
    store.backups[0].links = []
    seed(store)
    await repository.updateNote(source.id, draft('Source', 'Unlinked'))
    await repository.restoreBackup(id)
    expect(await repository.listBacklinks(target.id)).toEqual([{ fromNoteId: source.id, fromTitle: 'Source', linkText: 'Target' }])
  })

  it('preserves all existing backups when creating recovery snapshots', async () => {
    await repository.createNote(draft())
    await repository.backupNow()
    const store = persisted()
    const template = store.backups[0]
    store.backups = Array.from({ length: 31 }, (_, index) => ({ ...template, id: `old-${index}` }))
    seed(store)
    await repository.restoreBackup('old-0')
    expect(await repository.listBackups()).toHaveLength(32)
    await repository.backupNow()
    expect(await repository.listBackups()).toHaveLength(33)
    expect((await repository.listBackups()).includes('old-0')).toBe(true)
  })

  it('does not write or create recovery snapshots when the target is missing', async () => {
    await repository.createNote(draft())
    const before = localStorage.getItem(STORAGE_KEY)
    await expect(repository.restoreBackup('missing')).rejects.toThrow()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
  })

  it('leaves data and backups untouched when persisting a restore fails', async () => {
    const note = await repository.createNote(draft())
    await repository.backupNow()
    await repository.updateNote(note.id, draft('Alpha', 'Current'))
    const before = localStorage.getItem(STORAGE_KEY)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    await expect(repository.restoreBackup()).rejects.toThrow('quota exceeded')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
  })
})

describe('link rebuilding', () => {
  it('resolves previously missing destinations when a target is created', async () => {
    const source = await repository.createNote(draft('Source', '[[Target]] [[Target]]'))
    const target = await repository.createNote(draft('Target'))
    expect(await repository.listBacklinks(target.id)).toEqual([
      { fromNoteId: source.id, fromTitle: 'Source', linkText: 'Target' },
    ])
  })

  it('rebuilds incoming links after renaming a destination', async () => {
    const target = await repository.createNote(draft('Old'))
    const source = await repository.createNote(draft('Source', '[[Old]] [[New]]'))
    await repository.updateNote(target.id, draft('New'))
    expect((await repository.listBacklinks(target.id)).map((entry) => entry.linkText)).toEqual(['New'])
    expect(await repository.listBacklinks(target.id)).toEqual([{ fromNoteId: source.id, fromTitle: 'Source', linkText: 'New' }])
  })

  it('excludes trashed sources and restores their backlinks', async () => {
    const target = await repository.createNote(draft('Target'))
    const source = await repository.createNote(draft('Source', '[[Target]]'))
    await repository.moveToTrash(source.id)
    expect(await repository.listBacklinks(target.id)).toEqual([])
    await repository.restoreNote(source.id)
    expect(await repository.listBacklinks(target.id)).toHaveLength(1)
  })

  it('excludes trashed targets from backlinks and keeps the stored relation', async () => {
    const target = await repository.createNote(draft('Target'))
    await repository.createNote(draft('Source', '[[Target]]'))
    await repository.moveToTrash(target.id)
    expect(await repository.listBacklinks(target.id)).toEqual([])
    await repository.restoreNote(target.id)
    expect(await repository.listBacklinks(target.id)).toHaveLength(1)
  })

  it('re-resolves links after permanently deleting one of two same-title targets', async () => {
    const first = await repository.createNote(draft('Target'))
    const second = await repository.createNote(draft('Target'))
    const source = await repository.createNote(draft('Source', '[[Target]]'))
    await repository.deleteNotePermanently(first.id)
    expect(await repository.listBacklinks(second.id)).toEqual([{ fromNoteId: source.id, fromTitle: 'Source', linkText: 'Target' }])
  })

  it('rebuilds links after restoring content from a version', async () => {
    const target = await repository.createNote(draft('Target'))
    const source = await repository.createNote(draft('Source', '[[Target]]'))
    const linkedVersion = (await repository.listVersions(source.id))[0].id
    await repository.updateNote(source.id, draft('Source', 'No links'))
    expect(await repository.listBacklinks(target.id)).toEqual([])
    await repository.restoreVersion(source.id, linkedVersion)
    expect(await repository.listBacklinks(target.id)).toHaveLength(1)
  })
})

describe('web vault', () => {
  it.each(['exportVault', 'importVault'] as const)('%s rejects honestly without modifying storage', async (method) => {
    await repository.createNote(draft())
    const before = localStorage.getItem(STORAGE_KEY)
    await expect(repository[method]()).rejects.toThrow(/Tauri/i)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
  })
})

describe('legacy history safety', () => {
  it('preserves the exact pre-edit Markdown when a legacy note has no snapshots', async () => {
    const note = await repository.createNote(draft('Legacy', '3. **Original**\n\n  spaces  \n'))
    const store = persisted()
    store.versions = []
    seed(store)
    await repository.updateNote(note.id, draft('Legacy', 'Edited'))
    const versions = await repository.listVersions(note.id)
    expect(versions.some((version) => version.snapshotMd === '3. **Original**\n\n  spaces  \n')).toBe(true)
  })

  it('preserves the current content before restoring an older version absent from the latest history', async () => {
    const note = await repository.createNote(draft('Legacy', 'Old'))
    const store = persisted()
    const old = store.versions[0].id
    store.notes[0] = { ...store.notes[0], ...draft('Legacy', 'Unversioned current') }
    seed(store)
    await repository.restoreVersion(note.id, old)
    expect((await repository.getNote(note.id))?.contentMd).toBe('Old')
    const versions = await repository.listVersions(note.id)
    expect(versions.some((version) => version.snapshotMd === 'Unversioned current')).toBe(true)
  })
})
