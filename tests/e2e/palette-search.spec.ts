import { expect, test, type Page } from '@playwright/test'

async function note(page: Page, title: string, text: string) {
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill(title)
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
  await page.getByTestId('note-content-input').fill(text)
  await page.getByRole('button', { name: 'Escritura', exact: true }).click()
}

test('la lupa encuentra notas por lo escrito dentro, no solo por el título', async ({ page }) => {
  await page.goto('/')
  await note(page, 'Reunión lunes', 'Hablamos con Marta del presupuesto de la campaña de invierno.')
  await note(page, 'Lista de la compra', 'Leche, pan y café.')
  await page.waitForTimeout(1200)

  await page.getByRole('button', { name: 'Buscar y ejecutar comandos' }).click()
  const input = page.getByTestId('command-palette-input')
  // No title contains it; accents and case do not matter.
  await input.fill('CAMPANA de invierno')
  const result = page.locator('.palette-results button').filter({ hasText: 'Reunión lunes' })
  await expect(result).toBeVisible()
  await expect(result.locator('mark')).toHaveText('campaña de invierno')
  await expect(page.locator('.palette-results button').filter({ hasText: 'Lista de la compra' })).toHaveCount(0)

  // Enter opens the first result.
  await input.press('Enter')
  await expect(page.getByTestId('note-title-input')).toHaveValue('Reunión lunes')

  // Titles still match, and commands too.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
  await input.fill('compra')
  await expect(page.locator('.palette-results button').filter({ hasText: 'Lista de la compra' })).toBeVisible()
})

test('la lupa no encuentra el texto de una nota protegida', async ({ page }) => {
  await page.goto('/')
  await note(page, 'Privada', 'contraseña del trastero 4455')
  await page.getByRole('button', { name: 'Más acciones' }).click()
  await page.getByTestId('lock-note-btn').click()
  await page.getByTestId('password-new').fill('abcd')
  await page.getByTestId('password-repeat').fill('abcd')
  await page.getByTestId('password-submit').click()
  await expect(page.getByRole('region', { name: 'Nota protegida: Privada' })).toBeVisible()
  await page.getByRole('button', { name: 'Buscar y ejecutar comandos' }).click()
  await page.getByTestId('command-palette-input').fill('trastero')
  await expect(page.locator('.palette-results')).toContainText('Sin resultados')
})
