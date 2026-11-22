import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import Database from '@tauri-apps/plugin-sql'
import type { Backlink, Folder, LockedContent, TextMatch, Reminder, ReminderCapabilities, ReminderChange, ReminderRepeat, Note, NoteDraft, NoteSummary, NoteVersion, SortOrder } from '../types'
import { deriveDailyNoteTitle, sortNotes, splitTagBlob } from '../utils/notes'
import { markdownToRichJson, normalizeRichJson } from '../utils/content'
import type { NotesRepository } from './notesRepository'
import { checkImage, isAttachmentName } from '../utils/attachments'

const DB_URL = 'sqlite:notes.db'
const TAG_SEPARATOR = '\u001f'

interface NoteRow {
  id: string
  title: string
  content_rich_json: string
  content_md: string
  content_plain: string
  created_at: number
  updated_at: number
  is_deleted: number
  deleted_at: number | null
  tags: string
  folder_id: string | null
  locked?: number
}

let databasePromise: Promise<Database> | null = null

async function getDb(): Promise<Database> {
  if (!databasePromise) {
    // Startup preloads this database after its safety snapshot and migrations.
    databasePromise = Promise.resolve(Database.get(DB_URL))
  }
  return databasePromise
}

function sanitizeFtsQuery(search: string): string {
  const tokens = search
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean)

  if (tokens.length === 0) {
    return ''
  }

  return tokens.map((token) => `"${token}"*`).join(' ')
}

function rowToNote(row: NoteRow): Note {
  let rich = row.content_rich_json
  try {
    const parsed = JSON.parse(rich)
    if (parsed?.type !== 'doc' || !Array.isArray(parsed.content)) rich = ''
  } catch {
    rich = ''
  }
  return {
    id: row.id,
    title: row.title,
    contentRichJson: rich ? normalizeRichJson(rich) : markdownToRichJson(row.content_md || row.content_plain),
    contentMd: row.content_md,
    contentPlain: row.content_plain,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDeleted: row.is_deleted === 1,
    deletedAt: row.deleted_at,
    tags: splitTagBlob(row.tags),
    folderId: row.folder_id ?? null,
    locked: row.locked === 1,
  }
}

export class TauriDbRepository implements NotesRepository {
  async createNote(draft: NoteDraft, folderId: string | null = null): Promise<Note> {
    const id = await invoke<string>('save_note', { noteId: null, draft: { ...draft, folderId } })

    const note = await this.getNote(id)
    if (!note) {
      throw new Error('No se pudo crear la nota')
    }

    return note
  }

  async createOrOpenDailyNote(): Promise<Note> {
    const db = await getDb()
    const title = deriveDailyNoteTitle()

    const rows = await db.select<{ id: string }[]>(
      'SELECT id FROM notes WHERE title = $1 AND is_deleted = 0 ORDER BY updated_at DESC LIMIT 1',
      [title],
    )

    if (rows[0]?.id) {
      const existing = await this.getNote(rows[0].id)
      if (existing) {
        return existing
      }
    }

    const markdown = `# ${title}\n\n## Prioridades\n- \n\n## Diario\n\n`
    return this.createNote({
      title,
      contentRichJson: markdownToRichJson(markdown),
      contentMd: markdown,
      contentPlain: markdown,
      tags: ['daily'],
    })
  }

  async updateNote(noteId: string, draft: NoteDraft): Promise<void> {
    await invoke('save_note', { noteId, draft })
  }

  async moveToTrash(noteId: string): Promise<void> {
    await invoke('move_to_trash', { noteId })
  }

  async restoreNote(noteId: string): Promise<void> {
    await invoke('restore_note', { noteId })
  }

  async deleteNotePermanently(noteId: string): Promise<void> {
    await invoke('delete_note_permanently', { noteId })
  }

  async getNote(noteId: string): Promise<Note | null> {
    const db = await getDb()
    const rows = await db.select<NoteRow[]>(
      `SELECT
        n.id,
        n.title,
        n.content_rich_json,
        n.content_md,
        n.content_plain,
        n.created_at,
        n.updated_at,
        n.is_deleted,
        n.deleted_at,
        n.folder_id,
        EXISTS (SELECT 1 FROM note_locks l WHERE l.note_id = n.id) AS locked,
        COALESCE(GROUP_CONCAT(t.name, '${TAG_SEPARATOR}'), '') AS tags
      FROM notes n
      LEFT JOIN note_tags nt ON nt.note_id = n.id
      LEFT JOIN tags t ON t.id = nt.tag_id
      WHERE n.id = $1
      GROUP BY n.id`,
      [noteId],
    )

    if (rows.length === 0) {
      return null
    }

    return rowToNote(rows[0])
  }

