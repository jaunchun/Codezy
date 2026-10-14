import { useEffect, useRef } from 'react'

type Star = { x: number; y: number; z: number; tw: number; sp: number }
type Spark = { a: number; r: number; w: number }
type Flare = { r: number; life: number }
type Streak = { x: number; y: number; len: number; sp: number; a: number; wd: number }
type Dust = { x: number; y: number; z: number; ph: number }

function grey(v: number, a: number): string {
  const c = Math.max(0, Math.min(255, v)) | 0
  return `rgba(${c},${c},${c},${Math.max(0, Math.min(1, a))})`
}

/**
 * singularity — the animated black-hole backdrop for the `singularity` theme.
 *
 * The black hole is *rendered*, not stroked: every frame a small offscreen
 * buffer (~0.4× resolution) is filled pixel by pixel as if by a ray tracer —
 * a Doppler-beamed accretion disk, a thin white photon ring hugging the
 * event horizon that gathers into a blazing arc on the approaching side, and
 * gravitational lensing that bends the far side of the disk over the top of
 * the shadow — then upscaled with smoothing onto the full window. The glow
 * and bloom are layered on afterwards with cheap full-screen gradients, so
 * the hole itself stays crisp and the shadow pure black while the heavy
 * maths stays on a fraction of the pixels. On a slow machine the loop
 * throttles itself to half rate automatically.
 *
 * Everything is strict monochrome: black shadow, white/grey light. Stars,
 * the light cascade on the left, cosmic dust, infalling sparks and grain are
 * overlaid additively. Idle cost is a single rAF loop; it pauses while the
 * window is hidden and draws one static frame when motion is reduced.
 */
