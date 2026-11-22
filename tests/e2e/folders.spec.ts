import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => { await page.goto('/') })

async function createFolder(page: Page, name: string, parent?: string) {
  if (parent) {
    await page.getByRole('button', { name: 'Opciones de ' + parent }).click({ force: true })
    await page.getByRole('menuitem', { name: 'Nueva subcarpeta' }).click()
  } else {
    await page.getByRole('button', { name: 'Nueva carpeta' }).click()
  }
  await page.getByLabel('Nombre de la carpeta').fill(name)
  await page.getByLabel('Nombre de la carpeta').press('Enter')
  await expect(page.getByRole('treeitem', { name: new RegExp(name) }).first()).toBeVisible()
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Carpetas' })

test('carpetas anidadas: crear, abrir, mover notas y borrar sin perder notas', async ({ page }) => {
  await createFolder(page, 'Trabajo')
  await createFolder(page, 'Proyectos', 'Trabajo')
  await tree(page).getByRole('button', { name: /^Proyectos/ }).click()
  await expect(page.locator('.list-heading h2')).toHaveText('Proyectos')
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Plan de empleados')
  await expect(page.locator('.breadcrumb')).toContainText('Trabajo')
  await expect(page.locator('.breadcrumb')).toContainText('Proyectos')
  await expect(page.getByRole('list', { name: 'Notas', exact: true }).getByRole('button', { name: /Plan de empleados/ })).toBeVisible()

  // Move with the menu to the parent folder.
  await page.getByRole('button', { name: 'Más acciones' }).click()
  await page.getByTestId('move-note-btn').click()
  await page.getByRole('dialog', { name: 'Mover a carpeta' }).getByRole('button', { name: 'Trabajo' }).click()
  await expect(page.locator('.breadcrumb')).not.toContainText('Proyectos')
  await expect(page.getByRole('list', { name: 'Notas', exact: true }).getByText('Plan de empleados')).toHaveCount(0)

  // Drag it back into «Proyectos» from «Todas las notas».
  await page.getByRole('button', { name: /^Todas las notas/ }).click()
  const row = page.getByRole('list', { name: 'Notas', exact: true }).getByRole('button', { name: /Plan de empleados/ })
  await expect(row).toContainText('Trabajo')
  await row.dragTo(tree(page).getByRole('button', { name: /^Proyectos/ }))
  await expect(row).toContainText('Proyectos')

  // A folder cannot be moved into its own subfolder.
  await tree(page).getByRole('button', { name: /^Trabajo/ }).dragTo(tree(page).getByRole('button', { name: /^Proyectos/ }))
  await expect(tree(page).locator('li[role=treeitem]').first()).toContainText('Trabajo')

  // Deleting «Proyectos» keeps the note, which moves up to «Trabajo».
  await page.getByRole('button', { name: 'Opciones de Proyectos' }).click({ force: true })
  await page.getByRole('menuitem', { name: 'Eliminar carpeta' }).click()
  await page.getByRole('dialog', { name: 'Eliminar carpeta' }).getByRole('button', { name: 'Eliminar carpeta' }).click()
  await expect(tree(page).getByRole('button', { name: /^Proyectos/ })).toHaveCount(0)
  await page.getByRole('button', { name: /^Todas las notas/ }).click()
  await expect(row).toContainText('Trabajo')
  await page.reload()
  await expect(page.getByRole('list', { name: 'Notas', exact: true }).getByRole('button', { name: /Plan de empleados/ })).toContainText('Trabajo')
})

test('renombrar una carpeta y rechazar nombres repetidos', async ({ page }) => {
  await createFolder(page, 'Ideas')
  await createFolder(page, 'Lecturas')
  await tree(page).getByRole('button', { name: /^Lecturas/ }).dblclick()
  await page.getByLabel('Nombre de la carpeta').fill('ideas')
  await page.getByLabel('Nombre de la carpeta').press('Enter')
  await expect(page.getByTestId('status-message')).toContainText('Ya existe')
  await page.getByLabel('Nombre de la carpeta').fill('Libros')
  await page.getByLabel('Nombre de la carpeta').press('Enter')
  await expect(tree(page).getByRole('button', { name: /^Libros/ })).toBeVisible()
})
