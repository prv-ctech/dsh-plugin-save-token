// Run: node --test bench/verify-host.mjs
// This audit deliberately fails when an advertised invariant is violated.
// All mutations use isolated temporary homes and the native local spill writer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
const { apply } = await import(process.env.SAVE_TOKEN_ENTRY || '../src/index.js')
import { buildCandidate, compressJsonText, compressJsonlText, compressLinesText, csvCell, estTokens, fnv1a } from '../src/compress.js'

const rows = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ model: 'm' + i, input: i, output: i * 2 })))
const plain = Array.from({ length: 500 }, (_, i) => 'output line ' + i + ' with useful details').join('\n')
const textOf = result => result.content.map(b => b.text).join('')
const marker = text => text.match(/\[save-token #([a-z0-9]+) /)?.[1]

function harness(config = {}, services = {}, home = mkdtempSync(join(tmpdir(), 'save-token-audit-'))) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const hooks = {}, tools = {}, routes = {}, spills = []
  const nativeStore = { root: home }
  const store = {
    async saveText(input) {
      const ref = await LocalSpillStore.prototype.saveText.call(nativeStore, input)
      spills.push({ input, ref })
      return ref
    }
  }
  const ctx = {
    on(name, fn) { hooks[name] = fn },
    get(name) { return Object.hasOwn(services, name) ? services[name] : name === 'spillStore' ? store : undefined },
    tools: { register(tool) { tools[tool.name] = tool } },
    effect(fn) { fn() },
    webServer: { register(route) { routes[route.path] = route.handler; return () => {} } }
  }
  try { apply(ctx, config) } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  async function api(action = 'dashboard', body, headers = {}, raw) {
    let status, data
    const req = { method: body === undefined && raw === undefined ? 'GET' : 'POST', url: '/save-token/api/' + action, headers: { host: 'localhost', ...headers },
      async *[Symbol.asyncIterator]() { if (raw !== undefined) yield Buffer.from(raw); else if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
    await routes['/save-token'](req, { writeHead(s) { status = s }, end(s) { data = JSON.parse(s) } })
    return { status, data }
  }
  async function run(text, overrides = {}, resultOverrides = {}, decision = { kind: 'accept' }) {
    const exec = { name: 'bash', arguments: '{}', callId: 'call', agent: { session: { header: { id: 'session-a' } } }, ...overrides }
    const result = { content: [{ type: 'text', text }], ...resultOverrides }
    // Use the actual host post-execution consumer, not only the plugin callback.
    const runtime = {
      ctx: { scope: {}, waterfall(_scope, name, e, r) { return hooks[name](e, r, async () => decision) } },
      markCanonical(_exec, value) { return value }
    }
    return ToolRuntime.prototype.postExecute.call(runtime, exec, result)
  }
  async function stream(messages = [], usage, options = {}) {
    const chunks = usage ? [{ type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }] : []
    const source = async function* () { yield* chunks }
    const seen = []
    for await (const chunk of hooks['llm/stream']({ sessionId: 'session-a', model: 'audit-model', messages, ...options }, source)) seen.push(chunk)
    assert.deepEqual(seen, chunks, 'metering must not change provider chunks')
  }
  return { home, hooks, tools, spills, api, routes: () => routes, run, stream, dashboard: async () => (await api()).data }
}

const toolMessage = text => [{ role: 'tool', content: [{ type: 'text', text }] }]

test('compression reaches native post-execute consumer, persists exact text, expands verbatim', async () => {
  const h = harness()
  const result = await h.run(plain)
  const text = textOf(result)
  assert.ok(marker(text))
  assert.ok(text.length < plain.length)
  assert.equal(readFileSync(h.spills[0].ref.locator, 'utf8'), plain)
  const expanded = await h.tools.save_token_expand.execute({ id: marker(text) })
  assert.equal(expanded.text, plain)
  assert.equal(textOf({ content: h.tools.save_token_expand.output.render({}, expanded) }), plain)
  const d = await h.dashboard()
  assert.equal(d.compression.count, 1)
  assert.equal(d.byTool[0].savedBytes, Buffer.byteLength(plain) - Buffer.byteLength(text))
})

test('lossless, JSONL and table routes reach host counters', async () => {
  const h = harness({ dedupeEnabled: false })
  const json = textOf(await h.run(rows))
  assert.match(json, /losslessly re-encoded/)
  const jsonl = JSON.parse(rows).map(row => JSON.stringify(row)).join('\n')
  assert.match(textOf(await h.run(jsonl)), /losslessly re-encoded/)
  const table = Array.from({ length: 1000 }, (_, i) => `row-${i}|value-${i}|meta-${i}`).join('\n')
  assert.match(textOf(await h.run(table)), /row sampled/)
  const d = await h.dashboard()
  assert.equal(d.compression.losslessEncodes, 2)
  assert.equal(d.compression.tabularWindows, 1)
})

test('missing or failing spill storage preserves original and adoption counters', async () => {
  for (const store of [undefined, { async saveText() { throw new Error('disk unavailable') } }, { async saveText() { return {} } }]) {
    const h = harness({}, { spillStore: store })
    assert.equal(textOf(await h.run(plain)), plain)
    assert.equal((await h.dashboard()).compression.count, 0)
  }
})

test('read, expansion, nested calls, mixed media and upstream blocks stay exempt', async () => {
  const h = harness()
  for (const name of ['read', 'save_token_expand']) assert.equal(textOf(await h.run(plain, { name })), plain)
  assert.equal(textOf(await h.run(plain, { parent: {} })), plain)
  assert.equal(textOf(await h.run(plain, { agent: undefined })), plain)
  const mixed = [{ type: 'text', text: plain }, { type: 'image', attachment: {} }]
  assert.deepEqual((await h.run(plain, {}, { content: mixed })).content, mixed)
  const blocked = await h.hooks['tools/post-execute']({}, {}, async () => ({ kind: 'block', feedback: [] }))
  assert.equal(blocked.kind, 'block')
  const replaced = { kind: 'accept', value: { data: 1 } }
  assert.equal(await h.hooks['tools/post-execute']({}, {}, async () => replaced), replaced)
  assert.equal((await h.dashboard()).compression.count, 0)
})

test('dedupe works only within session, arguments, TTL and successful calls', async () => {
  const h = harness({ compressEnabled: false })
  assert.equal(textOf(await h.run(plain)), plain)
  const stub = textOf(await h.run(plain))
  assert.match(stub, /BYTE-IDENTICAL/)
  assert.equal((await h.tools.save_token_expand.execute({ id: marker(stub) })).text, plain)
  assert.equal(textOf(await h.run(plain, { arguments: '{"other":true}' })), plain)
  assert.equal(textOf(await h.run(plain, { agent: { session: { header: { id: 'session-b' } } } })), plain)
  assert.equal(textOf(await h.run(plain, {}, { isError: true })), plain)
  for (const config of [{ dedupeEnabled: false }, { dedupeTtlOverrides: { bash: 0 } }, { dedupeTtlMs: -1 }]) {
    const other = harness({ compressEnabled: false, ...config })
    await other.run(plain)
    assert.equal(textOf(await other.run(plain)), plain)
  }
  const expiring = harness({ compressEnabled: false, dedupeTtlMs: 10 })
  const now = Date.now
  let clock = now()
  Date.now = () => clock
  try { await expiring.run(plain); clock += 11; assert.equal(textOf(await expiring.run(plain)), plain) } finally { Date.now = now }
})

test('error threshold, disabled compression and rejected candidates leave output unchanged', async () => {
  const h = harness({ dedupeEnabled: false })
  const short = 'same output line\n'.repeat(200)
  assert.equal(textOf(await h.run(short, {}, { isError: true })), short)
  assert.ok(marker(textOf(await h.run(plain, {}, { isError: true }))))
  assert.equal(textOf(await harness({ compressEnabled: false, dedupeEnabled: false }).run(plain)), plain)
  assert.equal(textOf(await harness({ minSavingBytes: 100000 }).run(plain)), plain)
})

test('actual disjoint usage, replay estimates, auxiliary calls, stream errors and reset', async () => {
  const h = harness()
  const compressed = textOf(await h.run(plain))
  await h.stream(toolMessage(compressed), { inputTokens: 1000, cacheReadTokens: 3000, cacheWriteTokens: 200, outputTokens: 30, reasoningTokens: 7 })
  let d = await h.dashboard()
  assert.equal(d.totals.inputTokens, 1000)
  assert.equal(d.totals.cachedTokens, 3200)
  assert.equal(d.totals.outputTokens, 30)
  assert.equal(d.totals.reasoningTokens, 7)
  assert.equal(d.cacheHitPct, Math.round(3000 * 100 / 4200))
  assert.equal(d.compression.replays, 1)
  assert.ok(d.totals.avoidedTokens > 0)
  await h.stream([], { inputTokens: 50, outputTokens: 5 }, { purpose: 'title' })
  d = await h.dashboard()
  assert.equal(d.totals.requests, 1)
  assert.equal(d.totals.auxRequests, 1)
  const broken = h.hooks['llm/stream']({ messages: [] }, async function* () { throw new Error('provider failed') })
  await assert.rejects(async () => { for await (const chunk of broken) void chunk }, /provider failed/)
  assert.equal((await h.dashboard()).totals.requests, 2)
  assert.equal((await h.api('reset', {})).data.ok, true)
  assert.equal((await h.dashboard()).totals.inputTokens, 0)
})

test('Boolean toggles persist; cross-origin mutation is rejected', async () => {
  const h = harness()
  await h.api('set-enabled', { key: 'compress', value: false })
  const restarted = harness({}, {}, h.home)
  assert.equal((await restarted.dashboard()).flags.compress, false)
  assert.equal((await h.api('reset', {}, { origin: 'https://other.example', 'sec-fetch-site': 'cross-site' })).status, 403)
})

test('evicted originals retain locator fallback; optional readText success and rejection', async () => {
  // Fixed-width nonce isolates eviction from the separately tested marker collision.
  const random = Math.random
  Math.random = () => 0.5
  try {
    const h = harness({ dedupeEnabled: false })
    const first = textOf(await h.run(plain))
    const id = marker(first), locator = h.spills[0].ref.locator
    for (let i = 0; i < 160; i++) await h.run(plain, { callId: 'call-' + i })
    const fallback = await h.tools.save_token_expand.execute({ id })
    assert.equal(fallback.locator, locator)
    assert.match(fallback.error, /FULL ORIGINAL/)
    // A fresh fixture supplies the optional read API while retaining native writes.
    const root = mkdtempSync(join(tmpdir(), 'save-token-audit-read-'))
    let rejectRead = false
    const readable = harness({ dedupeEnabled: false }, { spillStore: {
      saveText(input) { return LocalSpillStore.prototype.saveText.call({ root }, input) },
      async readText({ locator }) { if (rejectRead) throw new Error('read unavailable'); return { text: readFileSync(locator, 'utf8') } }
    } })
    const firstReadable = textOf(await readable.run(plain))
    for (let i = 0; i < 160; i++) await readable.run(plain, { callId: 'call-' + i })
    assert.equal((await readable.tools.save_token_expand.execute({ id: marker(firstReadable) })).text, plain)
    rejectRead = true
    assert.match((await readable.tools.save_token_expand.execute({ id: marker(firstReadable) })).error, /FULL ORIGINAL/)
  } finally { Math.random = random }
})

// The following checks are acceptance probes, not assertions of existing bugs.
test('INVARIANT: marker identities never overwrite a different retained original', async () => {
  const random = Math.random
  try {
    const h = harness({ dedupeEnabled: false })
    const original = plain + '\nFIRST ORIGINAL ONLY'
    Math.random = () => 37.1 / 1296 // sequence 1 + nonce "11"
    const first = marker(textOf(await h.run(original)))
    Math.random = () => 1.1 / 1296 // sequence 37 + nonce "1"
    for (let i = 0; i < 35; i++) await h.run(plain)
    const other = marker(textOf(await h.run(plain + '\nSECOND ORIGINAL ONLY')))
    const expanded = await h.tools.save_token_expand.execute({ id: first })
    assert.ok(first !== other && expanded.text === original, `different originals reused ${first}/${other}; originalMatches=${expanded.text === original}`)
  } finally { Math.random = random }
})

for (const [a, b] of [[null, 'null'], [true, 'true'], [1, '1']]) {
  test(`INVARIANT: lossless cells distinguish ${typeof a} ${a} from string`, () => {
    assert.notEqual(csvCell(a), csvCell(b))
  })
}

test('INVARIANT: carriage return is escaped inside a lossless cell', () => {
  assert.match(csvCell('a\rb'), /^"/)
})

test('INVARIANT: unsafe flat keys cannot produce ambiguous lossless headers', () => {
  const text = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ 'a,b': i })))
  const route = compressJsonText(text, { jsonMaxParseBytes: 524288 })
  assert.ok(!route.lossless || !route.text.startsWith('items[20]{a,b}:'))
})

