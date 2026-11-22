import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'

const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
const root = path.resolve('dist')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }
const server = createServer(async (request, response) => {
  try {
    const filename = path.resolve(root, '.' + (new URL(request.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(request.url, 'http://localhost').pathname))
    if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return }
    const content = await readFile(filename)
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream', 'Content-Security-Policy': config.app.security.csp })
    response.end(content)
  } catch { response.writeHead(404).end() }
})
await new Promise((resolve) => server.listen(4180, '127.0.0.1', resolve))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
const errors = []
const external = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('request', (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4180')) external.push(request.url()) })
await page.addInitScript(() => {
  window.__cspViolations = []
  document.addEventListener('securitypolicyviolation', (event) => window.__cspViolations.push({ directive: event.violatedDirective, blockedURI: event.blockedURI }))
})
try {
  await page.goto('http://127.0.0.1:4180')
  await page.getByTestId('new-note-btn').click()
  await page.getByTestId('note-title-input').fill('Prueba de producción')
  await page.getByTestId('note-content-input').fill('# Documento seguro\n\n**Formato** sin recursos externos.')
  await page.getByRole('button', { name: 'Con formato', exact: true }).click()
  await expect(page.locator('.mazmi-editor h1')).toHaveText('Documento seguro')
  await page.locator('.mazmi-editor').click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' Cambios guardados.')
  await page.getByTestId('save-note-btn').click()
  await expect(page.getByTestId('save-state')).toHaveText('Guardado')
  await page.reload()
  await expect(page.getByTestId('note-content-input')).toHaveValue(/Cambios guardados/)
  const violations = await page.evaluate(() => window.__cspViolations)
  await mkdir('output/playwright', { recursive: true })
  await writeFile('output/playwright/production-csp.json', JSON.stringify({ errors, externalRequests: external, violations, policy: config.app.security.csp }, null, 2) + '\n')
  await page.screenshot({ path: 'output/playwright/production-csp.png' })
  expect(errors).toEqual([])
  expect(external).toEqual([])
  expect(violations).toEqual([])
  console.log('Build de producción probado con la CSP real: guardado y persistencia correctos, sin violaciones CSP ni peticiones externas.')
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
