import { useCallback, useEffect, useRef, useState } from 'react'
import type { Folder, LockedContent, Note, NoteDraft, NoteSummary, SortOrder } from '../types'
import * as service from '../services/notesService'
import { DraftWriter } from '../services/draftWriter'
import { buildDraftFromNote } from '../utils/notes'
import { isTauriRuntime } from '../services/runtime'
import { markdownToRichJson, deriveContentPlain } from '../utils/content'

const RECOVERY_KEY = 'mazminotas-pending-drafts-v1'
type SaveState = 'saved' | 'pending' | 'saving' | 'error'

function readRecovery(): Record<string, NoteDraft> {
  const raw = localStorage.getItem(RECOVERY_KEY)
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, NoteDraft>
}

export function useNotebook() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [trash, setTrash] = useState<NoteSummary[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [note, setNote] = useState<Note | null>(null)
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const [recovery, setRecovery] = useState<NoteDraft | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [epoch, setEpoch] = useState(0)
  /** The protected note whose content is open right now (its key lives in the backend). */
  const [unlockedId, setUnlockedId] = useState<string | null>(null)
  const unlockedRef = useRef<string | null>(null)
  const noteRef = useRef<Note | null>(null)
  const draftRef = useRef<NoteDraft | null>(null)
  const operation = useRef(false)
  const alive = useRef(true)
  const request = useRef(0)
  // The editor coalesces keystrokes; this flushes them into the draft before any save or navigation.
  const pendingEditor = useRef<(() => void) | null>(null)
  // Edits that arrive during an operation wait for it instead of being dropped (see `change`).
  const deferred = useRef<{ patch: Partial<NoteDraft>; noteId: string; loads: number } | null>(null)
  const loads = useRef(0)
  const changeRef = useRef<(patch: Partial<NoteDraft>, noteId?: string) => void>(() => {})
  const commitEditor = useCallback(() => { pendingEditor.current?.() }, [])
  const registerPending = useCallback((commit: () => void) => {
    pendingEditor.current = commit
    return () => { if (pendingEditor.current === commit) pendingEditor.current = null }
  }, [])
  const [writer] = useState(() => new DraftWriter<{ id: string; draft: NoteDraft }>(async (value) => {
    await service.updateNote(value.id, value.draft)
    // Recovery is removed only after SQLite/localStorage acknowledged the write.
    const pending = readRecovery()
    if (JSON.stringify(pending[value.id]) === JSON.stringify(value.draft)) {
      delete pending[value.id]
      localStorage.setItem(RECOVERY_KEY, JSON.stringify(pending))
    }
  }))

  const reportError = useCallback((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason)
    if (alive.current) setError(message)
  }, [])

  const refresh = useCallback(async () => {
    const [active, deleted, tree] = await Promise.all([
      service.listNotes('', 'recent', false), service.listNotes('', 'recent', true), service.listFolders(),
    ])
    if (alive.current) { setNotes(active); setTrash(deleted.filter((item) => item.isDeleted)); setFolders(tree) }
  }, [])

  const flush = useCallback(async () => {
    commitEditor()
    if (!writer.dirty) return
    setSaveState('saving')
    try {
      await writer.flush()
      if (!alive.current) return
      setSaveState(writer.dirty ? 'pending' : 'saved')
      setError('')
      setRevision((value) => value + 1)
      // The list refresh never delays navigation or the next action.
      void refresh().catch(reportError)
    } catch (reason) {
      if (alive.current) { setSaveState('error'); reportError(reason) }
      throw reason
    }
  }, [commitEditor, refresh, reportError, writer])

  const show = useCallback((next: Note | null, token: number) => {
    if (!alive.current || token !== request.current) return
    // Leaving an open protected note locks it again (its edits were flushed before this).
    const open = unlockedRef.current
    if (open && (open !== next?.id || !next?.locked)) {
      unlockedRef.current = null
      setUnlockedId(null)
      void service.relockNote(open).catch(() => {})
    }
    if (next?.locked && next.id === open) {
      // Reloading the open protected note (e.g. after a save): keep its decrypted draft.
      noteRef.current = { ...next, contentMd: noteRef.current?.contentMd ?? '', contentRichJson: noteRef.current?.contentRichJson ?? next.contentRichJson, contentPlain: noteRef.current?.contentPlain ?? '' }
      setNote(noteRef.current)
      return
    }
    loads.current += 1
    noteRef.current = next
    const nextDraft = next ? buildDraftFromNote(next) : null
    draftRef.current = nextDraft
    setNote(next)
    setDraft(nextDraft)
    // Protected notes never leave a plain copy in recovery storage.
    setRecovery(next && !next.locked ? readRecovery()[next.id] ?? null : null)
    setSaveState('saved')
    setEpoch((value) => value + 1)
  }, [])

  /** Opens the current protected note with its password. Rejects a wrong one. */
  const unlock = useCallback(async (password: string) => {
    const current = noteRef.current
    if (!current?.locked) return
    const content: LockedContent = await service.unlockNote(current.id, password)
    if (noteRef.current?.id !== current.id) { void service.relockNote(current.id); return }
    const opened: Note = { ...current, ...content }
    noteRef.current = opened
    draftRef.current = buildDraftFromNote(opened)
    unlockedRef.current = opened.id
    setUnlockedId(opened.id)
    setNote(opened)
    setDraft(draftRef.current)
    setSaveState('saved')
    setEpoch((value) => value + 1)
  }, [])

  const load = useCallback(async (id: string | null) => {
    const token = ++request.current
    show(id ? await service.getNote(id) : null, token)
  }, [show])

  /** `quiet` operations (open, create) skip the busy state so the interface never flickers. */
  const run = useCallback(async (action: () => Promise<void>, quiet = false) => {
    if (operation.current) return
    commitEditor()
    operation.current = true
    if (!quiet) setBusy(true)
    setError('')
    try { await flush(); await action() } catch (reason) { reportError(reason) }
    finally {
      operation.current = false
      if (alive.current && !quiet) setBusy(false)
      const late = deferred.current
      deferred.current = null
      if (late && late.loads === loads.current && late.noteId === noteRef.current?.id) changeRef.current(late.patch, late.noteId)
    }
  }, [commitEditor, flush, reportError])

  /**
   * Opening a note reads it while the previous note's edits are flushed, and the latest click
   * wins, so rapid navigation never queues behind a save or an earlier click.
   */
  const open = useCallback(async (id: string | null) => {
    if (operation.current || (id !== null && id === noteRef.current?.id)) return
    commitEditor()
    const token = ++request.current
    setError('')
    try {
      const [next] = await Promise.all([id ? service.getNote(id) : Promise.resolve(null), flush()])
      show(next, token)
    } catch (reason) { reportError(reason) }
  }, [commitEditor, flush, reportError, show])

  useEffect(() => {
    alive.current = true
    const token = ++request.current
    void Promise.all([service.listNotes('', 'recent', false), service.listNotes('', 'recent', true), service.listFolders()])
      .then(async ([active, deleted, tree]) => {
        if (!alive.current || token !== request.current) return
        setNotes(active); setTrash(deleted.filter((item) => item.isDeleted)); setFolders(tree)
        await load(active[0]?.id ?? null)
      }).catch(reportError).finally(() => { if (alive.current) setBusy(false) })
    return () => { alive.current = false; request.current += 1 }
  }, [load, reportError])

  const change = useCallback((patch: Partial<NoteDraft>, noteId?: string) => {
    const current = noteRef.current
    if (!current || current.isDeleted || !draftRef.current) return
    // A late editor commit must never land in a different note.
    if (noteId !== undefined && noteId !== current.id) return
    if (operation.current) {
      // Keep typing usable during short operations: apply the edit once the operation ends,
      // unless that operation replaced the note (restore, trash, open another note).
      const previous = deferred.current?.noteId === current.id ? deferred.current.patch : {}
      deferred.current = { patch: { ...previous, ...patch }, noteId: current.id, loads: loads.current }
      return
    }
    const next = { ...draftRef.current, ...patch }
    draftRef.current = next
    setDraft(next)
    writer.set({ id: current.id, draft: next })
    if (!current.locked) try {
      const pending = readRecovery()
      pending[current.id] = next
      localStorage.setItem(RECOVERY_KEY, JSON.stringify(pending))
    } catch (reason) { reportError(reason) }
    setSaveState('pending')
    setRevision((value) => value + 1)
  }, [reportError, writer])

  useEffect(() => { changeRef.current = change }, [change])

  /** Marks unsaved typing without rendering the whole draft. */
  const touch = useCallback(() => { setSaveState('pending') }, [])

  useEffect(() => {
    if (saveState !== 'pending') return
    const timer = window.setTimeout(() => { void flush().catch(() => {}) }, 650)
    return () => window.clearTimeout(timer)
  }, [flush, revision, saveState])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      commitEditor()
      if (!writer.dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    const onHidden = () => { if (document.hidden) void flush().catch(() => {}) }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('visibilitychange', onHidden)
    let dispose: (() => void) | undefined
    if (isTauriRuntime()) {
      void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow()
        const unlisten = await win.onCloseRequested(async (event) => {
          commitEditor()
          if (!writer.dirty) return
          event.preventDefault()
          try { await flush(); await win.close() } catch (reason) { reportError(reason) }
        })
        if (alive.current) dispose = unlisten
        else unlisten()
      }).catch(reportError)
    }
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('visibilitychange', onHidden)
      dispose?.()
    }
  }, [commitEditor, flush, reportError, writer])

  const create = useCallback((markdown = '', title = 'Sin título', tags: string[] = [], folderId: string | null = null) => run(async () => {
    const rich = markdownToRichJson(markdown)
    const created = await service.createNote({ title, contentMd: markdown, contentRichJson: rich,
      contentPlain: deriveContentPlain(rich, markdown), tags }, folderId)
    await Promise.all([refresh(), load(created.id)])
  }, true), [load, refresh, run])

  const mutate = useCallback((action: () => Promise<unknown>, nextId?: string | null) => run(async () => {
    await action()
    await refresh()
    await load(nextId === undefined ? noteRef.current?.id ?? null : nextId)
    setRevision((value) => value + 1)
  }), [load, refresh, run])

  /** Folder and move operations: quiet (no busy state) and followed by a library refresh. */
  const organize = useCallback((action: () => Promise<unknown>) => run(async () => {
    await action()
    await refresh()
    if (noteRef.current) {
      const fresh = await service.getNote(noteRef.current.id)
      if (fresh && alive.current && noteRef.current?.id === fresh.id) {
        noteRef.current = { ...noteRef.current, folderId: fresh.folderId }
        setNote(noteRef.current)
      }
    }
  }, true), [refresh, run])

  const recover = useCallback(() => {
    if (!recovery) return
    change(recovery)
    setRecovery(null)
    setEpoch((value) => value + 1)
  }, [change, recovery])

  const dismissRecovery = useCallback(() => {
    if (!noteRef.current) return
    try {
      const pending = readRecovery()
      delete pending[noteRef.current.id]
      localStorage.setItem(RECOVERY_KEY, JSON.stringify(pending))
      setRecovery(null)
    } catch (reason) { reportError(reason) }
  }, [reportError])

  const searchNotes = useCallback((query: string, order: SortOrder, deleted: boolean) =>
    service.listNotes(query, order, deleted), [])

  return { unlockedId, unlock, folders, organize, notes, trash, note, draft, busy, error, saveState, revision, epoch, recovery,
    open, change, touch, registerPending, flush, run, refresh, create, mutate, load, reportError, recover, dismissRecovery, searchNotes }
}
