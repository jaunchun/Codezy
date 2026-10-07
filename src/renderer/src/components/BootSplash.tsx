import { useEffect, useRef, useState } from 'react'
import { CubeLogo } from './Icons'

/**
 * v2.3 startup splash — the logo pops in at the middle of the window while
 * init loads, then flies onto its perch in the title bar the moment the app
 * is ready. The target is measured against the real `.titlebar .logo`, so it
 * lands exactly on top of it and hands over invisibly (the mark fades out over
 * the last frames). One quick arc — entrance → path → hand-off.
 */
export default function BootSplash({ ready }: { ready: boolean }) {
  const mark = useRef<HTMLDivElement>(null)
  const [flying, setFlying] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    if (!ready || gone) return
    const el = mark.current
    const target = document.querySelector<HTMLElement>('.titlebar .logo')
    const from = el?.getBoundingClientRect()
    const to = target?.getBoundingClientRect()

    if (el && from && to && from.width >= 4 && to.width >= 4) {
      // FLIP: pin the mark where it is (out of the grid flow), then move it
      const s = to.width / from.width
      const dx = to.left + to.width / 2 - (from.left + (from.width * s) / 2)
      const dy = to.top + to.height / 2 - (from.top + (from.height * s) / 2)
      const land = `translate(${dx}px, ${dy}px) scale(${s})`
      el.style.position = 'fixed'
      el.style.left = `${from.left}px`
      el.style.top = `${from.top}px`
      el.style.margin = '0'
      if (typeof el.animate === 'function') {
        // arc: bulge up on the way, settle onto the title bar, then fade out
        // over the last frames while the real logo shows through beneath
        void el.animate(
          [
            { transform: 'translate(0, 0) scale(1)', opacity: 1 },
            {
              transform: `translate(${dx * 0.5}px, ${dy * 0.26 - 30}px) scale(${1 + (s - 1) * 0.55})`,
              opacity: 1,
              offset: 0.5
            },
            { transform: land, opacity: 1, offset: 0.82 },
            { transform: land, opacity: 0 }
          ],
          { duration: 700, easing: 'cubic-bezier(0.65, 0, 0.25, 1)', fill: 'forwards' }
        )
      } else {
        el.style.transition = 'transform 0.64s cubic-bezier(0.6, 0, 0.2, 1), opacity 0.16s ease 0.5s'
        void el.offsetWidth // reflow — start from the pinned spot
        el.style.transform = land
        el.style.opacity = '0'
      }
    }
    setFlying(true)
    const t = window.setTimeout(() => setGone(true), 740)
    return () => window.clearTimeout(t)
  }, [ready, gone])

  if (gone) return null
  return (
    <div className={`boot${flying ? ' flying' : ''}`} aria-hidden="true">
      <div className="boot-glow" />
      <div className="boot-logo">
        <div className="boot-mark" ref={mark}>
          <CubeLogo />
          <span>CODEZY</span>
        </div>
      </div>
    </div>
  )
}
