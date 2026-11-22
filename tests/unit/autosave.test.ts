import { describe, expect, it } from 'vitest'
import { DraftWriter } from '../../src/services/draftWriter'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('guardado de borradores', () => {
  it('serializa escrituras y conserva los cambios escritos durante una petición', async () => {
    const gate = deferred()
    const saved: string[] = []
    const writer = new DraftWriter<string>(async (value) => {
      if (value === 'primero') await gate.promise
      saved.push(value)
    })
    writer.set('primero')
    const saving = writer.flush()
    writer.set('segundo')
    expect(writer.dirty).toBe(true)
    gate.resolve()
    await saving
    expect(saved).toEqual(['primero', 'segundo'])
    expect(writer.dirty).toBe(false)
  })

  it('mantiene pendiente un borrador si falla y permite reintentar', async () => {
    let available = false
    const saved: string[] = []
    const writer = new DraftWriter<string>(async (value) => {
      if (!available) throw new Error('Disco lleno')
      saved.push(value)
    })
    writer.set('no perder')
    await expect(writer.flush()).rejects.toThrow('Disco lleno')
    expect(writer.dirty).toBe(true)
    available = true
    await writer.flush()
    expect(saved).toEqual(['no perder'])
    expect(writer.dirty).toBe(false)
  })

  it('evita escrituras duplicadas si llegan varios flush simultáneos', async () => {
    const saved: string[] = []
    const writer = new DraftWriter<string>(async (value) => { saved.push(value) })
    writer.set('una vez')
    await Promise.all([writer.flush(), writer.flush(), writer.flush()])
    expect(saved).toEqual(['una vez'])
  })
})
