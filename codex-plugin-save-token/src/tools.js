/*!
 * codex-plugin-save-token — MCP tool handlers (the orchestration half)
 *
 * Same three arms as the dsh plugin's host half, adapted to a world where the
 * model opts in by calling these tools (Codex has no waterfall to intercept
 * built-in tool results):
 * - compress: oversized command/file output -> structure-aware compression
 *   (lossless TOON first, never-worse gates) + FULL text spilled to disk +
 *   a reversible [save-token #id] notice;
 * - dedupe: a byte-identical rerun within TTL becomes a stub pointing at the
 *   first copy (fingerprints hash the FULL strings — the dsh v2.2.0 fix);
 * - expand: save_token_expand hands back the FULL original (memory cache,
 *   then the persistent spill locator — the dsh v2.4.0 closure).
 *
 * Reversibility red line kept verbatim: no spill, no compression.
 */

import { spawn } from 'node:child_process'
import { promises as fsp, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  utf8Bytes, estTokens, fmtInt, dedupeFingerprint,
  buildCandidate, buildNotice, effectiveMinBytes
} from './compress.js'

export var defaultConfig = {
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
  runTimeoutSec: 120,
  runTimeoutSecMax: 600,
  maxCaptureBytes: 2097152
}

/** SAVE_TOKEN_<SNAKE_KEY> env overrides (numbers, true/false, 0/1). */
export function applyEnv(cfg, env) {
  env = env || process.env
  for (var key of Object.keys(cfg)) {
    var raw = env['SAVE_TOKEN_' + key.replace(/[A-Z]/g, function (c) { return '_' + c }).toUpperCase()]
    if (raw === undefined) continue
    if (/^(true|false|on|off|0|1)$/i.test(raw)) cfg[key] = /^(true|on|1)$/i.test(raw)
    else if (Number(raw) === Number(raw)) cfg[key] = Number(raw)
  }
  return cfg
}

function expandHome(p) {
  if (p === '~/') return os.homedir()
  if (p && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)) }

function intArg(v, dflt, lo, hi) {
  var n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return clamp(Math.round(n), lo, hi)
}

