import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

await mkdir('output/playwright', { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.goto('http://127.0.0.1:5173')
for (const [title, tags, text] of [
  ['Arquitectura local', 'desarrollo', '## Una base sólida\n\nSQLite conserva las notas en este equipo. Las escrituras se confirman juntas y el historial permite volver atrás.'],
  ['Ideas para después', 'ideas', '## Sin prisa\n\n- Un índice de lecturas.\n- Documentar lo que voy aprendiendo.\n- Volver a las ideas que merecen otra oportunidad.'],
  ['Cuaderno de desarrollo', 'desarrollo, personal', [
    '## Pensar en voz alta', '',
    'Un cuaderno para las ideas que quiero convertir en proyectos.', '',
    '- Escribir sin perder el hilo.',
    '- Encontrar cada nota cuando la necesito.',
    '- Mantener una copia de lo importante.', '',
    '## Esta semana', '',
    'Revisar [[Arquitectura local]] y preparar el próximo lanzamiento.', '',
    '> La mejor herramienta es la que deja espacio para pensar.',
  ].join('\n')],
]) {
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill(title)
  await page.getByTestId('note-tags-input').fill(tags)
  await page.getByTestId('note-content-input').fill(text)
  await page.getByTestId('save-note-btn').click()
  await page.getByTestId('save-state').filter({ hasText: 'Guardado' }).waitFor()
}
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: 'output/playwright/after-desktop.png', fullPage: true })
await page.getByRole('button', { name: 'Vista previa', exact: true }).click()
await page.screenshot({ path: 'output/playwright/after-preview.png', fullPage: true })
await page.getByRole('button', { name: 'Historial', exact: true }).click()
await page.getByRole('complementary', { name: 'Historial de la nota' }).waitFor()
await page.screenshot({ path: 'output/playwright/after-history.png', fullPage: true })
await page.getByRole('button', { name: 'Cerrar panel' }).click()
await page.setViewportSize({ width: 390, height: 844 })
await page.screenshot({ path: 'output/playwright/after-mobile.png', fullPage: true })
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
await writeFile('output/playwright/visual-check.json', JSON.stringify({ errors, mobileHorizontalOverflow: overflow, viewports: ['1360x900', '390x844'] }, null, 2) + '\n')
await browser.close()
if (errors.length || overflow) throw new Error('Visual check failed: ' + JSON.stringify({ errors, overflow }))
console.log('Capturas reales guardadas. Sin errores de página ni desbordamiento horizontal móvil.')
