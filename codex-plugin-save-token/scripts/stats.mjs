#!/usr/bin/env node
/*!
 * codex-plugin-save-token — savings report
 *
 * Reads the JSONL event stream the server appends to
 * <spill-root>/stats.jsonl on every adopted compression / dedupe and prints
 * totals, per-tool and per-day breakdowns.
 *
 *   node scripts/stats.mjs              # aggregate everything
 *   node scripts/stats.mjs --tail 10    # also show the last 10 events
 *   node scripts/stats.mjs --file X     # explicit stats file
 */

import fs from 'node:fs'
import { aggregateStats, defaultStatsPath } from '../src/stats.js'

function fmtInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') }

var argv = process.argv.slice(2)
function argOf(flag) {
  var i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
var file = argOf('--file') || defaultStatsPath()
var tail = Number(argOf('--tail') || 0)

if (!fs.existsSync(file)) {
  console.log('no stats yet: ' + file)
  console.log('(events appear after the first adopted compression or dedupe)')
  process.exit(0)
}

var events = []
for (var line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  try { events.push(JSON.parse(line)) } catch (e) { /* skip damaged line */ }
}
var report = aggregateStats(events)

var t = report.totals
console.log('save-token savings — ' + file)
console.log('  events: ' + fmtInt(t.events) + ' (' + fmtInt(t.compressions) + ' compressions, ' + fmtInt(t.dedupes) + ' dedupes)')
console.log('  bytes:  ' + fmtInt(t.bytesBefore) + ' -> ' + fmtInt(t.bytesAfter) + '  (saved ' + fmtInt(t.savedBytes) + ' B)')
console.log('  tokens: ~' + fmtInt(t.tokensBefore) + ' -> ~' + fmtInt(t.tokensAfter) + '  (saved ~' + fmtInt(t.savedTokens) + ' tok, ' + report.reliefPct + '% of compressed-input tokens)')
if (report.byTool.length > 0) {
  console.log('\nby tool:')
  for (var tool of report.byTool) {
    console.log('  ' + tool.tool.padEnd(8) + ' x' + String(tool.count).padEnd(6) + ' saved ' + fmtInt(tool.savedBytes) + ' B / ~' + fmtInt(tool.savedTokens) + ' tok')
  }
}
if (report.byDay.length > 0) {
  console.log('\nby day:')
  for (var d of report.byDay) {
    console.log('  ' + d.day + '  x' + String(d.count).padEnd(6) + ' saved ' + fmtInt(d.savedBytes) + ' B / ~' + fmtInt(d.savedTokens) + ' tok')
  }
}
if (tail > 0) {
  console.log('\nlast ' + Math.min(tail, events.length) + ' events:')
  for (var e of events.slice(-tail)) {
    console.log('  ' + new Date(e.ts).toISOString().slice(0, 19).replace('T', ' ') + '  ' + (e.kind || '?').padEnd(8) + ' ' + String(e.tool || '?').padEnd(6) + ' ' + String((e.label || '').slice(0, 40)).padEnd(42) + ' ' + fmtInt(e.before) + ' -> ' + fmtInt(e.after) + ' B' + (e.lossless ? '  [lossless]' : ''))
  }
}
