// One-off: build/icon.png (256×256) for electron-builder, rendered from the
// app's own logo-mark.svg — dark rounded tile + accent mark, matching the
// boot splash.  Run:  node build/gen-icon.mjs
import fs from 'node:fs'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const markSvg = fs.readFileSync(path.join(root, 'src/renderer/src/assets/logo-mark.svg'), 'utf8')
const inner = markSvg.slice(markSvg.indexOf('>') + 1, markSvg.lastIndexOf('</svg>')).replace(/currentColor/g, '#3d9bff')

const S = 256
// The mark's DRAWN content (incl. stroke) spans x 5.5–122.5, y 8–120 — its
// real center is (64, 64), the same in either viewBox. Center on the CONTENT,
// not the box: centering the 160-wide box (old viewBox) pushed the logo 19px
// left of the tile.
const contentCx = 64
const contentCy = 64
const contentW = 117 // 122.5 - 5.5
const scale = 190 / contentW // mark ≈190px wide inside the 256px tile
const x = S / 2 - contentCx * scale
const y = S / 2 - contentCy * scale

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#151524"/>
      <stop offset="1" stop-color="#0b0b12"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" rx="56" fill="url(#bg)"/>
  <rect x="2" y="2" width="${S - 4}" height="${S - 4}" rx="54" fill="none" stroke="#3d9bff" stroke-opacity="0.4" stroke-width="3"/>
  <g transform="translate(${x} ${y}) scale(${scale})">${inner}</g>
</svg>`

const png = new Resvg(svg, { fitTo: { mode: 'width', value: S } }).render().asPng()
const out = path.join(root, 'build', 'icon.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log('wrote', out, png.length, 'bytes')
