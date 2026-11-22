export function rotateBackupNames(names: string[], keep = 30): string[] {
  const sorted = [...names].sort()
  if (sorted.length <= keep) {
    return sorted
  }

  return sorted.slice(sorted.length - keep)
}
