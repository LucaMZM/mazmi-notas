import { canEditRich, resolveEditorRichJson } from './content'
import { zipStore } from './zip'
import { attachmentName } from './attachments'

/** An image the note references, read before building the document. */
export interface DocxImage { bytes: Uint8Array; extension: 'png' | 'jpg' | 'gif' | 'webp'; width: number; height: number }
/** Word's text column (A4 minus margins) in EMU; wider images are scaled down. */
const MAX_IMAGE_EMU = (11906 - 2 * 1418) * 635
const EMU_PER_PX = 9525
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif' }

/**
 * Word (.docx) export from the note's Rich document, so formatting that Markdown cannot carry
 * (colour, highlight, size, alignment) survives too. Notes the editor cannot represent
 * (tables, external images, raw HTML) are exported as their Markdown text, one paragraph per line.
 * Stored images are embedded, scaled to the text column.
 */
interface Mark { type: string; attrs?: Record<string, unknown> }
interface Node { type: string; text?: string; attrs?: Record<string, unknown>; marks?: Mark[]; content?: Node[] }

const COLORS: Record<string, string> = {
  'sd-color-1': '9B2C2C', 'sd-color-2': 'AD4A17', 'sd-color-3': '0F5F6E',
  'sd-color-4': '17706B', 'sd-color-5': '253A5E', 'sd-color-6': '2F7353',
}
const HIGHLIGHTS: Record<string, string> = { 'sd-hl-1': 'FBE7A1', 'sd-hl-2': 'D6EFC6', 'sd-hl-3': 'F9D9BD', 'sd-hl-4': 'CFE4F6' }
const SIZES: Record<string, number> = { 'sd-size-s': 19, 'sd-size-m': 22, 'sd-size-l': 26, 'sd-size-xl': 30 }
const ALIGN: Record<string, string> = { center: 'center', right: 'right', justify: 'both' }

