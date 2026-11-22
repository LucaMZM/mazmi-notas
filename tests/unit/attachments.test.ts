import { describe, expect, it } from 'vitest'
import { altFromFileName, attachmentName, checkImage, imageSize, isAttachmentName, referencedAttachments, sha256Hex, sniffImage } from '../../src/utils/attachments'

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
const name = 'ab'.repeat(32) + '.png'

describe('attachments', () => {
  it('validates names and references', () => {
    expect(isAttachmentName(name)).toBe(true)
    for (const bad of ['../notes.db', 'ab.png', 'AB'.repeat(32) + '.png', 'ab'.repeat(32) + '.svg']) expect(isAttachmentName(bad)).toBe(false)
    expect(attachmentName('attachment:' + name)).toBe(name)
    expect(attachmentName('https://example.com/' + name)).toBeNull()
    expect(referencedAttachments(`![a](attachment:${name}) ![b](attachment:${name}) ![c](attachment:x.png)`)).toEqual([name])
  })

  it('detects formats by content and refuses the rest', () => {
    expect(sniffImage(png)).toBe('png')
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(sniffImage(new TextEncoder().encode('GIF89a......'))).toBe('gif')
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(() => checkImage(new TextEncoder().encode('<svg onload="alert(1)"/>'))).toThrow(/no admitido/)
    expect(() => checkImage(new Uint8Array())).toThrow(/vacía/)
    expect(() => checkImage(new Uint8Array(20 * 1024 * 1024 + 1).fill(0x89))).toThrow(/límite/)
  })

  it('reads pixel sizes from headers', () => {
    expect(imageSize(png)).toEqual({ width: 1, height: 1 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02])
    expect(imageSize(gif)).toEqual({ width: 800, height: 600 })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03])
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 480 })
    expect(imageSize(new Uint8Array([0x89, 0x50]))).toBeNull()
  })

  it('names content like the desktop store and suggests a description', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(altFromFileName('plano_oficina-2026.PNG')).toBe('plano oficina 2026')
  })
})