test('INVARIANT: lossless output identifies the full parent path', () => {
  const arr = JSON.parse(rows)
  const cfg = { jsonMaxParseBytes: 524288 }
  const first = compressJsonText(JSON.stringify({ left: { items: arr }, right: {} }), cfg)
  const second = compressJsonText(JSON.stringify({ left: {}, right: { items: arr } }), cfg)
  assert.ok(first.text !== second.text, 'different parent paths must not encode identically')
})

test('INVARIANT: full notice passes never-worse gates, not only its body', async () => {
  const h = harness({}, { spillStore: { async saveText() { return { locator: '/spill/result.txt', retrievalHint: 'metadata '.repeat(10000) } } } })
  const text = textOf(await h.run(plain))
  assert.ok(Buffer.byteLength(text) <= Buffer.byteLength(plain) * 0.72)
  assert.ok(Buffer.byteLength(plain) - Buffer.byteLength(text) >= 500)
  assert.ok(marker(text), 'compact fallback must be adopted')
  assert.match(text, /full: \/spill\/result\.txt/)
  assert.doesNotMatch(text, /metadata/)
})

test('INVARIANT: compression counters measure the actual final replacement', async () => {
  const h = harness()
  const text = textOf(await h.run(plain))
  assert.equal((await h.dashboard()).compression.bytesAfter, Buffer.byteLength(text))
})