  async listNotes(search: string, sortOrder: SortOrder, includeDeleted: boolean): Promise<NoteSummary[]> {
    const db = await getDb()
    const query = search.trim().toLowerCase()
    const like = '%' + query.replace(/[\\%_]/g, '\\$&') + '%'
    const fts = includeDeleted ? '' : sanitizeFtsQuery(search)
    const select = async (useFts: boolean) => db.select<Array<Pick<NoteRow,
      'id' | 'title' | 'created_at' | 'updated_at' | 'is_deleted' | 'deleted_at' | 'tags' | 'folder_id' | 'locked'
    >>>(
      `SELECT n.id,n.title,n.created_at,n.updated_at,n.is_deleted,n.deleted_at,n.folder_id,
       EXISTS (SELECT 1 FROM note_locks l WHERE l.note_id=n.id) AS locked,
       COALESCE(GROUP_CONCAT(t.name, '${TAG_SEPARATOR}'), '') AS tags
       FROM notes n
       LEFT JOIN note_tags nt ON nt.note_id=n.id
       LEFT JOIN tags t ON t.id=nt.tag_id
       WHERE n.is_deleted=$1 AND ($2='' OR lower(n.title) LIKE $3 ESCAPE '\\'
         OR lower(n.content_plain) LIKE $3 ESCAPE '\\'
         OR EXISTS (SELECT 1 FROM note_tags search_nt JOIN tags search_t ON search_t.id=search_nt.tag_id
           WHERE search_nt.note_id=n.id AND search_t.name LIKE $3 ESCAPE '\\')
         ${useFts ? 'OR n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH $4)' : ''})
       GROUP BY n.id`,
      useFts ? [includeDeleted ? 1 : 0, query, like, fts] : [includeDeleted ? 1 : 0, query, like],
    )
    let rows
    try {
      rows = await select(Boolean(fts))
    } catch (error) {
      if (!fts) throw error
      rows = await select(false)
    }
    return sortNotes(rows.map((row) => ({
      id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
      isDeleted: row.is_deleted === 1, deletedAt: row.deleted_at, tags: splitTagBlob(row.tags), folderId: row.folder_id ?? null,
      locked: row.locked === 1,
    })), sortOrder)
  }

  async searchText(query: string, limit: number): Promise<TextMatch[]> {
    const fts = sanitizeFtsQuery(query)
    if (!fts) return []
    const db = await getDb()
    // Column 2 of notes_fts is the note's plain text; matched words are wrapped in \u0002 … \u0003.
    return db.select<TextMatch[]>(
      `SELECT f.note_id AS noteId, n.title AS title, snippet(notes_fts, 2, char(2), char(3), '…', 14) AS snippet
       FROM notes_fts f JOIN notes n ON n.id = f.note_id
       WHERE notes_fts MATCH $1 AND n.is_deleted = 0
       ORDER BY bm25(notes_fts, 0.0, 4.0, 1.0, 2.0) LIMIT $2`,
      [fts, limit],
    ).catch(() => [])
  }

  async listBacklinks(noteId: string): Promise<Backlink[]> {
    const db = await getDb()
    return db.select<Backlink[]>(
      `SELECT
        l.from_note_id AS fromNoteId,
        n.title AS fromTitle,
        l.link_text AS linkText
      FROM note_links l
      JOIN notes n ON n.id = l.from_note_id
      WHERE l.to_note_id = $1
        AND n.is_deleted = 0
      ORDER BY n.updated_at DESC`,
      [noteId],
    )
  }

  async listVersions(noteId: string): Promise<NoteVersion[]> {
    const db = await getDb()
    const rows = await db.select<Array<Omit<NoteVersion, 'snapshotMd'> & { snapshotMd: string | null }>>(
      `SELECT
        id,
        note_id AS noteId,
        snapshot_rich_json AS snapshotRichJson,
        snapshot_plain AS snapshotPlain,
        snapshot_md AS snapshotMd,
        created_at AS createdAt
      FROM note_versions
      WHERE note_id = $1
      ORDER BY created_at DESC, rowid DESC
      LIMIT 100`,
      [noteId],
    )
    return rows.map((row) => ({ ...row, snapshotMd: row.snapshotMd ?? undefined }))
  }

