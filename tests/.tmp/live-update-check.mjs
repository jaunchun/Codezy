// Live check: bundle src/main/update.ts for real, run it against GitHub.
import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const outfile = path.join(here, 'live-update.bundle.mjs')

await build({
  entryPoints: [path.join(root, 'src', 'main', 'update.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent'
})

const mod = await import(pathToFileURL(outfile).href + `?v=${Date.now()}`)
const { checkForUpdates, evaluateReleases, UPDATE_REPO } = mod

console.log('REPO:', UPDATE_REPO)

// What each installed version would be told right now:
for (const v of ['2.3.0', '2.5.0', '2.6.0', '2.7.0']) {
  const res = await checkForUpdates(v)
  console.log(
    `installed ${v} -> ok=${res.ok} available=${res.available}` +
      (res.release ? ` release=${res.release.version} (${res.release.name})` : '') +
      (res.error ? ` error=${res.error}` : '')
  )
}

// Raw payload view: what releases GitHub returns and what is picked.
const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`, {
  headers: { accept: 'application/vnd.github+json', 'user-agent': 'CODEZY/debug' }
})
const payload = await r.json()
console.log('HTTP', r.status, 'releases:', Array.isArray(payload) ? payload.length : String(payload))
if (Array.isArray(payload)) {
  for (const rel of payload) {
    console.log(
      ` - tag=${rel.tag_name} draft=${rel.draft} prerelease=${rel.prerelease} assets=` +
        (rel.assets || []).map((a) => a.name).join(',')
    )
  }
  const ev = evaluateReleases(payload, '2.6.0')
  console.log('evaluateReleases(payload, "2.6.0") =>', JSON.stringify(ev))
  const evOld = evaluateReleases(payload, '2.3.0')
  console.log('evaluateReleases(payload, "2.3.0") =>', JSON.stringify(evOld))
}
