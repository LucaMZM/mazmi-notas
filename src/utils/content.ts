import type { Definition, Nodes, Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { attachmentName } from './attachments'

interface RichMark {
  type: string
  attrs?: Record<string, unknown>
}

interface RichNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: RichMark[]
  content?: RichNode[]
}

interface RichDoc {
  type: 'doc'
  content: RichNode[]
}

const parser = unified().use(remarkParse).use(remarkGfm)

/**
 * Opening a note checks, converts and indexes the same Markdown; parse it once. The trees are
 * only read, never mutated, so a tiny cache of the most recent sources is safe.
 */
const parsed = new Map<string, Root>()
function parse(markdown: string): Root {
  const cached = parsed.get(markdown)
  if (cached) return cached
  const root = parser.parse(markdown)
  parsed.set(markdown, root)
  if (parsed.size > 6) parsed.delete(parsed.keys().next().value as string)
  return root
}
const supportedNodes = new Set([
  'root', 'paragraph', 'heading', 'text', 'strong', 'emphasis', 'delete', 'inlineCode',
  'link', 'linkReference', 'definition', 'break', 'blockquote', 'list', 'listItem', 'code', 'thematicBreak', 'html',
])
const serializedMarks = new Set(['link', 'bold', 'italic', 'strike', 'underline', 'code'])
/** Visual-only marks and attributes live in Rich JSON; Markdown stays portable without them. */
const visualTokenMarks = new Set(['sdColor', 'sdHighlight', 'sdSize'])
const visualAttributes = new Set(['sdAlign'])
const knownRichNodes = new Set([
  'doc', 'paragraph', 'heading', 'text', 'blockquote', 'bulletList', 'orderedList', 'listItem',
  'taskList', 'taskItem', 'codeBlock', 'hardBreak', 'horizontalRule', 'image',
])
const phrasingParents = new Set(['paragraph', 'heading', 'strong', 'emphasis', 'delete', 'link', 'linkReference'])
const UNDERLINE_OPEN = '<u>'
const UNDERLINE_CLOSE = '</u>'
const attributeDefaults: Record<string, Record<string, unknown>> = {
  heading: { level: 1 },
  orderedList: { start: 1, type: null },
  codeBlock: { language: null },
  taskItem: { checked: false },
  link: { href: null, title: null, target: '_blank', rel: 'noopener noreferrer nofollow', class: null },
  image: { alt: null, title: null },
}

/**
 * A managed image on its own line (`![alt](attachment:<name>)`) is an image block. Images
 * anywhere else, or pointing at any other URL, keep the note in Markdown, where they are preserved.
 */
function blockImage(node: Nodes): (Nodes & { type: 'image' }) | null {
  if (node.type !== 'paragraph' || node.children.length !== 1) return null
  const [child] = node.children
  return child.type === 'image' && attachmentName(child.url) ? child : null
}

function hasYamlFrontmatter(markdown: string): boolean {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
  return /^---[ \t]*$/.test(lines[0] ?? '') && lines.slice(1).some((line) => /^(---|\.\.\.)[ \t]*$/.test(line))
}

