/** Shortcut labels follow the platform: ⌘ ⌥ ⇧ on macOS, Ctrl / Alt / Mayús elsewhere (Windows build). */
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export function keys(label: string): string {
  if (isMac) return label
  return label.replace(/⌘/g, 'Ctrl+').replace(/⌥/g, 'Alt+').replace(/⇧/g, 'Mayús+').replace(/\+(?=\s|$|·)/g, '')
}
