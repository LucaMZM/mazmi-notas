import { expect, test } from '@playwright/test'
import { noteAction, useMarkdown } from './helpers'

test.beforeEach(async ({ page }) => { await page.goto('/') })

test('guarda al navegar, buscar y recargar sin pulsar Guardar', async ({ page }) => {
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Alpha')
  await useMarkdown(page)
  await page.getByTestId('note-content-input').fill('Código y notas que no se deben perder')
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Beta')
  await page.getByTestId('note-content-input').fill('Segunda nota')
  await page.getByRole('button', { name: /^Alpha/ }).click()
  await expect(page.getByTestId('note-content-input')).toHaveValue('Código y notas que no se deben perder')
  await page.getByTestId('search-input').fill('inexistente')
  await expect(page.getByText('Sin resultados')).toBeVisible()
  await expect(page.getByTestId('note-title-input')).toHaveValue('Alpha')
  await page.reload()
  await page.getByRole('button', { name: /^Beta/ }).click()
  await expect(page.getByTestId('note-content-input')).toHaveValue('Segunda nota')
})

test('restaura copia, recarga el documento y permite recuperar el estado anterior', async ({ page }) => {
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Mi proyecto')
  await useMarkdown(page)
  await page.getByTestId('note-content-input').fill('Versión uno')
  await page.getByRole('button', { name: 'Copias y ajustes' }).click()
  await page.getByRole('button', { name: 'Crear copia' }).click()
  await expect(page.getByTestId('status-message')).toContainText(/copia|backup/i)
  await page.getByRole('button', { name: 'Cerrar diálogo' }).click()
  await page.getByTestId('note-content-input').fill('Versión dos')
  await noteAction(page, 'save-note-btn')
  await page.getByRole('button', { name: 'Copias y ajustes' }).click()
  await page.getByRole('button', { name: 'Restaurar copia' }).click()
  await page.getByRole('button', { name: 'Confirmar restauración' }).click()
  await page.getByRole('button', { name: 'Cerrar diálogo' }).click()
  await expect(page.getByTestId('note-content-input')).toHaveValue('Versión uno')
  await page.reload()
  await expect(page.getByTestId('note-content-input')).toHaveValue('Versión uno')
})

test('papelera en lectura, confirmación de borrado y atajos Windows', async ({ page }) => {
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Conservar')
  await useMarkdown(page)
  await page.getByTestId('note-content-input').fill('Borrador protegido')
  await page.keyboard.press('Control+s')
  await expect(page.getByTestId('save-state')).toHaveText('Guardado')
  await noteAction(page, 'delete-note-btn')
  await page.getByRole('button', { name: /^Papelera/ }).click()
  await page.getByRole('button', { name: /^Conservar/ }).click()
  await expect(page.getByTestId('note-content-input')).toHaveAttribute('readonly', '')
  await page.getByRole('button', { name: 'Eliminar definitivamente' }).click()
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await expect(page.getByTestId('note-title-input')).toHaveValue('Conservar')
  await page.getByRole('button', { name: 'Restaurar nota', exact: true }).click()
  await expect(page.getByTestId('note-content-input')).toHaveValue('Borrador protegido')
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Buscar y ejecutar' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('preview no solicita recursos remotos y conserva tablas en Markdown', async ({ page }) => {
  const remote: string[] = []
  page.on('request', (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:5173')) remote.push(request.url()) })
  await page.getByTestId('new-note-btn').click()
  await useMarkdown(page)
  await page.getByTestId('note-content-input').fill('| A | B |\n|---|---|\n| uno | dos |\n\n![remoto](https://example.com/image.png)\n\n<script>alert(1)</script>')
  await page.getByRole('button', { name: 'Vista previa', exact: true }).click()
  await expect(page.locator('.document-preview table')).toBeVisible()
  await expect(page.locator('.document-preview img')).toHaveCount(0)
  expect(remote).toEqual([])
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
  await expect(page.getByTestId('note-content-input')).toHaveValue(/\| A \| B \|/)
})

test('conserva formato al alternar y el undo no cruza documentos', async ({ page }) => {
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Documento A')
  await useMarkdown(page)
  const markdown = '# Desarrollo\n\n**Importante** y _énfasis_.\n\n~~~ts\n  const answer = 42\n~~~\n\n- uno\n- dos'
  await page.getByTestId('note-content-input').fill(markdown)
  await page.getByRole('button', { name: 'Escritura', exact: true }).click()
  await expect(page.locator('.mazmi-editor strong')).toHaveText('Importante')
  await expect(page.locator('.mazmi-editor pre')).toContainText('  const answer = 42')
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
  await expect(page.getByTestId('note-content-input')).toHaveValue(markdown)
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Documento B')
  await page.getByTestId('note-content-input').fill('Solo pertenece a B')
  await page.getByRole('button', { name: 'Escritura', exact: true }).click()
  await page.locator('.mazmi-editor').click()
  await page.keyboard.press('Meta+z')
  await expect(page.locator('.mazmi-editor')).not.toContainText('Importante')
})

test('fallo de escritura conserva borrador y bloquea navegación destructiva', async ({ page }) => {
  await page.getByTestId('new-note-btn').click()
  await useMarkdown(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'scribedock-web-store-v4') throw new DOMException('Cuota de prueba agotada', 'QuotaExceededError')
      return original.call(this, key, value)
    }
  })
  await page.getByTestId('note-content-input').fill('Trabajo que sobrevivirá al error')
  await expect(page.getByRole('alert')).toContainText('Cuota de prueba')
  await page.getByTestId('new-note-btn').click()
  await expect(page.getByTestId('note-content-input')).toHaveValue('Trabajo que sobrevivirá al error')
  page.once('dialog', (dialog) => dialog.accept())
  await page.reload()
  await page.getByRole('button', { name: 'Recuperar borrador' }).click()
  await expect(page.getByTestId('note-content-input')).toHaveValue('Trabajo que sobrevivirá al error')
  await expect(page.getByTestId('save-state')).toHaveText('Guardado')
})

