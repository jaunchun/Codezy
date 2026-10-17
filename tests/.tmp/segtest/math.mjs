// exact replay of the built inTri + onTrajectory with probe-measured numbers
const inTri = (p, a, b, c) => {
  const side = (o, u, v) => (u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x)
  const d1 = side(p, a, b)
  const d2 = side(p, b, c)
  const d3 = side(p, c, a)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return { inside: !(neg && pos), d1, d2, d3 }
}

const from = { x: 636.609375, y: 764.5 }   // leave-event coords per probe log
const p = { x: 636.609375, y: 764.5 }      // the window pointermove coords
const pr = { left: 504, right: 651, bottom: 761 }
const br = { left: 504, right: 651, top: 768 } // fab rect guess: pop right == fab right-ish

console.log('fan1 (climb):', inTri(p, from, { x: pr.left, y: pr.bottom }, { x: pr.right, y: pr.bottom }))
console.log('fan2 (descend):', inTri(p, from, { x: br.left, y: br.top }, { x: br.right, y: br.top }))

// also the drive.mjs first-run numbers (pop x605..751, badge center 783)
const from2 = { x: 678, y: 765 }
const p2 = { x: 678, y: 765 }
console.log('run2 fan1:', inTri(p2, from2, { x: 605, y: 761 }, { x: 751, y: 761 }))
