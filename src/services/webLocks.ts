import type { LockedContent } from '../types'

/**
 * Browser mode's protected notes, mirroring the desktop design with WebCrypto: PBKDF2-SHA256
 * (600 000 iterations) derives an AES-256-GCM key; the note id is authenticated data. The key is
 * kept in memory only while the note is open.
 */
export interface StoredLock { kdf: string; salt: string; iv: string; data: string }

const ITERATIONS = 600_000
const KDF = `pbkdf2-sha256:i=${ITERATIONS}`
export const MIN_PASSWORD = 4

const keys = new Map<string, { key: CryptoKey; salt: string }>()
const failures = new Map<string, number>()

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

async function derive(password: string, salt: Uint8Array, kdf: string): Promise<CryptoKey> {
  const iterations = Number(/i=(\d+)/.exec(kdf)?.[1] ?? ITERATIONS)
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function seal(key: CryptoKey, noteId: string, content: LockedContent, salt: string, kdf = KDF): Promise<StoredLock> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(noteId) }, key,
    new TextEncoder().encode(JSON.stringify(content))))
  return { kdf, salt, iv: toBase64(iv), data: toBase64(data) }
}

export function checkPassword(password: string): void {
  if ([...password].length < MIN_PASSWORD) throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`)
}

export async function lockContent(noteId: string, password: string, content: LockedContent): Promise<StoredLock> {
  checkPassword(password)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return seal(await derive(password, salt, KDF), noteId, content, toBase64(salt))
}

export async function openContent(noteId: string, password: string, lock: StoredLock): Promise<LockedContent> {
  // Wrong attempts wait longer each time, like the desktop app.
  const failed = failures.get(noteId) ?? 0
  if (failed) await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 250 * 2 ** Math.min(failed, 5))))
  const key = await derive(password, fromBase64(lock.salt), lock.kdf)
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(lock.iv) as BufferSource, additionalData: new TextEncoder().encode(noteId) },
      key, fromBase64(lock.data) as BufferSource)
    failures.delete(noteId)
    keys.set(noteId, { key, salt: lock.salt })
    return JSON.parse(new TextDecoder().decode(plain)) as LockedContent
  } catch {
    failures.set(noteId, failed + 1)
    throw new Error('Contraseña incorrecta')
  }
}

/** Re-encrypts an open protected note (autosave). */
export async function resealContent(noteId: string, lock: StoredLock, content: LockedContent): Promise<StoredLock> {
  const open = keys.get(noteId)
  if (!open || open.salt !== lock.salt) throw new Error('La nota está bloqueada: desbloquéala para guardar')
  return seal(open.key, noteId, content, lock.salt, lock.kdf)
}

export function forgetKey(noteId: string): void { keys.delete(noteId) }
