import type { TextMatch } from '../types'
import type { Backlink, Folder, Note, NoteDraft, NoteSummary, NoteVersion, Reminder, ReminderCapabilities, ReminderChange, ReminderRepeat, SortOrder } from '../types'
import { pickWebImages, readWebAttachment, saveWebAttachment, webAttachmentUrl } from './webAttachments'
import { isValidZone, nextAfter, parseWall } from '../utils/reminderTime'
import { canMoveFolder, cleanFolderName, folderDepth, MAX_FOLDER_DEPTH } from '../utils/folders'
import {
  deriveDailyNoteTitle,
  markdownExportContent,
  matchesSearch,
  normalizeTags,
  nowUnix,
  parseWikilinks,
  sortNotes,
} from '../utils/notes'
import { deriveContentPlain, markdownToRichJson, normalizeRichJson, richJsonToMarkdown } from '../utils/content'
import type { NotesRepository } from './notesRepository'
import { forgetKey, lockContent, openContent, resealContent, type StoredLock } from './webLocks'

const STORAGE_KEY = 'scribedock-web-store-v4'
/** Ids of protected notes, refreshed on every read of the store. */
let lockedIds = new Set<string>()
const isLocked = (noteId: string) => lockedIds.has(noteId)
const STORE_VERSION = 4

type StoredNote = Note
type StoredVersion = NoteVersion & { snapshotMd?: string }

interface StoredLink {
  source: string
  target: string
  label: string
}

interface StoredData {
  version?: number
  notes: StoredNote[]
  versions: StoredVersion[]
  links: StoredLink[]
  /** Added with folders; stores written before them simply have none. */
  folders?: Folder[]
  reminders?: Reminder[]
  /** Protected notes' encrypted content, by note id (the note itself keeps only its title). */
  locks?: Record<string, StoredLock>
}

interface StoredBackup extends StoredData {
  id: string
  createdAt: number
}

interface WebStore extends StoredData {
  backups: StoredBackup[]
}

function createDefaultStore(): WebStore {
  return {
    version: STORE_VERSION,
    notes: [],
    versions: [],
    links: [],
    backups: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRichNode(value: unknown): boolean {
  return isRecord(value) && typeof value.type === 'string'
    && (value.type !== 'text' || typeof value.text === 'string')
    && (value.content === undefined || (Array.isArray(value.content) && value.content.every(isRichNode)))
    && (value.marks === undefined || (Array.isArray(value.marks)
      && value.marks.every((mark: unknown) => isRecord(mark) && typeof mark.type === 'string')))
}

function isRichJson(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!value.trim()) return true // Legacy notes may only have Markdown.
  try {
    const doc: unknown = JSON.parse(value)
    return isRecord(doc) && doc.type === 'doc' && Array.isArray(doc.content) && doc.content.every(isRichNode)
  } catch {
    return false
  }
}

function isStoredNote(value: unknown): value is StoredNote {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    && typeof value.title === 'string' && isRichJson(value.contentRichJson)
    && typeof value.contentMd === 'string' && typeof value.contentPlain === 'string'
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt)
    && typeof value.isDeleted === 'boolean' && (value.deletedAt === null || isTimestamp(value.deletedAt))
    && Array.isArray(value.tags) && value.tags.every((tag: unknown) => typeof tag === 'string')
}

function isStoredVersion(value: unknown): value is StoredVersion {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    && typeof value.noteId === 'string' && isRichJson(value.snapshotRichJson)
    && typeof value.snapshotPlain === 'string' && isTimestamp(value.createdAt)
    && (value.snapshotMd === undefined || typeof value.snapshotMd === 'string')
}

