import { memo, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Icon } from './Icon'
import type { Folder } from '../types'
import { buildFolderTree, canMoveFolder, MAX_FOLDER_DEPTH, type FolderNode } from '../utils/folders'
import { onPress } from '../utils/press'

export const UNFILED = '__unfiled__'
export const NOTE_DRAG = 'application/x-mazmi-note'
const FOLDER_DRAG = 'application/x-mazmi-folder'
const EXPANDED_KEY = 'mazminotas-expanded-folders-v1'

interface Props {
  folders: Folder[]
  counts: Map<string | null, number>
  selected: string | null
  disabled: boolean
  onSelect: (folder: string | null) => void
  onCreate: (parent: string | null, name: string) => Promise<boolean>
  onRename: (folder: string, name: string) => Promise<boolean>
  onDelete: (folder: Folder) => void
  onMoveFolder: (folder: string, parent: string | null) => void
  onMoveNote: (note: string, folder: string | null) => void
}

function readExpanded(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as string[]) } catch { return new Set() }
}

/** The drag payload is only readable on drop; the type list tells what is being dragged. */
let draggingFolder: string | null = null

function NameInput({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  return <input ref={ref} className="folder-name-input" defaultValue={initial} aria-label="Nombre de la carpeta" maxLength={120}
    onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); onSubmit(event.currentTarget.value) }
      if (event.key === 'Escape') { event.preventDefault(); onCancel() }
    }}
    onBlur={(event) => { if (event.currentTarget.value.trim() && event.currentTarget.value.trim() !== initial) onSubmit(event.currentTarget.value); else onCancel() }} />
}

