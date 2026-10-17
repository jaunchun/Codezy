// Batch 22 — the v3 agent-core upgrade (harness.mjs):
//  A. schemas: edit_file/glob/task_status in TOOLS, DANGEROUS/MUTATING sets,
//     run_command background flag, DELEGATE_TOOL.
//  B. globToRegExp: ** / * / ? / {a,b} semantics.
//  C. edit_file: happy path, not-found, ambiguous, replace_all, identical,
//     traversal, missing path, new file — plus the approval gate and plan mode.
//  D. glob: cross-folder matching, sorted, skips node_modules, no-match copy.
//  E. plan mode (allowMutations:false): mutating tools refuse, read-only tools
//     keep working, v2.ts wires the gate + hides the schema.
//  F. background tasks: start → id, status tail, output capture, kill, prune.
//  G. sub-agents: delegate offered, fresh-context chain, approval still gates
//     sub writes, depth limit, allowDelegate:false removes the tool.
//  H. iteration cap: raised to 5–40 (40 is real), low values still clamp to 5.
// Deterministic throughout: fake callModel, no network, no real model.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PROJ = 'C:/Users/kajtg/Documents/Projekt domyślny/codezy'
const {
  TOOLS,
  DANGEROUS_TOOLS,
  MUTATING_TOOLS,
  DELEGATE_TOOL,
  globToRegExp,
  makeRegistry,
  runAgent
} = await import(pathToFileURL(path.join(PROJ, 'cli', 'lib', 'harness.mjs')).href)

const fails = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) fails.push(label)
}

const ROOT = path.join(PROJ, 'tests', '.tmp', `b22-${Date.now() % 100000}`)
fs.mkdirSync(path.join(ROOT, 'src', 'deep'), { recursive: true })
fs.mkdirSync(path.join(ROOT, 'node_modules', 'junk'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'app.ts'), "const a = 1\nconst b = 2\nconst a2 = 'x'\n")
fs.writeFileSync(path.join(ROOT, 'dup.txt'), 'one\ntwo\none\nthree\n')
fs.writeFileSync(path.join(ROOT, 'file.txt'), 'hello b22\nsecond line\n')
fs.writeFileSync(path.join(ROOT, 'src', 'main.ts'), 'export const x = 1\n')
fs.writeFileSync(path.join(ROOT, 'src', 'deep', 'util.ts'), 'export const y = 2\n')
fs.writeFileSync(path.join(ROOT, 'src', 'notes.md'), '# notes\n')
fs.writeFileSync(path.join(ROOT, 'node_modules', 'junk', 'skip.ts'), 'nope\n')
fs.writeFileSync(path.join(ROOT, 'a1.txt'), 'x\n')
fs.writeFileSync(path.join(ROOT, 'a2.txt'), 'y\n')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** Scripted model: answers in order; branch() can override per call. */
function scripted(answers, branch) {
  let i = 0
  return async (o) => {
    const override = branch ? branch(o) : null
    if (override) return override
    return answers[Math.min(i++, answers.length - 1)]
  }
}
const toolCall = (name, args) => ({ content: '', tool_calls: [{ function: { name, arguments: args } }] })
const endTurn = (text) => ({ content: text, tool_calls: [] })

// --- A. schemas ----------------------------------------------------------------
{
  const names = TOOLS.map((t) => t.function?.name)
  check('A edit_file in TOOLS', names.includes('edit_file'), names.join(','))
  check('A glob in TOOLS', names.includes('glob'), names.join(','))
  check('A task_status in TOOLS', names.includes('task_status'), names.join(','))
  const edit = TOOLS.find((t) => t.function?.name === 'edit_file')?.function?.parameters
  check(
    'A edit_file requires path/old/new',
    ['path', 'old', 'new'].every((k) => edit?.required?.includes(k)) && !!edit?.properties?.replace_all,
    JSON.stringify(edit?.required)
  )
  const rc = TOOLS.find((t) => t.function?.name === 'run_command')?.function?.parameters
  check('A run_command has a background flag', !!rc?.properties?.background, JSON.stringify(Object.keys(rc?.properties ?? {})))
  check('A edit_file is gated (DANGEROUS)', DANGEROUS_TOOLS.has('edit_file'), [...DANGEROUS_TOOLS].join(','))
  check('A MUTATING = write/edit/run', MUTATING_TOOLS.has('write_file') && MUTATING_TOOLS.has('edit_file') && MUTATING_TOOLS.has('run_command'), [...MUTATING_TOOLS].join(','))
  check('A DELEGATE_TOOL has a task param', DELEGATE_TOOL?.function?.name === 'delegate' && !!DELEGATE_TOOL?.function?.parameters?.properties?.task, DELEGATE_TOOL?.function?.name)
}

