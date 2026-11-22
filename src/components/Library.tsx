import { memo, type RefObject } from 'react'
import { Icon } from './Icon'
import { formatUnix } from '../utils/notes'
import { keys } from '../utils/platform'
import { onPress } from '../utils/press'
import type { NoteSummary, SortOrder } from '../types'
import { FolderTree, NOTE_DRAG } from './FolderTree'

const NoteRow = memo(function NoteRow({ item, selected, folderName, reminder, onSelect }: {
  item: NoteSummary; selected: boolean; folderName?: string; reminder?: 'scheduled' | 'overdue'; onSelect: (id: string) => void
}) {
  return <li>
    <button className={'note-row' + (selected ? ' selected' : '')} aria-current={selected ? 'true' : undefined} {...onPress(() => onSelect(item.id))}
      draggable={!item.isDeleted} onDragStart={(event) => { event.dataTransfer.setData(NOTE_DRAG, item.id); event.dataTransfer.effectAllowed = 'move' }}>
      <Icon name="file" size={17} /><span className="note-row-content"><span className="note-row-title">{item.title || 'Sin título'}</span>
        <span className="note-row-meta"><time dateTime={new Date(item.updatedAt * 1000).toISOString()}>{formatUnix(item.updatedAt)}</time>
          {folderName && <span className="note-row-folder"><Icon name="folder" size={11} />{folderName}</span>}
          {item.locked && <span className="note-row-lock" aria-label="Protegida con contraseña"><Icon name="lock" size={11} /></span>}
          {reminder && <span className={'note-row-reminder ' + reminder} aria-label={reminder === 'overdue' ? 'Recordatorio vencido' : 'Con recordatorio'}><Icon name="bell" size={11} /></span>}</span>
        {item.tags.length > 0 && <span className="note-row-tags">{item.tags.map((tag) => '#' + tag).join('  ')}</span>}</span>
    </button>
  </li>
}, (previous, next) => previous.selected === next.selected && previous.onSelect === next.onSelect
  && previous.folderName === next.folderName && previous.reminder === next.reminder && previous.item.locked === next.item.locked
  && previous.item.id === next.item.id && previous.item.title === next.item.title
  && previous.item.updatedAt === next.item.updatedAt && previous.item.tags.join('\u001f') === next.item.tags.join('\u001f'))

export type FolderTreeProps = Parameters<typeof FolderTree>[0]

const SORTS: { id: SortOrder; label: string; tip: string }[] = [
  { id: 'recent', label: 'Recientes', tip: 'Últimas editadas primero' },
  { id: 'alphabetical', label: 'A–Z', tip: 'Por título' },
]

interface Props {
  list: NoteSummary[]
  tags: string[]
  noteCount: number
  trashCount: number
  selectedId: string | null
  showTrash: boolean
  search: string
  order: SortOrder
  busy: boolean
  loading: boolean
  searching: boolean
  searchRef: RefObject<HTMLInputElement | null>
  folderTree: FolderTreeProps
  folderNames: Map<string, string>
  showFolderNames: boolean
  heading: string
  reminders: Map<string, 'scheduled' | 'overdue'>
  remindersView: { active: boolean; attention: number; count: number; onShow: () => void }
  onCreate: () => void
  onSearch: (value: string) => void
  onOrder: (value: SortOrder) => void
  onShowNotes: () => void
  onShowTrash: () => void
  onSelect: (id: string) => void
  onSettings: () => void
}

function LibraryView({
  list, tags, noteCount, trashCount, selectedId, showTrash, search, order, busy, loading, searching, searchRef,
  folderTree, folderNames, showFolderNames, heading, reminders, remindersView, onCreate, onSearch, onOrder, onShowNotes, onShowTrash, onSelect, onSettings,
}: Props) {
  const empty = loading ? 'Cargando…' : search ? 'Sin resultados para «' + search + '».' : showTrash ? 'La papelera está vacía.' : 'Tu primera idea empieza con una nota nueva.'
  return <aside id="library" className="library" aria-label="Biblioteca">
    <header className="brand"><img className="brand-symbol" src="/mazmi.svg" alt="" width="34" height="34" /><h1 translate="no">MazmiNotas</h1></header>
    <button className="primary new-note" data-testid="new-note-btn" disabled={busy} onClick={onCreate}><Icon name="plus" /> Nueva nota <kbd>{keys('⌘N')}</kbd></button>
    <label className="search-box"><Icon name="search" size={17} /><input ref={searchRef} aria-label="Buscar notas" data-testid="search-input" type="search"
      placeholder="Buscar en tus notas" value={search} onChange={(event) => onSearch(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Escape' && search) { event.preventDefault(); onSearch('') } }} />
      {searching ? <span className="search-spinner" aria-hidden="true" /> : <kbd>{keys('⌘F')}</kbd>}</label>
    <nav className="library-nav" aria-label="Vistas">
      <button aria-current={!showTrash && folderTree.selected === null && !remindersView.active ? 'page' : undefined} {...onPress(onShowNotes)}><Icon name="notes" size={17} /><span>Todas las notas</span><span>{noteCount}</span></button>
      <button aria-current={remindersView.active ? 'page' : undefined} {...onPress(remindersView.onShow)}><Icon name="bell" size={17} /><span>Recordatorios</span>
        {remindersView.attention > 0 ? <span className="nav-badge" aria-label={remindersView.attention + ' vencidos'}>{remindersView.attention}</span> : <span>{remindersView.count}</span>}</button>
      <button aria-current={showTrash ? 'page' : undefined} {...onPress(onShowTrash)}><Icon name="trash" size={17} /><span>Papelera</span><span>{trashCount}</span></button>
    </nav>
    <FolderTree {...folderTree} />
    {tags.length > 0 && !showTrash && <div className="tag-filters" aria-label="Filtrar por etiqueta">
      {tags.slice(0, 12).map((tag) => <button key={tag} aria-pressed={search === tag} onClick={() => onSearch(search === tag ? '' : tag)}>#{tag}</button>)}
    </div>}
    <div className="list-heading"><h2>{showTrash ? 'Papelera' : search ? 'Resultados' : heading}</h2>
      <div className="sort-toggle" role="radiogroup" aria-label="Orden de las notas" data-testid="sort-select">
        {SORTS.map((entry) => <button key={entry.id} type="button" role="radio" aria-checked={order === entry.id} data-tip={entry.tip}
          onClick={() => onOrder(entry.id)}>{entry.label}</button>)}
      </div>
    </div>
    <ul className="note-list" aria-label="Notas" aria-busy={searching}>
      {list.length === 0 && <li className="list-empty">{empty}</li>}
      {list.map((item) => <NoteRow key={item.id} item={item} selected={selectedId === item.id} onSelect={onSelect}
        folderName={showFolderNames && item.folderId ? folderNames.get(item.folderId) : undefined} reminder={reminders.get(item.id)} />)}
    </ul>
    <footer className="library-footer">
      <button onClick={onSettings} disabled={busy}><Icon name="settings" size={17} />Copias y ajustes</button>
    </footer>
  </aside>
}

export const Library = memo(LibraryView)
