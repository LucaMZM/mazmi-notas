import type { Page } from '@playwright/test'

/** The writing editor is the default; Markdown source mode is remembered once chosen. */
export async function useMarkdown(page: Page) {
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
}

/** Rare note actions live in the «Más acciones» menu of the note header. */
export async function noteAction(page: Page, testId: string) {
  await page.getByRole('button', { name: 'Más acciones' }).click()
  await page.getByTestId(testId).click()
}
