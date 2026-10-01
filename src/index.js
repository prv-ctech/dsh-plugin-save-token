/*!
 * dsh-plugin-save-token v2.4.5 — Host half (node)
 *
 * Standard Cordis plugin loaded from the bundle layer declared in
 * cordis.patch.yml (`dsh plugin --profile web add <pkg>`). Contract:
 *
 * - `inject = ['tools', 'webServer']` — the dsh-tools registry for the
 *   `save_token_expand` dynamic tool, and the web server surface for the
 *   package-private JSON API consumed by the client dashboard.
 * - `spillStore` is read lazily with ctx.get() and is optional at runtime:
 *   a missing spill store keeps compression permanently off (reversibility
 *   first).
 * - Waterfalls: `tools/post-execute` (prepend) and `llm/stream`. The
 *   compaction assist was REMOVED in v2.4.4: dsh mounts `compaction-basic`
 *   inside an isolated group (`isolate: { compaction: true }`) and cordis
 *   resolves an isolated service only inside its own scope, so a top-level
 *   plugin can never reach `ctx.compaction`. dsh's own engine still performs
 *   automatic pressure compaction; install a dedicated compaction plugin if
 *   you need a different policy.
 *
 * v2.2.0 changes (all pure-compression logic moved to ./compress.js for unit
 * testing; behavior fixes marked):
 * - dedupe keys carry the owning session id (cross-session stubs were false)
 *   and hash the FULL args/content strings (prefix truncation could claim
 *   byte-identity for different outputs);
 * - `save_token_expand` output is exempt from both arms: re-compressing an
 *   expand result handed the model the same elided preview it just paid a
 *   turn to unfold;
 * - lossless counters increment on ADOPTED candidates (previously counted
 *   attempts the never-worse gates later rejected);
 * - the compression trigger floor also respects the saving/keepRatio
 *   arithmetic (outputs that cannot save minSavingBytes at keepRatioMax are
 *   skipped without building a candidate);
 * - the first `noticeFullTrailerCount` notices are verbose; later ones use a
 *   compact trailer with the same id/locator (fewer replayed tokens, both
 *   recovery channels intact);
 * - lossless TOON routes extended: nested field groups, keyed maps, deep
 *   dominant-array search, JSONL/NDJSON, and a lossless-vs-lossy price
 *   comparison; lossy notices disclose what was elided.
 *
 * v2.3.0 changes (cache-aware layer; bench evidence: 88.9% of input tokens
 * ride the provider prompt cache, billed at ~1/30 of the miss price):
 * - cacheRead/cacheWrite are metered separately and surfaced as a cache-hit
 *   sentinel KPI (any change that tanks it is saving tokens while raising
 *   real cost);
 * - per-model online calibration (EMA of billed/estimated tokens) corrects
 *   the avoided-token accounting without bundling a tokenizer.
 *
 * v2.4.0 changes:
 * - dedupe TTL default raised 90s -> 600s (adoption literally compares the
 *   retained full args + content, so an identical replay carries no new
 *   information; the stub already tells the model to re-run when freshness
 *   matters) with
 *   per-tool overrides (`dedupeTtlOverrides`, 0 disables dedupe for a tool);
 * - error-line protection in plain-text windows widened to ±1 context line;
 * - `save_token_expand` survives restarts/eviction via a persistent
 *   id->locator index: on a miss it hands back the spill locator (and tries
 *   a spillStore readText API when one exists) instead of a dead end;
 * - top-level vs nested tool calls are counted (dashboard) to measure the
 *   unexploited subagent surface before the nesting exemption is ever
 *   touched.
 */

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  utf8Bytes, estTokens, fmtInt,
  argsToString, dedupeFingerprint,
  buildCandidate, buildNotice, gate
} from './compress.js'

export const name = 'save-token'

export const inject = ['tools', 'webServer']

