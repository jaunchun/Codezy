// Full color histogram of the client area + bbox of every non-dominant color.
import fs from 'node:fs'
import zlib from 'node:zlib'

function decodePng(buf) {
  let off = 8
  const idat = []
  let w = 0, h = 0, type = 0
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const tag = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (tag === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9] }
    else if (tag === 'IDAT') idat.push(data)
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
console.log(`image ${img.w}x${img.h}`)
const hist = new Map()
const bbox = new Map()
for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
  const i = (y * img.w + x) * img.bpp
  const k = `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`
  hist.set(k, (hist.get(k) || 0) + 1)
  const bb = bbox.get(k)
  if (bb) { if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y }
  else bbox.set(k, [x, y, x, y])
}
const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1])
for (const [k, n] of sorted.slice(0, 15)) console.log(`${k}  n=${n}  bbox=${bbox.get(k).join(',')}`)
console.log('distinct colors:', sorted.length)
