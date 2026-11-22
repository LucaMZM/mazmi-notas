/**
 * Images attached to notes. Mirrors `src-tauri/src/attachments.rs`: names are the SHA-256 of the
 * bytes plus the detected extension, and Markdown references them as `attachment:<name>`.
 */
export const ATTACHMENT_PREFIX = 'attachment:'
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export type ImageExtension = 'png' | 'jpg' | 'gif' | 'webp'

const NAME = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/
const REFERENCE = /attachment:([0-9a-f]{64}\.(?:png|jpg|gif|webp))/g

export const isAttachmentName = (name: string): boolean => NAME.test(name)

/** `attachment:<name>` → `<name>`, or null for any other URL. */
export function attachmentName(src: string | null | undefined): string | null {
  if (!src?.startsWith(ATTACHMENT_PREFIX)) return null
  const name = src.slice(ATTACHMENT_PREFIX.length)
  return isAttachmentName(name) ? name : null
}

export function referencedAttachments(text: string): string[] {
  return [...new Set([...text.matchAll(REFERENCE)].map((match) => match[1]))]
}

/** The format from the content (magic bytes), never from a file name or MIME type. */
export function sniffImage(bytes: Uint8Array): ImageExtension | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (starts(0xff, 0xd8, 0xff)) return 'jpg'
  if (starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
  return null
}

export const MIME: Record<ImageExtension, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

/** Rejects what the store would reject, before sending megabytes across. */
export function checkImage(bytes: Uint8Array): ImageExtension {
  if (!bytes.length) throw new Error('La imagen está vacía')
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`La imagen supera el límite de ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
  const extension = sniffImage(bytes)
  if (!extension) throw new Error('Formato de imagen no admitido (usa PNG, JPEG, GIF o WebP)')
  return extension
}

/** Pixel size read from the header (Word needs it to lay the image out). */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kind = sniffImage(bytes)
  try {
    if (kind === 'png') return { width: view.getUint32(16), height: view.getUint32(20) }
    if (kind === 'gif') return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
    if (kind === 'webp') {
      const chunk = String.fromCharCode(...bytes.slice(12, 16))
      if (chunk === 'VP8X') return { width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(27, true) & 0xffffff) }
      if (chunk === 'VP8L') {
        const bits = view.getUint32(21, true)
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
      }
      if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
      return null
    }
    if (kind === 'jpg') {
      let offset = 2
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null
        const marker = bytes[offset + 1]
        const length = view.getUint16(offset + 2)
        // Start-of-frame markers (baseline, progressive, …) carry the dimensions.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
        }
        offset += 2 + length
      }
    }
  } catch { /* Truncated header. */ }
  return null
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Default description for an inserted image: the file name without extension. */
export function altFromFileName(name: string | undefined): string {
  return (name ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 120)
}