// --- B. globToRegExp ------------------------------------------------------------
{
  check('B **/*.ts matches top level', globToRegExp('**/*.ts').test('a.ts'))
  check('B **/*.ts matches nested', globToRegExp('**/*.ts').test('src/deep/util.ts'))
  check('B *.md stays in one segment', globToRegExp('*.md').test('src/notes.md') === false && globToRegExp('*.md').test('notes.md'))
  check('B src/** crosses folders', globToRegExp('src/**').test('src/deep/util.ts'))
  check('B ? one char', globToRegExp('a?.txt').test('a1.txt') && !globToRegExp('a?.txt').test('abc.txt'))
  check('B {a,b} alternation', globToRegExp('{a,b}*.txt').test('a1.txt') && globToRegExp('{a,b}*.txt').test('b9.txt') && !globToRegExp('{a,b}*.txt').test('c1.txt'))
  check('B dots are literal', !globToRegExp('a.txt').test('axtxt'))
}

// --- C. edit_file ----------------------------------------------------------------
{
  const reg = makeRegistry({ roots: [ROOT] })
  const ok = await reg.edit_file.run({ path: 'app.ts', old: 'const b = 2', new: 'const b = 3' })
  check('C happy path message', /edited app\.ts: 1 replacement/.test(ok), ok)
  check('C file changed', read('app.ts').includes('const b = 3'))
  check('C rest untouched', read('app.ts').startsWith('const a = 1') && read('app.ts').includes("const a2 = 'x'"))

  const missing = await reg.edit_file.run({ path: 'app.ts', old: 'const NOPE = 9', new: 'x' })
  check('C not found is an ERROR', /^ERROR: the old text was not found/.test(missing), missing.slice(0, 60))

  const ambiguous = await reg.edit_file.run({ path: 'dup.txt', old: 'one', new: '1' })
  check('C ambiguous refused', /appears 2 times/.test(ambiguous), ambiguous)
  check('C ambiguous leaves file alone', read('dup.txt') === 'one\ntwo\none\nthree\n')

  const all = await reg.edit_file.run({ path: 'dup.txt', old: 'one', new: '1', replace_all: true })
  check('C replace_all counts 2', /2 replacements/.test(all), all)
  check('C replace_all applied', read('dup.txt') === '1\ntwo\n1\nthree\n')

  check('C identical refused by check', typeof (await reg.edit_file.check({ path: 'app.ts', old: 'x', new: 'x' })) === 'string')
  check('C traversal refused', typeof (await reg.edit_file.check({ path: '../escape.ts', old: 'a', new: 'b' })) === 'string')
  check('C path required', (await reg.edit_file.check({ old: 'a', new: 'b' })) === 'path is required')
  check('C old required', (await reg.edit_file.check({ path: 'app.ts', new: 'b' }))?.includes('old text is required'))
  const fresh = await reg.edit_file.run({ path: 'new.txt', old: 'a', new: 'b' })
  check('C new file points at write_file', /does not exist — use write_file/.test(fresh), fresh)

  // approval gate through the loop
  const before = read('app.ts')
  let asked = 0
  await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: reg,
    callModel: scripted([toolCall('edit_file', { path: 'app.ts', old: 'const a = 1', new: 'const a = 111' }), endTurn('done')]),
    approve: async () => (asked++, false)
  })
  check('C gate: denied → unchanged', read('app.ts') === before && asked === 1, `asked=${asked}`)
  await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: reg,
    callModel: scripted([toolCall('edit_file', { path: 'app.ts', old: 'const a = 1', new: 'const a = 111' }), endTurn('done')]),
    approve: async () => true
  })
  check('C gate: approved → applied', read('app.ts').includes('const a = 111'))
}

