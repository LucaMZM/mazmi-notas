import { expect, test, type Page } from '@playwright/test'

const stored = (page: Page) => page.evaluate(() => Object.keys(localStorage).map((key) => localStorage.getItem(key)).join('\n'))

async function noteWithText(page: Page, title: string, text: string) {
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill(title)
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
  await page.getByTestId('note-content-input').fill(text)
  await page.getByRole('button', { name: 'Escritura', exact: true }).click()
}

async function protect(page: Page, password: string) {
  await page.getByRole('button', { name: 'Más acciones' }).click()
  await page.getByTestId('lock-note-btn').click()
  await page.getByTestId('password-new').fill(password)
  await page.getByTestId('password-repeat').fill(password)
  await page.getByTestId('password-submit').click()
}

test('proteger una nota, abrirla con la contraseña, editarla cifrada y quitar la protección', async ({ page }) => {
  await page.goto('/')
  await noteWithText(page, 'Diario', 'Un secreto muy personal')
  await noteWithText(page, 'Compra', 'Pan y leche')
  await page.getByRole('button', { name: /^Diario/ }).click()

  // The password needs 4+ characters and must be typed twice.
  await page.getByRole('button', { name: 'Más acciones' }).click()
  await page.getByTestId('lock-note-btn').click()
  await page.getByTestId('password-new').fill('abc')
  await expect(page.getByTestId('password-submit')).toBeDisabled()
  await page.getByTestId('password-new').fill('clave segura')
  await page.getByTestId('password-repeat').fill('clave segurx')
  await expect(page.getByText('Las contraseñas no coinciden.')).toBeVisible()
  await page.getByTestId('password-repeat').fill('clave segura')
  await page.getByTestId('password-submit').click()

  const locked = page.getByRole('region', { name: 'Nota protegida: Diario' })
  await expect(locked).toBeVisible()
  await expect(page.getByTestId('note-content-input')).toHaveCount(0)
  expect(await stored(page)).not.toContain('secreto')
  await expect(page.getByLabel('Protegida con contraseña')).toBeVisible()
  // Searching by its content finds nothing; by its title it still appears.
  await page.getByPlaceholder('Buscar en tus notas').fill('secreto')
  await expect(page.getByRole('list', { name: 'Notas', exact: true }).getByRole('button', { name: /Diario/ })).toHaveCount(0)
  await page.getByPlaceholder('Buscar en tus notas').fill('')

  await page.getByTestId('unlock-password').fill('otra')
  await page.getByTestId('unlock-password').press('Enter')
  await expect(locked.getByRole('alert')).toHaveText('Contraseña incorrecta')
  await page.getByTestId('unlock-password').fill('clave segura')
  await page.getByTestId('unlock-password').press('Enter')
  await expect(page.locator('.mazmi-editor')).toContainText('Un secreto muy personal')
  await expect(page.getByRole('button', { name: 'Historial' })).toBeDisabled()

  // Edits are saved encrypted.
  await page.locator('.mazmi-editor').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' y otro más')
  await expect(page.getByTestId('save-state')).toHaveText(/Guardado/, { timeout: 5000 })
  expect(await stored(page)).not.toContain('otro más')

  // Leaving locks it again; the edit is there after unlocking.
  await page.getByRole('button', { name: /^Compra/ }).click()
  await page.getByRole('button', { name: /^Diario/ }).click()
  await expect(locked).toBeVisible()
  await page.getByTestId('unlock-password').fill('clave segura')
  await page.getByTestId('unlock-password').press('Enter')
  await expect(page.locator('.mazmi-editor')).toContainText('Un secreto muy personal y otro más')

  await page.getByRole('button', { name: 'Más acciones' }).click()
  await page.getByTestId('unlock-note-btn').click()
  await page.getByTestId('password-new').fill('clave segura')
  await page.getByTestId('password-submit').click()
  await expect(page.getByTestId('status-message')).toContainText('ya no tiene contraseña')
  await page.getByRole('button', { name: /^Compra/ }).click()
  await page.getByRole('button', { name: /^Diario/ }).click()
  await expect(page.locator('.mazmi-editor')).toContainText('otro más')
  expect(await stored(page)).toContain('otro más')
})

test('una nota protegida sigue bloqueada al recargar y no ofrece exportar ni duplicar', async ({ page }) => {
  await page.goto('/')
  await noteWithText(page, 'Claves', 'texto reservado')
  await protect(page, 'abcd')
  await expect(page.getByRole('region', { name: 'Nota protegida: Claves' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: /^Claves/ }).click()
  await expect(page.getByRole('region', { name: 'Nota protegida: Claves' })).toBeVisible()
  await page.getByRole('button', { name: 'Más acciones' }).click()
  await expect(page.getByTestId('export-note-btn')).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Duplicar' })).toHaveCount(0)
})

test('pantalla de inicio: entrar a las notas', async ({ page }) => {
  await page.goto('/?splash')
  const splash = page.getByRole('dialog', { name: 'MazmiNotas' })
  await expect(splash).toBeVisible()
  await expect(page.getByTestId('splash-enter')).toBeFocused()
  await page.getByTestId('splash-enter').click()
  await expect(splash).toHaveCount(0)
  await expect(page.getByTestId('new-note-btn')).toBeVisible()
})
