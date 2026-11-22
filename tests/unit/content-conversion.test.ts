import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import {
  canEditRich,
  createParagraphDoc,
  deriveContentPlain,
  markdownToRichJson,
  normalizeRichJson,
  resolveEditorRichJson,
  richJsonToMarkdown,
  richJsonToPlain,
} from '../../src/utils/content'
import { createEditorExtensions } from '../../src/editor/extensions'

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const doc = (content: unknown[]) => JSON.stringify({ type: 'doc', content })

describe('rich <-> markdown conversion', () => {
  it('convierte markdown a rich_json válido', () => {
    const rich = markdownToRichJson('# Titulo\n\n- uno\n- dos')
    const parsed = JSON.parse(rich)
    expect(parsed.type).toBe('doc')
    expect(Array.isArray(parsed.content)).toBe(true)
  })

  it('convierte rich_json a plain y markdown', () => {
    const rich = createParagraphDoc('Hola ScribeDock')
    expect(richJsonToPlain(rich)).toContain('Hola ScribeDock')
    expect(richJsonToMarkdown(rich)).toContain('Hola ScribeDock')
  })

  it('normaliza JSON inválido', () => {
    const normalized = normalizeRichJson('{not-valid}')
    const parsed = JSON.parse(normalized)
    expect(parsed.type).toBe('doc')
  })

  it('deriva content_plain desde rich o markdown', () => {
    const rich = createParagraphDoc('Texto canonical')
    expect(deriveContentPlain(rich, '')).toContain('Texto canonical')
    expect(deriveContentPlain('', '# Cabecera markdown')).toContain('Cabecera')
  })
})

describe('Canonical Markdown editor resolution', () => {
  it('rebuilds a flattened legacy heading even when its plain text is identical', () => {
    const legacy = createParagraphDoc('Same title')
    expect(JSON.parse(resolveEditorRichJson(legacy, '# Same title'))).toEqual({
      type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Same title' }] }],
    })
  })

  it('replaces a stale link destination even when its label is unchanged', () => {
    const legacy = doc([{ type: 'paragraph', content: [{ type: 'text', text: 'Guide', marks: [
      { type: 'sdColor', attrs: { token: 'sd-color-2' } },
      { type: 'link', attrs: { href: 'https://old.test' } },
    ] }] }])
    expect(JSON.parse(resolveEditorRichJson(legacy, '[Guide](https://new.test)'))).toEqual({
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Guide', marks: [
        { type: 'link', attrs: { href: 'https://new.test' } },
      ] }] }],
    })
  })

  it.each(['', ' \n\t'])('does not resurrect stale Rich when canonical Markdown is empty: %s', (markdown) => {
    expect(JSON.parse(resolveEditorRichJson(createParagraphDoc('Deleted content'), markdown))).toEqual({
      type: 'doc', content: [{ type: 'paragraph', content: [] }],
    })
  })

  it('preserves the original bytes and tokens across mark ordering and fragmented text', () => {
    const original = JSON.stringify({ type: 'doc', attrs: {}, content: [{
      type: 'heading', attrs: { level: 1 }, content: [
        { type: 'text', text: 'Hello ', marks: [
          { type: 'italic' }, { type: 'sdColor', attrs: { token: 'sd-color-2' } }, { type: 'bold' },
        ] },
        { type: 'text', text: 'world', marks: [
          { type: 'sdHighlight', attrs: { token: 'sd-hl-1' } }, { type: 'bold' },
          { type: 'sdSize', attrs: { token: 'sd-size-l' } }, { type: 'italic' },
        ] },
      ],
    }] }, null, 2)
    expect(resolveEditorRichJson(original, '# **_Hello world_**')).toBe(original)
  })

  it.each([
    ['1. Item', [{ type: 'orderedList', attrs: { type: null, start: 1 }, content: [
      { type: 'listItem', attrs: {}, content: [paragraph('Item')] },
    ] }]],
    ['```\nx\n```', [{ type: 'codeBlock', attrs: {}, content: [{ type: 'text', text: 'x', marks: [] }] }]],
    ['[Guide](https://example.test)', [{ type: 'paragraph', attrs: {}, content: [{ type: 'text', text: 'Guide', marks: [{
      type: 'link', attrs: { title: null, class: null, rel: 'noopener noreferrer nofollow', target: '_blank', href: 'https://example.test' },
    }] }] }]],
  ])('normalizes StarterKit default attributes when comparing: %s', (markdown, content) => {
    const original = doc(content)
    expect(resolveEditorRichJson(original, markdown)).toBe(original)
  })

  it.each([
    ['3. Item', [{ type: 'orderedList', attrs: { start: 2 }, content: [{ type: 'listItem', content: [paragraph('Item')] }] }]],
    ['```js\nx\n```', [{ type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'x' }] }]],
    ['Text', [{ type: 'paragraph', content: [{ type: 'text', text: 'Text', marks: [{ type: 'bold' }] }] }]],
    ['[Guide](https://example.test "New")', [{ type: 'paragraph', content: [{ type: 'text', text: 'Guide', marks: [
      { type: 'link', attrs: { href: 'https://example.test', title: 'Old' } },
    ] }] }]],
  ])('does not ignore meaningful structure, marks or attributes: %s', (markdown, content) => {
    const original = doc(content)
    const resolved = resolveEditorRichJson(original, markdown)
    expect(resolved).not.toBe(original)
    expect(resolved).toBe(markdownToRichJson(markdown))
  })

  it.each(['{broken', '{"type":"doc","content":[null]}'])('recovers malformed legacy Rich: %s', (rich) => {
    expect(JSON.parse(resolveEditorRichJson(rich, 'Recovered'))).toEqual({
      type: 'doc', content: [paragraph('Recovered')],
    })
  })

  it.each(['- [x] Task\n- Plain\n', '| A | B |\n| - | - |\n| x | y |'])('always returns a literal candidate for unsupported Markdown: %s', (markdown) => {
    const original = doc([{ type: 'paragraph', content: [{ type: 'text', text: markdown, marks: [
      { type: 'sdColor', attrs: { token: 'sd-color-2' } },
    ] }] }])
    expect(resolveEditorRichJson(original, markdown)).toBe(createParagraphDoc(markdown))
  })
})

