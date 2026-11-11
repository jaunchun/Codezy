import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/** Open traps, newest last — only the top dialogue answers Tab/Escape. */
const stack: symbol[] = []

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('hidden') && el.offsetParent !== null && el.getAttribute('aria-hidden') !== 'true'
  )
}

/**
 * Keeps keyboard focus inside an open dialog and gives it back on close.
 *
 * - Tab / Shift+Tab cycle within `ref` (wrapping at both ends).
 * - Escape calls `onEscape` (latest render's closure) without re-running the
 *   effect, so dialogs don't lose and regain focus on every keypress.
 * - The element focused before opening is restored on unmount/close.
 * - `initial` can override where focus starts (e.g. a search input).
 *
 * Renders are cheap: the effect only re-runs when `active` changes.
 */
export function useFocusTrap(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  onEscape?: () => void,
  initial?: RefObject<HTMLElement | null>
): void {
  const escape = useRef(onEscape)
  escape.current = onEscape

  useEffect(() => {
    if (!active) return
    const root = ref.current
    if (!root) return
    const id = Symbol('trap')
    stack.push(id)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusFirst = (): void => {
      const preferred = initial?.current
      if (preferred && root.contains(preferred)) {
        preferred.focus()
        return
      }
      const items = focusable(root)
      if (items.length) items[0].focus()
      else {
        root.tabIndex = -1
        root.focus()
      }
    }
    // wait one frame: the dialog just mounted and its refs are fresh. jsdom
    // harnesses without pretendToBeVisual have no rAF — focus synchronously.
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(focusFirst) : 0
    if (!raf) focusFirst()

    const onKey = (e: KeyboardEvent): void => {
      if (stack[stack.length - 1] !== id) return // a newer dialogue is on top
      if (e.key === 'Escape' && escape.current) {
        e.preventDefault()
        e.stopPropagation()
        escape.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusable(root)
      if (!items.length) {
        e.preventDefault()
        root.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const here = document.activeElement
      if (e.shiftKey) {
        if (here === first || !root.contains(here)) {
          e.preventDefault()
          last.focus()
        }
      } else if (here === last || !root.contains(here)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey, true)
    return () => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey, true)
      const at = stack.lastIndexOf(id)
      if (at !== -1) stack.splice(at, 1)
      if (previous?.isConnected) previous.focus()
    }
    // `initial` is a stable ref; `onEscape` is read through the ref above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref])
}
