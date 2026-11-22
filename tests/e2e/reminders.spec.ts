import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => { await page.goto('/') })

test('programar, ver vencidos tras reiniciar, posponer, completar y quitar un recordatorio', async ({ page }) => {
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Llamar a Ana')
  await page.getByRole('button', { name: 'Añadir recordatorio' }).click()
  const panel = page.getByRole('dialog', { name: 'Recordatorio' })
  const tomorrow = new Date(Date.now() + 86_400_000)
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  await panel.getByLabel('Fecha', { exact: true }).fill(date)
  await panel.getByLabel('Hora', { exact: true }).fill('09:00')
  await panel.getByRole('radio', { name: 'Cada semana' }).click()
  await expect(panel).toContainText('modo navegador')
  await panel.getByRole('button', { name: 'Programar' }).click()
  await expect(panel).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Recordatorio: mañana, 9:00 · cada semana/ })).toBeVisible()

  await page.getByRole('button', { name: /^Recordatorios/ }).click()
  await expect(page.locator('.list-heading h2')).toHaveText('Recordatorios')
  await expect(page.getByRole('list', { name: 'Notas', exact: true }).getByRole('button', { name: /Llamar a Ana/ })).toBeVisible()

  // The reminder time passes while the app is closed: on restart it needs attention.
  await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem('scribedock-web-store-v4')!)
    store.reminders[0].nextFireAt = Math.floor(Date.now() / 1000) - 120
    localStorage.setItem('scribedock-web-store-v4', JSON.stringify(store))
  })
  await page.reload()
  await page.getByRole('button', { name: /^Llamar a Ana/ }).click()
  const attention = page.locator('.reminder-attention')
  await expect(attention).toBeVisible()
  await expect(page.getByLabel('1 vencidos')).toBeVisible()
  await attention.getByRole('button', { name: '1 hora' }).click()
  await expect(attention).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Recordatorio: hoy|^Recordatorio: mañana/ })).toBeVisible()

  await page.getByRole('button', { name: /^Recordatorio:/ }).click()
  await page.getByRole('dialog', { name: 'Recordatorio' }).getByRole('button', { name: 'Quitar' }).click()
  await expect(page.getByRole('button', { name: 'Añadir recordatorio' })).toBeVisible()
})

test('rechaza programar un recordatorio en el pasado', async ({ page }) => {
  await page.getByTestId('new-note-btn').click()
  await page.getByRole('button', { name: 'Añadir recordatorio' }).click()
  const panel = page.getByRole('dialog', { name: 'Recordatorio' })
  await panel.getByLabel('Fecha', { exact: true }).fill('2020-01-01')
  await panel.getByLabel('Hora', { exact: true }).fill('09:00')
  await panel.getByRole('button', { name: 'Programar' }).click()
  await expect(page.getByTestId('status-message')).toContainText('ya ha pasado')
  await expect(panel).toBeVisible()
})
