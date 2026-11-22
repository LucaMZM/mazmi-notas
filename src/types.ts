export type SortOrder = 'recent' | 'alphabetical'
export type EditorMode = 'rich' | 'markdown'

export interface NoteSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  isDeleted: boolean
  deletedAt: number | null
  tags: string[]
  /** null = the note is not in any folder. */
  folderId: string | null
  /** Protected with a password: its content is encrypted and only the title is readable. */
  locked?: boolean
}

/** A note whose text contains what was searched, with the passage around it. */
export interface TextMatch {
  noteId: string
  title: string
  /** Passage around the match; the matched words are wrapped in MATCH_START / MATCH_END. */
  snippet: string
}

export const MATCH_START = '\u0002'
export const MATCH_END = '\u0003'

/** The decrypted content of a protected note. */
export interface LockedContent { contentMd: string; contentRichJson: string; contentPlain: string }

export interface Folder {
  id: string
  name: string
  parentId: string | null
  position: number
}

export interface Note extends NoteSummary {
  contentRichJson: string
  contentMd: string
  contentPlain: string
}

export interface NoteDraft {
  title: string
  contentRichJson: string
  contentMd: string
  contentPlain: string
  tags: string[]
}

export interface NoteVersion {
  id: string
  noteId: string
  snapshotRichJson: string
  snapshotPlain: string
  snapshotMd?: string
  createdAt: number
}

export interface Backlink {
  fromNoteId: string
  fromTitle: string
  linkText: string
}

export type ReminderRepeat = 'none' | 'daily' | 'weekly' | 'monthly'

export interface Reminder {
  id: string
  noteId: string
  noteTitle: string
  /** Wall-clock `YYYY-MM-DDTHH:MM` in `timeZone`. */
  localTime: string
  timeZone: string
  repeat: ReminderRepeat
  status: 'scheduled' | 'done'
  nextFireAt: number | null
  snoozedUntil: number | null
  lastFiredAt: number | null
  needsAttention: boolean
  noteDeleted: boolean
}

export interface ReminderCapabilities {
  platform: 'macos' | 'windows' | 'other' | 'web'
  worksWhenClosed: boolean
  permission: 'granted' | 'denied' | 'unknown' | 'unavailable'
}

export interface ReminderChange {
  reminder: Reminder | null
  permission: ReminderCapabilities['permission']
}