// --- D. glob ---------------------------------------------------------------------
{
  const reg = makeRegistry({ roots: [ROOT] })
  const hits = await reg.glob.run({ pattern: '**/*.ts' })
  check('D finds across folders', hits.includes('src/deep/util.ts') && hits.includes('src/main.ts') && hits.includes('app.ts'), JSON.stringify(hits))
  check('D sorted', hits === [...hits.split('\n')].sort().join('\n'))
  check('D skips node_modules', !hits.includes('node_modules'), hits)
  const md = await reg.glob.run({ pattern: '*.md' })
  check('D one segment only (nothing at root)', md === 'no files match *.md', JSON.stringify(md))
  const mdAll = await reg.glob.run({ pattern: '**/*.md' })
  check('D ** reaches nested md', mdAll === 'src/notes.md', JSON.stringify(mdAll))
  const inSrc = await reg.glob.run({ pattern: '*.md', path: 'src' })
  check('D path param respected', inSrc === 'notes.md', JSON.stringify(inSrc))
  const none = await reg.glob.run({ pattern: '**/*.rs' })
  check('D no-match copy', none === 'no files match **/*.rs', none)
  check('D traversal refused', typeof (await reg.glob.check({ pattern: '*', path: '../..' })) === 'string')
  check('D pattern required', (await reg.glob.check({})) === 'pattern is required')
}

// --- E. plan mode ------------------------------------------------------------------
{
  const reg = makeRegistry({ roots: [ROOT], allowMutations: false })
  const before = read('app.ts')
  const w = await reg.write_file.check({ path: 'app.ts', content: 'x' })
  const e = await reg.edit_file.check({ path: 'app.ts', old: 'a', new: 'b' })
  const r = await reg.run_command.check({ command: 'echo hi' })
  check('E write refused', /plan mode: write_file is disabled/.test(w), w)
  check('E edit refused', /plan mode: edit_file is disabled/.test(e), e)
  check('E run refused', /plan mode: run_command is disabled/.test(r), r)
  const res = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: reg,
    callModel: scripted([toolCall('write_file', { path: 'app.ts', content: 'hacked' }), endTurn('planned')]),
    approve: async () => true // even an approve cannot bypass plan mode
  })
  const tool = res.messages.find((m) => m.role === 'tool')
  check('E loop outcome rejected', tool?.content?.startsWith('ERROR: plan mode'), tool?.content)
  check('E file untouched', read('app.ts') === before)
  check('E read tools still work', (await reg.list_dir.run({ path: '.' })).includes('app.ts'))
  check('E glob still works', (await reg.glob.run({ pattern: '**/*.md' })).includes('notes.md'))
  const rw = makeRegistry({ roots: [ROOT] })
  check('E default registry allows writes', (await rw.write_file.check({ path: 'x.txt', content: 'y' })) === null)
}