describe('YAML frontmatter safety', () => {
  it.each([
    '---\ntitle: Note\n---\n# Body',
    '---\ntitle: Note\n...\n# Body',
    '\uFEFF---\r\ntags: [a, b]\r\n---\r\nBody',
    '---\n---\nBody',
  ])('blocks frontmatter instead of parsing it as rules and headings: %s', (markdown) => {
    expect(canEditRich(markdown)).toBe(false)
    expect(markdownToRichJson(markdown)).toBe(createParagraphDoc(markdown))
    expect(resolveEditorRichJson(createParagraphDoc('Stale'), markdown)).toBe(createParagraphDoc(markdown))
  })

  it.each(['Before\n\n---\n\nAfter', '---\n\nBody', '```yaml\n---\ntitle: Code\n---\n```'])('does not block ordinary rules or fenced YAML: %s', (markdown) => {
    expect(canEditRich(markdown)).toBe(true)
  })
})

describe('Markdown parser and serializer', () => {
  it('parses heading levels and nested inline marks without exposing syntax', () => {
    expect(JSON.parse(markdownToRichJson('## **Bold and *italic*** with ~~old~~ and `x_y`'))).toEqual({
      type: 'doc',
      content: [{
        type: 'heading', attrs: { level: 2 }, content: [
          { type: 'text', text: 'Bold and ', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'italic', marks: [{ type: 'bold' }, { type: 'italic' }] },
          { type: 'text', text: ' with ' },
          { type: 'text', text: 'old', marks: [{ type: 'strike' }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'x_y', marks: [{ type: 'code' }] },
        ],
      }],
    })
  })

  it('resolves formatted reference links and preserves href and title', () => {
    expect(JSON.parse(markdownToRichJson('[**Guide**][docs]\n\n[docs]: https://example.test/a_(b) "Read me"'))).toEqual({
      type: 'doc', content: [{ type: 'paragraph', content: [{
        type: 'text', text: 'Guide', marks: [
          { type: 'link', attrs: { href: 'https://example.test/a_(b)', title: 'Read me' } },
          { type: 'bold' },
        ],
      }] }],
    })
  })

  it('keeps list siblings together and preserves nested ordered starts', () => {
    expect(JSON.parse(markdownToRichJson('3. First\n   - Child\n\n     7. Deep\n     8. Next\n4. Second'))).toEqual({
      type: 'doc', content: [{ type: 'orderedList', attrs: { start: 3 }, content: [
        { type: 'listItem', content: [paragraph('First'), {
          type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Child'), {
            type: 'orderedList', attrs: { start: 7 }, content: [
              { type: 'listItem', content: [paragraph('Deep')] },
              { type: 'listItem', content: [paragraph('Next')] },
            ],
          }] }],
        }] },
        { type: 'listItem', content: [paragraph('Second')] },
      ] }],
    })
  })

  it('preserves ordered start zero', () => {
    const rich = markdownToRichJson('0. Zero\n1. One')
    expect(JSON.parse(rich).content[0].attrs.start).toBe(0)
    expect(richJsonToMarkdown(rich)).toBe('0. Zero\n1. One')
  })

  it('preserves fenced code language, indentation, blank lines and trailing spaces', () => {
    const markdown = '```typescript\n  const key_name = "a_b";  \n\n\treturn key_name\n\n```'
    const rich = markdownToRichJson(markdown)
    expect(JSON.parse(rich).content).toEqual([{
      type: 'codeBlock', attrs: { language: 'typescript' }, content: [{
        type: 'text', text: '  const key_name = "a_b";  \n\n\treturn key_name\n',
      }],
    }])
    expect(richJsonToMarkdown(rich)).toBe(markdown)
  })

  it('uses a code fence longer than literal fences inside the block', () => {
    const rich = doc([{ type: 'codeBlock', attrs: { language: 'md' }, content: [{
      type: 'text', text: '```js\n  run()\n```',
    }] }])
    expect(richJsonToMarkdown(rich)).toBe('````md\n```js\n  run()\n```\n````')
    expect(JSON.parse(markdownToRichJson(richJsonToMarkdown(rich)))).toEqual(JSON.parse(rich))
  })

  it('parses indented code without trimming its content', () => {
    expect(JSON.parse(markdownToRichJson('    const a_b = 1\n      next()')).content).toEqual([{
      type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'const a_b = 1\n  next()' }],
    }])
  })

  it.each(['First  \nSecond', 'First\\\nSecond'])('maps a hard break to a real line separator: %s', (markdown) => {
    const rich = markdownToRichJson(markdown)
    expect(JSON.parse(rich).content[0].content).toEqual([
      { type: 'text', text: 'First' }, { type: 'hardBreak' }, { type: 'text', text: 'Second' },
    ])
    expect(richJsonToMarkdown(rich)).toBe('First\\\nSecond')
    expect(richJsonToPlain(rich)).toBe('First\nSecond')
  })

  it('serializes heading marks rather than flattening them', () => {
    expect(richJsonToMarkdown(doc([{ type: 'heading', attrs: { level: 3 }, content: [
      { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'old', marks: [{ type: 'strike' }] },
    ] }]))).toBe('### **Bold** and ~~old~~')
  })

  it('escapes literal markup without turning it into formatting on reparse', () => {
    const rich = doc([paragraph('# not a heading *literal* _name_ [label](url) <tag> ![image](x)')])
    expect(richJsonToPlain(markdownToRichJson(richJsonToMarkdown(rich))))
      .toBe('# not a heading *literal* _name_ [label](url) <tag> ![image](x)')
    expect(canEditRich(richJsonToMarkdown(rich))).toBe(true)
  })

  it('preserves inline backticks and significant edge spaces in code spans', () => {
    const rich = doc([{ type: 'paragraph', content: [{ type: 'text', text: ' `value` ', marks: [{ type: 'code' }] }] }])
    expect(richJsonToMarkdown(rich)).toBe('``  `value`  ``')
    expect(JSON.parse(markdownToRichJson(richJsonToMarkdown(rich)))).toEqual(JSON.parse(rich))
  })

  it.each([
    '# Heading **bold and *italic***\n\nText ~~old~~ and `code`.',
    '- First\n  - Nested\n    - Deep\n- Second',
    '3. First\n\n   Second paragraph\n\n   > Quoted **text**\n\n4. Last',
    '> First\n>\n> - Item\n>   - Child\n>\n> Last',
    '[**Bold** and *italic*](https://example.test/a_(b) "A title")',
    'Before\n\n---\n\nAfter',
    '```\n\n  a_b  \n\n```',
    '~~~lang`name\n  literal ``` and ~~~ inside\n~~~',
    'a**bold**b and a*italic*b',
    '***combined*** and **bold** normal *italic*',
    '**first *middle* last**',
    '- > Quoted item\n\n- ```js\n  run()\n  ```',
  ])('round-trips supported block structure and marks: %s', (markdown) => {
    const initial = JSON.parse(markdownToRichJson(markdown))
    expect(JSON.parse(markdownToRichJson(richJsonToMarkdown(JSON.stringify(initial))))).toEqual(initial)
  })

  it('does not turn a literal multiline paragraph into a setext heading', () => {
    const rich = doc([paragraph('literal\n===')])
    expect(JSON.parse(markdownToRichJson(richJsonToMarkdown(rich))))
      .toEqual(JSON.parse(rich))
  })

  it('keeps literal wikilink syntax when exporting unformatted text', () => {
    expect(richJsonToMarkdown(createParagraphDoc('See [[Target note]]'))).toBe('See [[Target note]]')
  })
})

