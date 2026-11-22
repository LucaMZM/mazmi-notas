import type { MouseEvent, PointerEvent } from 'react'

let lastPointer = 'mouse'

/**
 * Handlers that run an action on mouse/pen press instead of on release, like native macOS lists.
 * That removes the ~100 ms between pressing and releasing. Keyboard activation (click with
 * detail 0) and touch (where a press may start a scroll) still use the regular click.
 */
export function onPress(action: () => void) {
  return {
    onPointerDown(event: PointerEvent) {
      lastPointer = event.pointerType
      if (event.pointerType === 'touch' || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      action()
    },
    onClick(event: MouseEvent) {
      if (event.detail === 0 || lastPointer === 'touch') action()
    },
  }
}
