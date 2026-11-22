import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

describe('identidad y continuidad de instalaciones', () => {
  it('presenta MazmiNotas en la ventana y el paquete', () => {
    expect(config.productName).toBe('MazmiNotas')
    expect(config.app.windows[0].title).toBe('MazmiNotas')
    expect(pkg.name).toBe('mazminotas')
  })

  it('conserva el identificador del que dependen las rutas de datos existentes', () => {
    expect(config.identifier).toBe('com.scribedock.app')
  })
})
