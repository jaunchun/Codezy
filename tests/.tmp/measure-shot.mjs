// Measures installer shot geometry: image dims, progress-bar extent, logo bbox.
import fs from 'node:fs'
import zlib from 'node:zlib'

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
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      depth = data[8]; type = data[9]; interlace = data[12]
    } else if (tag === 'IDAT') idat.push(data)
    else if (tag === 'IEND') break
    off += 12 + len
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
      }
      row[x] = v
    }
  }
  return { w, h, bpp, data: out }
}

const file = process.argv[2]
const img = decodePng(fs.readFileSync(file))
const px = (x, y) => {
  const i = (y * img.w + x) * img.bpp
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}
console.log(`image ${img.w}x${img.h} bpp=${img.bpp}`)

// 1) find progress bar: row with the longest run of non-background pixels
//    background = corner color (top-left content pixel)
const bg = px(30, 80)
console.log('bg sample @(30,80) =', bg)
for (let y = 40; y < img.h; y++) {
  let run = 0, maxRun = 0, startX = -1, best = [-1, -1]
  for (let x = 0; x < img.w; x++) {
    const [r, g, b] = px(x, y)
    const diff = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2])
    if (diff > 45) { if (run === 0) startX = x; run++; if (run > maxRun) { maxRun = run; best = [startX, x] } }
    else run = 0
  }
  if (maxRun > img.w * 0.5) console.log(`bar row y=${y}: x ${best[0]}..${best[1]} (len ${maxRun})`)
}

// 2) bar row colors at y of the longest run
function rowColors(y) {
  const seen = new Map()
  for (let x = 0; x < img.w; x++) {
    const [r, g, b] = px(x, y)
    const k = `${r},${g},${b}`
    seen.set(k, (seen.get(k) || 0) + 1)
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
}
const barRows = []
for (let y = 40; y < img.h; y++) {
  let run = 0, max = 0
  for (let x = 0; x < img.w; x++) {
    const [r, g, b] = px(x, y)
    const diff = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2])
    if (diff > 45) run++; else run = 0
    if (run > max) max = run
  }
  if (max > img.w * 0.5) barRows.push(y)
}
if (barRows.length) {
  const y = barRows[Math.floor(barRows.length / 2)]
  console.log(`bar mid row y=${y} colors:`, rowColors(y))
  console.log('bar rows y =', barRows[0], '..', barRows[barRows.length - 1], `(h=${barRows.length})`)
}

// 3) title-bar height: first row from top that is mostly bg-colored content
for (let y = 0; y < 80; y++) {
  let match = 0
  for (let x = 0; x < img.w; x += 4) {
    const [r, g, b] = px(x, y)
    if (Math.abs(r - 255) + Math.abs(g - 255) + Math.abs(b - 255) < 30) match++
  }
  if (match > (img.w / 4) * 0.7) { console.log('first mostly-white row y =', y); break }
}

// 4) blue-ish pixels (logo mark / text) bbox in content area
let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, count = 0
for (let y = 40; y < img.h; y++) for (let x = 0; x < img.w; x++) {
  const [r, g, b] = px(x, y)
  if (b > 140 && b - r > 60 && b - g > 40) {
    count++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
  }
}
console.log(`blue pixels: n=${count} bbox x ${minX}..${maxX} y ${minY}..${maxY}`)
