import { memo, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { keys } from '../utils/platform'

export interface MenuAction {
  label: string
  icon: IconName
  onSelect: () => void
  testId?: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  separatorBefore?: boolean
}

/** A compact popover menu: keeps rarely used actions one click away instead of on screen. */
function ActionsMenuView({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const items = () => [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    items()[0]?.focus()
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); root.current?.querySelector<HTMLButtonElement>('.menu-trigger')?.focus(); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const list = items()
      const index = list.indexOf(document.activeElement as HTMLButtonElement)
      list[(index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [open])

  return <div className="actions-menu" ref={root}>
    <button type="button" className="menu-trigger" aria-label={label} data-tip={label} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(!open)}><Icon name="more" size={18} /></button>
    {open && <div className="menu-panel" role="menu" aria-label={label}>
      {actions.map((action) => <div key={action.label} className="menu-entry">
        {action.separatorBefore && <hr className="menu-separator" />}
        <button type="button" role="menuitem" data-testid={action.testId} disabled={action.disabled}
          className={action.danger ? 'menu-item danger-text' : 'menu-item'}
          onClick={() => { setOpen(false); action.onSelect() }}>
          <Icon name={action.icon} size={15} /><span>{action.label}</span>{action.shortcut && <kbd>{keys(action.shortcut)}</kbd>}
        </button>
      </div>)}
    </div>}
  </div>
}

export const ActionsMenu = memo(ActionsMenuView)