// --- F. background tasks ------------------------------------------------------------
{
  const reg = makeRegistry({ roots: [ROOT] })
  const started = await reg.run_command.run({ command: 'echo bg-output', background: true })
  check('F returns a task id', /started background task #1:/.test(started), started)
  let status = ''
  for (let i = 0; i < 50; i++) {
    status = await reg.task_status.run({ id: 1 })
    if (/exited with code 0/.test(status)) break
    await sleep(100)
  }
  check('F finishes with exit 0', /task #1 exited with code 0/.test(status), status.split('\n')[0])
  check('F output captured', /bg-output/.test(status), JSON.stringify(status))

  const list = await reg.task_status.run({})
  check('F list shows the task', /#1 exit 0: echo bg-output/.test(list), list)
  check('F unknown id', /no task #99/.test(await reg.task_status.run({ id: 99 })))

  // kill: a long node process, killed mid-flight
  const sleeper = path.join(ROOT, 'sleep.js')
  fs.writeFileSync(sleeper, 'setTimeout(() => {}, 30000)\n')
  const k = await reg.run_command.run({ command: `node "${sleeper}"`, background: true })
  const kid = Number(/#(\d+)/.exec(k)?.[1])
  await sleep(400)
  const before = await reg.task_status.run({ id: kid })
  check('F long task still running', /task #\d+ running/.test(before), before.split('\n')[0])
  const killed = await reg.task_status.run({ id: kid, kill: true })
  check('F kill requested', /kill requested/.test(killed), killed.split('\n')[0])
  let dead = ''
  for (let i = 0; i < 50; i++) {
    dead = await reg.task_status.run({ id: kid })
    if (!/running/.test(dead.split('\n')[0])) break
    await sleep(100)
  }
  check('F task stopped', !/running/.test(dead.split('\n')[0]), dead.split('\n')[0])

  // prune: 22 tasks → the map keeps at most 20, oldest finished dropped
  for (let i = 0; i < 21; i++) await reg.run_command.run({ command: `echo n${i}`, background: true })
  for (let i = 0; i < 100; i++) {
    const all = await reg.task_status.run({})
    if ((all.match(/#/g) ?? []).length <= 20) break
    await sleep(100)
  }
  const sizes = reg.task_status.state.tasks.size
  check('F pruned to 20', sizes <= 20, String(sizes))
  check('F oldest id dropped', !reg.task_status.state.tasks.has(1))
  check('F state shared with todo_write state', reg.todo_write.state.tasks === reg.task_status.state.tasks)
}

// --- G. sub-agents (delegate) ---------------------------------------------------------
{
  const reg = makeRegistry({ roots: [ROOT] })
  const BRIEF = 'Read file.txt and summarize it.'
  const subSeen = {}
  const parent = scripted(null, ({ messages, tools }) => {
    const names = (tools ?? []).map((t) => t?.function?.name)
    const first = messages[0]?.content
    if (messages.length === 1 && first === BRIEF) {
      subSeen.tools = names
      return toolCall('read_file', { path: 'file.txt' })
    }
    if (messages.length === 1) return toolCall('delegate', { task: BRIEF })
    if (messages.some((m) => m.role === 'tool' && /hello b22/.test(m.content ?? ''))) return endTurn('sub done')
    return endTurn('parent done')
  })
  const events = []
  const res = await runAgent({
    messages: [{ role: 'user', content: 'do the thing' }],
    registry: reg,
    callModel: parent,
    onEvent: (e) => events.push(e)
  })
  const del = res.messages.find((m) => m.role === 'tool' && m.tool_name === 'delegate')
  check('G delegate ran in a fresh context', /sub-agent finished \(text, 2 steps\)/.test(del?.content ?? ''), del?.content?.slice(0, 80))
  check('G final answer carried back', /sub done/.test(del?.content ?? ''))
  check('G parent finished', res.text === 'parent done' && res.iterations === 2, `${res.status}/${res.iterations}`)
  check('G sub got the full tool list', subSeen.tools?.includes('read_file') && subSeen.tools?.includes('delegate'), JSON.stringify(subSeen.tools))
  const subEvent = events.find((e) => e.type === 'tool' && e.sub)
  check('G sub events carry the flag', subEvent?.name === 'read_file' && subEvent?.depth === 1, JSON.stringify({ n: subEvent?.name, d: subEvent?.depth }))

  // sub-agent writes still hit the approval gate
  let approvals = 0
  const del2 = (
    await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      registry: makeRegistry({ roots: [ROOT] }),
      approve: async (name) => (approvals++, name !== 'write_file'), // deny writes, allow others
      callModel: scripted(null, ({ messages }) => {
        if (messages.length === 1 && messages[0]?.content === 'write x')
          return toolCall('write_file', { path: 'sub.txt', content: 'nope' })
        if (messages.length === 1) return toolCall('delegate', { task: 'write x' })
        // the denial lands in the sub-agent's context — echo it into the
        // final text so the PARENT (and this test) can see it
        if (messages.some((m) => m.role === 'tool' && /denied/.test(m.content ?? ''))) return endTurn('SUB WAS DENIED')
        return endTurn('done')
      })
    })
  ).messages.find((m) => m.role === 'tool' && m.tool_name === 'delegate')
  // the delegate result carries the sub's FINAL TEXT only — the denial
  // itself lives in the sub's private messages, so prove the gate fired by
  // what the sub reported back, that approve was consulted, and that no
  // file appeared
  check('G sub write gated', /SUB WAS DENIED/.test(del2?.content ?? ''), del2?.content?.slice(0, 120))
  check('G sub.txt never written', !fs.existsSync(path.join(ROOT, 'sub.txt')))
  check('G approve was consulted', approvals > 0, String(approvals))

  // depth: with maxDelegateDepth 1 only the TOP chain gets the tool
  const deepSeen = {}
  await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: makeRegistry({ roots: [ROOT] }),
    maxDelegateDepth: 1,
    callModel: scripted(null, ({ messages, tools }) => {
      if (messages.length === 1 && messages[0]?.content === 'inner') {
        deepSeen.tools = (tools ?? []).map((t) => t?.function?.name)
        return endTurn('inner done')
      }
      if (messages.length === 1) return toolCall('delegate', { task: 'inner' })
      return endTurn('outer done')
    })
  })
  check('G depth limit: sub gets no delegate at the cutoff', Array.isArray(deepSeen.tools) && !deepSeen.tools.includes('delegate'), JSON.stringify(deepSeen.tools))

  // allowDelegate:false removes the tool entirely
  const offTools = []
  await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: makeRegistry({ roots: [ROOT] }),
    allowDelegate: false,
    callModel: async ({ tools }) => {
      offTools.push(...(tools ?? []).map((t) => t?.function?.name))
      return endTurn('ok')
    }
  })
  check('G allowDelegate:false hides the tool', !offTools.includes('delegate'), offTools.join(','))

  // validation — `delegate` is merged by runAgent, so drive it through the loop
  const emptyRes = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: makeRegistry({ roots: [ROOT] }),
    callModel: scripted([toolCall('delegate', {}), endTurn('ok')])
  })
  check('G empty brief refused', /task is required/.test(emptyRes.messages.find((m) => m.role === 'tool')?.content ?? ''))
  const longRes = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    registry: makeRegistry({ roots: [ROOT] }),
    callModel: scripted([toolCall('delegate', { task: 'x'.repeat(5000) }), endTurn('ok')])
  })
  check('G long brief refused', /task too long/.test(longRes.messages.find((m) => m.role === 'tool')?.content ?? ''))
}

