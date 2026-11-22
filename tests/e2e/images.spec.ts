import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => { await page.goto('/') })

// 2×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGGEMAD4cBP+8r3R1AAAAAElFTkSuQmCC', 'base64')
const NAME = /attachment:[0-9a-f]{64}\.png/

async function markdownOf(page: Page) {
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
  const value = await page.getByTestId('note-content-input').inputValue()
  await page.getByRole('button', { name: 'Escritura', exact: true }).click()
  return value
}

test('insertar una imagen desde «/», verla, conservarla al recargar y en la vista previa', async ({ page }) => {
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Con plano')
  await page.getByTestId('rich-editor').locator('.ProseMirror').click()
  await page.keyboard.type('Antes')
  await page.keyboard.press('Enter')
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.type('/imagen')
  await page.getByRole('listbox', { name: 'Insertar bloque' }).getByRole('option', { name: /Imagen/ }).click()
  await (await chooser).setFiles({ name: 'plano-oficina.png', mimeType: 'image/png', buffer: PNG })

  const image = page.locator('.note-image img')
  await expect(image).toHaveCount(1)
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2)
  expect(await markdownOf(page)).toMatch(new RegExp(`^Antes\\n\\n!\\[\\]\\(${NAME.source}\\)`))

  await page.waitForTimeout(1600)
  await page.reload()
  await page.getByRole('button', { name: /^Con plano/ }).click()
  await expect.poll(() => page.locator('.note-image img').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2)
  await page.getByRole('button', { name: 'Vista previa', exact: true }).click()
  await expect.poll(() => page.locator('.document-preview img.preview-image').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2)
})

test('pegar una captura y soltar un archivo insertan imágenes; un SVG se rechaza', async ({ page }) => {
  await page.getByTestId('new-note-btn').click()
  const editor = page.getByTestId('rich-editor').locator('.ProseMirror')
  await editor.click()
  const send = (kind: 'paste' | 'drop', base64: string, type: string, name: string) => editor.evaluate((target, { kind, base64, type, name }) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], name, { type }))
    const box = target.getBoundingClientRect()
    target.dispatchEvent(kind === 'paste'
      ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
      : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 10 }))
  }, { kind, base64, type, name })

  await send('paste', PNG.toString('base64'), 'image/png', 'captura.png')
  await expect(page.locator('.note-image')).toHaveCount(1)
  await send('drop', PNG.toString('base64'), 'image/png', 'otra.png')
  await expect(page.locator('.note-image')).toHaveCount(2)
  await expect(page.locator('.note-image').last()).toHaveAttribute('title', 'otra')

  await send('paste', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64'), 'image/svg+xml', 'x.svg')
  await expect(page.locator('.editor-notice')).toContainText('Formato de imagen no admitido')
  await expect(page.locator('.note-image')).toHaveCount(2)
})
