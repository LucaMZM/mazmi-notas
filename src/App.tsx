import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Fuse from 'fuse.js'
import { useNotebook } from './hooks/useNotebook'
import { NoteEditor, MarkdownPreview } from './components/NoteEditor'
import { LockedNote, PasswordDialog, Splash } from './components/LockScreens'
import { Library } from './components/Library'
import { ActionsMenu } from './components/ActionsMenu'
import { UNFILED } from './components/FolderTree'
import { ReminderAttention, ReminderControl } from './components/ReminderControl'
import { buildFolderTree, folderPath, type FolderNode } from './utils/folders'
import { Modal } from './components/Modal'
import { Icon } from './components/Icon'
import { formatUnix, normalizeTags, sortNotes } from './utils/notes'
import { isTauriRuntime } from './services/runtime'
import { keys } from './utils/platform'
import { preferenceStyle, useEditorPreferences } from './editor/preferences'
import * as service from './services/notesService'
import type { Backlink, Folder, NoteSummary, NoteVersion, Reminder, ReminderCapabilities, ReminderRepeat, SortOrder, TextMatch } from './types'
import { MATCH_END, MATCH_START } from './types'

type Panel = 'history' | 'links' | null
type Confirmation = { title: string; body: string; label: string; action: () => Promise<void> }
const SAVE_LABELS = { saved: 'Guardado', active: 'Guardando…', error: 'No se pudo guardar' }
const MESSAGE_TTL = 4200

/** Shows a flag only once it has stayed true for `delay` ms, so quick operations never flash UI. */
function useDelayedFlag(value: boolean, delay: number) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!value) { setShown(false); return }
    const timer = window.setTimeout(() => setShown(true), delay)
    return () => window.clearTimeout(timer)
  }, [delay, value])
  return shown
}

/**
 * Autosave runs about once per second while typing. Instead of flickering between three labels,
 * the status reads «Guardando…» during activity and «Guardado» once it has stayed saved briefly.
 */
function useSettledSaveState(state: 'saved' | 'pending' | 'saving' | 'error') {
  const [display, setDisplay] = useState<'saved' | 'active' | 'error'>('saved')
  useEffect(() => {
    if (state === 'error') { setDisplay('error'); return }
    if (state !== 'saved') { setDisplay('active'); return }
    const timer = window.setTimeout(() => setDisplay('saved'), 600)
    return () => window.clearTimeout(timer)
  }, [state])
  return display
}

/** Backup files carry their creation time (ms or ns since 1970); show it as a readable date. */
function backupLabel(entry: string): string {
  const name = entry.split(/[\\/]/).pop() ?? entry
  const digits = name.match(/-(\d{13,19})(?:-|\.|$)/)?.[1]
  if (!digits) return name.replace(/\.json$/, '')
  const date = new Date(digits.length > 13 ? Number(digits.slice(0, 13)) : Number(digits))
  const when = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  return /recovery|pre-|restore/i.test(name) ? 'Antes de restaurar · ' + when : when
}

/** The «Recordatorios» view of the library. */
export const REMINDERS_VIEW = '__reminders__'

/** Flattened folder tree for pickers (indentation shows depth). */
function flattenTree(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)])
}

interface PaletteItem { id: string; label: string; hint: string; snippet?: string }

/** A search passage with the matched words emphasised. */
function Highlighted({ text }: { text: string }) {
  return <>{text.split(MATCH_START).map((part, index) => {
    if (index === 0) return <span key={index}>{part}</span>
    const [match, rest = ''] = part.split(MATCH_END)
    return <span key={index}><mark>{match}</mark>{rest}</span>
  })}</>
}

