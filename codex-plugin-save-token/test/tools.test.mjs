import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SpillStore } from '../src/store.js'
import { TokenSaver, defaultConfig, applyEnv, toolDefinitions } from '../src/tools.js'

var MARKER_RE = /\[save-token #([a-z0-9]+) /

function makeSaver(cfgOver) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'save-token-tools-'))
  var cfg = Object.assign({}, defaultConfig, cfgOver || {})
  var saver = new TokenSaver(cfg, new SpillStore(root), function () {})
  saver.root = root
  return saver
}

function textOf(res) { return res.content[0].text }

test('config: SAVE_TOKEN_* env overrides apply', () => {
  var cfg = applyEnv(Object.assign({}, defaultConfig), {
    SAVE_TOKEN_MIN_BYTES: '800',
    SAVE_TOKEN_DEDUPE_ENABLED: '0',
    SAVE_TOKEN_KEEP_RATIO_MAX: '0.5'
  })
  assert.equal(cfg.minBytes, 800)
  assert.equal(cfg.dedupeEnabled, false)
  assert.equal(cfg.keepRatioMax, 0.5)
})

test('runTool: small output passes through verbatim with exit code', async () => {
  var saver = makeSaver()
  var res = await saver.runTool({ command: 'echo hello' })
  assert.equal(res.isError, false)
  assert.ok(textOf(res).startsWith('exit=0\n--- stdout ---\nhello'))
  assert.ok(!MARKER_RE.test(textOf(res)))
})

test('runTool: oversized output is compressed, spilled, and expandable', async () => {
  var saver = makeSaver()
  var res = await saver.runTool({ command: 'seq 0 4999 | sed "s/^/row-/"' })
  var text = textOf(res)
  assert.ok(MARKER_RE.test(text), 'notice present')
  assert.ok(text.length < 4000, 'compressed window is small, got ' + text.length)
  var id = text.match(MARKER_RE)[1]
  var full = textOf(await saver.expandTool({ id: id }))
  assert.ok(full.includes('row-4999'))
  assert.ok(full.includes('row-0'))
})

test('runTool: failing command is isError and gets the looser error floor', async () => {
  var saver = makeSaver({ errorMinBytes: 999999 })
  var res = await saver.runTool({ command: 'seq 5000 | sed "s/^/boom-/" >&2; exit 3' })
  assert.equal(res.isError, true)
  assert.ok(textOf(res).startsWith('exit=3'))
  assert.ok(textOf(res).includes('boom-4999'))
  assert.ok(!MARKER_RE.test(textOf(res)), 'below the error floor: not compressed')
})

test('runTool: timeout kills the command and reports it', async () => {
  var saver = makeSaver()
  var res = await saver.runTool({ command: 'sleep 30', timeoutSec: 1 })
  assert.ok(textOf(res).startsWith('exit=timeout'))
})

test('runTool: byte-identical rerun within TTL becomes a dedupe stub', async () => {
  var saver = makeSaver()
  var cmd = 'seq 2000 | sed "s/^/dup-/"'
  var first = await saver.runTool({ command: cmd })
  var second = await saver.runTool({ command: cmd })
  assert.ok(MARKER_RE.test(textOf(first)))
  assert.ok(/deduped/.test(textOf(second)), 'second call stubbed')
  assert.ok(textOf(second).length < textOf(first).length)
  assert.equal(saver.stats.dedupeHits, 1)
})

test('runTool: stderr-only output keeps its section; runTool validates args', async () => {
  var saver = makeSaver()
  var res = await saver.runTool({ command: 'echo warn >&2' })
  assert.ok(textOf(res).includes('--- stderr ---\nwarn'))
  assert.ok(!textOf(res).includes('--- stdout ---'))
  var bad = await saver.runTool({})
  assert.equal(bad.isError, true)
  assert.ok(/`command`/.test(textOf(bad)))
})

test('readTool: oversized file is compressed and expand matches the read window', async () => {
  var saver = makeSaver()
  var file = path.join(saver.root, 'big.log')
  var lines = []
  for (var i = 0; i < 4000; i++) lines.push('log line ' + i + ' with some words')
  fs.writeFileSync(file, lines.join('\n'))
  var res = await saver.readTool({ path: file })
  var text = textOf(res)
  assert.ok(MARKER_RE.test(text))
  var id = text.match(MARKER_RE)[1]
  var full = textOf(await saver.expandTool({ id: id }))
  assert.ok(full.includes('log line 1999'))
})

test('readTool: offset/limit slice is respected before compression', async () => {
  var saver = makeSaver({ minBytes: 50, minSavingBytes: 1, keepRatioMax: 0.9 })
  var file = path.join(saver.root, 'slice.txt')
  var lines = []
  for (var i = 0; i < 3000; i++) lines.push('L' + i)
  fs.writeFileSync(file, lines.join('\n'))
  var res = await saver.readTool({ path: file, offset: 10, limit: 5 })
  assert.equal(textOf(res), 'L9\nL10\nL11\nL12\nL13')
})

test('readTool: missing file and directory are clean errors', async () => {
  var saver = makeSaver()
  var miss = await saver.readTool({ path: '/nonexistent/file.txt' })
  assert.equal(miss.isError, true)
  var dir = await saver.readTool({ path: saver.root })
  assert.equal(dir.isError, true)
  var noargs = await saver.readTool({})
  assert.equal(noargs.isError, true)
})

test('expandTool: unknown id explains both recovery channels', async () => {
  var saver = makeSaver()
  var res = await saver.expandTool({ id: 'zzzz' })
  assert.ok(/unknown or expired id/.test(textOf(res)))
})

test('maybeCompress: spill failure keeps the original (reversibility red line)', async () => {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'save-token-ro-'))
  var brokenStore = { saveText: function () { return Promise.reject(new Error('disk full')) } }
  var saver = new TokenSaver(Object.assign({}, defaultConfig), brokenStore, function () {})
  var big = []
  for (var i = 0; i < 3000; i++) big.push('filler ' + i)
  var m = await saver.maybeCompress('test', big.join('\n'), false)
  assert.equal(m.compressed, false)
  assert.equal(saver.stats.spillFailures, 1)
  assert.ok(fs.existsSync(root))
})

test('toolDefinitions: three tools with usable schemas', () => {
  var defs = toolDefinitions(makeSaver())
  assert.deepEqual(defs.map(function (d) { return d.name }),
    ['save_token_run', 'save_token_read', 'save_token_expand'])
  for (var d of defs) {
    assert.equal(d.inputSchema.type, 'object')
    assert.ok(d.description.length > 40)
    assert.ok(typeof d.handler === 'function')
  }
})
