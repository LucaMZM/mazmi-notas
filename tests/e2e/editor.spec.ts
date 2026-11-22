import { expect, test, type Page } from '@playwright/test'
import { useMarkdown } from './helpers'

test.beforeEach(async ({ page }) => { await page.goto('/') })

/**
 * Native ⌥⇧← word selection is not emitted by Playwright on macOS, so select character by character
 * at keyboard auto-repeat pace: zero-delay synthetic bursts right after typing race ProseMirror's
 * DOM observer even with every toolbar disabled, which no physical keyboard can produce.
 */
async function selectBackwards(page: Page, count: number) {
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Shift+ArrowLeft')
    await page.waitForTimeout(35)
  }
}

async function newNote(page: Page, title: string) {
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill(title)
  await page.getByTestId('note-title-input').press('Enter')
  await expect(page.locator('.mazmi-editor')).toBeFocused()
}

test('la barra flotante aplica negrita y color, y ambos persisten al recargar', async ({ page }) => {
  await newNote(page, 'Formato persistente')
  await page.keyboard.type('Una idea brillante')
  await selectBackwards(page, 'brillante'.length)
  const bubble = page.getByRole('toolbar', { name: 'Formato del texto seleccionado' })
  await expect(bubble).toBeVisible()
  await bubble.getByRole('button', { name: 'Negrita' }).click()
  await expect(page.locator('.mazmi-editor strong')).toHaveText('brillante')
  await bubble.getByRole('button', { name: 'Color, resaltado y tamaño' }).click()
  await bubble.getByRole('button', { name: 'Musgo' }).click()
  await bubble.getByRole('button', { name: 'Ámbar' }).click()
  await expect(page.locator('.mazmi-editor .sd-color-6')).toHaveText('brillante')
  await expect(page.locator('.mazmi-editor .sd-hl-1')).toHaveText('brillante')
  await expect(page.getByTestId('save-state')).toHaveText('Guardado')
  await page.reload()
  await expect(page.getByTestId('note-title-input')).toHaveValue('Formato persistente')
  await expect(page.locator('.mazmi-editor strong')).toHaveText('brillante')
  await expect(page.locator('.mazmi-editor .sd-color-6')).toHaveText('brillante')
  await useMarkdown(page)
  await expect(page.getByTestId('note-content-input')).toHaveValue('Una idea **brillante**')
})

