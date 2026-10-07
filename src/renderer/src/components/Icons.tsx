// Tiny inline icon set (16px, stroke-based) so the app doesn't depend on an
// icon library. All icons inherit currentColor.
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

const base = (p: P) => ({
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...p
})

export const IconFolder = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
)

export const IconChat = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
  </svg>
)

export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconTerminal = (p: P) => (
  <svg {...base(p)}>
    <path d="m4 17 6-5-6-5M12 19h8" />
  </svg>
)

export const IconGear = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.33-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.05V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09A1.7 1.7 0 0 0 21 10h.09a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.55 1Z" />
  </svg>
)

export const IconCloud = (p: P) => (
  <svg {...base(p)}>
    <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 10.2 4 4 0 0 0 7 19Z" />
  </svg>
)

export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7" />
  </svg>
)

export const IconSend = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12 20 4l-4 16-4.5-6.5Z" />
  </svg>
)

export const IconStop = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <rect x="7" y="7" width="10" height="10" rx="2" />
  </svg>
)

export const IconClip = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17a2 2 0 0 1-3-3l8-8" />
  </svg>
)

export const IconLinkFolder = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M9 14h6M13 14v3" />
  </svg>
)

export const IconUser = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </svg>
)

/** Google Drive mark (simple-icons path) — drawn as an outline so it can
 *  read as "gray = not connected / green = synced" via currentColor.
 *  viewBox pads 1 unit so the stroke doesn't clip at the edges. */
export const IconDrive = (p: P) => (
  <svg {...base(p)} viewBox="-1 -1 26 26" strokeWidth={1.5}>
    <path d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z" />
  </svg>
)

/** -- action glyphs: one stroke family, 1.8px, 16px grid ------------------- */

export const IconCopy = (p: P) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </svg>
)

export const IconQuote = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 7c-2.5 0-4 1.8-4 4.2 0 2.1 1.4 3.5 3.2 3.5.3 0 .6 0 .8-.1-.4 1.6-1.6 2.6-3 3.1M19 7c-2.5 0-4 1.8-4 4.2 0 2.1 1.4 3.5 3.2 3.5.3 0 .6 0 .8-.1-.4 1.6-1.6 2.6-3 3.1" />
  </svg>
)

export const IconBranch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6.5" cy="5.5" r="2.5" />
    <circle cx="6.5" cy="18.5" r="2.5" />
    <circle cx="17.5" cy="9" r="2.5" />
    <path d="M6.5 8v8M9 9h6a2.5 2.5 0 0 1 0 5h-3a2.5 2.5 0 0 0-2.5 2.5" />
  </svg>
)

export const IconRefresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4" />
  </svg>
)

export const IconPencil = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 20h4L20 8a2.1 2.1 0 0 0-3-3L5 17v3ZM14.5 6.5l3 3" />
  </svg>
)

export const IconPin = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 4h6l-1 6 3.5 3.5H6.5L10 10 9 4ZM12 13.5V20" />
  </svg>
)

export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </svg>
)

export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </svg>
)

export const IconX = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)

export const IconChevronUp = (p: P) => (
  <svg {...base(p)}>
    <path d="m6 14.5 6-6 6 6" />
  </svg>
)

export const IconChevronDown = (p: P) => (
  <svg {...base(p)}>
    <path d="m6 9.5 6 6 6-6" />
  </svg>
)

export const IconCommand = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 9V7a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v10a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V9Z" />
  </svg>
)

export const IconAlert = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4.5 21 20H3l9-15.5ZM12 10v4.5M12 17.4v.2" />
  </svg>
)

export const IconInfo = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8v.2" />
  </svg>
)

export const IconMinus = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12h14" />
  </svg>
)

export const IconSquare = (p: P) => (
  <svg {...base(p)}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="2" />
  </svg>
)

export const IconUndo = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 9h10.5a5 5 0 0 1 0 10H9M4 9l4-4M4 9l4 4" />
  </svg>
)

export const IconSidebar = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="M9.5 4.5v15" />
  </svg>
)

export const IconCode = (p: P) => (
  <svg {...base(p)}>
    <path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5" />
  </svg>
)

export const IconDuplicate = (p: P) => (
  <svg {...base(p)}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
    <path d="M15.5 4.5H5.5a2 2 0 0 0-2 2v10" />
  </svg>
)

export const IconDownload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15" />
  </svg>
)

/** The CODEZY cube mark (also used as the empty-state hero). */
export const CubeLogo = ({ withBrackets = false, ...p }: P & { withBrackets?: boolean }) => (
  // both variants share the 128×128 box — the mark's content is centered at
  // (64,64), so a 160-wide viewBox rendered it 16 units (10%) left of center
  <svg viewBox="0 0 128 128" fill="none" {...p}>
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M 53.6,14 Q 64,8 74.4,14 L 102.1,30 Q 112.5,36 112.5,48 L 112.5,80 Q 112.5,92 102.1,98 L 74.4,114 Q 64,120 53.6,114 L 25.9,98 Q 15.5,92 15.5,80 L 15.5,48 Q 15.5,36 25.9,30 Z M 59.1,67.4 Q 64,64 68.9,67.4 L 91.1,82.6 Q 96,86 91.1,89.4 L 68.9,104.6 Q 64,108 59.1,104.6 L 36.9,89.4 Q 32,86 36.9,82.6 Z"
    />
    {withBrackets && (
      <>
        <g fill="currentColor" transform="translate(64 86)">
          <rect x="-9" y="-1.7" width="18" height="3.4" rx="1.7" />
          <rect x="-9" y="-1.7" width="18" height="3.4" rx="1.7" transform="rotate(60)" />
          <rect x="-9" y="-1.7" width="18" height="3.4" rx="1.7" transform="rotate(120)" />
        </g>
        <path
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          d="M 22,70 L 8,86 L 22,102 M 106,70 L 120,86 L 106,102"
        />
      </>
    )}
  </svg>
)