function App() {
  const n = useNotebook()
  const { notes, trash, note, draft, busy, saveState, epoch, open, run, reportError, searchNotes, create, load, refresh, folders, organize } = n
  const refreshLibrary = refresh
  const desktop = isTauriRuntime()
  const [search, setSearch] = useState('')
  const [order, setOrder] = useState<SortOrder>('recent')
  const [showTrash, setShowTrash] = useState(false)
  // null: all notes · UNFILED: notes without a folder · otherwise a folder id.
  const [folderFilter, setFolderFilter] = useState<string | null>(null)
  const [folderToDelete, setFolderToDelete] = useState<Folder | null>(null)
  const [movingNote, setMovingNote] = useState(false)
  const [passwordDialog, setPasswordDialog] = useState<'lock' | 'unlock' | null>(null)
  // The welcome screen opens the desktop app (and the browser build with ?splash, for testing).
  const [splash, setSplash] = useState(() => isTauriRuntime() || new URLSearchParams(window.location.search).has('splash'))
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [reminderCaps, setReminderCaps] = useState<ReminderCapabilities | null>(null)
  const reminderByNote = useMemo(() => new Map(reminders.map((entry) => [entry.noteId, entry])), [reminders])
  const reminderMarks = useMemo(() => new Map(reminders.filter((entry) => entry.status === 'scheduled' || entry.needsAttention)
    .map((entry) => [entry.noteId, entry.needsAttention ? 'overdue' as const : 'scheduled' as const])), [reminders])
  const attentionCount = useMemo(() => reminders.filter((entry) => entry.needsAttention && !entry.noteDeleted).length, [reminders])
  const [results, setResults] = useState<NoteSummary[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [mobileLibrary, setMobileLibrary] = useState(false)
  const [libraryCollapsed, setLibraryCollapsed] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [versions, setVersions] = useState<NoteVersion[]>([])
  const [contextLoading, setContextLoading] = useState(false)
  const [version, setVersion] = useState<NoteVersion | null>(null)
  const [settings, setSettings] = useState(false)
  const [backups, setBackups] = useState<string[]>([])
  const [selectedBackup, setSelectedBackup] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [palette, setPalette] = useState(false)
  const [query, setQuery] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [message, setMessage] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const paletteRef = useRef<HTMLInputElement>(null)
  const noteId = note?.id ?? null
  const slowBusy = useDelayedFlag(busy, 350)
  const saveDisplay = useSettledSaveState(saveState)
  const [preferences, updatePreferences] = useEditorPreferences()
  const surfaceStyle = useMemo(() => preferenceStyle(preferences), [preferences])

  // Results refresh when the library changes (after each save), not on every keystroke.
  useEffect(() => {
    let cancelled = false
    if (!search.trim()) { setResults(null); setSearching(false); return }
    setSearching(true)
    const timer = window.setTimeout(() => {
      void searchNotes(search, order, showTrash).then((next) => {
        if (!cancelled) setResults(next)
      }).catch(reportError).finally(() => { if (!cancelled) setSearching(false) })
    }, 90)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [search, order, showTrash, notes, trash, reportError, searchNotes])

  const contextNote = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!panel || !noteId) { setBacklinks([]); setVersions([]); contextNote.current = null; return }
    // Refetches for the same note keep the current list on screen instead of flashing «Cargando…».
    if (contextNote.current !== noteId) { setBacklinks([]); setVersions([]); contextNote.current = noteId }
    setContextLoading(true)
    void Promise.all([service.listBacklinks(noteId), service.listVersions(noteId)])
      .then(([links, history]) => {
        if (!cancelled) { setBacklinks(links); setVersions(history) }
      }).catch(reportError).finally(() => { if (!cancelled) setContextLoading(false) })
    return () => { cancelled = true }
  }, [noteId, panel, notes, epoch, reportError])

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), MESSAGE_TTL)
    return () => window.clearTimeout(timer)
  }, [message])

  const createBlank = useCallback(async () => {
    setShowTrash(false); setSearch(''); setMobileLibrary(false)
    await create('', 'Sin título', [], folderFilter && folderFilter !== UNFILED ? folderFilter : null)
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [create, folderFilter])

  const select = useCallback(async (id: string) => {
    setMobileLibrary(false)
    await open(id)
  }, [open])

  const selectFromList = useCallback((id: string) => { void select(id) }, [select])
  const createFromList = useCallback(() => { void createBlank() }, [createBlank])
  const showNotes = useCallback(() => { setShowTrash(false); setFolderFilter(null); setSearch(''); void open(notes[0]?.id ?? null) }, [notes, open])
  const showDeleted = useCallback(() => { setShowTrash(true); setFolderFilter(null); setSearch(''); void open(trash[0]?.id ?? null) }, [open, trash])
  const notesInFolder = useCallback((folder: string | null) => folder === REMINDERS_VIEW
    ? notes.filter((item) => reminderMarks.has(item.id))
    : notes.filter((item) => folder === UNFILED ? !item.folderId : item.folderId === folder), [notes, reminderMarks])
  const selectFolder = useCallback((folder: string | null) => {
    setShowTrash(false); setSearch(''); setFolderFilter(folder); setMobileLibrary(false)
    const first = sortNotes(folder === null ? notes : notesInFolder(folder), order)[0]
    if (first && first.id !== noteId) void open(first.id)
  }, [noteId, notes, notesInFolder, open, order])
  // Folder operations report validation errors in place; they return whether they succeeded.
  const tryOrganize = useCallback(async (action: () => Promise<unknown>) => {
    try { await action(); await refreshLibrary(); return true } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); return false }
  }, [refreshLibrary])
  const folderTree = useMemo(() => ({
    folders,
    counts: notes.reduce((map, item) => map.set(item.folderId, (map.get(item.folderId) ?? 0) + 1), new Map<string | null, number>()),
    selected: showTrash ? null : folderFilter,
    disabled: busy,
    onSelect: selectFolder,
    onCreate: (parent: string | null, name: string) => tryOrganize(() => service.createFolder(name, parent)),
    onRename: (folder: string, name: string) => tryOrganize(() => service.renameFolder(folder, name)),
    onDelete: (folder: Folder) => setFolderToDelete(folder),
    onMoveFolder: (folder: string, parent: string | null) => { void tryOrganize(() => service.moveFolder(folder, parent)) },
    onMoveNote: (moved: string, folder: string | null) => { void organize(() => service.moveNoteToFolder(moved, folder)) },
  }), [busy, folderFilter, folders, notes, organize, selectFolder, showTrash, tryOrganize])
  const folderNames = useMemo(() => new Map(folders.map((folder) => [folder.id, folder.name])), [folders])

  // Stable identity so the editor does not re-render whenever the library refreshes.
  const notesRef = useRef(notes)
  useEffect(() => { notesRef.current = notes }, [notes])
  const openLink = useCallback((title: string) => {
    const target = notesRef.current.find((item) => item.title.toLowerCase() === title.toLowerCase())
    if (target) void select(target.id)
    else setMessage('No existe una nota llamada «' + title + '». Crea una nota con ese título para enlazarla.')
  }, [select])

  const notify = useCallback((action: () => Promise<string>) => run(async () => {
    setMessage(await action())
  }), [run])

  const loadReminders = useCallback(() => { service.listReminders().then(setReminders).catch(reportError) }, [reportError])
  const openRef = useRef(open)
  useEffect(() => { openRef.current = open }, [open])
  useEffect(() => {
    loadReminders()
    service.reminderCapabilities().then(setReminderCaps).catch(() => setReminderCaps(null))
    // A notification click opens its note, including the click that launched the app.
    const openFromReminder = (id: string) => { setShowTrash(false); setSearch(''); setMobileLibrary(false); void openRef.current(id) }
    service.takePendingOpenNote().then((id) => { if (id) openFromReminder(id) }).catch(() => {})
    const stop = service.onReminderEvents(loadReminders, openFromReminder)
    // Browser mode only: re-read so fired reminders are flagged. Native apps are told by Rust.
    const timer = window.setInterval(loadReminders, 60_000)
    return () => { stop(); window.clearInterval(timer) }
  }, [loadReminders])
  const changeReminder = useCallback(async (action: () => Promise<{ permission: ReminderCapabilities['permission'] }>) => {
    try {
      const result = await action()
      setReminderCaps((current) => current ? { ...current, permission: result.permission } : current)
      loadReminders()
      return true
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); return false }
  }, [loadReminders])

  const showSettings = useCallback(() => run(async () => {
    const list = await service.listBackups()
    setBackups(list); setSelectedBackup(list[0] ?? '')
    setSettings(true)
  }), [run])
  const openSettings = useCallback(() => { void showSettings() }, [showSettings])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey)) return
      if (document.querySelector('dialog[open]')) return
      const key = event.key.toLowerCase()
      if (key === 's') { event.preventDefault(); void notify(async () => 'Nota guardada') }
      if (key === 'k') { event.preventDefault(); setQuery(''); setPaletteIndex(0); setPalette(true) }
      if (key === 'n') { event.preventDefault(); if (!busy) void createBlank() }
      if (key === 'f' && !event.shiftKey) {
        event.preventDefault(); setLibraryCollapsed(false); setMobileLibrary(true)
        window.requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select() })
      }
      if (key === '\\') { event.preventDefault(); setLibraryCollapsed((value) => !value) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, createBlank, notify])

  const actions = useMemo(() => [
    { id: 'action:new', label: 'Nueva nota', hint: 'Crear un documento en blanco' },
    { id: 'action:daily', label: 'Nota de hoy', hint: 'Abrir tu cuaderno del día' },
    { id: 'action:backup', label: 'Copias y ajustes', hint: 'Proteger y recuperar tu biblioteca' },
    ...notes.map((item) => ({ id: item.id, label: item.title || 'Sin título', hint: 'Abrir nota · ' + formatUnix(item.updatedAt) })),
  ], [notes])
  const fuse = useMemo(() => new Fuse(actions, { keys: ['label', 'hint'], threshold: 0.35 }), [actions])

  function executeCommand(id: string) {
    setPalette(false)
    if (id === 'action:new') { void createBlank(); return }
    if (id === 'action:daily') {
      setShowTrash(false); setSearch('')
      void run(async () => { const daily = await service.createOrOpenDailyNote(); await refresh(); await load(daily.id) })
      return
    }
    if (id === 'action:backup') { void showSettings(); return }
    void select(id)
  }

  // The search also looks inside the notes' text (protected notes: title only, it is encrypted).
  const [textMatches, setTextMatches] = useState<TextMatch[]>([])
  useEffect(() => {
    const words = query.trim()
    if (!palette || words.length < 2) { setTextMatches([]); return }
    let live = true
    const timer = window.setTimeout(() => {
      service.searchText(words).then((found) => { if (live) setTextMatches(found) }, () => { if (live) setTextMatches([]) })
    }, 110)
    return () => { live = false; window.clearTimeout(timer) }
  }, [palette, query])

  const matches = useMemo<PaletteItem[]>(() => {
    if (!query.trim()) return actions.slice(0, 20)
    const passages = new Map(textMatches.map((match) => [match.noteId, match.snippet]))
    const byTitle: PaletteItem[] = fuse.search(query).map((entry) => entry.item).slice(0, 20)
      .map((item) => passages.has(item.id) ? { ...item, snippet: passages.get(item.id) } : item)
    const seen = new Set(byTitle.map((item) => item.id))
    const byText: PaletteItem[] = textMatches.filter((match) => !seen.has(match.noteId))
      .map((match) => ({ id: match.noteId, label: match.title || 'Sin título', hint: '', snippet: match.snippet }))
    return [...byTitle, ...byText].slice(0, 24)
  }, [actions, fuse, query, textMatches])

  // Searching always covers the whole library; folders narrow the list otherwise. The reminders
  // view lists what needs attention first, then by the next reminder time.
  const currentList = useMemo(() => {
    if (!results && !showTrash && folderFilter === REMINDERS_VIEW) {
      const rank = (id: string) => { const entry = reminderByNote.get(id); return entry ? (entry.needsAttention ? 0 : 1) * 1e12 + (entry.snoozedUntil ?? entry.nextFireAt ?? 0) : 2e12 }
      return [...notesInFolder(REMINDERS_VIEW)].sort((a, b) => rank(a.id) - rank(b.id))
    }
    return sortNotes(results ?? (showTrash ? trash : folderFilter === null ? notes : notesInFolder(folderFilter)), order)
  }, [folderFilter, notes, notesInFolder, order, reminderByNote, results, showTrash, trash])
  const listHeading = folderFilter === REMINDERS_VIEW ? 'Recordatorios' : folderFilter === UNFILED ? 'Sin carpeta' : folderFilter ? folderNames.get(folderFilter) ?? 'Notas' : 'Notas'
  const notePath = useMemo(() => folderPath(n.folders, note?.folderId ?? null), [n.folders, note?.folderId])
  const tags = useMemo(() => [...new Set(notes.flatMap((item) => item.tags))].sort(), [notes])
  const readonly = !!note?.isDeleted
  // A protected note shows its lock screen until the password opens it.
  const sealed = !!note?.locked && n.unlockedId !== note.id
  const wordCount = useMemo(() => draft?.contentPlain.trim().split(/\s+/).filter(Boolean).length ?? 0, [draft?.contentPlain])
  const status = message || (slowBusy ? 'Preparando tu espacio…' : '')

  return <div className={'workspace' + (mobileLibrary ? ' library-open' : '') + (libraryCollapsed ? ' library-collapsed' : '')}>
    <a className="skip-link" href="#document">Ir al editor</a>
    <Library list={currentList} tags={tags} noteCount={notes.length} trashCount={trash.length} selectedId={noteId}
      showTrash={showTrash} search={search} order={order} busy={busy} loading={busy && !notes.length} searching={searching}
      searchRef={searchRef} onCreate={createFromList} onSearch={setSearch} onOrder={setOrder}
      onShowNotes={showNotes} onShowTrash={showDeleted} onSelect={selectFromList} onSettings={openSettings}
      folderTree={folderTree} folderNames={folderNames} showFolderNames={folderFilter === null || folderFilter === REMINDERS_VIEW || !!search} heading={listHeading}
      reminders={reminderMarks} remindersView={{ active: !showTrash && folderFilter === REMINDERS_VIEW, attention: attentionCount, count: reminderMarks.size, onShow: () => selectFolder(REMINDERS_VIEW) }} />

    <main id="document" className="document" tabIndex={-1} aria-busy={busy}>
      <header className="document-header">
        <button className="desktop-library-toggle" aria-label={libraryCollapsed ? 'Mostrar biblioteca' : 'Ocultar biblioteca'} data-tip={(libraryCollapsed ? 'Mostrar' : 'Ocultar') + ' biblioteca · ' + keys('⌘\\')}
          aria-controls="library" aria-expanded={!libraryCollapsed} onClick={() => setLibraryCollapsed(!libraryCollapsed)}><Icon name="panel" size={19} /></button>
        <button className="library-toggle" onClick={() => setMobileLibrary(!mobileLibrary)} aria-controls="library" aria-expanded={mobileLibrary}><Icon name="panel" size={17} />Biblioteca</button>
        <span className="breadcrumb">{notePath.map((folder) => <span key={folder.id} className="crumb"><span aria-hidden="true">/</span>
          <button type="button" onClick={() => selectFolder(folder.id)}>{folder.name}</button></span>)}
          <span aria-hidden="true">/</span><strong>{note ? draft?.title || 'Sin título' : showTrash ? 'Papelera' : listHeading}</strong></span>
        <div className="header-actions">
          <button onClick={() => { setQuery(''); setPaletteIndex(0); setPalette(true) }} className="command-trigger" aria-label="Buscar y ejecutar comandos" data-tip="Buscar y ejecutar"><Icon name="search" size={16} /><kbd>{keys('⌘K')}</kbd></button>
          {note && draft && !readonly && <ReminderControl reminder={reminderByNote.get(note.id) ?? null} capabilities={reminderCaps} disabled={busy}
            onSave={(localTime: string, zone: string, repeat: ReminderRepeat) => changeReminder(() => service.setReminder(note.id, localTime, zone, repeat))}
            onClear={() => { void changeReminder(() => service.clearReminder(note.id)) }} />}
          <button className="icon-button" aria-label="Referencias" data-tip="Referencias" aria-pressed={panel === 'links'} disabled={!note || busy} onClick={() => setPanel(panel === 'links' ? null : 'links')}><Icon name="link" size={17} /></button>
          <button className="icon-button" aria-label="Historial" data-tip={note?.locked ? 'Las notas protegidas no guardan historial' : 'Historial'} aria-pressed={panel === 'history'} disabled={!note || busy || !!note?.locked} onClick={() => setPanel(panel === 'history' ? null : 'history')}><Icon name="history" size={17} /></button>
          {note && draft && <ActionsMenu label="Más acciones" actions={sealed ? [
            { label: 'Mover a papelera', icon: 'trash', testId: 'delete-note-btn', danger: true, onSelect: () => void n.mutate(() => service.moveToTrash(note.id), null) },
          ] : note.locked && !readonly ? [
            { label: 'Guardar ahora', icon: 'check', testId: 'save-note-btn', shortcut: '⌘S', onSelect: () => void notify(async () => 'Nota guardada') },
            { label: 'Mover a carpeta…', icon: 'folder', testId: 'move-note-btn', onSelect: () => setMovingNote(true) },
            { label: 'Quitar la contraseña…', icon: 'unlock', testId: 'unlock-note-btn', separatorBefore: true, onSelect: () => setPasswordDialog('unlock') },
            { label: 'Mover a papelera', icon: 'trash', testId: 'delete-note-btn', danger: true, separatorBefore: true, onSelect: () => void n.mutate(() => service.moveToTrash(note.id), null) },
          ] : readonly ? [
            { label: 'Exportar como Markdown', icon: 'export', testId: 'export-note-btn', onSelect: () => void notify(() => service.exportNote(note.id)) },
            { label: 'Exportar como Word', icon: 'word', testId: 'export-docx-btn', onSelect: () => void notify(() => service.exportNoteDocx(note.id)) },
          ] : [
            { label: 'Guardar ahora', icon: 'check', testId: 'save-note-btn', shortcut: '⌘S', onSelect: () => void notify(async () => 'Nota guardada') },
            { label: 'Duplicar', icon: 'copy', onSelect: () => void n.create(draft.contentMd, draft.title + ' (copia)', normalizeTags(draft.tags), note.folderId) },
            { label: 'Mover a carpeta…', icon: 'folder', testId: 'move-note-btn', onSelect: () => setMovingNote(true) },
            { label: 'Proteger con contraseña…', icon: 'lock', testId: 'lock-note-btn', onSelect: () => setPasswordDialog('lock') },
            { label: 'Exportar como Markdown', icon: 'export', testId: 'export-note-btn', separatorBefore: true, onSelect: () => void notify(() => service.exportNote(note.id)) },
            { label: 'Exportar como Word', icon: 'word', testId: 'export-docx-btn', onSelect: () => void notify(() => service.exportNoteDocx(note.id)) },
            { label: 'Mover a papelera', icon: 'trash', testId: 'delete-note-btn', danger: true, separatorBefore: true, onSelect: () => void n.mutate(() => service.moveToTrash(note.id), null) },
          ]} />}
        </div>
      </header>

      {n.error && <div className="error-banner" role="alert"><strong>No se ha completado la operación.</strong> {n.error} {saveState === 'error' && <button onClick={() => void n.flush().catch(() => {})}>Reintentar guardado</button>}</div>}
      {n.recovery && <div className="notice" role="status">Hay un borrador pendiente de una sesión anterior. <button onClick={n.recover}>Recuperar borrador</button><button onClick={n.dismissRecovery}>Conservar versión guardada</button></div>}

      {note && draft && sealed ? <div className="writing-layout locked-layout"><LockedNote key={note.id} title={note.title} unlock={n.unlock} /></div>
      : note && draft ? <div className={'writing-layout' + (panel ? ' with-inspector' : '')}>
        <div className="writing-surface" key={note.id} style={surfaceStyle} data-font={preferences.font}>
          {readonly && <div className="trash-banner"><span>Esta nota está en la papelera.</span>
            <button disabled={busy} onClick={() => { setShowTrash(false); void n.mutate(() => service.restoreNote(note.id), note.id) }}><Icon name="restore" size={14} />Restaurar nota</button>
            <button className="danger-text" disabled={busy} onClick={() => setConfirmation({
              title: 'Eliminar definitivamente', body: 'Se eliminará «' + draft.title + '» junto con su historial. Esta acción no se puede deshacer.',
              label: 'Confirmar eliminación', action: () => n.mutate(() => service.deleteNotePermanently(note.id), null),
            })}>Eliminar definitivamente</button></div>}
          {!readonly && reminderByNote.get(note.id)?.needsAttention && <ReminderAttention reminder={reminderByNote.get(note.id)!}
            onDone={() => { void changeReminder(() => service.completeReminder(note.id)) }}
            onSnooze={(minutes) => { void changeReminder(() => service.snoozeReminder(note.id, minutes)) }} />}
          <div className="document-heading">
            <p className="document-kicker"><time dateTime={new Date(note.updatedAt * 1000).toISOString()}>{formatUnix(note.updatedAt)}</time></p>
            <label className="sr-only" htmlFor="note-title">Título de la nota</label>
            <input ref={titleRef} id="note-title" className="title-input" data-testid="note-title-input" value={draft.title} autoComplete="off"
              placeholder="Sin título" readOnly={readonly} onChange={(event) => n.change({ title: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                document.querySelector<HTMLElement>('.mazmi-editor, .markdown-input')?.focus()
              }} />
            <label className="note-tags"><Icon name="tag" size={13} /><input aria-label="Etiquetas separadas por comas" data-testid="note-tags-input"
              value={draft.tags.join(', ')} placeholder="Añadir etiquetas" readOnly={readonly} autoComplete="off"
              onChange={(event) => n.change({ tags: event.target.value.split(',') })} onBlur={() => n.change({ tags: normalizeTags(draft.tags) })} /></label>
          </div>
          <NoteEditor key={note.id + ':' + epoch} noteId={note.id} draft={draft} readonly={readonly}
            change={n.change} touch={n.touch} registerPending={n.registerPending} openLink={openLink}
            preferences={preferences} updatePreferences={updatePreferences} />
          <footer className="document-footer">
            <span data-testid="save-state" role="status" className={'save-state ' + saveDisplay}><span aria-hidden="true" className="local-dot" />{readonly ? 'Solo lectura' : SAVE_LABELS[saveDisplay]}</span>
            <span className="word-count">{wordCount} {wordCount === 1 ? 'palabra' : 'palabras'}</span>
          </footer>
        </div>

        {panel && <aside className="inspector" aria-label={panel === 'history' ? 'Historial de la nota' : 'Referencias de la nota'}>
          <div className="inspector-heading"><h2><Icon name={panel === 'history' ? 'history' : 'link'} size={18} />{panel === 'history' ? 'Historial' : 'Referencias'}</h2><button aria-label="Cerrar panel" onClick={() => setPanel(null)}><Icon name="close" size={16} /></button></div>
          <p className="muted">{panel === 'history' ? 'Consulta el contenido antes de recuperar una versión. El título y las etiquetas actuales se mantienen.' : 'Notas que mencionan este documento mediante [[título]].'}</p>
          {contextLoading && !versions.length && !backlinks.length ? <p className="muted" role="status">Cargando…</p> : panel === 'history' ? <ul className="context-list">
            {versions.length === 0 && <li className="muted">Todavía no hay versiones guardadas.</li>}
            {versions.map((entry) => <li key={entry.id}><button onClick={() => setVersion(entry)}><time>{formatUnix(entry.createdAt)}</time><span>{entry.snapshotPlain.slice(0, 100) || 'Documento vacío'}</span></button></li>)}
          </ul> : <ul className="context-list">
            {backlinks.length === 0 && <li className="muted">Todavía no hay referencias a esta nota.</li>}
            {backlinks.map((entry) => <li key={entry.fromNoteId + entry.linkText}><button onClick={() => void select(entry.fromNoteId)}>{entry.fromTitle}</button></li>)}
          </ul>}
        </aside>}
      </div> : <section className="welcome">
        <span className="welcome-symbol" aria-hidden="true"><img src="/mazmi.svg" alt="" width="68" height="68" /></span>
        <h2>{showTrash ? 'Nada se pierde por accidente.' : 'Una idea. Todo lo que viene después.'}</h2>
        <p>{showTrash ? 'Selecciona una nota de la papelera para leerla o recuperarla.' : 'Escribe, conecta tus notas y vuelve a ellas cuando las necesites. Todo queda en tu equipo.'}</p>
        {!showTrash && <button className="primary" disabled={busy} onClick={() => void createBlank()}><Icon name="plus" size={18} />Escribir una nota</button>}
        {!showTrash && <div className="welcome-shortcuts"><span><kbd>{keys('⌘N')}</kbd>Nueva nota</span><span><kbd>{keys('⌘K')}</kbd>Buscar y ejecutar</span><span><kbd>/</kbd>Insertar bloques</span></div>}
      </section>}
      <div className={'operation-status' + (status ? ' visible' : '')} data-testid="status-message" role="status">{status}</div>
    </main>

    {passwordDialog && note && <PasswordDialog mode={passwordDialog} close={() => setPasswordDialog(null)} submit={async (password) => {
      const id = note.id
      if (passwordDialog === 'lock') {
        await n.flush()
        await service.lockNote(id, password)
        setPanel(null)
        setMessage('Nota protegida. Necesitarás la contraseña para abrirla.')
      } else {
        await n.flush()
        await service.removeNoteLock(id, password)
        setMessage('La nota ya no tiene contraseña.')
      }
      await refresh()
      await load(id)
    }} />}
    {splash && <Splash enter={() => setSplash(false)} />}
    {palette && <Modal title="Buscar y ejecutar" close={() => setPalette(false)} className="palette" initialFocus={paletteRef}>
      <input ref={paletteRef} data-testid="command-palette-input" className="palette-search" aria-label="Buscar comando o nota" placeholder="¿Qué necesitas encontrar?"
        value={query} onChange={(event) => { setQuery(event.target.value); setPaletteIndex(0) }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setPaletteIndex((value) => Math.min(value + 1, matches.length - 1)) }
          if (event.key === 'ArrowUp') { event.preventDefault(); setPaletteIndex((value) => Math.max(0, value - 1)) }
          if (event.key === 'Enter' && matches[paletteIndex]) executeCommand(matches[paletteIndex].id)
        }} />
      <ul className="palette-results">{matches.length === 0 && <li>Sin resultados</li>}{matches.map((item, index) => <li key={item.id}>
        <button className={index === paletteIndex ? 'active' : ''} onMouseEnter={() => setPaletteIndex(index)} onClick={() => executeCommand(item.id)}><strong>{item.label}</strong>{item.snippet ? <span className="palette-snippet"><Highlighted text={item.snippet} /></span> : <span>{item.hint}</span>}</button>
      </li>)}</ul>
      <div className="palette-help" aria-hidden="true"><span><kbd>↑ ↓</kbd>Explorar</span><span><kbd>↵</kbd>Abrir</span><span><kbd>esc</kbd>Cerrar</span></div>
    </Modal>}

    {settings && <Modal title="Copias y ajustes" close={() => { if (!busy) setSettings(false) }}>
      <section className="settings-section"><h3>Copias de seguridad</h3><p>Guarda una copia de todas tus notas, etiquetas, papelera e historial{desktop ? ' en este equipo.' : ' en este navegador.'}</p>
        <div className="button-row">
          <button className="primary" disabled={busy} onClick={() => void run(async () => {
            setMessage(await service.backupNow())
            const list = await service.listBackups(); setBackups(list); setSelectedBackup(list[0] ?? '')
          })}>Crear copia</button>
          <select value={selectedBackup} onChange={(event) => setSelectedBackup(event.target.value)} aria-label="Copia de seguridad">
            <option value="">Elige una copia</option>{backups.map((entry) => <option key={entry} value={entry}>{backupLabel(entry)}</option>)}
          </select>
          <button disabled={busy || !selectedBackup} onClick={() => setConfirmation({
            title: 'Restaurar biblioteca', body: 'La copia reemplazará tus notas actuales. Antes se guarda automáticamente una copia del estado actual.',
            label: 'Confirmar restauración', action: () => n.mutate(async () => {
              setMessage(await service.restoreBackup(selectedBackup))
              const list = await service.listBackups(); setBackups(list); setSelectedBackup(list[0] ?? '')
            }),
          })}>Restaurar copia</button>
        </div>
      </section>
      {desktop && <section className="settings-section"><h3>Carpeta de notas</h3><p>Exporta todas tus notas como archivos Markdown o importa una carpeta existente.</p>
        <div className="button-row"><button disabled={busy} onClick={() => void notify(service.exportVault)}>Exportar carpeta</button>
          <button disabled={busy} onClick={() => void n.mutate(async () => { setMessage(await service.importVault()) })}>Importar carpeta</button></div>
      </section>}
      <section className="settings-section settings-foot"><button data-testid="db-self-check-btn" disabled={busy} onClick={() => void notify(service.runDbSelfCheck)}>Revisar la biblioteca</button>
        <p className="muted">MazmiNotas 0.4 · Tus notas se quedan en {desktop ? 'este equipo' : 'este navegador'}.</p>
      </section>
    </Modal>}

    {folderToDelete && <Modal title="Eliminar carpeta" close={() => setFolderToDelete(null)}>
      <p className="confirm-body">Se eliminará la carpeta «{folderToDelete.name}». Sus notas y subcarpetas pasarán a {folderToDelete.parentId ? '«' + (folderNames.get(folderToDelete.parentId) ?? 'la carpeta superior') + '»' : 'Sin carpeta'}. Ninguna nota se borra.</p>
      <div className="modal-actions"><button onClick={() => setFolderToDelete(null)}>Cancelar</button>
        <button className="danger" onClick={() => {
          const target = folderToDelete
          setFolderToDelete(null)
          if (folderFilter === target.id) setFolderFilter(target.parentId)
          void tryOrganize(() => service.deleteFolder(target.id))
        }}>Eliminar carpeta</button></div>
    </Modal>}

    {movingNote && note && <Modal title="Mover a carpeta" close={() => setMovingNote(false)} className="folder-picker">
      <ul className="picker-list">
        <li><button aria-pressed={!note.folderId} onClick={() => { setMovingNote(false); void n.organize(() => service.moveNoteToFolder(note.id, null)) }}><Icon name="inbox" size={16} />Sin carpeta</button></li>
        {flattenTree(buildFolderTree(n.folders)).map((folder) => <li key={folder.id}>
          <button aria-pressed={note.folderId === folder.id} style={{ paddingLeft: 12 + folder.depth * 16 }}
            onClick={() => { setMovingNote(false); void n.organize(() => service.moveNoteToFolder(note.id, folder.id)) }}><Icon name="folder" size={16} />{folder.name}</button>
        </li>)}
      </ul>
      {n.folders.length === 0 && <p className="muted">Todavía no tienes carpetas. Créalas desde la barra lateral.</p>}
    </Modal>}

    {confirmation && <Modal title={confirmation.title} close={() => { if (!busy) setConfirmation(null) }}>
      <p className="confirm-body">{confirmation.body}</p><div className="modal-actions">
        <button disabled={busy} onClick={() => setConfirmation(null)}>Cancelar</button>
        <button className="danger" disabled={busy} onClick={() => { const action = confirmation.action; setConfirmation(null); void action() }}>{confirmation.label}</button>
      </div>
    </Modal>}

    {version && <Modal title="Consultar versión" close={() => setVersion(null)}>
      <p className="muted">{formatUnix(version.createdAt)} · Recupera el contenido, conservando el título y las etiquetas actuales.</p>
      <MarkdownPreview text={version.snapshotMd ?? version.snapshotPlain} />
      <div className="modal-actions"><button onClick={() => setVersion(null)}>Cancelar</button>
        <button className="primary" disabled={busy || readonly} onClick={() => { const selected = version; setVersion(null); if (note) void n.mutate(() => service.restoreVersion(note.id, selected.id)) }}>Recuperar esta versión</button></div>
    </Modal>}
  </div>
}

export default App
