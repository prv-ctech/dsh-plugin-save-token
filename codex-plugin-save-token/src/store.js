/*!
 * codex-plugin-save-token — spill store (reversibility arm)
 *
 * The dsh plugin delegates persistence to the harness `spillStore` service;
 * a plain Codex CLI install has no such service, so this module is the
 * smallest complete replacement: append-friendly day directories, one file
 * per spilled output, a `locator` (absolute path) that survives process
 * restarts, strict root-scoped reads, and a throttled best-effort prune.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** Pick the spill root: explicit arg > env > CODEX_HOME > ~/.codex > tmp. */
export function resolveSpillRoot(explicit) {
  var candidates = [
    explicit,
    process.env.SAVE_TOKEN_SPILL_DIR,
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'save-token', 'spill') : undefined,
    path.join(os.homedir(), '.codex', 'save-token', 'spill')
  ].filter(Boolean)
  for (var i = 0; i < candidates.length; i++) {
    try { fs.mkdirSync(candidates[i], { recursive: true }); return path.resolve(candidates[i]) } catch (e) { /* try next */ }
  }
  var fallback = path.join(os.tmpdir(), 'save-token-spill')
  fs.mkdirSync(fallback, { recursive: true })
  return path.resolve(fallback)
}

function dayStamp(d) {
  return '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0')
}

function safeName(s) {
  return String(s || 'output').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'output'
}

export class SpillStore {
  constructor(root, opts) {
    this.root = root
    this.opts = Object.assign({ maxFiles: 800, maxAgeDays: 7, pruneEveryMs: 3600000 }, opts)
    this.lastPruneAt = 0
  }

  /** Persist one full text; resolves to { locator, bytes }. */
  async saveText(ref) {
    var dir = path.join(this.root, dayStamp(new Date()))
    await fsp.mkdir(dir, { recursive: true })
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    var file = path.join(dir, id + '-' + safeName(ref.toolName) + '.txt')
    await fsp.writeFile(file, ref.content, 'utf8')
    this.pruneSoon()
    return { locator: file, bytes: Buffer.byteLength(ref.content, 'utf8') }
  }

  /** Read back by locator; null when the path is outside the root or gone. */
  async readLocator(locator) {
    var resolved = path.resolve(String(locator || ''))
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) return null
    try { return await fsp.readFile(resolved, 'utf8') } catch (e) { return null }
  }

  pruneSoon() {
    var now = Date.now()
    if (now - this.lastPruneAt < this.opts.pruneEveryMs) return
    this.lastPruneAt = now
    this.prune(now).catch(function () {})
  }

  /** Best-effort retention: drop day dirs older than maxAgeDays, then cap file count. */
  async prune(nowMs) {
    var opts = this.opts
    var entries
    try { entries = await fsp.readdir(this.root) } catch (e) { return }
    var days = entries.filter(function (e) { return /^\d{8}$/.test(e) }).sort()
    var cutoff = dayStamp(new Date(nowMs - opts.maxAgeDays * 86400000))
    var removals = []
    var kept = []
    for (var i = 0; i < days.length; i++) {
      if (days[i] < cutoff) removals.push(fsp.rm(path.join(this.root, days[i]), { recursive: true, force: true }))
      else kept.push(days[i])
    }
    var remaining = kept.length
    for (var k = 0; k < kept.length && remaining * 60 > opts.maxFiles; k++) {
      var dir = path.join(this.root, kept[k])
      try {
        var files = (await fsp.readdir(dir)).sort()
        var excess = files.length - Math.max(0, opts.maxFiles - (remaining - 1) * 60)
        for (var f = 0; f < Math.min(excess, files.length); f++) removals.push(fsp.rm(path.join(dir, files[f]), { force: true }))
      } catch (e) { /* next dir */ }
      remaining--
    }
    await Promise.all(removals.map(function (p) { return p.catch(function () {}) }))
  }
}