  async restoreVersion(noteId: string, versionId: string): Promise<void> {
    await invoke('restore_version', { noteId, versionId })
  }

  async selfCheck(): Promise<string> {
    return invoke<string>('self_check')
  }

  async listReminders(): Promise<Reminder[]> {
    return invoke<Reminder[]>('list_reminders')
  }

  async setReminder(noteId: string, localTime: string, timeZone: string, repeat: ReminderRepeat): Promise<ReminderChange> {
    return invoke<ReminderChange>('set_reminder', { noteId, localTime, timeZone, repeat })
  }

  async clearReminder(noteId: string): Promise<ReminderChange> {
    return invoke<ReminderChange>('clear_reminder', { noteId })
  }

  async snoozeReminder(noteId: string, minutes: number): Promise<ReminderChange> {
    return invoke<ReminderChange>('snooze_reminder', { noteId, minutes })
  }

  async completeReminder(noteId: string): Promise<ReminderChange> {
    return invoke<ReminderChange>('complete_reminder', { noteId })
  }

  async reminderCapabilities(): Promise<ReminderCapabilities> {
    return invoke<ReminderCapabilities>('reminder_capabilities')
  }

  async takePendingOpenNote(): Promise<string | null> {
    return invoke<string | null>('take_pending_open_note')
  }

  onReminderEvents(changed: () => void, open: (noteId: string) => void): () => void {
    const unlisteners: Array<Promise<() => void>> = [
      listen('reminders://changed', () => changed()),
      listen<string>('reminders://open', (event) => open(event.payload)),
    ]
    return () => { for (const unlisten of unlisteners) void unlisten.then((stop) => stop()) }
  }

  async listFolders(): Promise<Folder[]> {
    const db = await getDb()
    return db.select<Folder[]>('SELECT id, name, parent_id AS parentId, position FROM folders')
  }

  async createFolder(name: string, parentId: string | null): Promise<string> {
    return invoke<string>('create_folder', { name, parentId })
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    await invoke('rename_folder', { folderId, name })
  }

  async moveFolder(folderId: string, parentId: string | null): Promise<void> {
    await invoke('move_folder', { folderId, parentId })
  }

  async deleteFolder(folderId: string): Promise<void> {
    await invoke('delete_folder', { folderId })
  }

  async moveNoteToFolder(noteId: string, folderId: string | null): Promise<void> {
    await invoke('move_note_to_folder', { noteId, folderId })
  }

  async exportNote(noteId: string): Promise<string> {
    return invoke<string>('export_note_markdown', { noteId })
  }

  async exportNoteDocx(noteId: string, document: Uint8Array): Promise<string> {
    return invoke<string>('export_note_docx', document, { headers: { 'x-note-id': noteId } })
  }

  async saveAttachment(bytes: Uint8Array): Promise<string> {
    checkImage(bytes)
    return invoke<string>('save_attachment', bytes)
  }

  async pickImages(): Promise<string[]> {
    return invoke<string[]>('pick_images')
  }

  async readAttachment(name: string): Promise<Uint8Array> {
    return new Uint8Array(await invoke<ArrayBuffer>('read_attachment', { name }))
  }

  async attachmentUrl(name: string): Promise<string> {
    if (!isAttachmentName(name)) throw new Error('Referencia de imagen no válida')
    // mazmi-attachment://localhost/<name> on macOS/Linux, http://mazmi-attachment.localhost/<name> on Windows.
    return convertFileSrc(name, 'mazmi-attachment')
  }

  lockNote(noteId: string, password: string): Promise<void> {
    return invoke('lock_note', { noteId, password })
  }

  unlockNote(noteId: string, password: string): Promise<LockedContent> {
    return invoke<LockedContent>('unlock_note', { noteId, password })
  }

  removeNoteLock(noteId: string, password: string): Promise<LockedContent> {
    return invoke<LockedContent>('remove_note_lock', { noteId, password })
  }

  async relockNote(noteId: string): Promise<void> {
    await invoke('relock_note', { noteId })
  }

  async backupNow(): Promise<string> {
    return invoke<string>('backup_now')
  }

  async listBackups(): Promise<string[]> {
    return invoke<string[]>('list_backups')
  }

  async restoreBackup(backupFile?: string): Promise<string> {
    return invoke<string>('restore_backup', { backupFile })
  }

  async exportVault(): Promise<string> {
    return invoke<string>('export_vault')
  }

  async importVault(): Promise<string> {
    return invoke<string>('import_vault')
  }

}