test('el mapa de notas ya no existe, pero las referencias entre notas siguen disponibles', async ({ page }) => {
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Destino')
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Origen')
  await useMarkdown(page)
  await page.getByTestId('note-content-input').fill('Ver [[Destino]]')
  await noteAction(page, 'save-note-btn')
  await expect(page.getByRole('button', { name: 'Mapa de notas' })).toHaveCount(0)
  await page.keyboard.press('Control+k')
  await page.getByTestId('command-palette-input').fill('Mapa')
  await expect(page.getByRole('dialog', { name: 'Buscar y ejecutar' }).getByText('Mapa de notas')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Destino/ }).click()
  await page.getByRole('button', { name: 'Referencias', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Referencias de la nota' }).getByRole('button', { name: 'Origen' })).toBeVisible()
})

test('biblioteca de mil notas: búsqueda por contenido sin cambiar el documento abierto', async ({ page }) => {
  await page.evaluate(() => {
    const now = Math.floor(Date.now() / 1000)
    const notes = Array.from({ length: 1000 }, (_, index) => ({
      id: 'fixture-' + index, title: 'Nota ' + String(index).padStart(4, '0'),
      contentMd: 'Contenido único referencia-' + index,
      contentPlain: 'Contenido único referencia-' + index,
      contentRichJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Contenido único referencia-' + index }] }] }),
      tags: ['pruebas'], createdAt: now - index, updatedAt: now - index, isDeleted: false, deletedAt: null,
    }))
    localStorage.setItem('scribedock-web-store-v4', JSON.stringify({ notes, versions: [], links: [], backups: [] }))
  })
  await page.reload()
  await expect(page.getByTestId('note-title-input')).toHaveValue('Nota 0000')
  await page.getByTestId('search-input').fill('referencia-777')
  await expect(page.getByRole('list', { name: 'Notas', exact: true }).getByRole('button')).toHaveCount(1)
  await expect(page.getByTestId('note-title-input')).toHaveValue('Nota 0000')
  await page.getByRole('button', { name: /^Nota 0777/ }).click()
  await expect(page.locator('.mazmi-editor')).toHaveText('Contenido único referencia-777')
})

test('una nota importada con Rich desactualizado conserva el Markdown al editar visualmente', async ({ page }) => {
  await page.evaluate(() => {
    const now = Math.floor(Date.now() / 1000)
    const notes = [{
      id: 'legacy-import', title: 'Proyecto importado', contentMd: '# Proyecto\n\n**Importante**',
      contentPlain: 'Proyecto Importante', contentRichJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Proyecto Importante' }] }] }),
      tags: [], createdAt: now, updatedAt: now, isDeleted: false, deletedAt: null,
    }]
    localStorage.setItem('scribedock-web-store-v4', JSON.stringify({ notes, versions: [], links: [], backups: [] }))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Escritura', exact: true }).click()
  await expect(page.locator('.mazmi-editor h1')).toHaveText('Proyecto')
  await expect(page.locator('.mazmi-editor strong')).toHaveText('Importante')
  await page.locator('.mazmi-editor').click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' adicional')
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
  await expect(page.getByTestId('note-content-input')).toHaveValue(/# Proyecto/)
  await expect(page.getByTestId('note-content-input')).toHaveValue(/\*\*Importante/)
})