export default function SingularityBg() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let running = false
    let w = 0
    let h = 0
    let t = 0
    let last = 0
    let stars: Star[] = []
    let sparks: Spark[] = []
    let flares: Flare[] = []
    let streaks: Streak[] = []
    let dust: Dust[] = []

    // low-res render buffer — the "ray tracer" works here
    let s = 0.4 // buffer scale (high enough to stay sharp, low enough to be cheap)
    let bCanvas: HTMLCanvasElement | null = null
    let bctx: CanvasRenderingContext2D | null = null
    let img: ImageData | null = null

    // adaptive performance governor
    let slow = false
    let ftick = 0
    let accMs = 0

    const reduceMotion = () =>
      document.documentElement.dataset.motion === 'off' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const rand = (a: number, b: number) => a + Math.random() * (b - a)

    const spawnSpark = (spread = false): Spark => ({
      a: Math.random() * Math.PI * 2,
      r: spread ? 0.62 + Math.random() * 0.7 : 1.04 + Math.random() * 0.24,
      w: (0.55 + Math.random() * 0.9) * (Math.random() < 0.5 ? -1 : 1)
    })

    const seed = () => {
      stars = []
      const n = Math.min(340, Math.max(90, Math.round((w * h) / 6800)))
      for (let i = 0; i < n; i++) {
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          z: 0.3 + Math.random() * 0.7,
          tw: Math.random() * Math.PI * 2,
          sp: 0.5 + Math.random() * 1.6
        })
      }
      sparks = Array.from({ length: 22 }, () => spawnSpark(true))
      flares = []
      streaks = Array.from({ length: 70 }, () => {
        const x = Math.pow(Math.random(), 1.7) * w * 0.58
        const len = rand(70, 240)
        return { x, y: rand(-h, h), len, sp: rand(40, 190), a: rand(0.07, 0.4), wd: rand(0.8, 2.6) }
      })
      dust = Array.from({ length: 260 }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        z: 0.25 + Math.random() * 0.75,
        ph: Math.random() * Math.PI * 2
      }))
    }

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.35)
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (w * h > 3_200_000) s = 0.3 // very large screens: lighter buffer
      const bw = Math.max(32, Math.round(w * s))
      const bh = Math.max(32, Math.round(h * s))
      bCanvas = document.createElement('canvas')
      bCanvas.width = bw
      bCanvas.height = bh
      bctx = bCanvas.getContext('2d')
      img = bctx ? bctx.createImageData(bw, bh) : null
      seed()
    }

    // screen-space size of the shadow (CSS px) — matches the buffer's.
    // Deliberately large: the scene is read through a 66%-black frosted pane.
    let screenR = Math.max(54, Math.min(w, h) * 0.16)

    /** Integer hash → [0,1). Dirt cheap — no trig per sample. */
    const hash = (n: number) => {
      let x = ((n | 0) * 374761393 + 668265263) | 0
      x = Math.imul(x ^ (x >>> 13), 1274126177)
      return ((x ^ (x >>> 16)) >>> 0) / 4294967296
    }

    /**
     * Seamless value noise — periodic in x with period `per`, smooth in both
     * axes. Wrapping the integer lattice makes azimuthal texture close on
     * itself, so no seam ever appears where ±π meets.
     */
    const pnoise = (x: number, y: number, per: number, seed: number) => {
      let xi = Math.floor(x)
      const yi = Math.floor(y)
      const xf = x - xi
      const yf = y - yi
      const u = xf * xf * (3 - 2 * xf)
      const v = yf * yf * (3 - 2 * yf)
      xi = ((xi % per) + per) % per
      const x2 = (xi + 1) % per
      const y0 = yi * 61 + seed
      const y1 = (yi + 1) * 61 + seed
      const a = hash(xi * 157 + y0)
      const b = hash(x2 * 157 + y0)
      const c = hash(xi * 157 + y1)
      const d = hash(x2 * 157 + y1)
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
    }

    /** Emission of the accretion disk at plane radius r (plane coords X, Y). */
    const diskLum = (r: number, X: number, Y: number, t: number, R: number, inn: number) => {
      const aP = Math.atan2(Y, X)
      const g = inn / r
      const lr = Math.log(r / inn) // 0 at the inner edge, grows outward

      // — relativistic beaming — the approaching side blows out to pure
      //   white, the receding side cools to deep grey but never vanishes
      const mu = 0.5 + 0.5 * Math.cos(aP - Math.PI)
      const dop = 0.15 + 0.85 * Math.pow(mu, 1.7)

      // — radial structure — a blinding rim where gas meets the ISCO, a
      //   gentle shoulder mid-disk so the falloff isn't monotone, then a
      //   soft power-law taper that dissolves into the void with no edge
      const rim = 1.6 * Math.exp(-(((r - inn) / (R * 0.09)) ** 2))
      const shoulder = 0.35 * Math.exp(-(((r - inn * 1.6) / (R * 0.6)) ** 2))
      const taper = 1 / (1 + ((r - inn) / (R * 2.1)) ** 3)
      const body = (Math.pow(g, 1.3) + shoulder) * taper

      // — turbulence — seamless value noise in (azimuth × log-radius)
      //   space. Differential rotation winds it into spiral shear (inner
      //   gas laps the outer many times per orbit); the phase only ever
      //   rotates, it never travels outward — streaking gas, not ripples
      //   on water. Radial frequency runs high and azimuthal low, so
      //   features smear into filaments along the orbit like real shear.
      const shear = t * 1.35 * Math.pow(g, 0.75)
      const ax = (aP / Math.PI + 1) * 4 // 8 azimuthal cells around the ring
      const n1 = pnoise(ax + shear, lr * 3.2, 8, 7)
      const n2 = pnoise(ax * 2 + shear * 1.9, lr * 7.4 + 5.3, 16, 29)
      const n3 = pnoise(ax * 1.5 + shear * 2.6, lr * 17.6 + 11.7, 12, 53)
      const n4 = pnoise(ax * 3 + shear * 3.4, lr * 35.2 + 23.1, 24, 91)
      // high-contrast mapping — threads read as sharp strands of gas, with
      // dark gaps between them, instead of smooth blobs
      const mix = n1 * 0.3 + n2 * 0.28 + n3 * 0.27 + n4 * 0.15
      const turb = 0.34 + 1.18 * Math.pow(mix, 1.6)

      // — large-scale arms slowly turning with the flow
      const macro = 0.82 + 0.18 * Math.sin(2 * (aP + shear * 0.35) + lr * 2)

      return (body * macro + rim) * dop * turb * 1.35
    }

    /** Fill the offscreen buffer with the rendered black hole scene. */
    const render = () => {
      if (!bctx || !img || !bCanvas) return
      const data = img.data
      const bw = img.width
      const bh = img.height
      const cxS = bw * 0.5
      const cyS = bh * 0.5
      const R = Math.max(7, screenR * s) * (1 + 0.012 * Math.sin(t * 0.5))
      const inn = R * 1.22
      const outR = R * 4.4
      // inclination: the disk is seen almost EDGE-ON (sin i ≈ 0.18), like the
      // reference renders — a thin band sweeping past, not an open top-down
      // ellipse. The far side is lensed over the top by the crown term below.
      const k = 0.18
      const kInv = 1 / k
      // the disk's line of nodes is tilted — the band sweeps lower-left to
      // upper-right like the reference renders, instead of lying flat
      const TILT = -0.26 // ≈ -15°
      const ct = Math.cos(TILT)
      const st = Math.sin(TILT)
      let o = 0
      for (let by = 0; by < bh; by++) {
        const dy0 = by - cyS
        for (let bx = 0; bx < bw; bx++) {
          const dx = bx - cxS
          const rs = Math.sqrt(dx * dx + dy0 * dy0)
          // the disk plane is tilted: un-rotate the pixel into disk frame
          const u = dx * ct + dy0 * st
          const v = -dx * st + dy0 * ct
          const Y = v * kInv
          const rr = Math.sqrt(u * u + Y * Y)
          // · the near half of the edge-on disk, crossing IN FRONT of the
          //   shadow — foreshortened to a thin band by the low inclination
          const diskL = v >= 0 && rr > inn && rr < outR ? diskLum(rr, u, Y, t, R, inn) : 0
          let l: number
          if (rs < R) {
            // event horizon — only the near band passes in front of it
            l = diskL
          } else {
            l = diskL
            const aS = Math.atan2(v, u) // azimuth in the disk's frame
            const dph = Math.pow(0.5 + 0.5 * Math.cos(aS - Math.PI), 1.25)
            // · photon ring — a thin, blinding rim burned into the horizon's
            //   edge, visible all the way round, hotter on the approach side
            l += 1.8 * Math.exp(-(((rs - R * 1.035) / (R * 0.04)) ** 2)) * (0.6 + 0.4 * dph)
            // · the secondary image — the disk's far side after half an orbit,
            //   a thin arc stacked just outside the photon ring, strongest
            //   where it crosses over the top and under the bottom
            const polar = Math.abs(v) / rs
            l += 0.55 * Math.pow(polar, 1.6) * (0.5 + 0.5 * dph) *
              Math.exp(-(((rs - R * 1.17) / (R * 0.06)) ** 2))
            // · the main lensed arc — the far side of the disk draped over
            //   the shadow. Blinding at the inner edge, decaying outward;
            //   tight against the horizon at the sides, ballooning over the
            //   top; blazing white on the approaching (left) side.
            const facing = Math.max(0, -v / rs)
            const cw = 0.18 + 0.55 * facing
            l += 1.2 * (0.25 + 0.75 * facing) * (0.4 + 0.6 * dph) *
              Math.exp(-(rs - R) / (R * cw))
            // · the under-image — the mirror sliver lensed BELOW the shadow
            const under = Math.max(0, v / rs)
            l += 0.5 * (0.3 + 0.7 * under) * (0.35 + 0.65 * dph) *
              Math.exp(-(((rs - R) / (R * (0.09 + 0.14 * under))) ** 2))
          }
          // filmic rolloff — highlights saturate smoothly to blinding white
          // instead of hard-clipping, the way a real exposure blooms
          const px = (255 * (1 - Math.exp(-l * 1.5))) | 0
          data[o++] = px
          data[o++] = px
          data[o++] = px
          data[o++] = 255
        }
      }
      bctx.putImageData(img, 0, 0)
      // upscale the little render onto the full window with smoothing →
      // creamier, more "rendered" light than any vector strokes
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bCanvas, 0, 0, bw, bh, 0, 0, w, h)
    }

    /** Twinkling starfield. */
    const field = () => {
      for (const st of stars) {
        const tw = 0.4 + 0.6 * Math.sin(t * st.sp + st.tw)
        const x = st.x
        const y = st.y
        const sz = 0.7 + st.z * 1.5
        ctx.globalAlpha = tw * (0.35 + st.z * 0.65)
        ctx.fillStyle = '#e8e8e8'
        ctx.fillRect(x, y, sz, sz)
        if (st.z > 0.88) {
          ctx.globalAlpha = tw * 0.35
          ctx.fillRect(x - sz * 1.9, y + sz * 0.4, sz * 4.8, 0.7)
          ctx.fillRect(x + sz * 0.4, y - sz * 1.9, 0.7, sz * 4.8)
        }
      }
      ctx.globalAlpha = 1
    }

    /** The vertical cascade of light pouring down the left half of the screen. */
    const lightfall = (dt: number) => {
      const col = ctx.createLinearGradient(0, 0, w * 0.5, 0)
      const pulse = 0.03 + 0.015 * Math.sin(t * 0.7)
      col.addColorStop(0, `rgba(255,255,255,${pulse * 0.4})`)
      col.addColorStop(0.2, `rgba(255,255,255,${pulse * 1.4})`)
      col.addColorStop(0.5, `rgba(255,255,255,${pulse * 0.4})`)
      col.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = col
      ctx.fillRect(0, 0, w * 0.5, h)

      for (const st of streaks) {
        st.y += st.sp * dt
        if (st.y - st.len > h) {
          st.y = -st.len * 0.4
          st.x = Math.pow(Math.random(), 1.7) * w * 0.58
          st.a = rand(0.07, 0.4)
          st.sp = rand(40, 190)
        }
        const g = ctx.createLinearGradient(0, st.y - st.len, 0, st.y)
        g.addColorStop(0, 'rgba(255,255,255,0)')
        g.addColorStop(1, `rgba(255,255,255,${st.a})`)
        ctx.strokeStyle = g
        ctx.lineWidth = st.wd
        ctx.beginPath()
        ctx.moveTo(st.x, st.y - st.len)
        ctx.lineTo(st.x, st.y)
        ctx.stroke()
        ctx.fillStyle = `rgba(255,255,255,${Math.min(0.7, st.a * 1.6)})`
        ctx.fillRect(st.x - st.wd * 0.5, st.y - 1, st.wd, 2)
      }
    }

    /** Cosmic dust that spirals along the light rings and drifts down. */
    const dustLayer = (dt: number) => {
      const cx = w * 0.5
      const cy = h * 0.5
      for (const d of dust) {
        const dx = d.x - cx
        const dy = (d.y - cy) / 0.18
        const dist = Math.hypot(dx, dy) + 1
        const sp = (30 * d.z) / (dist / screenR + 0.9)
        d.x += (-dy / dist) * sp * dt + Math.sin(t * 0.3 + d.ph) * 7 * dt
        d.y += (dx / dist) * sp * dt * 0.18 + (9 + d.z * 16) * dt
        if (d.y > h + 12 || d.x < -12 || d.x > w + 12) {
          d.x = Math.random() * w
          d.y = -8
          d.z = 0.25 + Math.random() * 0.75
        }
        const tw = 0.35 + 0.65 * Math.sin(t * 1.6 + d.ph)
        ctx.fillStyle = grey(255, 0.28 * d.z * tw)
        ctx.fillRect(d.x, d.y, 1.1, 1.1)
      }
    }

    /** Sparks spiralling in, plus the flares they kick up at the horizon. */
    const infall = () => {
      const R = screenR
      for (const sp of sparks) {
        const prev = sp.a
        sp.a += sp.w * (0.9 / (sp.r * 1.5 + 0.25)) * 0.016
        sp.r -= 0.0024 * (1.25 - sp.r) * 1.7
        if (sp.r <= 0.4) {
          flares.push({ r: R * 1.02, life: 1 })
          Object.assign(sp, spawnSpark())
          continue
        }
        const rr = sp.r * R * 4.2
        const x = w * 0.5 + Math.cos(sp.a) * rr
        const y = h * 0.5 + Math.sin(sp.a) * rr * 0.18
        const x2 = w * 0.5 + Math.cos(prev) * rr
        const y2 = h * 0.5 + Math.sin(prev) * rr * 0.18
        const fade = Math.min(1, (1.35 - sp.r) * 2.2) * 0.7
        ctx.strokeStyle = grey(228, 0.4 * fade)
        ctx.lineWidth = 1.3
        ctx.beginPath()
        ctx.moveTo(x2, y2)
        ctx.lineTo(x, y)
        ctx.stroke()
        ctx.fillStyle = grey(255, 0.85 * fade)
        ctx.fillRect(x - 1, y - 1, 2.1, 2.1)
      }
      for (let i = flares.length - 1; i >= 0; i--) {
        const fl = flares[i]
        fl.life -= 0.035
        if (fl.life <= 0) {
          flares.splice(i, 1)
          continue
        }
        ctx.strokeStyle = grey(190, fl.life * 0.45)
        ctx.lineWidth = 2 + (1 - fl.life) * 5
        ctx.beginPath()
        ctx.arc(w * 0.5, h * 0.5, fl.r + (1 - fl.life) * R * 0.5, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (flares.length > 60) flares.splice(0, flares.length - 60)
    }

    /** A faint, constantly redrawn grain so the void never looks frozen. */
    const grain = () => {
      for (let i = 0; i < 140; i++) {
        ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`
        ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1)
      }
    }

    const draw = (dt: number) => {
      screenR = Math.max(54, Math.min(w, h) * 0.16)

      // 1 · the rendered black hole (opaque — replaces the previous frame)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      render()

      // 2 · bloom — an elliptical glow lying IN the disk plane (tilted with
      //    it), so the light spills along the band the way real glare does,
      //    plus a wide soft halo. Kept out of the per-pixel render so the
      //    hole stays crisp and the shadow pure black.
      const cx = w * 0.5
      const cy = h * 0.5
      const gp = 0.82 + 0.18 * Math.sin(t * 1.3)
      ctx.globalCompositeOperation = 'lighter'
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(-0.26)
      ctx.scale(1, 0.34)
      const ge = ctx.createRadialGradient(0, 0, 0, 0, 0, screenR * 4.6)
      ge.addColorStop(0, 'rgba(255,255,255,0)')
      ge.addColorStop(0.24, 'rgba(255,255,255,0)') // hollow — shadow stays black
      ge.addColorStop(0.3, `rgba(255,255,255,${0.3 * gp})`)
      ge.addColorStop(0.5, `rgba(255,255,255,${0.1 * gp})`)
      ge.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = ge
      ctx.fillRect(-w, -h, w * 2, h * 2)
      ctx.restore()
      // anamorphic horizontal streak through the hole — the classic lens
      // flare of something blindingly bright behind glass
      const gs = ctx.createLinearGradient(cx - screenR * 5.5, cy, cx + screenR * 5.5, cy)
      gs.addColorStop(0, 'rgba(255,255,255,0)')
      gs.addColorStop(0.42, `rgba(255,255,255,${0.05 * gp})`)
      gs.addColorStop(0.5, `rgba(255,255,255,${0.09 * gp})`)
      gs.addColorStop(0.58, `rgba(255,255,255,${0.05 * gp})`)
      gs.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = gs
      ctx.fillRect(cx - screenR * 5.5, cy - 1.6, screenR * 11, 3.2)
      const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, screenR * 5)
      g2.addColorStop(0, 'rgba(255,255,255,0)')
      g2.addColorStop(0.4, `rgba(255,255,255,${0.05 * gp})`)
      g2.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g2
      ctx.fillRect(0, 0, w, h)

      // 3 · everything else on top, additive
      field()
      lightfall(dt)
      infall()
      dustLayer(dt)
      grain()

      // 4 · vignette — the void deepens toward the corners, so the eye is
      //    pulled to the horizon at the centre
      ctx.globalCompositeOperation = 'source-over'
      const gv = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.32, cx, cy, Math.max(w, h) * 0.72)
      gv.addColorStop(0, 'rgba(0,0,0,0)')
      gv.addColorStop(1, 'rgba(0,0,0,0.5)')
      ctx.fillStyle = gv
      ctx.fillRect(0, 0, w, h)

      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    const frame = (now: number) => {
      if (!running) return
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016
      last = now
      if (reduceMotion()) {
        t = 9
        draw(0)
        running = false
        return
      }
      t += dt
      // adaptive governor: if the machine is struggling, run every other frame
      accMs += dt * 1000
      ftick++
      if (ftick >= 50) {
        if (accMs / 50 > 19) slow = true
        ftick = 0
        accMs = 0
      }
      if (slow && now % 2 < 1) {
        raf = requestAnimationFrame(frame)
        return
      }
      draw(dt)
      raf = requestAnimationFrame(frame)
    }

    const start = () => {
      if (running) return
      running = true
      last = 0
      raf = requestAnimationFrame(frame)
    }

    const stop = () => {
      running = false
      cancelAnimationFrame(raf)
    }

    const onVisibility = () => (document.hidden ? stop() : start())
    const onMotion = () => {
      stop()
      start()
    }

    size()
    start()
    window.addEventListener('resize', size)
    document.addEventListener('visibilitychange', onVisibility)
    const mo = new MutationObserver(onMotion)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })

    return () => {
      stop()
      window.removeEventListener('resize', size)
      document.removeEventListener('visibilitychange', onVisibility)
      mo.disconnect()
    }
  }, [])

  return <canvas ref={ref} className="singularity-bg" aria-hidden="true" />
}