function assertStoredData(value: unknown): asserts value is StoredData {
  if (!isRecord(value) || (value.version !== undefined && value.version !== STORE_VERSION)
    || !Array.isArray(value.notes) || !value.notes.every(isStoredNote)
    || !Array.isArray(value.versions) || !value.versions.every(isStoredVersion)
    || !Array.isArray(value.links)) {
    throw new Error('Almacenamiento web corrupto: esquema o version no compatible; no se han modificado los datos')
  }

  const noteIds = new Set(value.notes.map((note: StoredNote) => note.id))
  const versionIds = new Set(value.versions.map((version: StoredVersion) => version.id))
  if (noteIds.size !== value.notes.length || versionIds.size !== value.versions.length
    || value.versions.some((version: StoredVersion) => !noteIds.has(version.noteId))
    || !value.links.every((link: unknown) => isRecord(link)
      && typeof link.source === 'string' && typeof link.target === 'string' && typeof link.label === 'string'
      && noteIds.has(link.source) && noteIds.has(link.target))) {
    throw new Error('Almacenamiento web corrupto: ids o referencias invalidas; no se han modificado los datos')
  }
}

function assertBackup(value: unknown): asserts value is StoredBackup {
  assertStoredData(value)
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || !isTimestamp(value.createdAt)) {
    throw new Error('Backup web invalido; no se han modificado los datos')
  }
}

function recoverRichJson(rich: string, markdown: string): string {
  return normalizeRichJson(rich.trim() ? rich : markdownToRichJson(markdown))
}

function recoverLegacyNote(note: StoredNote): StoredNote {
  if (note.folderId === undefined) note = { ...note, folderId: null }
  if (note.contentRichJson.trim()) return note
  const rich = recoverRichJson(note.contentRichJson, note.contentMd)
  return { ...note, contentRichJson: rich, contentPlain: deriveContentPlain(rich, note.contentMd) }
}

/** Lower case without accents, with the position of each folded character in the original. */
function foldChars(text: string): { text: string; index: number[] } {
  let folded = ''
  const index: number[] = []
  for (let position = 0; position < text.length; position += 1) {
    const plain = text[position].normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    for (const char of plain) { folded += char; index.push(position) }
  }
  return { text: folded, index }
}

function readStore(): WebStore {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) {
    return createDefaultStore()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Almacenamiento web corrupto: JSON invalido; no se han modificado los datos')
  }
  assertStoredData(parsed)
  if (!isRecord(parsed) || !Array.isArray(parsed.backups)) {
    throw new Error('Almacenamiento web corrupto: backups invalidos; no se han modificado los datos')
  }
  const backups = parsed.backups.map((backup: unknown) => {
    assertBackup(backup)
    return backup
  })
  const folders = Array.isArray(parsed.folders) ? parsed.folders.filter((folder: unknown): folder is Folder =>
    isRecord(folder) && typeof folder.id === 'string' && typeof folder.name === 'string'
    && (folder.parentId === null || typeof folder.parentId === 'string')) : []
  lockedIds = new Set(isRecord(parsed.locks) ? Object.keys(parsed.locks) : [])
  return { ...parsed, notes: parsed.notes.map(recoverLegacyNote), backups, folders }
}

function writeStore(store: WebStore): void {
  rebuildLinks(store)
  store.version = STORE_VERSION
  assertStoredData(store)
  store.backups.forEach(assertBackup)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

function toSummary(note: StoredNote): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    isDeleted: note.isDeleted,
    deletedAt: note.deletedAt,
    tags: note.tags,
    folderId: note.folderId ?? null,
    locked: isLocked(note.id),
  }
}

const EMPTY_DOC = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })

function blank(note: StoredNote): void {
  note.contentMd = ''
  note.contentPlain = ''
  note.contentRichJson = EMPTY_DOC
}

