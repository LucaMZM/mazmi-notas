import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { NoteDraft } from '../../src/types'

const rpc = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: unknown }>, failSave: false }))
const sqlite = new DatabaseSync(':memory:')
sqlite.exec(`
  CREATE TABLE notes (id TEXT,title TEXT,content_rich_json TEXT,content_md TEXT,content_plain TEXT,
    created_at INTEGER,updated_at INTEGER,is_deleted INTEGER,deleted_at INTEGER,folder_id TEXT);
  CREATE TABLE note_locks (note_id TEXT PRIMARY KEY,kdf TEXT,salt BLOB,nonce BLOB,ciphertext BLOB,attachments TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE tags (id TEXT,name TEXT);
  CREATE TABLE note_tags (note_id TEXT,tag_id TEXT);
  CREATE TABLE note_versions (id TEXT,note_id TEXT,snapshot_rich_json TEXT,snapshot_plain TEXT,snapshot_md TEXT,created_at INTEGER);
  CREATE VIRTUAL TABLE notes_fts USING fts5(note_id UNINDEXED,title,content_plain,tags_text);
  INSERT INTO notes VALUES ('server-created-id','Saved','','# Kept','Kept',10,20,0,NULL,NULL);
  INSERT INTO tags VALUES ('tag','qa');
  INSERT INTO note_tags VALUES ('server-created-id','tag');
  INSERT INTO notes_fts VALUES ('server-created-id','Saved','Kept','qa');
  INSERT INTO note_versions VALUES ('legacy','server-created-id','{}','plain',NULL,1);
  INSERT INTO note_versions VALUES ('new','server-created-id','{}','plain','3. exact',2);
`)
vi.stubGlobal('window', { __TAURI_INTERNALS__: {
  invoke: async (command: string, args?: Record<string, unknown>) => {
    rpc.calls.push({ command, args })
    if (command === 'plugin:sql|load') return 'sqlite:notes.db'
    if (command === 'plugin:sql|execute') throw new Error('SQL writes are not permitted')
    if (command === 'save_note') {
      if (rpc.failSave) throw new Error('transaction rolled back')
      return 'server-created-id'
    }
    if (command === 'plugin:sql|select') {
      const query = args?.query as string
      const values = args?.values as Array<string | number> ?? []
      const bindings = Object.fromEntries(values.map((value, index) => [String(index + 1), value]))
      return sqlite.prepare(query).all(bindings)
    }
    if (['move_to_trash', 'restore_note', 'delete_note_permanently', 'restore_version'].includes(command)) return null
    throw new Error(`Unexpected IPC command: ${command}`)
  },
} })

import { TauriDbRepository } from '../../src/services/tauriDb'

const draft: NoteDraft = {
  title: 'Saved', contentRichJson: '{"type":"doc","content":[]}', contentMd: '**exact Markdown**',
  contentPlain: 'exact Markdown', tags: ['QA'],
}

beforeEach(() => { rpc.calls = []; rpc.failSave = false })

describe('Tauri repository native write boundary', () => {
  it('creates through one native transaction and returns the server identity', async () => {
    const note = await new TauriDbRepository().createNote(draft)
    expect(note.id).toBe('server-created-id')
    expect(rpc.calls.filter((call) => call.command === 'save_note')).toEqual([
      { command: 'save_note', args: { noteId: null, draft: { ...draft, folderId: null } } },
    ])
    expect(rpc.calls.some((call) => call.command === 'plugin:sql|execute')).toBe(false)
  })

  it('updates atomically without losing the exact Markdown or hiding errors', async () => {
    const repository = new TauriDbRepository()
    await repository.updateNote('existing', draft)
    expect(rpc.calls).toEqual([{ command: 'save_note', args: { noteId: 'existing', draft } }])
    rpc.failSave = true
    await expect(repository.updateNote('existing', draft)).rejects.toThrow('transaction rolled back')
  })

  it('moves all trash and version writes to native commands', async () => {
    const repository = new TauriDbRepository()
    await repository.moveToTrash('n')
    await repository.restoreNote('n')
    await repository.deleteNotePermanently('n')
    await repository.restoreVersion('n', 'v')
    expect(rpc.calls).toEqual([
      { command: 'move_to_trash', args: { noteId: 'n' } },
      { command: 'restore_note', args: { noteId: 'n' } },
      { command: 'delete_note_permanently', args: { noteId: 'n' } },
      { command: 'restore_version', args: { noteId: 'n', versionId: 'v' } },
    ])
  })

  it('hydrates legacy Markdown rather than returning an empty rich editor', async () => {
    const note = await new TauriDbRepository().getNote('server-created-id')
    expect(note?.contentRichJson).toContain('Kept')
  })

  it('lists summaries with server filtering without transferring rich documents', async () => {
    const notes = await new TauriDbRepository().listNotes('Kept', 'recent', false)
    expect(notes[0]?.id).toBe('server-created-id')
    const reads = rpc.calls.filter((call) => call.command === 'plugin:sql|select')
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) {
      const args = read.args as { query: string; values: unknown[] }
      expect(args.query).not.toContain('content_rich_json')
      expect(args.query).not.toContain('content_md')
    }
    expect(JSON.stringify(reads)).toContain('Kept'.toLowerCase())
  })

  it('exposes optional legacy Markdown without violating the shared version type', async () => {
    const versions = await new TauriDbRepository().listVersions('server-created-id')
    expect(versions.find((version) => version.id === 'legacy')?.snapshotMd).toBeUndefined()
    expect(versions.find((version) => version.id === 'new')?.snapshotMd).toBe('3. exact')
  })
})