function FolderTreeView(props: Props) {
  const { folders, counts, selected, disabled, onSelect, onCreate, onRename, onDelete, onMoveFolder, onMoveNote } = props
  const tree = useMemo(() => buildFolderTree(folders), [folders])
  const [expanded, setExpanded] = useState(readExpanded)
  const [editing, setEditing] = useState<{ kind: 'new'; parent: string | null } | { kind: 'rename'; id: string } | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  useEffect(() => {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])) } catch { /* optional */ }
  }, [expanded])
  useEffect(() => {
    if (!menu) return
    const close = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest('.folder-menu')) setMenu(null) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])

  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const accepts = (event: DragEvent, target: string | null) => {
    if (disabled) return false
    if (event.dataTransfer.types.includes(NOTE_DRAG)) return true
    if (event.dataTransfer.types.includes(FOLDER_DRAG)) return draggingFolder !== null && canMoveFolder(folders, draggingFolder, target === UNFILED ? null : target)
    return false
  }
  const dropProps = (target: string | null) => ({
    onDragOver: (event: DragEvent) => { if (accepts(event, target)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(target ?? 'root') } },
    onDragLeave: () => setDropTarget((current) => current === (target ?? 'root') ? null : current),
    onDrop: (event: DragEvent) => {
      setDropTarget(null)
      const destination = target === UNFILED ? null : target
      const note = event.dataTransfer.getData(NOTE_DRAG)
      const folder = event.dataTransfer.getData(FOLDER_DRAG)
      if (note) { event.preventDefault(); onMoveNote(note, destination) }
      else if (folder && canMoveFolder(folders, folder, destination)) { event.preventDefault(); onMoveFolder(folder, destination) }
    },
  })

  const create = async (parent: string | null, name: string) => {
    if (await onCreate(parent, name)) {
      setEditing(null)
      if (parent) setExpanded((current) => new Set(current).add(parent))
    }
  }

  const renderNode = (node: FolderNode) => {
    const open = expanded.has(node.id)
    const hasChildren = node.children.length > 0
    const isTarget = dropTarget === node.id
    return <li key={node.id} role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-selected={selected === node.id}>
      {editing?.kind === 'rename' && editing.id === node.id
        ? <div className="folder-row editing" style={{ paddingLeft: 8 + node.depth * 14 }}>
          <Icon name="folder" size={16} />
          <NameInput initial={node.name} onCancel={() => setEditing(null)}
            onSubmit={(name) => { void onRename(node.id, name).then((ok) => { if (ok) setEditing(null) }) }} />
        </div>
        : <div className={'folder-row' + (selected === node.id ? ' selected' : '') + (isTarget ? ' drop-target' : '')}
          style={{ paddingLeft: 8 + node.depth * 14 }} draggable={!disabled}
          onDragStart={(event) => { draggingFolder = node.id; event.dataTransfer.setData(FOLDER_DRAG, node.id); event.dataTransfer.effectAllowed = 'move' }}
          onDragEnd={() => { draggingFolder = null; setDropTarget(null) }}
          {...dropProps(node.id)}>
          <button type="button" className="folder-twisty" aria-label={open ? 'Contraer ' + node.name : 'Expandir ' + node.name}
            tabIndex={-1} disabled={!hasChildren} onClick={() => toggle(node.id)}>
            {hasChildren && <Icon name="chevron" size={12} className={open ? 'open' : ''} />}
          </button>
          <button type="button" className="folder-name" aria-current={selected === node.id ? 'page' : undefined}
            {...onPress(() => onSelect(node.id))}
            onDoubleClick={() => setEditing({ kind: 'rename', id: node.id })}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' && hasChildren && !open) toggle(node.id)
              if (event.key === 'ArrowLeft' && open) toggle(node.id)
              if (event.key === 'F2') setEditing({ kind: 'rename', id: node.id })
            }}>
            <Icon name="folder" size={16} /><span className="folder-label">{node.name}</span>
            <span className="folder-count">{counts.get(node.id) || ''}</span>
          </button>
          <div className="folder-menu">
            <button type="button" className="folder-more" aria-label={'Opciones de ' + node.name} aria-haspopup="menu" aria-expanded={menu === node.id}
              onClick={() => setMenu(menu === node.id ? null : node.id)}><Icon name="more" size={15} /></button>
            {menu === node.id && <div className="menu-panel folder-menu-panel" role="menu">
              {node.depth + 1 < MAX_FOLDER_DEPTH && <button type="button" role="menuitem" className="menu-item"
                onClick={() => { setMenu(null); setExpanded((current) => new Set(current).add(node.id)); setEditing({ kind: 'new', parent: node.id }) }}><Icon name="folder-plus" size={15} /><span>Nueva subcarpeta</span></button>}
              <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); setEditing({ kind: 'rename', id: node.id }) }}><Icon name="type" size={15} /><span>Renombrar</span></button>
              {node.parentId && <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); onMoveFolder(node.id, null) }}><Icon name="arrow" size={15} /><span>Mover al nivel superior</span></button>}
              <hr className="menu-separator" />
              <button type="button" role="menuitem" className="menu-item danger-text" onClick={() => { setMenu(null); onDelete(node) }}><Icon name="trash" size={15} /><span>Eliminar carpeta</span></button>
            </div>}
          </div>
        </div>}
      {(open || (editing?.kind === 'new' && editing.parent === node.id)) && <ul role="group">
        {open && node.children.map(renderNode)}
        {editing?.kind === 'new' && editing.parent === node.id && <li className="folder-row editing" style={{ paddingLeft: 22 + (node.depth + 1) * 14 }}>
          <Icon name="folder" size={16} /><NameInput initial="" onCancel={() => setEditing(null)} onSubmit={(name) => void create(node.id, name)} />
        </li>}
      </ul>}
    </li>
  }

  return <section className="folders" aria-label="Carpetas">
    <div className={'folders-heading' + (dropTarget === 'root' ? ' drop-target' : '')} {...dropProps(UNFILED)}>
      <h2>Carpetas</h2>
      <button type="button" className="icon-button" aria-label="Nueva carpeta" data-tip="Nueva carpeta" disabled={disabled}
        onClick={() => setEditing({ kind: 'new', parent: null })}><Icon name="folder-plus" size={16} /></button>
    </div>
    <ul className="folder-tree" role="tree" aria-label="Carpetas">
      {tree.map(renderNode)}
      {editing?.kind === 'new' && editing.parent === null && <li className="folder-row editing" style={{ paddingLeft: 22 }}>
        <Icon name="folder" size={16} /><NameInput initial="" onCancel={() => setEditing(null)} onSubmit={(name) => void create(null, name)} />
      </li>}
      {folders.length > 0 && <li role="treeitem" aria-selected={selected === UNFILED}>
        <div className={'folder-row' + (selected === UNFILED ? ' selected' : '') + (dropTarget === UNFILED ? ' drop-target' : '')} style={{ paddingLeft: 22 }} {...dropProps(UNFILED)}>
          <button type="button" className="folder-name" aria-current={selected === UNFILED ? 'page' : undefined} {...onPress(() => onSelect(UNFILED))}>
            <Icon name="inbox" size={16} /><span className="folder-label">Sin carpeta</span><span className="folder-count">{counts.get(null) || ''}</span>
          </button>
        </div>
      </li>}
    </ul>
    {folders.length === 0 && !editing && <p className="folders-empty">Agrupa tus notas en carpetas y subcarpetas.</p>}
  </section>
}

export const FolderTree = memo(FolderTreeView)
