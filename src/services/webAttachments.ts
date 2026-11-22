import { checkImage, isAttachmentName, MIME, sha256Hex, type ImageExtension } from '../utils/attachments'

/**
 * Browser mode keeps images in IndexedDB (localStorage is too small for them), content-addressed
 * like the desktop store. The images live only in this browser profile.
 */
const DB_NAME = 'mazminotas-attachments'
const STORE = 'files'
let opening: Promise<IDBDatabase> | null = null
const urls = new Map<string, string>()

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { opening = null; reject(request.error ?? new Error('IndexedDB no disponible')) }
  })
  return opening
}

function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const request = action(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB falló'))
  }))
}

export async function saveWebAttachment(bytes: Uint8Array): Promise<string> {
  const extension = checkImage(bytes)
  const name = `${await sha256Hex(bytes)}.${extension}`
  await run('readwrite', (store) => store.put(new Blob([bytes as BlobPart], { type: MIME[extension] }), name))
  return name
}

export async function readWebAttachment(name: string): Promise<Uint8Array> {
  if (!isAttachmentName(name)) throw new Error('Referencia de imagen no válida')
  const blob = await run<Blob | undefined>('readonly', (store) => store.get(name) as IDBRequest<Blob | undefined>)
  if (!blob) throw new Error(`No se encuentra la imagen ${name}`)
  return new Uint8Array(await blob.arrayBuffer())
}

export async function webAttachmentUrl(name: string): Promise<string> {
  const cached = urls.get(name)
  if (cached) return cached
  const bytes = await readWebAttachment(name)
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[name.split('.').pop() as ImageExtension] }))
  urls.set(name, url)
  return url
}

/** A file input stands in for the system dialog. */
export function pickWebImages(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/gif,image/webp'
    input.multiple = true
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])].slice(0, 20)
      Promise.all(files.map(async (file) => saveWebAttachment(new Uint8Array(await file.arrayBuffer())))).then(resolve, reject)
    }, { once: true })
    input.addEventListener('cancel', () => resolve([]), { once: true })
    input.click()
  })
}