/** Run one command under /bin/sh, capturing capped stdout/stderr. */
function execShell(command, cwd, timeoutMs, capBytes) {
  return new Promise(function (resolve) {
    var child = spawn('/bin/sh', ['-c', command], { cwd: cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    var run = { exitCode: 0, signal: null, timedOut: false, truncated: false, stdout: '', stderr: '' }
    var settled = false
    function finish(exitCode, signal) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      run.exitCode = exitCode
      run.signal = signal
      resolve(run)
    }
    function cap(key) {
      return function (chunk) {
        if (run[key].length >= capBytes) { run.truncated = true; return }
        run[key] += chunk.toString('utf8')
        if (run[key].length >= capBytes) { run[key] = run[key].slice(0, capBytes); run.truncated = true }
      }
    }
    var timer = setTimeout(function () {
      run.timedOut = true
      child.kill('SIGTERM')
      setTimeout(function () { try { child.kill('SIGKILL') } catch (e) {} }, 5000)
    }, timeoutMs)
    child.stdout.on('data', cap('stdout'))
    child.stderr.on('data', cap('stderr'))
    // the child 'close' event is the single completion point: it fires after
    // the process exits AND all stdio streams flushed (stream 'close' events
    // can beat it, so they must not resolve the promise)
    child.on('close', function (code, signal) { finish(code === null ? 1 : code, signal) })
    child.on('error', function (e) {
      run.stderr += String(e.message)
      finish(127, null)
    })
  })
}

function composeRunText(run) {
  var out = []
  out.push(run.timedOut ? 'exit=timeout (killed after timeout, signal ' + (run.signal || 'SIGTERM') + ')'
    : run.signal ? 'exit=signal ' + run.signal : 'exit=' + run.exitCode)
  if (run.stdout !== '') out.push('--- stdout ---', run.stdout.replace(/\n$/, ''))
  if (run.stderr !== '') out.push('--- stderr ---', run.stderr.replace(/\n$/, ''))
  if (run.stdout === '' && run.stderr === '') out.push('(no output)')
  if (run.truncated) out.push('[save-token: output capture truncated at source]')
  return out.join('\n')
}

export class TokenSaver {
  constructor(config, store, log) {
    this.cfg = config
    this.store = store
    this.log = log || function () {}
    this.stats = { compressions: 0, dedupeHits: 0, bytesBefore: 0, bytesAfter: 0, spillFailures: 0, expansions: 0 }
    this.count = 0
    this.seq = 0
    this.originals = new Map() // id -> { text, locator, truncated, ts }
    this.locatorIndex = new Map() // id -> { locator, ts } (survives text-cache eviction)
    this.dedupe = new Map() // fingerprint -> { ts }
  }

  shortId(prefix) {
    this.seq = (this.seq + 1) % 1679616
    return prefix + this.seq.toString(36) + Math.floor(Math.random() * 1296).toString(36)
  }

  rememberOriginal(id, text, locator) {
    var truncated = text.length > 262144
    this.originals.set(id, { text: truncated ? text.slice(0, 262144) : text, locator: locator, truncated: truncated, ts: Date.now() })
    this.locatorIndex.set(id, { locator: locator, ts: Date.now() })
    if (this.locatorIndex.size > 4000) {
      var dropL = this.locatorIndex.keys()
      while (this.locatorIndex.size > 3200) { var lx = dropL.next(); if (lx.done) break; this.locatorIndex.delete(lx.value) }
    }
    if (this.originals.size > 160) {
      var it = this.originals.keys()
      while (this.originals.size > 120) { var nx = it.next(); if (nx.done) break; this.originals.delete(nx.value) }
    }
  }

  async spill(text, toolName) {
    try {
      var ref = await this.store.saveText({ toolName: toolName, content: text })
      return ref && ref.locator ? ref : null
    } catch (e) {
      this.stats.spillFailures++
      this.log('spill failed (compression disabled for this output): ' + String(e))
      return null
    }
  }

  /** Append one saving event to <spill-root>/stats.jsonl (best effort). */
  trace(event) {
    try {
      if (!this.store || !this.store.root) return
      event.ts = Date.now()
      // synchronous: saving events are sparse (per adopted compression), and
      // a sync append keeps the stats file consistent with tool responses
      appendFileSync(path.join(this.store.root, 'stats.jsonl'), JSON.stringify(event) + '\n')
    } catch (e) { /* stats must never break the tool */ }
  }

  /** Compress arm: never-worse gates + spill first. Returns { text, compressed, id? }. */
  async maybeCompress(label, text, isError) {
    if (!this.cfg.compressEnabled) return { text: text, compressed: false }
    var floor = effectiveMinBytes(isError ? this.cfg.errorMinBytes : this.cfg.minBytes, this.cfg.minSavingBytes, this.cfg.keepRatioMax)
    if (utf8Bytes(text) <= floor) return { text: text, compressed: false }
    var cand = buildCandidate(text, this.cfg)
    if (cand === null) return { text: text, compressed: false }
    var ref = await this.spill(text, label) // reversibility FIRST
    if (ref === null) return { text: text, compressed: false }
    var id = this.shortId('c')
    this.count++
    this.stats.compressions++
    this.stats.bytesBefore += cand.before
    this.stats.bytesAfter += cand.after
    var finalText = buildNotice({
      body: cand.text,
      id: id,
      before: cand.before,
      after: cand.after,
      lossless: cand.lossless,
      stats: cand.stats,
      locator: ref.locator,
      retrievalHint: '',
      verbose: this.count <= this.cfg.noticeFullTrailerCount
    })
    this.rememberOriginal(id, text, ref.locator)
    this.log('compressed ' + label + ': ' + fmtInt(cand.before) + ' -> ' + fmtInt(cand.after) + ' B (' + (cand.lossless ? 'lossless ' : '') + cand.strategy + ')')
    this.trace({ kind: 'compress', tool: String(label || '').split(':')[0], label: String(label || ''), strategy: cand.strategy, lossless: cand.lossless, before: cand.before, after: cand.after, estBefore: estTokens(text), estAfter: estTokens(cand.text) })
    return { text: finalText, compressed: true, id: id, locator: ref.locator }
  }

  // ---------- tool: save_token_run ----------
  async runTool(args) {
    args = args || {}
    var command = typeof args.command === 'string' ? args.command.trim() : ''
    if (command === '') return textResult('save_token_run: `command` (non-empty string) is required', true)
    var cwd = typeof args.cwd === 'string' && args.cwd !== '' ? expandHome(args.cwd.trim()) : process.cwd()
    var timeoutMs = intArg(args.timeoutSec, this.cfg.runTimeoutSec, 1, this.cfg.runTimeoutSecMax) * 1000
    var run = await execShell(command, cwd, timeoutMs, this.cfg.maxCaptureBytes)
    var isError = run.exitCode !== 0
    var text = composeRunText(run)

    // dedupe arm: byte-identical successful reruns carry no new information
    if (this.cfg.dedupeEnabled && !isError) {
      var fp = dedupeFingerprint('codex', 'run', cwd + '\u0000' + command, text)
      var prev = this.dedupe.get(fp)
      var now = Date.now()
      if (prev && now - prev.ts <= this.cfg.dedupeTtlMs) {
        var ref = await this.spill(text, 'run')
        if (ref !== null) {
          var did = this.shortId('d')
          var agoSec = Math.round((now - prev.ts) / 1000)
          var stub = '[save-token #' + did + ' deduped: this command returned BYTE-IDENTICAL output to the call ' + agoSec + 's ago, which remains in context above. Do not answer from this stub alone; retrieve the earlier message, or re-run if freshness matters. Full copy of THIS call stored at: ' + ref.locator + '.]'
          if (utf8Bytes(text) - utf8Bytes(stub) > this.cfg.minSavingBytes) {
            this.rememberOriginal(did, text, ref.locator)
            this.stats.dedupeHits++
            this.log('deduped rerun (' + agoSec + 's old): ' + labelOf(command))
            this.trace({ kind: 'dedupe', tool: 'run', label: labelOf(command), strategy: 'dedupe', lossless: true, before: utf8Bytes(text), after: utf8Bytes(stub), estBefore: estTokens(text), estAfter: estTokens(stub) })
            return textResult(stub, false)
          }
        }
      }
      this.dedupe.set(fp, { ts: now })
      if (this.dedupe.size > 800) {
        var dk = this.dedupe.keys()
        while (this.dedupe.size > 500) { var dn = dk.next(); if (dn.done) break; this.dedupe.delete(dn.value) }
      }
    }

    var m = await this.maybeCompress('run: ' + labelOf(command), text, isError)
    return textResult(m.text, isError)
  }

  // ---------- tool: save_token_read ----------
  async readTool(args) {
    args = args || {}
    var p = typeof args.path === 'string' ? expandHome(args.path.trim()) : ''
    if (p === '') return textResult('save_token_read: `path` (non-empty string) is required', true)
    var stat
    try { stat = await fsp.stat(p) } catch (e) { return textResult('save_token_read: cannot read ' + p + ' (' + (e.code || String(e)) + ')', true) }
    if (stat.isDirectory()) return textResult('save_token_read: ' + p + ' is a directory', true)
    var content
    var truncated = false
    if (stat.size > this.cfg.maxCaptureBytes) {
      var fh = await fsp.open(p, 'r')
      try {
        var buf = Buffer.alloc(this.cfg.maxCaptureBytes)
        var read = await fh.read(buf, 0, this.cfg.maxCaptureBytes, 0)
        content = buf.toString('utf8', 0, read.bytesRead)
      } finally { await fh.close() }
      truncated = true
    } else {
      content = await fsp.readFile(p, 'utf8')
    }
    var offset = intArg(args.offset, 1, 1, 2147483647)
    var limit = intArg(args.limit, 2000, 1, 20000)
    var lines = content.split('\n')
    if (offset > 1 || lines.length > limit) {
      lines = lines.slice(offset - 1, offset - 1 + limit)
    }
    var text = lines.join('\n')
    if (truncated) text += '\n[save-token: file is larger than the capture cap; showing the head only]'
    var m = await this.maybeCompress('read: ' + path.basename(p), text, false)
    return textResult(m.text, false)
  }

  // ---------- tool: save_token_expand ----------
  async expandTool(args) {
    args = args || {}
    var key = typeof args.id === 'string' ? args.id.trim() : ''
    this.stats.expansions++
    var ent = this.originals.get(key)
    if (ent) return textResult(ent.text, false)
    // miss: the id expired from the text cache but the spill file persists —
    // hand back the locator (and its content when still on disk) instead of a
    // dead end
    var loc = this.locatorIndex.get(key)
    if (loc) {
      var t = await this.store.readLocator(loc.locator)
      if (t !== null) return textResult(t, false)
      return textResult('expired id. The FULL ORIGINAL is still stored at: ' + loc.locator + '. Use the read tool (or shell) on that path.', false)
    }
    return textResult('unknown or expired id. Find the FULL ORIGINAL path printed inside the original [save-token #...] notice and use the read tool on that path.', false)
  }
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text: text }], isError: isError === true }
}