// --- H. iteration cap -------------------------------------------------------------------
{
  const reg = makeRegistry({ roots: [ROOT] })
  const res = await runAgent({
    messages: [{ role: 'user', content: 'loop' }],
    registry: reg,
    allowDelegate: false,
    maxIter: 40,
    callModel: async () => toolCall('list_dir', { path: '.' })
  })
  check('H maxIter 40 is real (no clamp to 10)', res.status === 'limit' && res.iterations === 40, `${res.status}/${res.iterations}`)
  const low = await runAgent({
    messages: [{ role: 'user', content: 'loop' }],
    registry: reg,
    allowDelegate: false,
    maxIter: 1,
    callModel: async () => toolCall('list_dir', { path: '.' })
  })
  check('H low maxIter still clamps to 5', low.status === 'limit' && low.iterations === 5, `${low.status}/${low.iterations}`)
}

// --- I. v2.ts wiring (static) -----------------------------------------------------------
{
  const v2 = fs.readFileSync(path.join(PROJ, 'src', 'main', 'v2.ts'), 'utf8')
  check('I v2 passes allowMutations', v2.includes('allowMutations') && v2.includes("!== 'plan'"))
  check('I v2 hides mutating tools in plan mode', /MUTATING_TOOLS\.has/.test(v2))
  check('I v2 maps effort → maxIter', /light: 8,\s*medium: 15,\s*deep: 30/.test(v2))
  check('I registry cache key carries the mode', v2.includes("'rw'") && v2.includes("'ro'"))
  const dts = fs.readFileSync(path.join(PROJ, 'cli', 'lib', 'harness.d.mts'), 'utf8')
  check('I declarations cover the new exports', dts.includes('MUTATING_TOOLS') && dts.includes('DELEGATE_TOOL') && dts.includes('globToRegExp'))
}

// --- cleanup + summary ---------------------------------------------------------------------
try {
  fs.rmSync(ROOT, { recursive: true, force: true })
} catch { /* best effort */ }

console.log('')
console.log(fails.length ? `${fails.length} FAIL:\n  ${fails.join('\n  ')}` : 'ALL PASS')
process.exitCode = fails.length ? 1 : 0
