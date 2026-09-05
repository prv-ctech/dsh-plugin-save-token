/*!
 * codex-plugin-save-token — pure stats aggregation
 *
 * The server appends one JSON line per saving event (compress / dedupe) to
 * <spill-root>/stats.jsonl; this module turns those events into totals.
 * Pure and deterministic — the CLI (scripts/stats.mjs) is a thin wrapper.
 */

export function aggregateStats(events) {
  var totals = { events: 0, compressions: 0, dedupes: 0, bytesBefore: 0, bytesAfter: 0, savedBytes: 0, tokensBefore: 0, tokensAfter: 0, savedTokens: 0 }
  var byToolMap = new Map()
  var byDayMap = new Map()
  for (var e of events) {
    if (!e || typeof e !== 'object') continue
    var saved = Math.max(0, (e.before || 0) - (e.after || 0))
    var savedTok = Math.max(0, (e.estBefore || 0) - (e.estAfter || 0))
    totals.events++
    if (e.kind === 'dedupe') totals.dedupes++
    else totals.compressions++
    totals.bytesBefore += e.before || 0
    totals.bytesAfter += e.after || 0
    totals.savedBytes += saved
    totals.tokensBefore += e.estBefore || 0
    totals.tokensAfter += e.estAfter || 0
    totals.savedTokens += savedTok
    var toolKey = String(e.tool || '?')
    var tool = byToolMap.get(toolKey) || { tool: toolKey, count: 0, savedBytes: 0, savedTokens: 0 }
    tool.count++
    tool.savedBytes += saved
    tool.savedTokens += savedTok
    byToolMap.set(toolKey, tool)
    var day = typeof e.ts === 'number' ? new Date(e.ts).toISOString().slice(0, 10) : '?'
    var dayStat = byDayMap.get(day) || { day: day, count: 0, savedBytes: 0, savedTokens: 0 }
    dayStat.count++
    dayStat.savedBytes += saved
    dayStat.savedTokens += savedTok
    byDayMap.set(day, dayStat)
  }
  var byTool = Array.from(byToolMap.values()).sort(function (a, b) { return b.savedBytes - a.savedBytes })
  var byDay = Array.from(byDayMap.values()).sort(function (a, b) { return a.day < b.day ? -1 : 1 })
  var relief = totals.tokensBefore > 0 ? Math.round(totals.savedTokens * 100 / totals.tokensBefore) : 0
  return { totals: totals, byTool: byTool, byDay: byDay, reliefPct: relief }
}

/** Resolve the stats.jsonl path the same way the server picks its spill root. */
export function defaultStatsPath(env) {
  env = env || process.env
  if (env.SAVE_TOKEN_SPILL_DIR) return env.SAVE_TOKEN_SPILL_DIR + '/stats.jsonl'
  var home = env.CODEX_HOME || (process.env.HOME || '') + '/.codex'
  return home + '/save-token/stats.jsonl'
}