describe('Rich editability guard', () => {
  it.each([
    '| A | B |\n| - | - |\n| x | y |',
    '![alt](./image.png)',
    '[![alt](./image.png)](https://example.test)',
    '![alt][image]\n\n[image]: ./image.png',
    '<div>raw HTML</div>',
    'Text <u class="x">underlined</u>',
    'Text <u>unbalanced',
    'Text </u> stray',
    '<u>\nblock</u>',
    '- [ ] Pending\n- Plain item',
    '1. [ ] Ordered task',
    'Text[^note]\n\n[^note]: Footnote',
    '```js title="not retained"\nrun()\n```',
    '**`code cannot also be bold`**',
    '[`code cannot also be a link`](https://example.test)',
  ])('rejects non-representable Markdown without flattening its source: %s', (markdown) => {
    expect(canEditRich(markdown)).toBe(false)
    expect(richJsonToPlain(markdownToRichJson(markdown))).toBe(markdown)
  })

  it.each([
    '',
    '# **Title**\n\n[[Target note]]',
    '- Item\n  2. Nested',
    'Text ~~old~~ and [link](https://example.test)',
    '```html\n<table><tr></tr></table>\n- [x] code only\n```',
    '`![not an image](x)` and \\<u>literal\\</u>',
    '<https://example.test>',
    'Text <u>underlined</u> and <u>**bold underline**</u>',
    '- [ ] Pending\n- [x] Done',
    '> - [x] Nested task',
  ])('accepts supported syntax and does not confuse code with unsupported nodes: %s', (markdown) => {
    expect(canEditRich(markdown)).toBe(true)
  })

  it.each([
    '# **Title** with *italic* and ~~old~~\n\n`code` and [link](https://example.test)',
    '- > Quote\n\n- ```js\n  run()\n  ```',
    '3. Parent\n   - Child\n\n     7. Deep',
    'Before\\\nAfter\n\n---\n\n```ts\n  a_b()  \n```',
  ])('produces a valid default StarterKit document without duplicate extensions: %s', (markdown) => {
    expect(canEditRich(markdown)).toBe(true)
    const schema = getSchema([StarterKit])
    expect(() => schema.nodeFromJSON(JSON.parse(markdownToRichJson(markdown))).check()).not.toThrow()
  })
})