test('el menú «/» inserta una lista de tareas que se guarda como Markdown GFM', async ({ page }) => {
  await newNote(page, 'Pendientes')
  await page.keyboard.type('/tar')
  const menu = page.getByRole('listbox', { name: 'Insertar bloque' })
  await expect(menu.getByRole('option', { name: /Lista de tareas/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await page.keyboard.type('Comprar pan')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Llamar')
  await expect(page.locator('.mazmi-editor ul[data-type="taskList"] > li')).toHaveCount(2)
  await page.locator('.mazmi-editor ul[data-type="taskList"] > li input').first().check()
  await expect(page.locator('.mazmi-editor ul[data-type="taskList"] > li').first()).toHaveAttribute('data-checked', 'true')
  await useMarkdown(page)
  await expect(page.getByTestId('note-content-input')).toHaveValue('- [x] Comprar pan\n- [ ] Llamar')
  await page.getByRole('button', { name: 'Escritura', exact: true }).click()
  await expect(page.locator('.mazmi-editor li[data-checked="true"]')).toHaveText('Comprar pan')
})

test('atajos de teclado: subrayado, encabezado y deshacer', async ({ page }) => {
  await newNote(page, 'Atajos')
  await page.keyboard.type('Título de sección')
  await page.keyboard.press('ControlOrMeta+Alt+2')
  await expect(page.locator('.mazmi-editor h2')).toHaveText('Título de sección')
  await page.keyboard.press('Enter')
  await page.keyboard.type('subrayado')
  await selectBackwards(page, 'subrayado'.length)
  await page.keyboard.press('ControlOrMeta+u')
  await expect(page.locator('.mazmi-editor u')).toHaveText('subrayado')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.mazmi-editor u')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(page.locator('.mazmi-editor u')).toHaveText('subrayado')
  await useMarkdown(page)
  await expect(page.getByTestId('note-content-input')).toHaveValue('## Título de sección\n\n<u>subrayado</u>')
  await page.getByRole('button', { name: 'Escritura', exact: true }).click()
  await expect(page.locator('.mazmi-editor u')).toHaveText('subrayado')
})

test('la tipografía elegida se aplica y se recuerda sin tocar el contenido', async ({ page }) => {
  await newNote(page, 'Lectura')
  await page.keyboard.type('Texto de prueba')
  await page.getByRole('button', { name: 'Tipografía y lectura' }).click()
  const panel = page.getByRole('dialog', { name: 'Tipografía y lectura' })
  await panel.getByRole('radio', { name: /Serif/ }).click()
  await panel.getByRole('button', { name: 'Aumentar tamaño' }).click()
  await panel.getByRole('radio', { name: 'Amplio' }).first().click()
  await expect(page.locator('.writing-surface')).toHaveAttribute('data-font', 'serif')
  const size = await page.locator('.mazmi-editor').evaluate((element) => getComputedStyle(element).fontSize)
  expect(size).toBe('18px')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.locator('.writing-surface')).toHaveAttribute('data-font', 'serif')
  await expect(page.locator('.mazmi-editor')).toHaveText('Texto de prueba')
})

test('una nota con tabla se abre en Markdown y no se convierte al pedir formato', async ({ page }) => {
  const markdown = '| A | B |\n|---|---|\n| uno | dos |'
  await page.evaluate((contentMd) => {
    const now = Math.floor(Date.now() / 1000)
    localStorage.setItem('scribedock-web-store-v4', JSON.stringify({ notes: [{
      id: 'tabla', title: 'Tabla', contentMd, contentPlain: 'A B uno dos',
      contentRichJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: contentMd }] }] }),
      tags: [], createdAt: now, updatedAt: now, isDeleted: false, deletedAt: null,
    }], versions: [], links: [], backups: [] }))
  }, markdown)
  await page.reload()
  await expect(page.getByTestId('note-content-input')).toHaveValue(markdown)
  await page.getByRole('button', { name: 'Escritura', exact: true }).click()
  await expect(page.getByText(/no puede conservar/)).toBeVisible()
  await expect(page.getByTestId('note-content-input')).toHaveValue(markdown)
})

test('cambiar de nota mientras se escribe guarda cada texto en su nota', async ({ page }) => {
  await newNote(page, 'Primera')
  await page.keyboard.type('Contenido de la primera')
  await newNote(page, 'Segunda')
  await page.keyboard.type('Contenido de la segunda')
  await page.getByRole('button', { name: /^Primera/ }).click()
  await expect(page.locator('.mazmi-editor')).toHaveText('Contenido de la primera')
  await page.getByRole('button', { name: /^Segunda/ }).click()
  await expect(page.locator('.mazmi-editor')).toHaveText('Contenido de la segunda')
  await page.reload()
  await page.getByRole('button', { name: /^Primera/ }).click()
  await expect(page.locator('.mazmi-editor')).toHaveText('Contenido de la primera')
})

test('abrir y hacer clic en una nota existente no la reescribe ni la vuelve a fechar', async ({ page }) => {
  const markdown = '# Código\n\nTexto previo.\n\n```ts\nconst a = 1\n```'
  await page.evaluate((contentMd) => {
    localStorage.setItem('scribedock-web-store-v4', JSON.stringify({ notes: [{
      id: 'intacta', title: 'Intacta', contentMd, contentPlain: 'Código Texto previo. const a = 1',
      contentRichJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: contentMd }] }] }),
      tags: [], createdAt: 1700000000, updatedAt: 1700000000, isDeleted: false, deletedAt: null,
    }], versions: [], links: [], backups: [] }))
  }, markdown)
  await page.reload()
  await page.locator('.mazmi-editor pre').click()
  await page.locator('.mazmi-editor p').first().click()
  await page.waitForTimeout(1200)
  await expect(page.getByTestId('save-state')).toHaveText('Guardado')
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('scribedock-web-store-v4')!).notes[0])
  expect(stored.updatedAt).toBe(1700000000)
  expect(stored.contentMd).toBe(markdown)
})

