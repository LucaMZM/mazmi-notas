import { describe, expect, it } from 'vitest'
import { rotateBackupNames } from '../../src/utils/backups'

describe('backup rotation', () => {
  it('mantiene solo los últimos N backups', () => {
    const backups = Array.from({ length: 35 }, (_, index) => `backup-${String(index).padStart(3, '0')}.json`)
    const rotated = rotateBackupNames(backups, 30)

    expect(rotated).toHaveLength(30)
    expect(rotated[0]).toBe('backup-005.json')
    expect(rotated[29]).toBe('backup-034.json')
  })
})