function definitionsFor(root: Root): Map<string, Definition> {
  const definitions = new Map<string, Definition>()
  function visit(node: Nodes): void {
    if (node.type === 'definition' && !definitions.has(node.identifier.toUpperCase())) {
      definitions.set(node.identifier.toUpperCase(), node)
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(root)
  return definitions
}

function isUnderlineTag(node: Nodes): boolean {
  return node.type === 'html' && (node.value === UNDERLINE_OPEN || node.value === UNDERLINE_CLOSE)
}

/** Only balanced, attribute-free `<u>` pairs are accepted; any other raw HTML keeps the note in Markdown. */
function hasBalancedUnderline(children: Nodes[]): boolean {
  let depth = 0
  for (const child of children) {
    if (child.type !== 'html') continue
    depth += child.value === UNDERLINE_OPEN ? 1 : -1
    if (depth < 0) return false
  }
  return depth === 0
}

/** Task lists are representable only when every item is a task and the list is unordered. */
function isTaskListShape(node: Nodes): boolean | null {
  if (node.type !== 'list') return null
  const checks = node.children.map((item) => item.checked != null)
  if (checks.every((value) => !value)) return null
  return !node.ordered && checks.every(Boolean)
}

function isRepresentable(node: Nodes, definitions: Map<string, Definition>, marked = false, parent = 'root'): boolean {
  if (blockImage(node)) return parent === 'root' || parent === 'blockquote'
  if (!supportedNodes.has(node.type)) return false
  if (node.type === 'html') return isUnderlineTag(node)
  if (isTaskListShape(node) === false) return false
  if (node.type === 'code' && node.meta) return false
  // StarterKit's inline code mark excludes every other mark, including links.
  if (node.type === 'inlineCode' && marked) return false
  if (node.type === 'linkReference' && !definitions.has(node.identifier.toUpperCase())) return false
  if (!('children' in node)) return true
  const children = node.children as Nodes[]
  if (children.some((child) => child.type === 'html')) {
    if (!phrasingParents.has(node.type) || !hasBalancedUnderline(children)) return false
  }
  // Underline counts as an enclosing mark, so code inside `<u>` is rejected like code inside `**`.
  let underline = 0
  return children.every((child) => {
    if (isUnderlineTag(child)) {
      underline += (child as { value: string }).value === UNDERLINE_OPEN ? 1 : -1
      return true
    }
    const nextMarked = marked || underline > 0 || ['strong', 'emphasis', 'delete', 'link', 'linkReference'].includes(node.type)
    return isRepresentable(child, definitions, nextMarked, node.type)
  })
}

/** Semantic compatibility with the default StarterKit, not a source-format round trip or sanitizer. */
export function canEditRich(markdown: string): boolean {
  if (hasYamlFrontmatter(markdown)) return false
  const root = parse(markdown)
  return isRepresentable(root, definitionsFor(root))
}

function textNode(text: string, marks: RichMark[] = []): RichNode[] {
  return text ? [{ type: 'text', text, ...(marks.length ? { marks } : {}) }] : []
}

function toRich(node: Nodes, definitions: Map<string, Definition>, marks: RichMark[] = []): RichNode[] {
  const children = (nextMarks = marks): RichNode[] => {
    if (!('children' in node)) return []
    let underline = 0
    return (node.children as Nodes[]).flatMap((child) => {
      if (isUnderlineTag(child)) {
        underline += (child as { value: string }).value === UNDERLINE_OPEN ? 1 : -1
        return []
      }
      const childMarks = underline > 0 && !nextMarks.some((mark) => mark.type === 'underline')
        ? [...nextMarks, { type: 'underline' }] : nextMarks
      return toRich(child, definitions, childMarks)
    })
  }

  switch (node.type) {
    case 'root': return children()
    case 'text': return textNode(node.value, marks)
    case 'strong': return children([...marks, { type: 'bold' }])
    case 'emphasis': return children([...marks, { type: 'italic' }])
    case 'delete': return children([...marks, { type: 'strike' }])
    case 'inlineCode': return textNode(node.value, [...marks, { type: 'code' }])
    case 'link':
    case 'linkReference': {
      const link = node.type === 'link' ? node : definitions.get(node.identifier.toUpperCase())
      if (!link) return children()
      return children([...marks, {
        type: 'link', attrs: { href: link.url, ...(link.title != null ? { title: link.title } : {}) },
      }])
    }
    case 'paragraph': {
      const image = blockImage(node)
      if (image) return [{ type: 'image', attrs: { src: image.url, alt: image.alt || null, ...(image.title ? { title: image.title } : {}) } }]
      return [{ type: 'paragraph', content: children() }]
    }
    case 'heading': return [{ type: 'heading', attrs: { level: node.depth }, content: children() }]
    case 'blockquote': return [{ type: 'blockquote', content: children() }]
    case 'list': {
      if (isTaskListShape(node)) return [{ type: 'taskList', content: children() }]
      return [{
        type: node.ordered ? 'orderedList' : 'bulletList',
        ...(node.ordered ? { attrs: { start: node.start ?? 1 } } : {}), content: children(),
      }]
    }
    case 'listItem': {
      const content = children()
      if (content[0]?.type !== 'paragraph') content.unshift({ type: 'paragraph', content: [] })
      if (node.checked != null) {
        // The placeholder written for an empty task (`- [ ] &#32;`) reads back as an empty paragraph.
        const first = content[0]
        if (first.content?.length === 1 && first.content[0].type === 'text' && !first.content[0].text?.trim()) first.content = []
        return [{ type: 'taskItem', attrs: { checked: node.checked }, content }]
      }
      return [{ type: 'listItem', content }]
    }
    case 'code': return [{ type: 'codeBlock', attrs: { language: node.lang ?? null }, content: textNode(node.value) }]
    case 'break': return [{ type: 'hardBreak' }]
    case 'thematicBreak': return [{ type: 'horizontalRule' }]
    default: return []
  }
}

/** Derives an editor document; callers must retain the original Markdown as the canonical source. */
export function markdownToRichJson(markdown: string): string {
  if (hasYamlFrontmatter(markdown)) return createParagraphDoc(markdown)
  const root = parse(markdown)
  const definitions = definitionsFor(root)
  // Unsupported content stays literal instead of silently dropping nodes during migration.
  if (!isRepresentable(root, definitions)) return createParagraphDoc(markdown)
  const content = toRich(root, definitions)
  return JSON.stringify({ type: 'doc', content: content.length ? content : [{ type: 'paragraph', content: [] }] })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRichNode(value: unknown): value is RichNode {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'text' && (typeof value.text !== 'string' || !value.text.length)) return false
  if (value.attrs !== undefined && !isRecord(value.attrs)) return false
  if (value.marks !== undefined && (!Array.isArray(value.marks) || !value.marks.every((mark) =>
    isRecord(mark) && typeof mark.type === 'string' && (mark.attrs === undefined || isRecord(mark.attrs)),
  ))) return false
  return value.content === undefined || (Array.isArray(value.content) && value.content.every(isRichNode))
}

function readRichDoc(input: string): RichDoc | null {
  try {
    const parsed: unknown = JSON.parse(input)
    if (isRichNode(parsed) && parsed.type === 'doc' && Array.isArray(parsed.content)) return parsed as RichDoc
  } catch { /* Invalid legacy JSON is recovered by normalizeRichJson. */ }
  return null
}

export function createParagraphDoc(text = ''): string {
  return JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: textNode(text) }] })
}

