import type { Folder } from '../types'

export const MAX_FOLDER_DEPTH = 12

export interface FolderNode extends Folder {
  depth: number
  children: FolderNode[]
}

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true })

/** Builds the folder tree; orphans (a parent that no longer exists) are shown at the root. */
export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const nodes = new Map(folders.map((folder) => [folder.id, { ...folder, depth: 0, children: [] as FolderNode[] }]))
  const roots: FolderNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (list: FolderNode[], depth: number) => {
    list.sort((a, b) => collator.compare(a.name, b.name))
    for (const node of list) { node.depth = depth; sort(node.children, depth + 1) }
  }
  sort(roots, 0)
  return roots
}

/** Ids of `id` and all of its descendants. */
export function subtreeIds(folders: Folder[], id: string): Set<string> {
  const result = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const folder of folders) {
      if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) { result.add(folder.id); grew = true }
    }
  }
  return result
}

export function folderDepth(folders: Folder[], id: string | null): number {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  let depth = 0
  for (let current = id ? byId.get(id) : undefined; current && depth < 64; current = current.parentId ? byId.get(current.parentId) : undefined) depth += 1
  return depth
}

export function folderPath(folders: Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: Folder[] = []
  for (let current = id ? byId.get(id) : undefined; current && path.length < 64; current = current.parentId ? byId.get(current.parentId) : undefined) path.unshift(current)
  return path
}

/** Whether `folder` may be moved under `parent` without creating a cycle. */
export function canMoveFolder(folders: Folder[], folder: string, parent: string | null): boolean {
  if (parent === null) return true
  return !subtreeIds(folders, folder).has(parent)
}

export function cleanFolderName(name: string): string {
  const value = name.trim()
  if (!value) throw new Error('La carpeta necesita un nombre')
  if ([...value].length > 120) throw new Error('El nombre de la carpeta es demasiado largo')
  if (/\p{Cc}/u.test(value)) throw new Error('El nombre de la carpeta contiene caracteres no válidos')
  return value
}