function labelOf(command) {
  var oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length > 60 ? oneLine.slice(0, 57) + '...' : oneLine
}

/** MCP tool descriptors: list shape (tools/list) + bound handlers (tools/call). */
export function toolDefinitions(saver) {
  return [
    {
      name: 'save_token_run',
      description: 'Run a shell command and get a token-optimized result: oversized output is compressed structure-aware (lossless TOON tabular encoding first) with the FULL output stored on disk plus a [save-token #id] notice. Prefer this over a plain shell call for long builds, test suites, dependency trees, log dumps, and big JSON output. Any omitted detail can be unfolded losslessly with save_token_expand.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', description: 'Shell command to run (executed via /bin/sh -c).' },
          cwd: { type: 'string', description: 'Working directory for the command (defaults to the directory this server was started in).' },
          timeoutSec: { type: 'number', description: 'Kill the command after this many seconds (default 120, max 600).' }
        },
        required: ['command']
      },
      handler: function (args) { return saver.runTool(args) }
    },
    {
      name: 'save_token_read',
      description: 'Read a text file with token-optimized windowing (head/tail windows, error-line protection, tabular striding) with the FULL content stored on disk plus a [save-token #id] notice. Prefer this over a plain read for big logs, data dumps, lockfiles, and generated files. Any omitted region can be unfolded losslessly with save_token_expand.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to read (~ is expanded).' },
          offset: { type: 'number', description: '1-based first line to return (default 1).' },
          limit: { type: 'number', description: 'Number of lines to return before compression (default 2000).' }
        },
        required: ['path']
      },
      handler: function (args) { return saver.readTool(args) }
    },
    {
      name: 'save_token_expand',
      description: 'Retrieve the FULL ORIGINAL text behind a compressed [save-token #id] notice. Use it whenever an omitted region might contain a detail you need, instead of guessing from the preview.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'The short marker id from the notice, e.g. "c1or".' }
        },
        required: ['id']
      },
      handler: function (args) { return saver.expandTool(args) }
    }
  ]
}