const escapeXml = (value: string) => value.replace(/[<>&"']/g, (char) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!)
  // Control characters (other than tab and line breaks) are invalid in XML 1.0.
  .split('').filter((char) => char >= ' ' || char === '\t' || char === '\n' || char === '\r').join('')

class Writer {
  body: string[] = []
  links: string[] = []
  lists: { kind: 'bullet' | 'ordered'; start: number }[] = []
  media: { name: string; part: string; bytes: Uint8Array }[] = []
  images: Map<string, DocxImage>
  constructor(images: Map<string, DocxImage> = new Map()) { this.images = images }

  drawing(src: unknown, alt: string): string | null {
    const name = attachmentName(typeof src === 'string' ? src : null)
    const image = name ? this.images.get(name) : undefined
    // WebP only opens in recent Word versions: it is exported as its description instead.
    if (!name || !image || !IMAGE_TYPES[image.extension] || !image.width || !image.height) return null
    let entry = this.media.find((item) => item.name === name)
    if (!entry) { entry = { name, part: `media/image${this.media.length + 1}.${image.extension}`, bytes: image.bytes }; this.media.push(entry) }
    const rid = `rIdImg${this.media.indexOf(entry) + 1}`
    const id = this.media.length * 1000 + this.body.length + 1
    const scale = Math.min(1, MAX_IMAGE_EMU / (image.width * EMU_PER_PX))
    const cx = Math.round(image.width * EMU_PER_PX * scale)
    const cy = Math.round(image.height * EMU_PER_PX * scale)
    const description = escapeXml(alt)
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Imagen ${id}" descr="${description}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A}" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}"><pic:nvPicPr><pic:cNvPr id="${id}" name="${entry.part.slice(6)}" descr="${description}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  }

  run(text: string, marks: Mark[] = []): string {
    const props: string[] = []
    const has = (type: string) => marks.find((mark) => mark.type === type)
    if (has('bold')) props.push('<w:b/>')
    if (has('italic')) props.push('<w:i/>')
    if (has('strike')) props.push('<w:strike/>')
    if (has('underline') || has('link')) props.push('<w:u w:val="single"/>')
    if (has('code')) props.push('<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Menlo"/><w:shd w:val="clear" w:color="auto" w:fill="EEF0F2"/>')
    const color = COLORS[String(has('sdColor')?.attrs?.token ?? '')] ?? (has('link') ? '3F3F46' : '')
    if (color) props.push(`<w:color w:val="${color}"/>`)
    const highlight = HIGHLIGHTS[String(has('sdHighlight')?.attrs?.token ?? '')]
    if (highlight && !has('code')) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${highlight}"/>`)
    const size = SIZES[String(has('sdSize')?.attrs?.token ?? '')]
    if (size) props.push(`<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`)
    const pieces = text.split('\n').map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`).join('<w:br/>')
    const xml = `<w:r>${props.length ? `<w:rPr>${props.join('')}</w:rPr>` : ''}${pieces}</w:r>`
    const link = has('link')
    if (!link?.attrs?.href) return xml
    this.links.push(String(link.attrs.href))
    return `<w:hyperlink r:id="rIdLink${this.links.length}">${xml}</w:hyperlink>`
  }

  inline(nodes: Node[] = []): string {
    return nodes.map((node) => node.type === 'hardBreak' ? '<w:r><w:br/></w:r>'
      : node.type === 'text' ? this.run(node.text ?? '', node.marks) : '').join('')
  }

  paragraph(runs: string, style?: string, extra = '', align?: unknown) {
    const props = [style ? `<w:pStyle w:val="${style}"/>` : '', extra,
      typeof align === 'string' && ALIGN[align] ? `<w:jc w:val="${ALIGN[align]}"/>` : ''].join('')
    this.body.push(`<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${runs}</w:p>`)
  }

  block(node: Node, context: { quote?: boolean; list?: number; level?: number } = {}) {
    const quoteStyle = context.quote ? 'Quote' : undefined
    const listProps = context.list !== undefined ? `<w:numPr><w:ilvl w:val="${context.level ?? 0}"/><w:numId w:val="${context.list}"/></w:numPr>` : ''
    switch (node.type) {
      case 'paragraph':
        this.paragraph(this.inline(node.content), context.list !== undefined ? 'ListParagraph' : quoteStyle, listProps, node.attrs?.sdAlign)
        return
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1))
        this.paragraph(this.inline(node.content), `Heading${level}`, '', node.attrs?.sdAlign)
        return
      }
      case 'blockquote': (node.content ?? []).forEach((child) => this.block(child, { ...context, quote: true })); return
      case 'codeBlock':
        this.paragraph(this.run((node.content ?? []).map((child) => child.text ?? '').join('')), 'Code')
        return
      case 'image': {
        const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : ''
        const drawing = this.drawing(node.attrs?.src, alt)
        this.paragraph(drawing ?? this.run(`[Imagen${alt ? ': ' + alt : ''}]`, [{ type: 'italic' }]), quoteStyle)
        return
      }
      case 'horizontalRule':
        this.paragraph('', undefined, '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D4D4D8"/></w:pBdr>')
        return
      case 'bulletList':
      case 'orderedList': {
        this.lists.push({ kind: node.type === 'orderedList' ? 'ordered' : 'bullet', start: Number(node.attrs?.start ?? 1) })
        const id = this.lists.length
        const level = context.list === undefined ? 0 : Math.min(8, (context.level ?? 0) + 1)
        for (const item of node.content ?? []) {
          ;(item.content ?? []).forEach((child, index) => {
            if (child.type === 'paragraph' && index === 0) this.block(child, { ...context, list: id, level })
            else this.block(child, { ...context, list: child.type.endsWith('List') ? id : undefined, level })
          })
        }
        return
      }
      case 'taskList':
        for (const item of node.content ?? []) {
          const [first, ...rest] = item.content ?? []
          const box = this.run(item.attrs?.checked ? '☑  ' : '☐  ')
          this.paragraph(box + this.inline(first?.content), quoteStyle ?? 'ListParagraph', '<w:ind w:left="360"/>')
          rest.forEach((child) => this.block(child, context))
        }
        return
      default: (node.content ?? []).forEach((child) => this.block(child, context))
    }
  }
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'

function styles(): string {
  const heading = (level: number, size: number) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 360 : 280}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="18181B"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Helvetica Neue" w:hAnsi="Helvetica Neue" w:cs="Arial" w:eastAsia="Helvetica Neue"/><w:color w:val="27272A"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-ES"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="18181B"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>
${heading(1, 34)}${heading(2, 28)}${heading(3, 24)}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D4D4D8"/></w:pBdr><w:ind w:left="240"/></w:pPr><w:rPr><w:color w:val="52525B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/><w:spacing w:line="260" w:lineRule="auto"/><w:ind w:left="120" w:right="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Menlo"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>
</w:styles>`
}

function numbering(lists: { kind: 'bullet' | 'ordered'; start: number }[]): string {
  const level = (kind: 'bullet' | 'ordered', index: number) => {
    const bullets = ['•', '◦', '▪']
    const format = kind === 'bullet' ? `<w:numFmt w:val="bullet"/><w:lvlText w:val="${bullets[index % 3]}"/>`
      : `<w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][index % 3]}"/><w:lvlText w:val="%${index + 1}."/>`
    return `<w:lvl w:ilvl="${index}"><w:start w:val="1"/>${format}<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + index * 360}" w:hanging="360"/></w:pPr></w:lvl>`
  }
  const abstract = (id: number, kind: 'bullet' | 'ordered') =>
    `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, index) => level(kind, index)).join('')}</w:abstractNum>`
  // Each list gets its own instance so numbered lists restart and honour their start value.
  const nums = lists.map((list, index) => `<w:num w:numId="${index + 1}"><w:abstractNumId w:val="${list.kind === 'bullet' ? 0 : 1}"/>${
    list.kind === 'ordered' ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${list.start}"/></w:lvlOverride>` : ''}</w:num>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${W}>${abstract(0, 'bullet')}${abstract(1, 'ordered')}${nums}</w:numbering>`
}

export function noteToDocx(title: string, contentRichJson: string, contentMd: string, images: Map<string, DocxImage> = new Map()): Uint8Array {
  const writer = new Writer(images)
  if (title.trim()) writer.paragraph(writer.run(title.trim()), 'Title')
  if (canEditRich(contentMd)) {
    const doc = JSON.parse(resolveEditorRichJson(contentRichJson, contentMd)) as Node
    for (const node of doc.content ?? []) writer.block(node)
  } else {
    // Tables, images or raw HTML: keep the Markdown text readable, one paragraph per line.
    for (const line of contentMd.split(/\r?\n/)) writer.paragraph(writer.run(line))
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${writer.body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const linkRels = writer.links.map((href, index) =>
    `<Relationship Id="rIdLink${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(href)}" TargetMode="External"/>`).join('')
    + writer.media.map((item, index) =>
      `<Relationship Id="rIdImg${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${item.part}"/>`).join('')
  const mediaTypes = [...new Set(writer.media.map((item) => item.part.split('.').pop()!))]
    .map((extension) => `<Default Extension="${extension}" ContentType="${IMAGE_TYPES[extension]}"/>`).join('')

  return zipStore([
    { name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${mediaTypes}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>` },
    { name: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${linkRels}</Relationships>` },
    { name: 'word/document.xml', content: document },
    { name: 'word/styles.xml', content: styles() },
    { name: 'word/numbering.xml', content: numbering(writer.lists) },
    ...writer.media.map((item) => ({ name: `word/${item.part}`, content: item.bytes })),
  ])
}