function triggerBrowserDownload(content: string | Uint8Array, filename: string, type = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([typeof content === 'string' ? content : new Uint8Array(content)], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function rebuildLinks(store: WebStore): void {
  const active = store.notes.filter((note) => !note.isDeleted)
  const targets = new Map<string, string>()
  for (const note of active) {
    const key = note.title.toLowerCase()
    if (!targets.has(key)) targets.set(key, note.id)
  }
  store.links = []
  for (const note of active) {
    for (const label of parseWikilinks(note.contentPlain)) {
      const target = targets.get(label.toLowerCase())
      if (target) store.links.push({ source: note.id, target, label })
    }
  }
}

/** Mirrors the desktop rule: one snapshot of the previous state per writing session. */
export const VERSION_SESSION_SECONDS = 300

function hasSessionVersion(store: WebStore, noteId: string): boolean {
  const latest = [...store.versions].reverse().find((version) => version.noteId === noteId)
  return !!latest && nowUnix() - latest.createdAt < VERSION_SESSION_SECONDS
}

function addVersion(store: WebStore, note: StoredNote): void {
  const previous = [...store.versions].reverse().find((version) => version.noteId === note.id)
  if (previous && previous.snapshotRichJson === note.contentRichJson
    && previous.snapshotPlain === note.contentPlain
    && (previous.snapshotMd ?? richJsonToMarkdown(previous.snapshotRichJson)) === note.contentMd) {
    return
  }

  const version: StoredVersion = {
    id: crypto.randomUUID(),
    noteId: note.id,
    snapshotRichJson: note.contentRichJson,
    snapshotPlain: note.contentPlain,
    snapshotMd: note.contentMd,
    createdAt: nowUnix(),
  }

  store.versions.push(version)
}

function siblingCount(folders: Folder[], parentId: string | null): number {
  return folders.filter((folder) => folder.parentId === parentId).length
}

function assertUniqueSibling(folders: Folder[], parentId: string | null, name: string, except?: string): void {
  if (folders.some((folder) => folder.id !== except && folder.parentId === parentId && folder.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`Ya existe una carpeta llamada «${name}» en ese lugar`)
  }
}

function createBackup(store: WebStore): StoredBackup {
  return structuredClone({
    version: STORE_VERSION,
    id: `backup-${Date.now()}-${crypto.randomUUID()}`,
    createdAt: nowUnix(),
    notes: store.notes,
    versions: store.versions,
    links: store.links,
    folders: store.folders ?? [],
    reminders: store.reminders ?? [],
  })
}

export class WebDbRepository implements NotesRepository {
  async createNote(draft: NoteDraft, folderId: string | null = null): Promise<Note> {
    const store = readStore()
    const now = nowUnix()
    const markdown = draft.contentMd
    const rich = recoverRichJson(draft.contentRichJson, markdown)
    const plain = deriveContentPlain(rich, markdown)

    const note: StoredNote = {
      id: crypto.randomUUID(),
      title: draft.title.trim(),
      contentRichJson: rich,
      contentMd: markdown,
      contentPlain: plain,
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
      deletedAt: null,
      tags: normalizeTags(draft.tags),
      folderId: folderId && (store.folders ?? []).some((folder) => folder.id === folderId) ? folderId : null,
    }

    store.notes.push(note)
    addVersion(store, note)
    writeStore(store)

    return note
  }

  async createOrOpenDailyNote(): Promise<Note> {
    const store = readStore()
    const title = deriveDailyNoteTitle()

    const existing = store.notes.find((note) => note.title === title && !note.isDeleted)
    if (existing) {
      return existing
    }

    const markdown = `# ${title}\n\n## Prioridades\n- \n\n## Diario\n\n`
    return this.createNote({
      title,
      contentRichJson: normalizeRichJson(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }] })),
      contentMd: markdown,
      contentPlain: markdown,
      tags: ['daily'],
    })
  }

  async updateNote(noteId: string, draft: NoteDraft): Promise<void> {
    const store = readStore()
    const note = store.notes.find((entry) => entry.id === noteId)

    if (!note || note.isDeleted) {
      throw new Error('No se puede guardar una nota inexistente o en papelera')
    }

    const lock = store.locks?.[noteId]
    if (lock) {
      // Protected: re-encrypt with the key kept since unlocking; no history, no plain copy.
      const rich = recoverRichJson(draft.contentRichJson, draft.contentMd)
      store.locks![noteId] = await resealContent(noteId, lock, { contentMd: draft.contentMd, contentRichJson: rich, contentPlain: deriveContentPlain(rich, draft.contentMd) })
      note.title = draft.title.trim()
      note.tags = normalizeTags(draft.tags)
      note.updatedAt = nowUnix()
      writeStore(store)
      return
    }

    const markdown = draft.contentMd
    const rich = recoverRichJson(draft.contentRichJson, markdown)

    if (!hasSessionVersion(store, note.id)) addVersion(store, note)
    note.title = draft.title.trim()
    note.contentRichJson = rich
    note.contentMd = markdown
    note.contentPlain = deriveContentPlain(rich, markdown)
    note.tags = normalizeTags(draft.tags)
    note.updatedAt = nowUnix()

    writeStore(store)
  }

  async moveToTrash(noteId: string): Promise<void> {
    const store = readStore()
    const note = store.notes.find((entry) => entry.id === noteId)
    if (!note) {
      return
    }

    note.isDeleted = true
    note.deletedAt = nowUnix()
    note.updatedAt = nowUnix()
    writeStore(store)
  }

  async restoreNote(noteId: string): Promise<void> {
    const store = readStore()
    const note = store.notes.find((entry) => entry.id === noteId)
    if (!note) {
      return
    }

    note.isDeleted = false
    note.deletedAt = null
    note.updatedAt = nowUnix()
    writeStore(store)
  }

  async deleteNotePermanently(noteId: string): Promise<void> {
    const store = readStore()
    store.notes = store.notes.filter((entry) => entry.id !== noteId)
    store.links = store.links.filter((entry) => entry.source !== noteId && entry.target !== noteId)
    store.versions = store.versions.filter((entry) => entry.noteId !== noteId)
    writeStore(store)
  }

  async getNote(noteId: string): Promise<Note | null> {
    const store = readStore()
    const note = store.notes.find((entry) => entry.id === noteId)
    return note ? { ...note, locked: isLocked(note.id) } : null
  }

  async lockNote(noteId: string, password: string): Promise<void> {
    const store = readStore()
    const note = store.notes.find((entry) => entry.id === noteId && !entry.isDeleted)
    if (!note) throw new Error('Nota no encontrada o en la papelera')
    if (store.locks?.[noteId]) throw new Error('La nota ya está protegida')
    const lock = await lockContent(noteId, password, { contentMd: note.contentMd, contentRichJson: note.contentRichJson, contentPlain: note.contentPlain })
    store.locks = { ...store.locks, [noteId]: lock }
    blank(note)
    store.versions = store.versions.filter((version) => version.noteId !== noteId)
    store.links = store.links.filter((link) => link.source !== noteId)
    writeStore(store)
  }

  async unlockNote(noteId: string, password: string) {
    const lock = readStore().locks?.[noteId]
    if (!lock) throw new Error('La nota no está protegida')
    return openContent(noteId, password, lock)
  }

  async removeNoteLock(noteId: string, password: string) {
    const content = await this.unlockNote(noteId, password)
    const store = readStore()
    const note = store.notes.find((entry) => entry.id === noteId)
    if (!note) throw new Error('Nota no encontrada')
    Object.assign(note, content, { updatedAt: nowUnix() })
    delete store.locks![noteId]
    writeStore(store)
    forgetKey(noteId)
    return content
  }

  async relockNote(noteId: string): Promise<void> { forgetKey(noteId) }

  async listNotes(search: string, sortOrder: SortOrder, includeDeleted: boolean): Promise<NoteSummary[]> {
    const store = readStore()

    const summaries = store.notes
      .filter((note) => (includeDeleted ? note.isDeleted : !note.isDeleted))
      .filter((note) => matchesSearch(note, search))
      .map(toSummary)

    return sortNotes(summaries, sortOrder)
  }

  async searchText(query: string, limit: number): Promise<TextMatch[]> {
    const needle = foldChars(query.trim().replace(/\s+/g, ' ')).text
    if (!needle) return []
    return readStore().notes.filter((note) => !note.isDeleted).flatMap((note) => {
      const text = note.contentPlain.replace(/\s+/g, ' ')
      // Matched ignoring case and accents, shown with the original characters.
      const folded = foldChars(text)
      const at = folded.text.indexOf(needle)
      if (at < 0) return []
      const from = folded.index[at]
      const to = folded.index[at + needle.length - 1] + 1
      const start = Math.max(0, from - 50)
      const end = Math.min(text.length, to + 70)
      const snippet = (start > 0 ? '…' : '') + text.slice(start, from) + '\u0002' + text.slice(from, to) + '\u0003' + text.slice(to, end) + (end < text.length ? '…' : '')
      return [{ noteId: note.id, title: note.title, snippet, updatedAt: note.updatedAt }]
    }).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit).map(({ noteId, title, snippet }) => ({ noteId, title, snippet }))
  }

  async listBacklinks(noteId: string): Promise<Backlink[]> {
    const store = readStore()
    const activeIds = new Set(store.notes.filter((note) => !note.isDeleted).map((note) => note.id))

    return store.links
      .filter((entry) => entry.target === noteId && activeIds.has(entry.source) && activeIds.has(entry.target))
      .map((entry) => {
        const source = store.notes.find((note) => note.id === entry.source)
        return {
          fromNoteId: entry.source,
          fromTitle: source?.title ?? 'Untitled',
          linkText: entry.label,
        }
      })
  }

  async listVersions(noteId: string): Promise<NoteVersion[]> {
    const store = readStore()
    return store.versions
      .filter((entry) => entry.noteId === noteId)
      .reverse()
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async restoreVersion(noteId: string, versionId: string): Promise<void> {
    const store = readStore()
    const note = store.notes.find((entry) => entry.id === noteId)
    const version = store.versions.find((entry) => entry.id === versionId && entry.noteId === noteId)

    if (!note || note.isDeleted || !version) {
      throw new Error('No se puede restaurar: nota inexistente, en papelera o version no encontrada')
    }

    addVersion(store, note)
    note.contentMd = version.snapshotMd ?? richJsonToMarkdown(version.snapshotRichJson)
    note.contentRichJson = recoverRichJson(version.snapshotRichJson, note.contentMd)
    note.contentPlain = version.snapshotPlain
    note.updatedAt = nowUnix()

    addVersion(store, note)
    writeStore(store)
  }

  // Browser mode has no OS notifications: reminders are stored, and what fired is flagged on read.
  async listReminders(): Promise<Reminder[]> {
    const store = readStore()
    const now = Date.now()
    let changed = false
    for (const reminder of store.reminders ?? []) {
      const snoozeFired = reminder.snoozedUntil !== null && reminder.snoozedUntil * 1000 <= now
      const regularFired = reminder.nextFireAt !== null && reminder.nextFireAt * 1000 <= now
      if (reminder.status !== 'scheduled' || (!snoozeFired && !regularFired)) continue
      reminder.lastFiredAt = Math.max(regularFired ? reminder.nextFireAt! : 0, snoozeFired ? reminder.snoozedUntil! : 0)
      if (regularFired) { const next = nextAfter(reminder.localTime, reminder.timeZone, reminder.repeat, now); reminder.nextFireAt = next === null ? null : Math.floor(next / 1000) }
      if (snoozeFired) reminder.snoozedUntil = null
      reminder.needsAttention = true
      changed = true
    }
    if (changed) writeStore(store)
    const notes = new Map(store.notes.map((note) => [note.id, note]))
    return (store.reminders ?? []).filter((reminder) => notes.has(reminder.noteId))
      .map((reminder) => ({ ...reminder, noteTitle: notes.get(reminder.noteId)!.title, noteDeleted: notes.get(reminder.noteId)!.isDeleted }))
  }

  async setReminder(noteId: string, localTime: string, timeZone: string, repeat: ReminderRepeat): Promise<ReminderChange> {
    const store = readStore()
    const note = store.notes.find((entry) => entry.id === noteId && !entry.isDeleted)
    if (!note) throw new Error('La nota no existe o está en la papelera')
    if (!parseWall(localTime)) throw new Error('Fecha u hora no válidas')
    if (!isValidZone(timeZone)) throw new Error('Zona horaria desconocida: ' + timeZone)
    const next = nextAfter(localTime, timeZone, repeat, Date.now())
    if (next === null) throw new Error('La fecha del recordatorio ya ha pasado')
    const reminders = (store.reminders ?? []).filter((entry) => entry.noteId !== noteId)
    const previous = (store.reminders ?? []).find((entry) => entry.noteId === noteId)
    const reminder: Reminder = { id: previous?.id ?? crypto.randomUUID(), noteId, noteTitle: note.title, localTime, timeZone, repeat,
      status: 'scheduled', nextFireAt: Math.floor(next / 1000), snoozedUntil: null, lastFiredAt: previous?.lastFiredAt ?? null, needsAttention: false, noteDeleted: false }
    store.reminders = [...reminders, reminder]
    writeStore(store)
    return { reminder, permission: 'unavailable' }
  }

  async clearReminder(noteId: string): Promise<ReminderChange> {
    const store = readStore()
    store.reminders = (store.reminders ?? []).filter((entry) => entry.noteId !== noteId)
    writeStore(store)
    return { reminder: null, permission: 'unavailable' }
  }

  async snoozeReminder(noteId: string, minutes: number): Promise<ReminderChange> {
    const store = readStore()
    const reminder = (store.reminders ?? []).find((entry) => entry.noteId === noteId)
    if (!reminder) throw new Error('La nota no tiene recordatorio')
    Object.assign(reminder, { snoozedUntil: Math.floor(Date.now() / 1000) + minutes * 60, needsAttention: false, status: 'scheduled' })
    writeStore(store)
    return { reminder, permission: 'unavailable' }
  }

  async completeReminder(noteId: string): Promise<ReminderChange> {
    const store = readStore()
    const reminder = (store.reminders ?? []).find((entry) => entry.noteId === noteId)
    if (reminder) {
      reminder.needsAttention = false
      reminder.snoozedUntil = null
      if (reminder.repeat === 'none' && (reminder.nextFireAt === null || reminder.nextFireAt * 1000 <= Date.now())) reminder.status = 'done'
      writeStore(store)
    }
    return { reminder: reminder ?? null, permission: 'unavailable' }
  }

  async reminderCapabilities(): Promise<ReminderCapabilities> {
    return { platform: 'web', worksWhenClosed: false, permission: 'unavailable' }
  }

  async takePendingOpenNote(): Promise<string | null> {
    return null
  }

  onReminderEvents(): () => void {
    return () => {}
  }

  async listFolders(): Promise<Folder[]> {
    return readStore().folders ?? []
  }

  async createFolder(name: string, parentId: string | null): Promise<string> {
    const store = readStore()
    const folders = store.folders ?? []
    const clean = cleanFolderName(name)
    if (parentId && !folders.some((folder) => folder.id === parentId)) throw new Error('La carpeta superior no existe')
    if (folderDepth(folders, parentId) >= MAX_FOLDER_DEPTH) throw new Error('Se ha alcanzado la profundidad máxima de carpetas')
    assertUniqueSibling(folders, parentId, clean)
    const id = crypto.randomUUID()
    store.folders = [...folders, { id, name: clean, parentId, position: siblingCount(folders, parentId) }]
    writeStore(store)
    return id
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    const store = readStore()
    const folder = (store.folders ?? []).find((entry) => entry.id === folderId)
    if (!folder) throw new Error('La carpeta no existe')
    const clean = cleanFolderName(name)
    assertUniqueSibling(store.folders ?? [], folder.parentId, clean, folderId)
    folder.name = clean
    writeStore(store)
  }

  async moveFolder(folderId: string, parentId: string | null): Promise<void> {
    const store = readStore()
    const folders = store.folders ?? []
    const folder = folders.find((entry) => entry.id === folderId)
    if (!folder) throw new Error('La carpeta no existe')
    if (!canMoveFolder(folders, folderId, parentId)) throw new Error('No se puede mover una carpeta dentro de sí misma')
    if (parentId && !folders.some((entry) => entry.id === parentId)) throw new Error('La carpeta de destino no existe')
    assertUniqueSibling(folders, parentId, folder.name, folderId)
    folder.parentId = parentId
    folder.position = siblingCount(folders, parentId)
    writeStore(store)
  }

  async deleteFolder(folderId: string): Promise<void> {
    const store = readStore()
    const folders = store.folders ?? []
    const folder = folders.find((entry) => entry.id === folderId)
    if (!folder) throw new Error('La carpeta no existe')
    for (const note of store.notes) if (note.folderId === folderId) note.folderId = folder.parentId
    for (const child of folders) {
      if (child.parentId !== folderId) continue
      child.parentId = folder.parentId
      let name = child.name
      for (let suffix = 2; folders.some((entry) => entry !== child && entry.id !== folderId && entry.parentId === folder.parentId
        && entry.name.toLowerCase() === name.toLowerCase()); suffix += 1) name = `${child.name} (${suffix})`
      child.name = name
    }
    store.folders = folders.filter((entry) => entry.id !== folderId)
    writeStore(store)
  }

  async moveNoteToFolder(noteId: string, folderId: string | null): Promise<void> {
    const store = readStore()
    const note = store.notes.find((entry) => entry.id === noteId)
    if (!note) throw new Error('La nota no existe')
    if (folderId && !(store.folders ?? []).some((folder) => folder.id === folderId)) throw new Error('La carpeta de destino no existe')
    note.folderId = folderId
    writeStore(store)
  }

  async exportNoteDocx(noteId: string, document: Uint8Array): Promise<string> {
    const note = readStore().notes.find((entry) => entry.id === noteId)
    if (!note) throw new Error('Nota no encontrada')
    const name = `${note.title.trim() || 'nota'}.docx`
    triggerBrowserDownload(document, name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    return `Exportada como ${name}`
  }

  saveAttachment(bytes: Uint8Array): Promise<string> { return saveWebAttachment(bytes) }
  pickImages(): Promise<string[]> { return pickWebImages() }
  readAttachment(name: string): Promise<Uint8Array> { return readWebAttachment(name) }
  attachmentUrl(name: string): Promise<string> { return webAttachmentUrl(name) }

  async selfCheck(): Promise<string> {
    readStore()
    return 'La biblioteca está en buen estado.'
  }

  async exportNote(noteId: string): Promise<string> {
    const store = readStore()
    const note = store.notes.find((entry) => entry.id === noteId)
    if (!note) {
      throw new Error('Nota no encontrada')
    }

    const content = markdownExportContent(note)
    const fallbackName = `${note.title.trim() || 'note'}.md`
    triggerBrowserDownload(content, fallbackName)
    return `Exportada en navegador como ${fallbackName}`
  }

  async backupNow(): Promise<string> {
    const store = readStore()
    const backup = createBackup(store)
    store.backups.push(backup)
    writeStore(store)
    return 'Copia de seguridad creada'
  }

  async listBackups(): Promise<string[]> {
    const store = readStore()
    return store.backups.map((backup) => backup.id).reverse()
  }

  async restoreBackup(backupFile?: string): Promise<string> {
    const store = readStore()
    const target = backupFile
      ? store.backups.find((backup) => backup.id === backupFile)
      : store.backups[store.backups.length - 1]

    if (!target) {
      throw new Error('No hay backups disponibles')
    }

    assertBackup(target)
    store.backups.push(createBackup(store))
    store.notes = structuredClone(target.notes).map(recoverLegacyNote)
    store.versions = structuredClone(target.versions)
    store.links = structuredClone(target.links)
    store.folders = structuredClone(target.folders ?? [])
    store.reminders = structuredClone(target.reminders ?? [])
    writeStore(store)

    return 'Biblioteca restaurada desde la copia'
  }

  async exportVault(): Promise<string> {
    throw new Error('Export vault no esta disponible en navegador; requiere el runtime Tauri')
  }

  async importVault(): Promise<string> {
    throw new Error('Import vault no esta disponible en navegador; requiere el runtime Tauri')
  }
}