describe('Plain text and migrated notes', () => {
  it('keeps wikilinks, list item boundaries, paragraph boundaries and code whitespace', () => {
    const markdown = '# Title\n\nBefore [[Target note]]\n\n- One\n- Two\n\n```ts\n  key_name()  \n```'
    expect(richJsonToPlain(markdownToRichJson(markdown)))
      .toBe('Title\n\nBefore [[Target note]]\n\nOne\nTwo\n\n  key_name()  ')
  })

  it('derives plain text from canonical Markdown rather than stale migrated Rich', () => {
    expect(deriveContentPlain(createParagraphDoc('legacy flattened text'), '# Actual\n\n[[Target]] and **bold**'))
      .toBe('Actual\n\n[[Target]] and bold')
  })

  it('extracts link labels and preserves code punctuation in Markdown-only notes', () => {
    expect(deriveContentPlain('', '[Guide](https://example.test)\n\n`a_b - c`\n\n[[Note]]'))
      .toBe('Guide\n\na_b - c\n\n[[Note]]')
  })

  it('keeps table cell and row separators when indexing unsupported Markdown', () => {
    expect(deriveContentPlain('', '| A | B |\n| - | - |\n| one | two |')).toBe('A\tB\none\ttwo')
  })

  it.each(['{broken', '', 'null', '{"type":"doc","content":[]}', createParagraphDoc(''),
    '{"type":"doc","content":[null]}', '{"type":"doc","content":[{"type":"text","text":42}]}',
  ])('recovers invalid or empty migrated Rich from optional Markdown: %s', (legacy) => {
    expect(JSON.parse(normalizeRichJson(legacy, '# Recovered\n\n**Text**'))).toEqual({
      type: 'doc', content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Recovered' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Text', marks: [{ type: 'bold' }] }] },
      ],
    })
  })

  it('does not overwrite existing Rich or its custom marks when a fallback is supplied', () => {
    const rich = doc([{ type: 'paragraph', content: [{
      type: 'text', text: 'Keep', marks: [{ type: 'sdColor', attrs: { token: 'sd-color-2' } }],
    }] }])
    expect(normalizeRichJson(rich, '# Different')).toBe(rich)
  })

  it('preserves legacy underline, links and custom highlights without migrating nonempty Rich', () => {
    const rich = doc([{ type: 'paragraph', content: [{ type: 'text', text: 'Keep original', marks: [
      { type: 'link', attrs: { href: 'https://example.test', target: '_blank' } },
      { type: 'underline' }, { type: 'sdHighlight', attrs: { token: 'sd-hl-2' } },
    ] }] }])
    expect(normalizeRichJson(rich, '# Canonical Markdown')).toBe(rich)
  })

  it('returns the original nonempty Rich JSON bytes so title-only edits do not rewrite it', () => {
    const original = '{\n  "type": "doc", "content": [{"type":"paragraph","content":[{"type":"text","text":"Original"}]}]\n}'
    expect(normalizeRichJson(original, '# Different Markdown')).toBe(original)
  })

  it('retains unsupported Markdown verbatim when recovering an empty migrated note', () => {
    const markdown = '- [x] Task\n\n![alt](./image.png)\n'
    expect(richJsonToPlain(normalizeRichJson('', markdown))).toBe(markdown)
  })

  it('does not mistake a horizontal rule or an empty code block for an empty document', () => {
    const rich = doc([{ type: 'horizontalRule' }, { type: 'codeBlock', attrs: { language: null }, content: [] }])
    expect(normalizeRichJson(rich, '# Fallback')).toBe(rich)
  })
})