test('INVARIANT: expand returns full original or explicitly renders truncation and locator', async () => {
  const h = harness()
  const original = 'long output line\n'.repeat(20000)
  const text = textOf(await h.run(original))
  const value = await h.tools.save_token_expand.execute({ id: marker(text) })
  const rendered = textOf({ content: h.tools.save_token_expand.output.render({}, value) })
  assert.ok(rendered === original || (rendered.includes('truncated') && rendered.includes(value.locator)), 'silent prefix is not a full original')
})

test('INVARIANT: restart lookup retains marker locator, as advertised', async () => {
  const h = harness()
  const text = textOf(await h.run(plain))
  const restarted = harness({}, {}, h.home)
  const value = await restarted.tools.save_token_expand.execute({ id: marker(text) })
  assert.ok(value.text === plain || value.locator === h.spills[0].ref.locator)
})

test('INVARIANT: different content with colliding FNV hashes is never deduped', async () => {
  const a = 'collision-11vsk8p-13317' + '\n' + 'x'.repeat(3500)
  const b = 'collision-1c0e837-25368' + '\n' + 'x'.repeat(3500)
  assert.notEqual(a, b)
  assert.equal(fnv1a(a), fnv1a(b), 'fixture must reproduce real fingerprint collision')
  const h = harness({ compressEnabled: false })
  await h.run(a)
  assert.equal(textOf(await h.run(b)), b)
})