export function normalizeRichJson(input: string, fallbackMarkdown?: string): string {
  const parsed = readRichDoc(input)
  const empty = !parsed || parsed.content.every((node) => node.type === 'paragraph' && !node.content?.length)
  if (empty && fallbackMarkdown !== undefined) return markdownToRichJson(fallbackMarkdown)
  return parsed && parsed.content.length ? input : createParagraphDoc('')
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function semanticAttrs(type: string, attrs: Record<string, unknown> = {}): Record<string, unknown> {
  const defaults = attributeDefaults[type] ?? {}
  return Object.fromEntries(Object.keys(attrs).sort()
    .filter((key) => !visualAttributes.has(key))
    .filter((key) => !(key in defaults) || attrs[key] !== defaults[key])
    .map((key) => [key, stableValue(attrs[key])]))
}

function semanticNode(node: RichNode): RichNode {
  const marks = (node.marks ?? []).filter((mark) => !visualTokenMarks.has(mark.type))
    .map((mark) => ({ type: mark.type, attrs: semanticAttrs(mark.type, mark.attrs) }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const content: RichNode[] = []
  for (const child of node.content ?? []) {
    const normalized = semanticNode(child)
    const previous = content.at(-1)
    // Token boundaries and editor text fragmentation must not make faithful Rich look stale.
    if (previous?.type === 'text' && normalized.type === 'text'
      && JSON.stringify({ ...previous, text: undefined }) === JSON.stringify({ ...normalized, text: undefined })) {
      previous.text = (previous.text ?? '') + (normalized.text ?? '')
    } else {
      content.push(normalized)
    }
  }
  return { type: node.type, attrs: semanticAttrs(node.type, node.attrs), marks, content, ...(node.text !== undefined ? { text: node.text } : {}) }
}

/** Markdown is authoritative; retain original Rich bytes/tokens only when its semantics still match. */
function usesKnownNodes(node: RichNode): boolean {
  if (node.type === 'image') return !!attachmentName(typeof node.attrs?.src === 'string' ? node.attrs.src : null)
  return knownRichNodes.has(node.type) && (node.content ?? []).every(usesKnownNodes)
}

export function resolveEditorRichJson(rich: string, markdown: string): string {
  const candidate = markdownToRichJson(markdown)
  if (!canEditRich(markdown)) return candidate
  const originalDoc = readRichDoc(rich)
  // Markdown generated from this exact Rich document: keep it verbatim, including empty
  // paragraphs, edge whitespace and visual tokens that a Markdown reparse cannot express.
  if (originalDoc && usesKnownNodes(originalDoc) && richJsonToMarkdown(rich) === markdown) return rich
  const candidateDoc = readRichDoc(candidate)
  return originalDoc && candidateDoc
    && JSON.stringify(semanticNode(originalDoc)) === JSON.stringify(semanticNode(candidateDoc)) ? rich : candidate
}

function richPlain(node: RichNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'image') return typeof node.attrs?.alt === 'string' ? node.attrs.alt : ''
  const separator = ['doc', 'blockquote'].includes(node.type) ? '\n\n'
    : ['bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem'].includes(node.type) ? '\n' : ''
  return (node.content ?? []).map(richPlain).join(separator)
}

export function richJsonToPlain(input: string): string {
  const parsed = readRichDoc(input)
  return parsed ? richPlain(parsed) : ''
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u

/**
 * Escapes only what CommonMark/GFM could reinterpret inline. Block markers that matter
 * solely at the start of a line are handled by `escapeLineStarts`, so prose such as
 * "Hola (nota) - 3.5" stays readable in exports instead of becoming "Hola \(nota\) \- 3\.5".
 * GFM autolink literals (www., https://, e-mail) are applied to decoded text, so no escape can
 * keep them literal: a typed URL becomes a link when Markdown is reparsed, which is harmless.
 */
function escapeLiteral(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const previous = value[index - 1] ?? ''
    const next = value[index + 1] ?? ''
    if ('\\`*[]<~|'.includes(char)) result += '\\' + char
    // Intraword underscores between letters or digits can never open or close emphasis.
    else if (char === '_') result += WORD_CHARACTER.test(previous) && WORD_CHARACTER.test(next) ? char : '\\_'
    // Character references such as &amp; or &#35; would otherwise be decoded on reparse.
    else if (char === '&' && /^&(#\d+|#x[\da-f]+|[a-z][\da-z]*);/i.test(value.slice(index))) result += '\\&'
    else result += char
  }
  return result
}

function escapeText(text: string): string {
  return text.split(/(\[\[[^\]\n]+\]\])/g).map((part, index) =>
    index % 2 ? `[[${escapeLiteral(part.slice(2, -2))}]]` : escapeLiteral(part),
  ).join('')
}

/** Escapes characters that would start a heading, list, quote, rule, setext underline or indented code. */
function escapeLineStarts(markdown: string): string {
  return markdown.split('\n').map((line) => {
    // Leading whitespace would be stripped (or start indented code); a character reference keeps it.
    if (/^[ \t]/.test(line)) return (line[0] === '\t' ? '&#9;' : '&#32;') + line.slice(1)
    if (/^#{1,6}(?=[ \t]|$)/.test(line) || line.startsWith('>') || /^[-+](?=[ \t]|$)/.test(line)
      || /^(?:=+|-+)[ \t]*$/.test(line) || /^(?:-[ \t]*){3,}$/.test(line)) return '\\' + line
    const ordered = line.match(/^(\d{1,9})([.)])(?=[ \t]|$)/)
    if (ordered) return ordered[1] + '\\' + line.slice(ordered[1].length)
    return line
  }).join('\n')
}

function delimiterFor(text: string, minimum: number, character: '`' | '~' = '`'): string {
  const longest = Math.max(0, ...(text.match(new RegExp(`${character}+`, 'g')) ?? []).map((run) => run.length))
  return character.repeat(Math.max(minimum, longest + 1))
}

function codeSpan(text: string): string {
  const fence = delimiterFor(text, 1)
  const pad = /^`|`$/.test(text) || (/^ .* $/s.test(text) && /[^ ]/.test(text))
  return `${fence}${pad ? ' ' : ''}${text}${pad ? ' ' : ''}${fence}`
}

function wrapMark(value: string, mark: RichMark, ancestors: RichMark[]): string {
  const leading = value.match(/^\s*/)?.[0] ?? ''
  const trailing = value.slice(leading.length).match(/\s*$/)?.[0] ?? ''
  const inner = value.slice(leading.length, value.length - trailing.length)
  if (!inner) return value
  let wrapped = inner
  switch (mark.type) {
    case 'bold': wrapped = `**${inner}**`; break
    case 'italic': {
      const delimiter = ancestors.some((ancestor) => ancestor.type === 'bold') ? '_' : '*'
      wrapped = `${delimiter}${inner}${delimiter}`
      break
    }
    case 'strike': wrapped = `~~${inner}~~`; break
    case 'underline': wrapped = `<u>${inner}</u>`; break
    case 'link': {
      const href = String(mark.attrs?.href ?? '').replace(/[<>\\\s]/g, (char) => encodeURIComponent(char))
      const title = typeof mark.attrs?.title === 'string'
        ? ` "${mark.attrs.title.replace(/([\\"])/g, '\\$1')}"` : ''
      wrapped = `[${inner}](<${href}>${title})`
      break
    }
  }
  return leading + wrapped + trailing
}

function inlineMarkdown(nodes: RichNode[], depth = 0): string {
  let result = ''
  for (let index = 0; index < nodes.length;) {
    const node = nodes[index]
    const marks = (node.marks ?? []).filter((mark) => serializedMarks.has(mark.type))
    const mark = marks[depth]
    if (node.type === 'text' && mark) {
      const group = [node]
      let next = index + 1
      while (next < nodes.length && nodes[next].type === 'text') {
        const nextMarks = (nodes[next].marks ?? []).filter((entry) => serializedMarks.has(entry.type))
        if (JSON.stringify(nextMarks[depth]) !== JSON.stringify(mark)) break
        group.push(nodes[next++])
      }
      result += mark.type === 'code' ? codeSpan(group.map((entry) => entry.text ?? '').join(''))
        : wrapMark(inlineMarkdown(group, depth + 1), mark, marks.slice(0, depth))
      index = next
    } else if (node.type === 'hardBreak') {
      result += '\\\n'
      index += 1
    } else {
      // Escape adjacent unmarked fragments together so context-sensitive rules
      // (intraword underscores, character references) see the same text the parser will.
      let text = node.text ?? ''
      let next = index + 1
      while (next < nodes.length && nodes[next].type === 'text'
        && !(nodes[next].marks ?? []).filter((entry) => serializedMarks.has(entry.type))[depth]) {
        text += nodes[next++].text ?? ''
      }
      result += escapeText(text)
      index = next
    }
  }
  return result
}

function blockMarkdown(node: RichNode): string {
  const content = node.content ?? []
  switch (node.type) {
    case 'text': return inlineMarkdown([node])
    case 'paragraph': return escapeLineStarts(inlineMarkdown(content))
    case 'heading': {
      // ATX headings are one line: a soft line break inside one becomes a space.
      // A trailing run of `#` after a space would be read as the optional closing sequence.
      const text = inlineMarkdown(content.map((child) => child.type === 'hardBreak' ? { type: 'text', text: ' ' } : child)).replace(/\n/g, ' ').replace(/(^|[ \t])(#+)([ \t]*)$/, '$1\\$2$3')
        .replace(/^[ \t]/, (space) => space === '\t' ? '&#9;' : '&#32;')
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${text}`
    }
    case 'horizontalRule': return '---'
    case 'image': {
      const src = String(node.attrs?.src ?? '')
      if (!attachmentName(src)) return ''
      const alt = typeof node.attrs?.alt === 'string' ? escapeLiteral(node.attrs.alt.replace(/\s+/g, ' ').trim()) : ''
      const title = typeof node.attrs?.title === 'string' && node.attrs.title ? ` "${node.attrs.title.replace(/([\\"])/g, '\\$1')}"` : ''
      return `![${alt}](${src}${title})`
    }
    case 'hardBreak': return '\\\n'
    case 'codeBlock': {
      const text = content.map((child) => child.text ?? '').join('')
      const language = String(node.attrs?.language ?? '')
      const fence = delimiterFor(text, 3, language.includes('`') ? '~' : '`')
      return `${fence}${language}\n${text}\n${fence}`
    }
    case 'blockquote': return content.map(blockMarkdown).join('\n\n').split('\n').map((line) => `> ${line}`).join('\n')
    case 'listItem':
    case 'taskItem': {
      const first = content[0]
      // The schema requires a paragraph before block-first items; Markdown does not.
      const blocks = node.type === 'listItem' && content.length > 1 && first?.type === 'paragraph' && !first.content?.length
        ? content.slice(1) : content
      return blocks.map(blockMarkdown).join('\n\n')
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const start = Number(node.attrs?.start ?? 1)
      const loose = content.some((item) => (item.content ?? []).filter((child) => child.type === 'paragraph').length > 1)
      return content.map((item, index) => {
        const prefix = node.type === 'orderedList' ? `${start + index}. ` : '- '
        // GFM task markers belong to the first paragraph; continuation lines indent to the bullet's content column.
        const marker = node.type === 'taskList' ? (item.attrs?.checked ? '[x] ' : '[ ] ') : ''
        return blockMarkdown(item).split('\n').map((line, lineIndex) =>
          // An empty task needs content after its marker or GFM reads `[ ]` as plain text.
          (lineIndex ? ' '.repeat(prefix.length) : prefix + marker) + (!lineIndex && marker && !line ? '&#32;' : line),
        ).join('\n')
      }).join(loose ? '\n\n' : '\n')
    }
    default: return content.map(blockMarkdown).join('\n\n')
  }
}

/** An explicit export of Rich content, never a replacement for untouched canonical Markdown. */
export function richJsonToMarkdown(input: string): string {
  const parsed = readRichDoc(input)
  // Trailing empty paragraphs (e.g. the editor's trailing node) add no content to the export.
  return parsed ? parsed.content.map(blockMarkdown).join('\n\n').replace(/(?:\n\n)+$/, '') : ''
}

function markdownPlain(node: Nodes): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code': return node.value
    case 'html': return isUnderlineTag(node) ? '' : node.value
    case 'image':
    case 'imageReference': return node.alt ?? ''
    case 'break': return '\n'
    case 'definition': return ''
    case 'footnoteReference': return `[^${node.identifier}]`
    default: {
      if (!('children' in node)) return ''
      const separator = ['root', 'blockquote'].includes(node.type) ? '\n\n'
        : ['list', 'listItem', 'table'].includes(node.type) ? '\n' : node.type === 'tableRow' ? '\t' : ''
      return node.children.filter((child) => child.type !== 'definition').map(markdownPlain).join(separator)
    }
  }
}

export function deriveContentPlain(contentRichJson: string, contentMd: string): string {
  return contentMd.trim() ? markdownPlain(parse(contentMd)) : richJsonToPlain(contentRichJson)
}
