import { expect, test } from '@playwright/test'
import { useMarkdown } from './helpers'

test('la paleta recibe la escritura al abrir y devuelve el foco al cerrar', async ({ page }) => {
  await page.goto('/')
  const trigger = page.getByRole('button', { name: 'Buscar y ejecutar comandos' })
  await trigger.click()
  await expect(page.getByTestId('command-palette-input')).toBeFocused()
  await page.keyboard.type('Nueva nota')
  await expect(page.getByTestId('command-palette-input')).toHaveValue('Nueva nota')
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})

test('contraer la biblioteca conserva el borrador y buscar vuelve a mostrarla', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Mi espacio de escritura')
  await useMarkdown(page)
  await page.getByTestId('note-content-input').fill('Un borrador que permanece al cambiar el espacio.')
  const toggle = page.getByRole('button', { name: 'Ocultar biblioteca', exact: true })
  await toggle.click()
  await expect(page.getByRole('complementary', { name: 'Biblioteca', exact: true })).toBeHidden()
  await expect(page.getByTestId('note-content-input')).toHaveValue('Un borrador que permanece al cambiar el espacio.')
  await page.keyboard.press('Control+f')
  await expect(page.getByTestId('search-input')).toBeFocused()
  await expect(page.getByRole('complementary', { name: 'Biblioteca', exact: true })).toBeVisible()
  await expect(page.getByTestId('note-title-input')).toHaveValue('Mi espacio de escritura')
})

test('la ventana mínima mantiene accesible el editor, herramientas y cierre del panel', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 540 })
  await page.goto('/')
  await page.getByTestId('new-note-btn').click()
  await page.getByRole('button', { name: 'Historial', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cerrar panel' })).toBeInViewport()
  await page.getByRole('button', { name: 'Cerrar panel' }).click()
  await expect(page.getByTestId('rich-editor')).toBeInViewport()
  await page.getByRole('button', { name: 'Vista previa', exact: true }).click()
  await expect(page.locator('.document-preview')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
