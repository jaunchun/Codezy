// Generates the custom installer window assets:
//   build/installer-bg.bmp    — flat backdrop for the installing window
//   build/installer-logo.bmp  — 48×48 logo tile (rendered 2× then box-down)
// Pure Node (zlib) PNG decode + hand-rolled 24-bit BMP writer — no new deps.
// Run:  node build/gen-installer-assets.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Resvg } from '@resvg/resvg-js'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const BG = [30, 31, 34] // backdrop: near-black, Chrome-setup dark style
const LOGO = 48 // final logo control/bitmap size in px

// --- PNG decode (8-bit RGB/RGBA, non-interlaced) ---------------------------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png')
  let off = 8
  const idat = []
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const tag = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (tag === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      type = data[9]
      interlace = data[12]
    } else if (tag === 'IDAT') idat.push(data)
    else if (tag === 'IEND') break
    off += 12 + len
  }
  if (depth !== 8 || interlace !== 0 || (type !== 2 && type !== 6)) {
    throw new Error(`unsupported png: depth=${depth} type=${type} interlace=${interlace}`)
  }
  const bpp = type === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const out = Buffer.alloc(w * h * stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const row = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      } else if (filter !== 0) throw new Error('bad png filter ' + filter)
      row[x] = v
    }
  }
  return { w, h, bpp, data: out }
}

// Exact 2:1 box filter — smoother than nearest for the logo downscale.
function box2(img) {
  const { w, h, bpp, data } = img
  if (w % 2 || h % 2) throw new Error('odd dimensions')
  const ow = w / 2, oh = h / 2
  const out = Buffer.alloc(ow * oh * bpp)
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      for (let c = 0; c < bpp; c++) {
        const i0 = ((2 * y) * w + 2 * x) * bpp + c
        const s = data[i0] + data[i0 + bpp] + data[i0 + w * bpp] + data[i0 + w * bpp + bpp]
        out[(y * ow + x) * bpp + c] = Math.round(s / 4)
      }
    }
  }
  return { w: ow, h: oh, bpp, data: out }
}

// Alpha-composite over a flat color, drop to RGB.
function flatten(img, [br, bg, bb]) {
  const { w, h, bpp, data } = img
  const out = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    const r = data[i * bpp], g = data[i * bpp + 1], b = data[i * bpp + 2]
    if (bpp === 4) {
      const a = data[i * bpp + 3] / 255
      out[i * 3] = Math.round(r * a + br * (1 - a))
      out[i * 3 + 1] = Math.round(g * a + bg * (1 - a))
      out[i * 3 + 2] = Math.round(b * a + bb * (1 - a))
    } else {
      out[i * 3] = r
      out[i * 3 + 1] = g
      out[i * 3 + 2] = b
    }
  }
  return { w, h, data: out }
}

// 24-bit uncompressed BMP, bottom-up rows (what NSIS LoadImage expects).
function writeBmp(file, w, h, rgb) {
  const rowSize = Math.ceil((w * 3) / 4) * 4
  const dataSize = rowSize * h
  const buf = Buffer.alloc(14 + 40 + dataSize)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(14 + 40 + dataSize, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(w, 18)
  buf.writeInt32LE(h, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(0, 30)
  buf.writeUInt32LE(dataSize, 34)
  buf.writeInt32LE(2835, 38)
  buf.writeInt32LE(2835, 42)
  for (let y = 0; y < h; y++) {
    const src = y * w * 3
    const dst = 14 + 40 + (h - 1 - y) * rowSize
    for (let x = 0; x < w; x++) {
      buf[dst + x * 3] = rgb[src + x * 3 + 2]
      buf[dst + x * 3 + 1] = rgb[src + x * 3 + 1]
      buf[dst + x * 3 + 2] = rgb[src + x * 3]
    }
  }
  fs.writeFileSync(file, buf)
  return buf.length
}

// --- backdrop: flat dark, oversized so it covers any dialog client size ----
const bgPath = path.join(here, 'installer-bg.bmp')
const flat = Buffer.alloc(640 * 400 * 3)
for (let i = 0; i < flat.length; i += 3) {
  flat[i] = BG[0]
  flat[i + 1] = BG[1]
  flat[i + 2] = BG[2]
}
const bgSize = writeBmp(bgPath, 640, 400, flat)
console.log('wrote', bgPath, bgSize, 'bytes')

// --- logo tile: same SVG as build/icon.png, rendered at 4× then box-down ---
// The mark only (no tile background) — it blends into the flat backdrop.
// scale must be derived from the FINAL supersampled canvas S, not a constant.
const markSvg = fs.readFileSync(path.join(root, 'src/renderer/src/assets/logo-mark.svg'), 'utf8')
const inner = markSvg.slice(markSvg.indexOf('>') + 1, markSvg.lastIndexOf('</svg>')).replace(/currentColor/g, '#3d9bff')
const S = LOGO * 4
const contentCx = 64, contentCy = 64, contentW = 117
const scale = (S * 0.62) / contentW
const x = S / 2 - contentCx * scale
const y = S / 2 - contentCy * scale
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <g transform="translate(${x} ${y}) scale(${scale})">${inner}</g>
</svg>`
const png = new Resvg(svg, { fitTo: { mode: 'width', value: S } }).render().asPng()
const logo = flatten(box2(box2(decodePng(png))), BG)
const logoPath = path.join(here, 'installer-logo.bmp')
const logoSize = writeBmp(logoPath, logo.w, logo.h, logo.data)
console.log('wrote', logoPath, logoSize, 'bytes', `(${logo.w}×${logo.h})`)