test('INVARIANT: windows reference original spill line numbers after duplicate/blank runs', () => {
  const lines = ['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', '', '', '', ...Array.from({ length: 500 }, (_, i) => `row-${i}|value-${i}|meta-${i}`)]
  const result = compressLinesText(lines.join('\n'), { maxLines: 240, headLines: 140, tailLines: 80, tabularHeadRows: 60, tabularTailRows: 40, tabularStrideSamples: 50, longLineChars: 420 })
  for (const match of result.text.matchAll(/^L(\d+): (.*)$/gm)) assert.equal(lines[Number(match[1]) - 1], match[2])
})

test('INVARIANT: configured 1400-byte floor permits valid 1500-byte savings', async () => {
  const original = 'abcdefghijklmn\n'.repeat(100)
  assert.equal(Buffer.byteLength(original), 1500)
  const cfg = { keepRatioMax: 0.72, minSavingBytes: 500, maxLines: 240, headLines: 140, tailLines: 80, tabularHeadRows: 60, tabularTailRows: 40, tabularStrideSamples: 50, longLineChars: 420, jsonMaxParseBytes: 524288 }
  assert.ok(buildCandidate(original, cfg))
  assert.ok(marker(textOf(await harness().run(original))))
})

test('INVARIANT: calibrated chart savings match calibrated total savings', async () => {
  const h = harness()
  const text = textOf(await h.run(plain))
  await h.stream(toolMessage(text), { inputTokens: estTokens(text) * 2 })
  const d = await h.dashboard()
  assert.equal(d.series[0].a, d.totals.avoidedTokens)
})