test('los enlaces [[título]] se destacan y se abren con ⌘/Ctrl + clic', async ({ page }) => {
  await newNote(page, 'Destino')
  await page.keyboard.type('Nota enlazada')
  await newNote(page, 'Origen')
  await page.keyboard.type('Ver [[Destino]] más tarde')
  const link = page.locator('.mazmi-editor .wikilink')
  await expect(link).toHaveText('[[Destino]]')
  await link.click({ modifiers: ['ControlOrMeta'] })
  await expect(page.getByTestId('note-title-input')).toHaveValue('Destino')
})

test('avisa antes de editar en Markdown una nota con formato visual', async ({ page }) => {
  await newNote(page, 'Con color')
  await page.keyboard.type('Rojo')
  await selectBackwards(page, 4)
  const bubble = page.getByRole('toolbar', { name: 'Formato del texto seleccionado' })
  await bubble.getByRole('button', { name: 'Color, resaltado y tamaño' }).click()
  await bubble.getByRole('button', { name: 'Granate' }).click()
  await expect(page.locator('.mazmi-editor .sd-color-1')).toHaveText('Rojo')
  await useMarkdown(page)
  await expect(page.getByText(/Markdown no puede expresarlos/)).toBeVisible()
  await page.getByRole('button', { name: 'Escritura', exact: true }).click()
  await expect(page.locator('.mazmi-editor .sd-color-1')).toHaveText('Rojo')
})

test('guardar con ⌘/Ctrl+S no interrumpe la escritura ni pierde lo tecleado durante el guardado', async ({ page }) => {
  await newNote(page, 'Sin pausa')
  await page.keyboard.type('Hola')
  await page.keyboard.press('ControlOrMeta+s')
  await page.keyboard.type(' mundo')
  await expect(page.locator('.mazmi-editor')).toBeFocused()
  await expect(page.locator('.mazmi-editor')).toHaveText('Hola mundo')
  await expect(page.getByTestId('save-state')).toHaveText('Guardado')
  await page.reload()
  await expect(page.locator('.mazmi-editor')).toHaveText('Hola mundo')
})

test('el orden integrado alterna entre recientes y A–Z', async ({ page }) => {
  await newNote(page, 'Zeta')
  await newNote(page, 'Alfa')
  await newNote(page, 'Media')
  const titles = () => page.locator('.note-row-title').allTextContents()
  await expect(page.getByRole('radio', { name: 'Recientes' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('radio', { name: 'A–Z' }).click()
  await expect.poll(titles).toEqual(['Alfa', 'Media', 'Zeta'])
  await expect(page.getByRole('radio', { name: 'A–Z' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('radio', { name: 'Recientes' }).click()
  await expect(page.getByRole('radio', { name: 'Recientes' })).toHaveAttribute('aria-checked', 'true')
})

test('exporta la nota como documento de Word (.docx)', async ({ page }) => {
  await newNote(page, 'Informe')
  await page.keyboard.type('Contenido del informe')
  await page.getByRole('button', { name: 'Más acciones' }).click()
  const download = page.waitForEvent('download')
  await page.getByTestId('export-docx-btn').click()
  const file = await download
  expect(file.suggestedFilename()).toBe('Informe.docx')
  const bytes = await (await file.createReadStream()).toArray()
  const buffer = Buffer.concat(bytes)
  expect(buffer.subarray(0, 4).toString('binary')).toBe('PK\u0003\u0004')
  expect(buffer.includes(Buffer.from('Contenido del informe'))).toBe(true)
})
