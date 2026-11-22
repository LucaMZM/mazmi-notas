import { describe, expect, it } from 'vitest'
import { crc32, inflateRawSync } from 'node:zlib'
import { noteToDocx } from '../../src/utils/docx'
import { markdownToRichJson } from '../../src/utils/content'

/** Reads a ZIP through its central directory, the way Word does, and checks every CRC. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  const count = view.getUint16(end + 10, true)
  let pointer = view.getUint32(end + 16, true)
  const files = new Map<string, string>()
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(pointer, true)).toBe(0x02014b50)
    const method = view.getUint16(pointer + 10, true)
    const size = view.getUint32(pointer + 20, true)
    const nameLength = view.getUint16(pointer + 28, true)
    const local = view.getUint32(pointer + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength))
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const raw = bytes.subarray(start, start + size)
    expect(crc32(method === 0 ? raw : inflateRawSync(raw))).toBe(view.getUint32(pointer + 16, true))
    files.set(name, new TextDecoder().decode(method === 0 ? raw : inflateRawSync(raw)))
    pointer += 46 + nameLength
  }
  return files
}

describe('Word export', () => {
  it('builds a valid OOXML package with formatting, lists, tasks and links', () => {
    const markdown = '# Plan & ideas\n\nTexto **negrita** y <u>subrayado</u> con [enlace](https://example.test/?a=1&b=2).\n\n1. uno\n2. dos\n\n- [x] hecha\n\n> cita\n\n```\nlínea 1\nlínea 2\n```'
    const rich = JSON.parse(markdownToRichJson(markdown))
    rich.content[1].attrs = { sdAlign: 'center' }
    rich.content[1].content[0].marks = [{ type: 'sdColor', attrs: { token: 'sd-color-1' } }]
    const files = unzip(noteToDocx('Informe <final>', JSON.stringify(rich), markdown))

    expect([...files.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']))
    const document = files.get('word/document.xml')!
    expect(document).toContain('Informe &lt;final&gt;')
    expect(document).toContain('<w:pStyle w:val="Heading1"/>')
    expect(document).toContain('<w:b/>')
    expect(document).toContain('<w:u w:val="single"/>')
    expect(document).toContain('<w:color w:val="9B2C2C"/>')
    expect(document).toContain('<w:jc w:val="center"/>')
    expect(document).toContain('☑')
    expect(document).toContain('<w:pStyle w:val="Quote"/>')
    expect(document).toContain('línea 1</w:t><w:br/><w:t xml:space="preserve">línea 2')
    expect(document).toContain('<w:numId w:val="1"/>')
    expect(files.get('word/_rels/document.xml.rels')).toContain('Target="https://example.test/?a=1&amp;b=2" TargetMode="External"')
    expect(files.get('word/numbering.xml')).toContain('<w:numFmt w:val="decimal"/>')
  })

  it('keeps unsupported Markdown readable, one paragraph per line, without control characters', () => {
    const files = unzip(noteToDocx('Tabla', '', '| A | B |\n|---|---|\n| 1 | 2\u0007 |'))
    const document = files.get('word/document.xml')!
    expect(document.match(/<w:p>/g)?.length).toBe(4)
    expect(document).not.toContain('\u0007')
  })
})

describe('Word export with images', () => {
  // 1×1 PNG.
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
  const name = 'cd'.repeat(32) + '.png'
  const webp = 'ef'.repeat(32) + '.webp'

  it('embeds stored images scaled to the text column and describes the rest', () => {
    const markdown = `![Plano](attachment:${name})\n\n![Grande](attachment:${name})\n\n![Moderna](attachment:${webp})`
    const images = new Map([[name, { bytes: png, extension: 'png' as const, width: 4000, height: 2000 }],
      [webp, { bytes: new Uint8Array([1]), extension: 'webp' as const, width: 10, height: 10 }]])
    const files = unzip(noteToDocx('Con imágenes', markdownToRichJson(markdown), markdown, images))
    expect(files.has('word/media/image1.png')).toBe(true)
    expect([...files.keys()].filter((key) => key.startsWith('word/media/'))).toHaveLength(1)
    expect(files.get('[Content_Types].xml')).toContain('<Default Extension="png" ContentType="image/png"/>')
    expect(files.get('word/_rels/document.xml.rels')).toContain('Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"')
    const document = files.get('word/document.xml')!
    expect(document.match(/<w:drawing>/g)).toHaveLength(2)
    expect(document).toContain('descr="Plano"')
    // 4000 px would overflow A4: scaled to the 9070-twip column, aspect ratio kept.
    expect(document).toContain(`cx="${9070 * 635}" cy="${9070 * 635 / 2}"`)
    expect(document).toContain('[Imagen: Moderna]')
  })
})