test('INVARIANT: non-Boolean toggle values are rejected', async () => {
  const h = harness({ compressEnabled: false })
  const invalid = await h.api('set-enabled', { key: 'compress', value: 'false' })
  assert.equal(invalid.status, 400)
  assert.equal((await h.dashboard()).flags.compress, false)
})

test('INVARIANT: invalid JSON cannot reset statistics', async () => {
  const h = harness()
  await h.run(plain)
  const reset = await h.api('reset', undefined, {}, '{broken')
  assert.ok(reset.status === 400 && (await h.dashboard()).compression.count === 1)
})

test('INVARIANT: final notice also reduces estimated tokens', async () => {
  const h = harness({}, { spillStore: { async saveText() { return { locator: '/spill/result.txt', retrievalHint: 'metadata '.repeat(10000) } } } })
  assert.ok(estTokens(textOf(await h.run(plain))) < estTokens(plain))
})

// Plan-completeness checks added after independent review of the repair receipt.
// Keep failures visible: passing the original 29 probes is not complete coverage.
const encodingCfg = { jsonMaxParseBytes: 524288 }

test('PLAN: dotted property names cannot collide with nested array paths', () => {
  const arr = Array.from({ length: 8 }, (_, x) => ({ x }))
  const a = compressJsonText(JSON.stringify({ 'a.b': arr, a: {} }), encodingCfg)
  const b = compressJsonText(JSON.stringify({ a: { b: arr } }), encodingCfg)
  assert.ok(!a?.lossless || !b?.lossless || a.text !== b.text, 'distinct paths must not produce identical lossless output')
})

for (const format of ['JSON', 'JSONL']) {
  test('PLAN: ' + format + ' lossless encoding preserves integer precision', () => {
    const make = n => format === 'JSON' ? '[' + Array(8).fill('{"x":' + n + '}').join(',') + ']' : Array(8).fill('{"x":' + n + '}').join('\n')
    const encode = format === 'JSON' ? compressJsonText : compressJsonlText
    const a = encode(make('9007199254740993'), encodingCfg)
    const b = encode(make('9007199254740992'), encodingCfg)
    assert.ok(!a?.lossless || !b?.lossless || a.text !== b.text, 'distinct raw integers must not collapse into identical lossless output')
  })
}

test('PLAN: finite JSON number cannot become Infinity in a lossless preview', () => {
  const original = '[' + Array(8).fill('{"x":1e400}').join(',') + ']'
  const result = compressJsonText(original, encodingCfg)
  assert.ok(!result?.lossless || !result.text.includes('Infinity'), 'unsupported precision must decline lossless encoding')
})

test('PLAN: restored locator index obeys the 4000-entry cap', async () => {
  const h = harness()
  const entries = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => ['c' + i.toString(36).padStart(6, '0'), { locator: '/fixture/' + i, ts: i }]))
  mkdirSync(join(h.home, 'plugin-state'), { recursive: true })
  writeFileSync(join(h.home, 'plugin-state', 'save-token-locators.json'), JSON.stringify({ version: 1, entries }))
  const restarted = harness({}, {}, h.home)
  let restored = 0
  for (const id of Object.keys(entries)) {
    if ((await restarted.tools.save_token_expand.execute({ id })).locator) restored++
  }
  assert.ok(restored <= 4000, 'restored ' + restored + ' entries exceeds retained-index bound')
})

