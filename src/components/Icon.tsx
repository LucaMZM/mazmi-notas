import type { ReactNode } from 'react'

export type IconName =
  | 'plus' | 'search' | 'notes' | 'trash' | 'settings'
  | 'panel' | 'link' | 'history' | 'save' | 'copy' | 'export'
  | 'close' | 'chevron' | 'chevron-down' | 'arrow' | 'check' | 'tag' | 'command'
  | 'file' | 'restore' | 'type' | 'eraser' | 'code' | 'more' | 'word' | 'folder' | 'folder-plus' | 'inbox' | 'bell' | 'image' | 'lock' | 'unlock'
  | 'align-left' | 'align-center' | 'align-right' | 'align-justify'

const shapes: Record<IconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></>,
  notes: <><rect x="5" y="3.5" width="15" height="17" rx="2.5" /><path d="M5 8H3M5 12H3M5 16H3M9 8h7M9 12h7M9 16h4" /></>,
  trash: <><path d="M4 6.5h16M9 6.5V4h6v2.5M6 6.5l1 14h10l1-14M10 10v7M14 10v7" /></>,
  settings: <><path d="M4 6h3M11 6h9M4 12h9M17 12h3M4 18h3M11 18h9" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></>,
  panel: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9 4.5v15M5.8 8h.2M5.8 11h.2" /></>,
  link: <><path d="m10 8 2.7-2.7a4.2 4.2 0 0 1 6 6L16 14M14 16l-2.7 2.7a4.2 4.2 0 0 1-6-6L8 10M8.5 15.5l7-7" /></>,
  history: <><path d="M4 10a8.2 8.2 0 1 1 .8 6M4 4v6h6M12 7.5V12l3 2" /></>,
  save: <><path d="M5 3.5h12l3.5 3.7V20.5h-17v-17ZM8 3.5v6h8v-6M8 20.5v-7h8v7" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2.3" /><path d="M15 8V3H3v13h5" /></>,
  export: <><path d="M12 15V3m-4 4 4-4 4 4M5 12v8h14v-8" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  'chevron-down': <path d="m7 10 5 5 5-5" />,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />,
  'folder-plus': <><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" /><path d="M12 11v5M9.5 13.5h5" /></>,
  inbox: <><path d="M4 13.5 6.5 5h11l2.5 8.5v5H4Z" /><path d="M4 13.5h4.5l1 2h5l1-2H20" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2.2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  unlock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2.2" /><path d="M8 10.5V8a4 4 0 0 1 7.6-1.7" /></>,
  bell: <><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5Z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m4.5 18 5-5 3.5 3.5 2.5-2.5 4 4" /></>,
  more: <><circle cx="6" cy="12" r="1.1" /><circle cx="12" cy="12" r="1.1" /><circle cx="18" cy="12" r="1.1" /></>,
  word: <><path d="M14 3.5H6v17h12V7.5ZM14 3.5v4h4" /><path d="m8.8 11 1.3 5.5L12 12l1.9 4.5L15.2 11" /></>,
  type: <><path d="M3.5 18 8 6l4.5 12M5.2 13.6h5.6M14.5 11.5c.6-1 1.6-1.5 2.9-1.5 1.9 0 3.1 1.1 3.1 3V18M20.5 14.6c-.9-.3-1.8-.4-2.8-.4-1.9 0-3.2.8-3.2 2.1 0 1.1.9 1.8 2.2 1.8 1.6 0 2.9-1 3.8-2.3" /></>,
  eraser: <><path d="m14 4.5 5.5 5.5-8.5 8.5H6.5L4 16l10-11.5ZM9 9.5l5.5 5.5M11 18.5h8.5" /></>,
  code: <path d="m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5M13.5 5.5l-3 13" />,
  'align-left': <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  'align-center': <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  'align-right': <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
  'align-justify': <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  tag: <><path d="M3.5 4h8l9 9-8 8-9-9Z" /><circle cx="8" cy="8.5" r="1" /></>,
  command: <><path d="M8 8h8v8H8ZM8 8H5.5A2.5 2.5 0 1 1 8 5.5ZM16 8V5.5A2.5 2.5 0 1 1 18.5 8ZM16 16h2.5a2.5 2.5 0 1 1-2.5 2.5ZM8 16v2.5A2.5 2.5 0 1 1 5.5 16Z" /></>,
  file: <><path d="M14 3.5H5v17h14V8.5ZM14 3.5v5h5M8.5 12h7M8.5 16h5" /></>,
  restore: <><path d="M5 8a8 8 0 1 1-1 8M5 3v5h5M9 12l3-3 3 3M12 9v8" /></>,
}

export function Icon({ name, size = 18, className }: {
  name: IconName
  size?: number
  className?: string
}) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">{shapes[name]}</svg>
}
