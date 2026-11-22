import type { DocxImage } from '../utils/docx'
import type { Backlink, Folder, LockedContent, TextMatch, Reminder, ReminderCapabilities, ReminderChange, ReminderRepeat, Note, NoteDraft, NoteSummary, NoteVersion, SortOrder } from '../types'
import { isTauriRuntime } from './runtime'
import { TauriDbRepository } from './tauriDb'
import { WebDbRepository } from './webDb'

const repository = isTauriRuntime() ? new TauriDbRepository() : new WebDbRepository()

export async function listNotes(
  search: string,
  sortOrder: SortOrder,
  includeDeleted = false,
): Promise<NoteSummary[]> {
  return repository.listNotes(search, sortOrder, includeDeleted)
}

export async function getNote(noteId: string): Promise<Note | null> {
  return repository.getNote(noteId)
}

export async function createNote(draft: NoteDraft, folderId: string | null = null): Promise<Note> {
  return repository.createNote(draft, folderId)
}

export const listFolders = (): Promise<Folder[]> => repository.listFolders()
export const createFolder = (name: string, parentId: string | null): Promise<string> => repository.createFolder(name, parentId)
export const renameFolder = (folderId: string, name: string): Promise<void> => repository.renameFolder(folderId, name)
export const moveFolder = (folderId: string, parentId: string | null): Promise<void> => repository.moveFolder(folderId, parentId)
export const deleteFolder = (folderId: string): Promise<void> => repository.deleteFolder(folderId)
export const moveNoteToFolder = (noteId: string, folderId: string | null): Promise<void> => repository.moveNoteToFolder(noteId, folderId)

export async function createOrOpenDailyNote(): Promise<Note> {
  return repository.createOrOpenDailyNote()
}

export async function updateNote(noteId: string, draft: NoteDraft): Promise<void> {
  return repository.updateNote(noteId, draft)
}

export async function moveToTrash(noteId: string): Promise<void> {
  return repository.moveToTrash(noteId)
}

export async function restoreNote(noteId: string): Promise<void> {
  return repository.restoreNote(noteId)
}

export async function deleteNotePermanently(noteId: string): Promise<void> {
  return repository.deleteNotePermanently(noteId)
}

export async function listBacklinks(noteId: string): Promise<Backlink[]> {
  return repository.listBacklinks(noteId)
}

export async function listVersions(noteId: string): Promise<NoteVersion[]> {
  return repository.listVersions(noteId)
}

export async function restoreVersion(noteId: string, versionId: string): Promise<void> {
  return repository.restoreVersion(noteId, versionId)
}

export async function exportNote(noteId: string): Promise<string> {
  return repository.exportNote(noteId)
}

/** Builds the Word document from the saved note (callers flush pending edits first). */
export async function exportNoteDocx(noteId: string): Promise<string> {
  const note = await repository.getNote(noteId)
  if (!note) throw new Error('Nota no encontrada')
  const [{ noteToDocx }, { referencedAttachments, imageSize, sniffImage }] = await Promise.all([import('../utils/docx'), import('../utils/attachments')])
  const images = new Map<string, DocxImage>()
  for (const name of referencedAttachments(note.contentMd)) {
    try {
      const bytes = await repository.readAttachment(name)
      const size = imageSize(bytes)
      const extension = sniffImage(bytes)
      if (size && extension) images.set(name, { bytes, extension, ...size })
    } catch { /* A missing image is exported as its description. */ }
  }
  return repository.exportNoteDocx(noteId, noteToDocx(note.title, note.contentRichJson, note.contentMd, images))
}

export const saveAttachment = (bytes: Uint8Array): Promise<string> => repository.saveAttachment(bytes)
export const pickImages = (): Promise<string[]> => repository.pickImages()
export const attachmentUrl = (name: string): Promise<string> => repository.attachmentUrl(name)

export async function runDbSelfCheck(): Promise<string> {
  return repository.selfCheck()
}

export async function backupNow(): Promise<string> {
  return repository.backupNow()
}

export async function listBackups(): Promise<string[]> {
  return repository.listBackups()
}

export async function restoreBackup(backupFile?: string): Promise<string> {
  return repository.restoreBackup(backupFile)
}

export async function exportVault(): Promise<string> {
  return repository.exportVault()
}

export async function importVault(): Promise<string> {
  return repository.importVault()
}

export const listReminders = (): Promise<Reminder[]> => repository.listReminders()
export const setReminder = (noteId: string, localTime: string, timeZone: string, repeat: ReminderRepeat): Promise<ReminderChange> =>
  repository.setReminder(noteId, localTime, timeZone, repeat)
export const clearReminder = (noteId: string): Promise<ReminderChange> => repository.clearReminder(noteId)
export const snoozeReminder = (noteId: string, minutes: number): Promise<ReminderChange> => repository.snoozeReminder(noteId, minutes)
export const completeReminder = (noteId: string): Promise<ReminderChange> => repository.completeReminder(noteId)
export const reminderCapabilities = (): Promise<ReminderCapabilities> => repository.reminderCapabilities()
export const takePendingOpenNote = (): Promise<string | null> => repository.takePendingOpenNote()
export const onReminderEvents = (changed: () => void, open: (noteId: string) => void): (() => void) => repository.onReminderEvents(changed, open)

export const lockNote = (noteId: string, password: string): Promise<void> => repository.lockNote(noteId, password)
export const unlockNote = (noteId: string, password: string): Promise<LockedContent> => repository.unlockNote(noteId, password)
export const removeNoteLock = (noteId: string, password: string): Promise<LockedContent> => repository.removeNoteLock(noteId, password)
export const relockNote = (noteId: string): Promise<void> => repository.relockNote(noteId)

export const searchText = (query: string, limit = 12): Promise<TextMatch[]> => repository.searchText(query, limit)
