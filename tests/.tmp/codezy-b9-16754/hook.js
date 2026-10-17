const fs = require('fs')
let s = ''
process.stdin.on('data', (d) => (s += d))
process.stdin.on('end', () => {
  try { fs.writeFileSync(process.argv[2], s) } catch {}
  const code = Number(process.argv[3]) || 0
  if (code !== 0) process.stderr.write("b9 hook refused the action\n")
  process.exit(code)
})