for (const metric of ['bytes', 'tokens']) {
  test('PLAN: dedupe notice obeys final ' + metric + ' gates', async () => {
    const original = '😀'.repeat(1000)
    const h = harness({ compressEnabled: false }, { spillStore: { async saveText() { return { locator: 'x'.repeat(3100) } } } })
    await h.run(original)
    const text = textOf(await h.run(original))
    if (text === original) return // Safe decline is allowed.
    if (metric === 'bytes') assert.ok(Buffer.byteLength(text) <= Buffer.byteLength(original) * 0.72, 'dedupe keep ratio exceeds configured maximum')
    else assert.ok(estTokens(text) < estTokens(original), 'dedupe increases estimated tokens')
  })
}

test('PLAN: invalid mutation bodies cannot change counters or persisted toggles', async () => {
  const h = harness()
  await h.run(plain)
  assert.equal((await h.api('set-enabled', { key: 'compress', value: false })).status, 200)
  const path = join(h.home, 'plugin-state', 'save-token-state.json')
  const saved = readFileSync(path, 'utf8')
  for (const body of [null, [], { value: true }, { key: 'unknown', value: true }, { key: 'compress', value: 1 }]) {
    assert.equal((await h.api('set-enabled', body)).status, 400)
  }
  for (const raw of ['null', '[]', 'x'.repeat(1048577), '{broken']) {
    assert.equal((await h.api('reset', undefined, {}, raw)).status, 400)
  }
  assert.equal(readFileSync(path, 'utf8'), saved)
  const d = await h.dashboard()
  assert.equal(d.flags.compress, false)
  assert.equal(d.compression.count, 1)
})

test('PLAN: a request-stream error cannot mutate state or persist partial input', async () => {
  const h = harness()
  await h.run(plain)
  const before = JSON.stringify(await h.dashboard())
  let status
  const req = { method: 'POST', url: '/save-token/api/reset', headers: { host: 'localhost' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{'); throw new Error('stream interrupted') } }
  await h.routes()['/save-token'](req, { writeHead(s) { status = s }, end() {} })
  assert.equal(status, 400)
  assert.equal(JSON.stringify(await h.dashboard()), before, 'a failed read must not reset counters')
})

test('PLAN: oversized dedupe entries are dropped without a false stub or budget growth', async () => {
  const h = harness({ compressEnabled: false })
  const huge = 'H'.repeat(2097153) // one char over DEDUPE_MAX_ENTRY
  assert.equal(textOf(await h.run(huge)), huge)
  assert.equal(textOf(await h.run(huge)), huge, 'unverifiable repeat must not adopt a stub')
  const d = await h.dashboard()
  assert.equal(d.compression.dedupeHits, 0)
})

test('PLAN: marker locator survives a genuinely fresh child process', () => {
  const home = mkdtempSync(join(tmpdir(), 'save-token-restart-'))
  const child = `
    const { LocalSpillStore } = await import('@deepseek-ai/dsh-spill-local')
    const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
    const { apply } = await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)})
    const hooks = {}
    const ctx = { on(n, f) { hooks[n] = f },
      get(n) { return n === 'spillStore' ? { async saveText(i) { return LocalSpillStore.prototype.saveText.call({ root: process.env.DSH_HOME }, i) } } : undefined },
      tools: { register() {} }, effect(f) { f() }, webServer: { register() {} } }
    apply(ctx, {})
    const runtime = { ctx: { scope: {}, waterfall(_s, n, e, r) { return hooks[n](e, r, async () => ({ kind: 'accept' })) } }, markCanonical(_e, v) { return v } }
    const text = Array.from({ length: 500 }, (_, i) => 'line ' + i).join('\\n')
    const out = await ToolRuntime.prototype.postExecute.call(runtime, { name: 'bash', arguments: '{}', callId: 'c', agent: { session: { header: { id: 'session-a' } } } }, { content: [{ type: 'text', text }] })
    process.stdout.write(out.content.map(b => b.text).join(''))
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', child], { cwd: process.cwd(), env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const id = marker(run.stdout)
  assert.ok(id, 'child must emit a marker')
  const restarted = harness({}, {}, home)
  return restarted.tools.save_token_expand.execute({ id }).then(value => {
    assert.ok(value.locator, 'fresh process must recover the locator from the sidecar')
    assert.equal(readFileSync(value.locator, 'utf8').includes('line 499'), true)
  })
})