describe('Formats added for the writing editor', () => {
  it('maps balanced <u> pairs to the underline mark and back', () => {
    const markdown = 'Texto <u>subrayado</u> y <u>**fuerte**</u>.'
    const rich = JSON.parse(markdownToRichJson(markdown))
    expect(rich.content[0].content).toEqual([
      { type: 'text', text: 'Texto ' },
      { type: 'text', text: 'subrayado', marks: [{ type: 'underline' }] },
      { type: 'text', text: ' y ' },
      { type: 'text', text: 'fuerte', marks: [{ type: 'underline' }, { type: 'bold' }] },
      { type: 'text', text: '.' },
    ])
    expect(JSON.parse(markdownToRichJson(richJsonToMarkdown(JSON.stringify(rich))))).toEqual(rich)
    expect(deriveContentPlain('', markdown)).toBe('Texto subrayado y fuerte.')
  })

  it('round-trips GFM checklists, including nesting and checked state', () => {
    const markdown = '- [ ] Comprar pan\n- [x] Llamar\n  - [ ] Subtarea\n- [ ] Con **negrita**'
    const rich = JSON.parse(markdownToRichJson(markdown))
    expect(rich.content[0].type).toBe('taskList')
    expect(rich.content[0].content.map((item: { attrs: { checked: boolean } }) => item.attrs.checked)).toEqual([false, true, false])
    const exported = richJsonToMarkdown(JSON.stringify(rich))
    expect(exported.startsWith('- [ ] Comprar pan\n- [x] Llamar')).toBe(true)
    expect(JSON.parse(markdownToRichJson(exported))).toEqual(rich)
    expect(richJsonToPlain(JSON.stringify(rich))).toBe('Comprar pan\nLlamar\nSubtarea\nCon negrita')
  })

  it('keeps a checklist with empty items editable after a Markdown round trip', () => {
    const task = (checked: boolean, text?: string) => ({ type: 'taskItem', attrs: { checked },
      content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] })
    const rich = doc([{ type: 'taskList', content: [task(true, 'Hecha'), task(false), task(false, 'Luego')] }])
    const markdown = richJsonToMarkdown(rich)
    expect(markdown).toBe('- [x] Hecha\n- [ ] &#32;\n- [ ] Luego')
    expect(canEditRich(markdown)).toBe(true)
    expect(JSON.parse(markdownToRichJson(markdown))).toEqual(JSON.parse(rich))
    expect(deriveContentPlain('', markdown).trim()).not.toContain('[ ]')
  })

  it('writes a line break inside a heading as a space instead of breaking the heading', () => {
    const rich = doc([{ type: 'heading', attrs: { level: 2 }, content: [
      { type: 'text', text: 'Primera' }, { type: 'hardBreak' }, { type: 'text', text: 'segunda' },
    ] }])
    expect(richJsonToMarkdown(rich)).toBe('## Primera segunda')
    expect(JSON.parse(markdownToRichJson(richJsonToMarkdown(rich))).content).toHaveLength(1)
  })

  it('produces documents valid for the full editor schema', () => {
    const schema = getSchema(createEditorExtensions())
    for (const markdown of ['- [ ] Uno\n  - [x] Dos', 'A <u>b</u>', '# T\n\n> - [x] cita']) {
      expect(() => schema.nodeFromJSON(JSON.parse(markdownToRichJson(markdown))).check()).not.toThrow()
    }
  })

  it('keeps alignment and visual tokens when Markdown was generated from that Rich document', () => {
    const rich = doc([
      { type: 'heading', attrs: { level: 2, sdAlign: 'center' }, content: [{ type: 'text', text: 'Centrado' }] },
      { type: 'paragraph', attrs: { sdAlign: null }, content: [] },
      { type: 'paragraph', attrs: { sdAlign: 'right' }, content: [{ type: 'text', text: 'Color', marks: [{ type: 'sdColor', attrs: { token: 'sd-color-3' } }] }] },
      { type: 'paragraph', content: [] },
    ])
    const markdown = richJsonToMarkdown(rich)
    expect(markdown).toBe('## Centrado\n\n\n\nColor')
    expect(resolveEditorRichJson(rich, markdown)).toBe(rich)
    // A later Markdown-only edit wins over the stale Rich document.
    expect(resolveEditorRichJson(rich, markdown + ' editado')).toBe(markdownToRichJson(markdown + ' editado'))
  })

  it('ignores alignment attributes when comparing legacy Rich semantically', () => {
    const rich = doc([{ type: 'paragraph', attrs: { sdAlign: 'center' }, content: [{ type: 'text', text: 'Hola' }] }])
    expect(resolveEditorRichJson(rich, 'Hola')).toBe(rich)
  })

  it('does not trust Rich documents containing nodes the editor cannot render', () => {
    const rich = doc([{ type: 'image', attrs: { src: 'x' } }])
    expect(resolveEditorRichJson(rich, richJsonToMarkdown(rich))).toBe(markdownToRichJson(''))
  })

  it('exports readable Markdown without needless escapes', () => {
    expect(richJsonToMarkdown(doc([paragraph('Hola (nota) - 3.5 € y snake_case. ¿Qué tal? ¡Bien! a -> b #idea')])))
      .toBe('Hola (nota) - 3.5 € y snake_case. ¿Qué tal? ¡Bien! a -> b #idea')
    expect(richJsonToMarkdown(doc([paragraph('-guion +1 #tag 2025.')]))).toBe('-guion +1 #tag 2025.')
  })

  it.each([
    '# no es título', '- no es lista', '+ tampoco', '1. no numerada', '2) tampoco', '> no es cita', '===', '---', '***',
    'línea\n---', 'línea\n===', 'antes\n- después', 'antes\n1. después', '&amp; y &#35;', 'a | b', 'C# y F#', '*a*', '_a_', '__init__', 'a_b_', '_x', 'snake_case_name',
    '~a~', '~~a~~', '`a`', '<u>x</u>', '<b>x</b>', '[[Nota enlazada]]', '![img](x)', '[a](b)', 'barra \\ invertida', '1.5 euros',
    '    sangría', '\tTab', 'fin con \\', '#etiqueta', '[ ] no es tarea', 'x\n[ ] tampoco',
  ])('literal text survives a Markdown round trip unchanged: %s', (text) => {
    for (const block of [paragraph(text), { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] }]) {
      if (block.type === 'heading' && text.includes('\n')) continue
      const rich = doc([block])
      const markdown = richJsonToMarkdown(rich)
      const reparsed = JSON.parse(markdownToRichJson(markdown))
      const expected = JSON.parse(rich)
      expect(canEditRich(markdown)).toBe(true)
      expect(reparsed.content[0].type).toBe(expected.content[0].type)
      expect(reparsed.content[0].content?.map((node: { text?: string }) => node.text ?? '').join('') ?? '')
        .toBe(expected.content[0].content[0].text)
      expect(reparsed.content[0].content?.every((node: { marks?: unknown[] }) => !node.marks?.length) ?? true).toBe(true)
    }
  })

  it('escapes literal text that would otherwise join a neighbouring mark', () => {
    const rich = doc([{ type: 'paragraph', content: [
      { type: 'text', text: 'snake' }, { type: 'text', text: '_case', marks: [{ type: 'sdColor', attrs: { token: 'sd-color-1' } }] },
      { type: 'text', text: ' y &amp' }, { type: 'text', text: ';' },
    ] }])
    expect(JSON.parse(markdownToRichJson(richJsonToMarkdown(rich))).content[0].content).toEqual([{ type: 'text', text: 'snake_case y &amp;' }])
  })

  it('keeps the exact Rich document even when a typed URL would autolink on reparse', () => {
    const rich = doc([paragraph('Visita www.example.com hoy')])
    const markdown = richJsonToMarkdown(rich)
    expect(markdown).toBe('Visita www.example.com hoy')
    expect(resolveEditorRichJson(rich, markdown)).toBe(rich)
  })
})

