import type { Backlink, Folder, LockedContent, Note, TextMatch, NoteDraft, NoteSummary, NoteVersion, Reminder, ReminderCapabilities, ReminderChange, ReminderRepeat, SortOrder } from '../types'

export interface NotesRepository {
  createNote(draft: NoteDraft, folderId?: string | null): Promise<Note>
  createOrOpenDailyNote(): Promise<Note>
  updateNote(noteId: string, draft: NoteDraft): Promise<void>
  moveToTrash(noteId: string): Promise<void>
  restoreNote(noteId: string): Promise<void>
  deleteNotePermanently(noteId: string): Promise<void>
  getNote(noteId: string): Promise<Note | null>
  listNotes(search: string, sortOrder: SortOrder, includeDeleted: boolean): Promise<NoteSummary[]>
  /** Notes whose text (not only the title) contains the words, best first, with a passage. */
  searchText(query: string, limit: number): Promise<TextMatch[]>
  listBacklinks(noteId: string): Promise<Backlink[]>
  listVersions(noteId: string): Promise<NoteVersion[]>
  restoreVersion(noteId: string, versionId: string): Promise<void>
  selfCheck(): Promise<string>
  exportNote(noteId: string): Promise<string>
  listFolders(): Promise<Folder[]>
  listReminders(): Promise<Reminder[]>
  setReminder(noteId: string, localTime: string, timeZone: string, repeat: ReminderRepeat): Promise<ReminderChange>
  clearReminder(noteId: string): Promise<ReminderChange>
  snoozeReminder(noteId: string, minutes: number): Promise<ReminderChange>
  completeReminder(noteId: string): Promise<ReminderChange>
  reminderCapabilities(): Promise<ReminderCapabilities>
  /** A note a notification click asked to open (consumed once). */
  takePendingOpenNote(): Promise<string | null>
  /** Subscribes to reminder changes and notification clicks; returns an unsubscribe function. */
  onReminderEvents(changed: () => void, open: (noteId: string) => void): () => void
  createFolder(name: string, parentId: string | null): Promise<string>
  renameFolder(folderId: string, name: string): Promise<void>
  moveFolder(folderId: string, parentId: string | null): Promise<void>
  deleteFolder(folderId: string): Promise<void>
  moveNoteToFolder(noteId: string, folderId: string | null): Promise<void>
  exportNoteDocx(noteId: string, document: Uint8Array): Promise<string>
  /** Stores an image (validated, content-addressed) and returns its attachment name. */
  saveAttachment(bytes: Uint8Array): Promise<string>
  /** Lets the person choose images; returns the stored names (empty when cancelled). */
  pickImages(): Promise<string[]>
  readAttachment(name: string): Promise<Uint8Array>
  /** Encrypts the note's content with the password; its version history is deleted. */
  lockNote(noteId: string, password: string): Promise<void>
  /** Decrypts a protected note; it stays writable until `relockNote`. Rejects a wrong password. */
  unlockNote(noteId: string, password: string): Promise<LockedContent>
  /** Removes the protection, putting the content back in clear. */
  removeNoteLock(noteId: string, password: string): Promise<LockedContent>
  /** Forgets the key of a protected note that was left. */
  relockNote(noteId: string): Promise<void>
  /** A URL the webview can load the image from. */
  attachmentUrl(name: string): Promise<string>
  backupNow(): Promise<string>
  listBackups(): Promise<string[]>
  restoreBackup(backupFile?: string): Promise<string>
  exportVault(): Promise<string>
  importVault(): Promise<string>
}
