import fs from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { getCurrentWindow } from '@tauri-apps/api/window'

afterEach(() => vi.unstubAllGlobals())

it('permite que la API real de Tauri cierre una ventana sin cambios pendientes', async () => {
  const capability = JSON.parse(fs.readFileSync('src-tauri/capabilities/default.json', 'utf8'))
  let callback!: (event: { event: string; id: number; payload: null }) => Promise<void>
  let destroyed = false
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: (handler: typeof callback) => { callback = handler; return 1 },
      invoke: async (command: string) => {
        if (command === 'plugin:event|listen') return 1
        if (command === 'plugin:window|destroy') {
          if (!capability.permissions.includes('core:window:allow-destroy')) {
            throw new Error('window.destroy not allowed by the main window capability')
          }
          destroyed = true
          return
        }
        throw new Error(`Unexpected IPC command: ${command}`)
      },
    },
  })
  await getCurrentWindow().onCloseRequested(() => {})
  await callback({ event: 'tauri://close-requested', id: 1, payload: null })
  expect(destroyed).toBe(true)
})
