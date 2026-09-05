import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { aggregateStats, defaultStatsPath } from '../src/stats.js'
import { SpillStore } from '../src/store.js'
import { TokenSaver, defaultConfig } from '../src/tools.js'

function makeSaver() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'save-token-stats-'))
  var saver = new TokenSaver(Object.assign({}, defaultConfig), new SpillStore(root), function () {})
  saver.root = root
  return saver
}

function eventsOf(root) {
  return fs.readFileSync(path.join(root, 'stats.jsonl'), 'utf8').split('\n')
    .filter(function (l) { return l.trim() !== '' }).map(function (l) { return JSON.parse(l) })
}

test('aggregateStats: totals, byTool ordering, byDay, reliefPct', () => {
  var r = aggregateStats([
    { ts: Date.UTC(2026, 8, 1, 10), kind: 'compress', tool: 'run', before: 10000, after: 2000, estBefore: 3000, estAfter: 600 },
    { ts: Date.UTC(2026, 8, 1, 11), kind: 'dedupe', tool: 'run', before: 8000, after: 300, estBefore: 2400, estAfter: 90 },
    { ts: Date.UTC(2026, 8, 2, 9), kind: 'compress', tool: 'read', before: 1000, after: 900, estBefore: 300, estAfter: 270 }
  ])
  assert.equal(r.totals.events, 3)
  assert.equal(r.totals.compressions, 2)
  assert.equal(r.totals.dedupes, 1)
  assert.equal(r.totals.savedBytes, 8000 + 7700 + 100)
  assert.equal(r.totals.savedTokens, 2400 + 2310 + 30)
  assert.equal(r.reliefPct, Math.round(r.totals.savedTokens * 100 / r.totals.tokensBefore))
  assert.equal(r.byTool[0].tool, 'run')
  assert.equal(r.byTool[0].count, 2)
  assert.deepEqual(r.byDay.map(function (d) { return d.day }), ['2026-09-01', '2026-09-02'])
})

test('aggregateStats: empty and malformed events are safe', () => {
  var r = aggregateStats([])
  assert.equal(r.totals.events, 0)
  assert.equal(r.reliefPct, 0)
  assert.equal(aggregateStats([null, 'junk', 42]).totals.events, 0)
})

test('defaultStatsPath: env precedence matches the spill root rule', () => {
  assert.equal(defaultStatsPath({ SAVE_TOKEN_SPILL_DIR: '/x' }), '/x/stats.jsonl')
  assert.equal(defaultStatsPath({ CODEX_HOME: '/ch' }), '/ch/save-token/stats.jsonl')
  assert.ok(defaultStatsPath({}).endsWith('/.codex/save-token/stats.jsonl'))
})

test('tool saves an event per adopted compression with byte+token estimates', async () => {
  var saver = makeSaver()
  await saver.runTool({ command: 'seq 0 4999 | sed "s/^/row-/"' })
  var events = eventsOf(saver.root)
  assert.equal(events.length, 1)
  var e = events[0]
  assert.equal(e.kind, 'compress')
  assert.equal(e.tool, 'run')
  assert.ok(e.before > e.after)
  assert.ok(e.estBefore > e.estAfter)
  assert.ok(typeof e.strategy === 'string' && e.strategy.length > 0)
  assert.equal(typeof e.lossless, 'boolean')
  // the CLI aggregate accepts exactly this shape
  var r = aggregateStats(events)
  assert.equal(r.totals.events, 1)
})

test('tool records dedupe stubs as saving events too', async () => {
  var saver = makeSaver()
  var cmd = 'seq 0 1999 | sed "s/^/dup-/"'
  await saver.runTool({ command: cmd })
  await saver.runTool({ command: cmd })
  var events = eventsOf(saver.root)
  assert.equal(events.filter(function (e) { return e.kind === 'compress' }).length, 1)
  assert.equal(events.filter(function (e) { return e.kind === 'dedupe' }).length, 1)
})