describe('Images', () => {
  const name = 'ab'.repeat(32) + '.png'
  const image = (alt: string | null = 'Plano de la oficina') => ({ type: 'image', attrs: { src: 'attachment:' + name, alt } })
  const wrap = (content: unknown[]) => JSON.stringify({ type: 'doc', content })

  it('round-trips a managed image block between Markdown and Rich', () => {
    const markdown = `Antes\n\n![Plano de la oficina](attachment:${name})\n\nDespués`
    expect(canEditRich(markdown)).toBe(true)
    const rich = JSON.parse(markdownToRichJson(markdown))
    expect(rich.content[1]).toEqual(image())
    expect(richJsonToMarkdown(JSON.stringify(rich))).toBe(markdown)
    expect(deriveContentPlain(JSON.stringify(rich), markdown)).toContain('Plano de la oficina')
  })

  it('escapes descriptions and keeps images inside quotes', () => {
    const md = richJsonToMarkdown(wrap([{ type: 'blockquote', content: [image('a [b] *c*')] }]))
    expect(md).toBe(`> ![a \\[b\\] \\*c\\*](attachment:${name})`)
    expect(JSON.parse(markdownToRichJson(md)).content[0].content[0].attrs.alt).toBe('a [b] *c*')
    expect(richJsonToMarkdown(wrap([image(null)]))).toBe(`![](attachment:${name})`)
  })

  it('keeps remote, inline and list images in Markdown', () => {
    expect(canEditRich('![x](https://example.com/a.png)')).toBe(false)
    expect(canEditRich(`Texto ![x](attachment:${name}) en línea`)).toBe(false)
    expect(canEditRich(`- ![x](attachment:${name})`)).toBe(false)
    expect(canEditRich(`![x](attachment:../../notes.db)`)).toBe(false)
  })

  it('never exports an image whose source is not a managed attachment', () => {
    expect(richJsonToMarkdown(wrap([{ type: 'image', attrs: { src: 'https://example.com/a.png', alt: 'x' } }]))).toBe('')
  })

  it('is a valid node of the editor schema', () => {
    const schema = getSchema(createEditorExtensions())
    expect(() => schema.nodeFromJSON(JSON.parse(markdownToRichJson(`![x](attachment:${name})`)))).not.toThrow()
  })
})