export function apply(ctx, config) {
  // ---------- owned state ----------
  var cfg = {
    compressEnabled: true,
    dedupeEnabled: true,
    minBytes: 1400,
    errorMinBytes: 6000,
    minSavingBytes: 500,
    keepRatioMax: 0.72,
    maxLines: 240,
    headLines: 140,
    tailLines: 80,
    tabularHeadRows: 60,
    tabularTailRows: 40,
    tabularStrideSamples: 50,
    longLineChars: 420,
    jsonMaxParseBytes: 524288,
    jsonlMinLines: 8,
    noticeFullTrailerCount: 3,
    dedupeTtlMs: 600000,
    dedupeTtlOverrides: {}
  }
  if (config && typeof config === 'object') {
    for (var ck in cfg) {
      if (Object.prototype.hasOwnProperty.call(config, ck) && config[ck] !== undefined) cfg[ck] = config[ck]
    }
  }

  // ---------- GUI config overrides survive restart ----------
  // The dashboard toggles only mutate `cfg` in memory, so without a sidecar
  // every restart fell back to the profile config. Persist the user-toggleable
  // booleans under $DSH_HOME/plugin-state (atomic tmp+rename), which sits
  // outside node_modules and survives plugin reinstalls. A saved value outranks
  // the profile config because it is the more recent user intent.
  var PERSIST_KEYS = ['compressEnabled', 'dedupeEnabled']
  var statePath = null
  try { statePath = join(dshHomePath('plugin-state'), 'save-token-state.json') }
  catch (e) { console.error('save-token: dshHomePath unavailable, config persistence disabled', e) }

  function loadState() {
    if (statePath === null) return
    try {
      var saved = JSON.parse(readFileSync(statePath, 'utf8')).config
      if (!saved || typeof saved !== 'object') return
      for (var i = 0; i < PERSIST_KEYS.length; i++) {
        if (typeof saved[PERSIST_KEYS[i]] === 'boolean') cfg[PERSIST_KEYS[i]] = saved[PERSIST_KEYS[i]]
      }
    } catch (e) { /* missing or corrupt sidecar: the profile config stands */ }
  }

  function persistState() {
    if (statePath === null) return
    try {
      var out = { version: 1, config: {} }
      for (var i = 0; i < PERSIST_KEYS.length; i++) out.config[PERSIST_KEYS[i]] = !!cfg[PERSIST_KEYS[i]]
      mkdirSync(dirname(statePath), { recursive: true })
      var tmp = statePath + '.tmp'
      writeFileSync(tmp, JSON.stringify(out), 'utf8')
      renameSync(tmp, statePath)
    } catch (e) { console.error('save-token: config persist failed', e) }
  }

  loadState()

  // ---------- locator index survives restart ----------
  // The marker -> spill-locator index is persisted as a bounded sidecar (same
  // plugin-state home as the toggles, separate file) so `save_token_expand`
  // can hand back the spill path after a restart/new process instead of a
  // dead end. Caps mirror the in-memory eviction; the notice text remains the
  // gold-standard recovery channel when this index has already evicted an id.
  var locatorStatePath = null
  try { locatorStatePath = join(dshHomePath('plugin-state'), 'save-token-locators.json') }
  catch (e) { console.error('save-token: dshHomePath unavailable, locator persistence disabled', e) }

  var LOCATOR_MAX_BYTES = 4194304
  var LOCATOR_MAX_ENTRY_BYTES = 4096

  function validLocator(id, entry) {
    return /^[a-z0-9]{1,64}$/.test(id) && entry && !Array.isArray(entry) &&
      typeof entry.locator === 'string' && entry.locator.length > 0 &&
      utf8Bytes(entry.locator) <= LOCATOR_MAX_ENTRY_BYTES &&
      Number.isSafeInteger(entry.ts) && entry.ts >= 0
  }

  function rememberLocator(id, entry) {
    if (!validLocator(id, entry)) return false
    var old = locatorIndex.get(id)
    if (old) locatorRetainedBytes -= utf8Bytes(JSON.stringify({ [id]: old }))
    var value = { locator: entry.locator, ts: entry.ts }
    locatorIndex.set(id, value)
    locatorRetainedBytes += utf8Bytes(JSON.stringify({ [id]: value }))
    var target = locatorIndex.size > 4000 ? 3200 : 4000
    while (locatorIndex.size > target || locatorRetainedBytes > LOCATOR_MAX_BYTES - 32) {
      var first = locatorIndex.keys().next().value
      locatorRetainedBytes -= utf8Bytes(JSON.stringify({ [first]: locatorIndex.get(first) }))
      locatorIndex.delete(first)
    }
    return locatorIndex.has(id)
  }

  function loadLocatorState() {
    if (locatorStatePath === null) return
    var fd
    try {
      fd = openSync(locatorStatePath, 'r')
      var size = fstatSync(fd).size
      if (size > LOCATOR_MAX_BYTES) return
      // A fixed-size read also bounds allocation if the file grows after stat.
      var buffer = Buffer.alloc(size + 1), used = 0, n
      while (used < buffer.length && (n = readSync(fd, buffer, used, buffer.length - used, null)) > 0) used += n
      if (used > size) return
      var saved = JSON.parse(buffer.subarray(0, used).toString('utf8'))
      var entries = saved && saved.version === 1 ? saved.entries : null
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return
      Object.entries(entries).filter(function (pair) { return validLocator(pair[0], pair[1]) })
        .sort(function (a, b) { return a[1].ts - b[1].ts }).slice(-4000)
        .forEach(function (pair) { rememberLocator(pair[0], pair[1]) })
    } catch (e) { /* missing/corrupt/oversized sidecar: use the notice's path */ }
    finally { if (fd !== undefined) closeSync(fd) }
  }

  function persistLocators() {
    if (locatorStatePath === null) return
    try {
      var out = { version: 1, entries: Object.fromEntries(locatorIndex) }
      mkdirSync(dirname(locatorStatePath), { recursive: true })
      var tmp = locatorStatePath + '.tmp'
      writeFileSync(tmp, JSON.stringify(out), 'utf8')
      renameSync(tmp, locatorStatePath)
    } catch (e) { console.error('save-token: locator persist failed', e) }
  }

  var startedAt = Date.now()
  var totals = { requests: 0, auxRequests: 0, inputTokens: 0, cachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, avoidedTokens: 0, estPromptTokens: 0 }
  var comp = { count: 0, bytesBefore: 0, bytesAfter: 0, dedupeHits: 0, dedupeSavedBytes: 0, replays: 0, losslessEncodes: 0, tabularWindows: 0, topLevelCalls: 0, nestedCalls: 0 }
  var records = []
  var recent = []
  var byTool = new Map()
  var compressedIndex = new Map()
  var dedupeCache = new Map()
  var originals = new Map()
  var locatorIndex = new Map()
  var locatorRetainedBytes = 0
  var calibration = new Map()
  var spillAvailable = null
  var lastSkip = ''
  loadLocatorState() // after the state maps exist

  // ---------- online token-estimate calibration (D1) ----------
  // Every request yields real billed input alongside this plugin's heuristic
  // estimate; a per-model EMA of actual/estimate keeps the avoided-token
  // accounting honest without bundling a tokenizer. The compression token gate
  // needs no calibration: the candidate and its original share the same script
  // mix, so the ratio cancels in that comparison.
  function ratioFor(model) {
    var ent = calibration.get(model || '')
    return ent ? ent.ratio : 1
  }
  function observeRatio(model, actual, est) {
    if (!(actual >= 500) || !(est >= 500)) return
    var key = model || ''
    var ent = calibration.get(key)
    var r = actual / est
    if (ent) {
      ent.ratio = ent.ratio * 0.8 + r * 0.2
      ent.samples = Math.min(50, ent.samples + 1)
    } else {
      ent = { ratio: r, samples: 1 }
    }
    calibration.delete(key); calibration.set(key, ent) // refresh LRU position
    if (calibration.size > 32) {
      var oldest = calibration.keys().next()
      if (!oldest.done) calibration.delete(oldest.value)
    }
  }

  // ---------- compaction: intentionally absent ----------
  // The assist was removed (v2.4.4). dsh mounts `compaction-basic` inside an
  // isolated group, and cordis resolves an isolated service only within its
  // own scope, so `ctx.get('compaction')` is undefined for a top-level plugin
  // and the assist could never run. dsh's engine still auto-compacts.

  function noteRecent(kind, label, detail, savedTokens) {
    recent.unshift({ ts: Date.now(), kind: kind, label: String(label || ''), detail: String(detail || ''), saved: savedTokens || 0 })
    if (recent.length > 60) recent.length = 60
  }

  // ---------- estimators (implemented in ./compress.js) ----------
  // Native UUIDs avoid sequence wrap/restart reuse; strip hyphens for the
  // existing marker alphabet. Guard retained IDs even if the generator repeats.
  // Legacy short IDs remain readable from the persisted index.
  function shortId(prefix) {
    for (;;) {
      var id = prefix + randomUUID().replace(/-/g, '')
      if (!originals.has(id) && !locatorIndex.has(id) && !compressedIndex.has(id)) return id
    }
  }

  function flattenPlainText(content) {
    var text = ''
    if (!Array.isArray(content)) return undefined
    for (var i = 0; i < content.length; i++) {
      var b = content[i]
      if (!b || b.type !== 'text' || typeof b.text !== 'string') return undefined
      text += b.text
    }
    return text
  }

  function ownerSessionId(exec) {
    try { return exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.id : undefined } catch (e) { return undefined }
  }

  function rememberOriginal(id, text, locator) {
    // Oversized/custom locators remain recoverable from the original notice,
    // but never enter bounded caches or the persisted lookup index.
    if (!rememberLocator(id, { locator: locator, ts: Date.now() })) return
    var truncated = text.length > 262144
    originals.set(id, { text: truncated ? text.slice(0, 262144) : text, locator: locator, truncated: truncated, ts: Date.now() })
    persistLocators()
    if (originals.size > 160) {
      var it = originals.keys()
      while (originals.size > 120) { var nx = it.next(); if (nx.done) break; originals.delete(nx.value) }
    }
  }
  function rememberCompressed(id, origText, replacedText, toolName) {
    var origTok = estTokens(origText), keptTok = estTokens(replacedText)
    compressedIndex.set(id, { o: Math.max(origTok, 1), k: keptTok, ts: Date.now() })
    if (compressedIndex.size > 4000) {
      var drop = compressedIndex.keys()
      while (compressedIndex.size > 3200) {
        var nx = drop.next()
        if (nx.done) break
        compressedIndex.delete(nx.value)
      }
    }
    var e = byTool.get(toolName) || { count: 0, savedBytes: 0 }
    e.count++; e.savedBytes += utf8Bytes(origText) - utf8Bytes(replacedText)
    byTool.set(toolName, e)
  }

  // ---------- dedupe identity bookkeeping ----------
  // The 32-bit fingerprint is only a bucket key; BYTE-IDENTICAL claims need
  // literal comparison of the retained full args + content at adoption. The
  // retained-text budget is bounded, so an entry too big to compare later is
  // dropped and dedupe silently does not fire for it — never a false stub.
  var DEDUPE_MAX_ENTRY = 2097152 // retained chars per entry
  var DEDUPE_MAX_CHARS = 8388608 // total retained verification budget
  var dedupeRetainedChars = 0
  function rememberDedupe(fp, ts, callId, args, content) {
    var old = dedupeCache.get(fp)
    if (old) dedupeRetainedChars -= old.args.length + old.content.length
    if (args.length + content.length > DEDUPE_MAX_ENTRY) {
      dedupeCache.delete(fp)
      return
    }
    dedupeCache.set(fp, { ts: ts, callId: callId, args: args, content: content })
    dedupeRetainedChars += args.length + content.length
    while (dedupeCache.size > 800 || dedupeRetainedChars > DEDUPE_MAX_CHARS) {
      var itD = dedupeCache.keys(), nxD = itD.next()
      if (nxD.done) break
      var eD = dedupeCache.get(nxD.value)
      dedupeCache.delete(nxD.value)
      dedupeRetainedChars -= eD.args.length + eD.content.length
    }
  }

  async function spillOriginal(text, sessionId, toolName, callId) {
    var store = ctx.get('spillStore')
    spillAvailable = store !== undefined
    if (store === undefined) { lastSkip = 'no spillStore backend: reversibility guaranteed, so compression stays off'; return undefined }
    if (sessionId === undefined) { lastSkip = 'no owning session'; return undefined }
    try {
      var ref = await store.saveText({
        owner: { sessionId: sessionId },
        source: { kind: 'tool', toolName: toolName, callId: callId, label: 'result' },
        suggestedName: toolName + '.txt',
        content: text
      })
      if (!ref || typeof ref.locator !== 'string' || ref.locator.length === 0) { lastSkip = 'spill ref had no locator'; return undefined }
      return ref
    } catch (e) { lastSkip = 'spill save failed: ' + String(e); return undefined }
  }

  // ---------- arm 1: compress/dedupe oversized tool results ----------
  ctx.on('tools/post-execute', async function (exec, result, next) {
    var decision = await next()
    if (!decision || decision.kind !== 'accept') return decision
    if (Object.prototype.hasOwnProperty.call(decision, 'value')) return decision
    // surface metrics (E4): how much of the call volume is nested inside
    // another tool / a subagent? The nesting exemption skips compression for
    // those calls — this counter quantifies that unexploited surface before
    // anyone flips the exemption.
    if (exec.parent !== undefined) comp.nestedCalls++
    else comp.topLevelCalls++
    if (exec.parent !== undefined) return decision
    // `read` stays exempt by design (write-file-then-read-precisely is a
    // verified information path). `save_token_expand` must stay exempt too:
    // its whole point is handing back the FULL original, so re-compressing it
    // would return the same elided preview the model just asked to unfold and
    // invite an expand loop.
    if (exec.name === 'read') return decision
    if (exec.name === 'save_token_expand') return decision
    var content = decision.content !== undefined ? decision.content : result.content
    var text = flattenPlainText(content)
    if (text === undefined) return decision
    var isError = result.isError === true
    var sessionId = ownerSessionId(exec)

    // dedupe arm (headroom cross-turn dedup). The 32-bit fingerprint is only
    // a bucket key: adoption also compares the retained full args + content
    // literally, so colliding hashes can never claim BYTE-IDENTICAL output.
    // Freshness-sensitive tools can opt out via dedupeTtlOverrides (0 = never
    // dedupe that tool).
    if (cfg.dedupeEnabled && !isError) {
      var ttl = Object.prototype.hasOwnProperty.call(cfg.dedupeTtlOverrides, exec.name) ? cfg.dedupeTtlOverrides[exec.name] : cfg.dedupeTtlMs
      if (ttl > 0) {
        var argsText = argsToString(exec.arguments)
        var fp = dedupeFingerprint(sessionId, exec.name, argsText, text)
        var prev = dedupeCache.get(fp)
        var now = Date.now()
        if (prev && now - prev.ts <= ttl && prev.args === argsText && prev.content === text) {
          var ref2 = await spillOriginal(text, sessionId, exec.name, exec.callId)
          if (ref2 !== undefined) {
            var did = shortId('d')
            var agoSec = Math.round((now - prev.ts) / 1000)
            var stub = '[save-token #' + did + ' deduped: this ' + exec.name + ' call returned BYTE-IDENTICAL output to a call ' + agoSec + 's ago, which remains in context above. Do not answer from this stub alone; retrieve the earlier message, or re-run if freshness matters. Full copy of THIS call stored at: ' + ref2.locator + '. ' + (ref2.retrievalHint || '') + ']'
            var stubGate = gate({ text: stub }, text, cfg)
            if (stubGate !== null) {
              rememberOriginal(did, text, ref2.locator)
              comp.dedupeHits++; comp.dedupeSavedBytes += stubGate.before - stubGate.after
              rememberCompressed(did, text, stub, exec.name)
              noteRecent('dedupe', exec.name, 'identical output within ' + agoSec + 's -> stubbed', estTokens(text) - estTokens(stub))
              return { kind: 'accept', content: [{ type: 'text', text: stub }] }
            }
          }
        }
        rememberDedupe(fp, now, exec.callId, argsText, text)
      }
    }

    // compress arm
    if (!cfg.compressEnabled) return decision
    var threshold = isError ? cfg.errorMinBytes : cfg.minBytes
    if (utf8Bytes(text) <= threshold) return decision
    var cand = buildCandidate(text, cfg)
    if (cand === null) return decision
    var ref = await spillOriginal(text, sessionId, exec.name, exec.callId)
    if (ref === undefined) { noteRecent('skip', exec.name, lastSkip, 0); return decision }
    var id = shortId('c')
    // The COMPLETE replacement (body + notice trailer + retrieval metadata)
    // must pass the never-worse gates, not just the body. If a verbose trailer
    // with the full retrieval hint would inflate the result, fall back to the
    // compact trailer (same id + locator channels); if even the compact form
    // cannot save anything, send the original unchanged.
    var verbose = comp.count < cfg.noticeFullTrailerCount
    var notice = {
      body: cand.text,
      id: id,
      before: cand.before,
      after: cand.after,
      lossless: cand.lossless,
      strategy: cand.strategy,
      stats: cand.stats,
      locator: ref.locator,
      retrievalHint: ref.retrievalHint || '',
      verbose: verbose
    }
    var finalText = buildNotice(notice)
    var finalGate = gate({ text: finalText, lossless: cand.lossless, strategy: cand.strategy, stats: cand.stats }, text, cfg)
    if (finalGate === null) {
      finalText = buildNotice(Object.assign({}, notice, { retrievalHint: '', verbose: false }))
      finalGate = gate({ text: finalText, lossless: cand.lossless, strategy: cand.strategy, stats: cand.stats }, text, cfg)
    }
    if (finalGate === null) return decision
    // counters count ADOPTED compressions (v2.1.x counted attempts the gates
    // later rejected), measured on the actual final replacement text
    if (cand.lossless) comp.losslessEncodes++
    if (cand.strategy === 'lines-strided') comp.tabularWindows++
    comp.count++; comp.bytesBefore += finalGate.before; comp.bytesAfter += finalGate.after
    rememberOriginal(id, text, ref.locator)
    rememberCompressed(id, text, finalText, exec.name)
    noteRecent(cand.lossless ? 'lossless' : 'compress', exec.name, fmtInt(finalGate.before) + 'B -> ' + fmtInt(finalGate.after) + 'B (-' + Math.round((1 - finalGate.after / finalGate.before) * 100) + '%)', estTokens(text) - estTokens(finalText))
    return { kind: 'accept', content: [{ type: 'text', text: finalText }] }
  }, { prepend: true })

  // ---------- arm 2: measure every model request (llm/stream waterfall) ----------
  var MARKER_RE = /\[save-token #([a-z0-9]+) /g
  function collectTexts(blocks, out, depth) {
    if (!Array.isArray(blocks)) return
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i]
      if (!b || typeof b !== 'object') continue
      if (typeof b.text === 'string') out.push(b.text)
      else if (typeof b.arguments === 'string') out.push(b.arguments)
      else if (Array.isArray(b.content) && depth < 3) collectTexts(b.content, out, depth + 1)
    }
  }
  function computeAvoided(messages) {
    var texts = []
    collectTexts(messages, texts, 0)
    var avoided = 0, hits = 0
    for (var i = 0; i < texts.length; i++) {
      MARKER_RE.lastIndex = 0
      var m
      while ((m = MARKER_RE.exec(texts[i])) !== null) {
        var ent = compressedIndex.get(m[1])
        if (ent) { avoided += Math.max(0, ent.o - ent.k); hits++ }
      }
    }
    return { avoided: avoided, hits: hits }
  }

  ctx.on('llm/stream', function (options, next) {
    var rec = {
      ts: Date.now(), kind: options.purpose ? 'aux' : 'request',
      provider: String(options.provider || ''), model: String(options.model || ''),
      estPrompt: 0, input: 0, cached: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
      avoided: 0, replayHits: 0, closed: false
    }
    try {
      var texts = []
      if (typeof options.system === 'string') texts.push(options.system)
      collectTexts(options.messages, texts, 0)
      for (var i = 0; i < texts.length; i++) rec.estPrompt += estTokens(texts[i])
      if (Array.isArray(options.tools) && options.tools.length > 0) {
        try { rec.estPrompt += estTokens(JSON.stringify(options.tools).slice(0, 200000)) } catch (e) {}
      }
      var av = computeAvoided(options.messages)
      rec.avoided = av.avoided; rec.replayHits = av.hits
    } catch (e) { console.error('save-token: measure failed', e) }

    function observe(chunk) {
      if (chunk && chunk.type === 'usage' && chunk.usage) {
        rec.input += chunk.usage.inputTokens || 0
        var cr = chunk.usage.cacheReadTokens || 0
        var cw = chunk.usage.cacheWriteTokens || 0
        // keep the split visible (cache health sentinel) alongside the sum
        rec.cacheRead += cr; rec.cacheWrite += cw
        rec.cached += cr + cw
        rec.output += chunk.usage.outputTokens || 0
        rec.reasoning += chunk.usage.reasoningTokens || 0
      }
    }
    function closeRecord() {
      if (rec.closed) return
      rec.closed = true
      observeRatio(rec.model, rec.input + rec.cached, rec.estPrompt)
      var ratio = ratioFor(rec.model)
      if (rec.kind === 'aux') totals.auxRequests++; else totals.requests++
      totals.inputTokens += rec.input; totals.cachedTokens += rec.cached
      totals.cacheReadTokens += rec.cacheRead; totals.cacheWriteTokens += rec.cacheWrite
      totals.outputTokens += rec.output; totals.reasoningTokens += rec.reasoning
      // avoided accounting is calibrated by the model's observed
      // est/actual ratio and recorded once — chart records and totals use
      // the same per-request contribution so they cannot disagree
      rec.avoidedCal = Math.round(rec.avoided * ratio)
      totals.avoidedTokens += rec.avoidedCal
      totals.estPromptTokens += rec.estPrompt
      comp.replays += rec.replayHits
      records.push(rec)
      if (records.length > 480) records.splice(0, records.length - 400)
      noteRecent(rec.kind === 'aux' ? 'aux' : 'request', rec.model || rec.provider || '?',
        'prompt~' + fmtInt(rec.estPrompt) + ' tok, out ' + fmtInt(rec.output) + ', avoided ~' + fmtInt(rec.avoidedCal) + (rec.replayHits ? ' (' + rec.replayHits + ' replayed)' : ''), rec.avoidedCal)
    }

    var inner = next()
    async function* tracked() {
      try {
        for await (var chunk of inner) { observe(chunk); yield chunk }
      } finally { closeRecord() }
    }
    return tracked()
  })

  // ---------- arm 4: save_token_expand retrieval tool (CCR closure) ----------
  ctx.tools.register(defineTool({
    name: 'save_token_expand',
    description: 'Retrieve the FULL ORIGINAL text behind a compressed [save-token #id] tool-output notice. Use it whenever an omitted region might contain a detail you need, instead of guessing from the preview.',
    parameters: {
      id: { type: 'string', required: true, description: 'The short marker id from the notice, e.g. "c1or".' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) {
        if (value && typeof value.text === 'string' && value.text.length > 0) {
          var out = value.text
          if (value.truncated === true) {
            out += '\n\n[save-token: expansion truncated at the in-memory cap of 262144 chars. FULL ORIGINAL at: ' + String(value.locator || '') + '. Use the read tool on that path.]'
          }
          return [{ type: 'text', text: out }]
        }
        return [{ type: 'text', text: String((value && value.error) || 'not found') }]
      }
    },
    execute: function (args) {
      var key = args && typeof args.id === 'string' ? args.id.trim() : ''
      var ent = originals.get(key)
      if (ent) return Promise.resolve({ text: ent.text, locator: ent.locator, truncated: ent.truncated === true })
      // miss: the id expired from the text cache (eviction or restart) but
      // the spill file persists — hand back the locator instead of a dead
      // end, and use a spillStore read API transparently when one exists
      var loc = locatorIndex.get(key)
      function locatorFallback() {
        return { error: 'expired id. The FULL ORIGINAL is still stored at: ' + loc.locator + '. Use the read tool on that path.', locator: loc.locator }
      }
      if (loc) {
        var store = ctx.get('spillStore')
        if (store && typeof store.readText === 'function') {
          return Promise.resolve().then(function () { return store.readText({ locator: loc.locator }) }).then(function (out) {
            var t = out && (typeof out.text === 'string' && out.text.length > 0 ? out.text : (typeof out === 'string' && out.length > 0 ? out : null))
            if (t) return { text: t, locator: loc.locator, truncated: false }
            return locatorFallback()
          }, function () { return locatorFallback() })
        }
        return Promise.resolve(locatorFallback())
      }
      return Promise.resolve({ error: 'unknown or expired id. Find the FULL ORIGINAL path printed inside the original [save-token #...] notice and use the read tool on that path.' })
    }
  }))

  // ---------- package-private JSON API for the Client dashboard ----------
  ctx.effect(
    () => {
      const handler = async (req, res) => {
        try {
          const path = String(req.url ?? '').split('?')[0].replace(/\/+$/, '')
          const action = path.endsWith('/api/dashboard') ? 'dashboard'
            : path.endsWith('/api/set-enabled') ? 'set-enabled'
            : path.endsWith('/api/reset') ? 'reset' : ''
          if (req.method === 'GET' && action === 'dashboard') {
            sendJson(res, 200, dashboardPayload())
            return
          }
          if (req.method === 'POST' && (action === 'set-enabled' || action === 'reset')) {
            // same-origin guard: prefix routes have no host trust fence here (PORTING §11.1 Δ5)
            const fetchSite = req.headers['sec-fetch-site']
            let sameOrigin = fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none'
            const originHeader = req.headers['origin'] || req.headers['referer']
            if (sameOrigin && originHeader) {
              try { sameOrigin = new URL(String(originHeader)).host === req.headers['host'] } catch (e) { sameOrigin = false }
            }
            if (!sameOrigin) { sendJson(res, 403, { ok: false, error: 'cross-origin POST rejected' }); return }
            let args = {}
            try {
              const chunks = []
              let len = 0
              for await (const c of req) {
                len += c.length
                if (len > 1 << 20) throw new Error('body too large')
                chunks.push(c)
              }
              const raw = Buffer.concat(chunks).toString('utf8')
              if (raw.trim() !== '') args = JSON.parse(raw)
              if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('body must be an object')
            } catch (e) {
              sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
              return
            }
            if (action === 'set-enabled') {
              const out = setEnabled(args)
              if (!out.ok) { sendJson(res, 400, out); return }
              sendJson(res, 200, out)
              return
            }
            sendJson(res, 200, resetAll())
            return
          }
          sendJson(res, 404, { ok: false, error: 'unknown save-token endpoint' })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      }
      return ctx.webServer.register({ kind: 'prefix', path: '/save-token', handler })
    },
    'save-token: dashboard API routes'
  )

  function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  function dashboardPayload() {
    var series = records.slice(-60).map(function (r) {
      return { p: r.input + r.cached || r.estPrompt, a: r.avoidedCal, aux: r.kind === 'aux' }
    })
    var tools = []
    byTool.forEach(function (v, k) { tools.push({ name: k, count: v.count, savedBytes: v.savedBytes }) })
    tools.sort(function (a, b) { return b.savedBytes - a.savedBytes })
    var billedInput = totals.inputTokens + totals.cachedTokens
    var ratioSum = 0, ratioSamples = 0
    calibration.forEach(function (e) { ratioSum += e.ratio * e.samples; ratioSamples += e.samples })
    return {
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      flags: { compress: cfg.compressEnabled, dedupe: cfg.dedupeEnabled, expandTool: true },
      spillReady: spillAvailable,
      lastSkip: lastSkip,
      totals: totals,
      reliefPct: (billedInput + totals.avoidedTokens) > 0 ? Math.round(totals.avoidedTokens * 100 / (billedInput + totals.avoidedTokens)) : 0,
      // cache-health sentinel: most input rides provider prompt cache (bench:
      // 88.9% cache-read at 1/30 price), so any change that tanks this number
      // is saving tokens while silently raising real cost
      cacheHitPct: billedInput > 0 ? Math.round(totals.cacheReadTokens * 100 / billedInput) : 0,
      estRatio: ratioSamples > 0 ? Math.round(ratioSum / ratioSamples * 100) / 100 : null,
      compression: comp,
      byTool: tools.slice(0, 8),
      series: series,
      recent: recent.slice(0, 18)
    }
  }

  function setEnabled(args) {
    var a = args || {}
    var known = a.key === 'compress' || a.key === 'dedupe'
    if (!known || typeof a.value !== 'boolean') return { ok: false }
    if (a.key === 'compress') cfg.compressEnabled = a.value
    else cfg.dedupeEnabled = a.value
    persistState()
    noteRecent('config', a.key, (a.value ? 'enabled' : 'disabled'), 0)
    return { ok: true, flags: { compress: cfg.compressEnabled, dedupe: cfg.dedupeEnabled, expandTool: true } }
  }

  function resetAll() {
    totals.requests = 0; totals.auxRequests = 0; totals.inputTokens = 0; totals.cachedTokens = 0
    totals.cacheReadTokens = 0; totals.cacheWriteTokens = 0
    totals.outputTokens = 0; totals.reasoningTokens = 0; totals.avoidedTokens = 0; totals.estPromptTokens = 0
    comp.count = 0; comp.bytesBefore = 0; comp.bytesAfter = 0; comp.dedupeHits = 0; comp.dedupeSavedBytes = 0; comp.replays = 0; comp.losslessEncodes = 0; comp.tabularWindows = 0
    comp.topLevelCalls = 0; comp.nestedCalls = 0
    records.length = 0; recent.length = 0; byTool.clear(); compressedIndex.clear(); dedupeCache.clear(); dedupeRetainedChars = 0; originals.clear()
    startedAt = Date.now()
    return { ok: true }
  }

  console.log('save-token v2.4.5 loaded: structure-aware compress + lossless tabular encode + expand tool')
}
