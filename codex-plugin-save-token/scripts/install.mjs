#!/usr/bin/env node
/*!
 * codex-plugin-save-token — installer for ~/.codex/config.toml
 *
 * Idempotent: `add` (default) inserts or replaces the [mcp_servers.save-token]
 * block in one canonical shape; `remove` strips it; `status` reports. A
 * timestamped backup is written before every mutation. No codex CLI needed —
 * the block mirrors what `codex mcp add` writes for a stdio server.
 *
 *   node scripts/install.mjs            # add / update
 *   node scripts/install.mjs remove     # uninstall
 *   node scripts/install.mjs status     # is it registered?
 *   --home <dir>    CODEX_HOME override (default $CODEX_HOME or ~/.codex)
 *   --entry <file>  server entry override (default ../src/index.js)
 *   --skill         also install skill/SKILL.md into <home>/skills/save-token/
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

var SERVER_KEY = 'save-token'
var HEADER = '[mcp_servers.' + SERVER_KEY + ']'

function homeDir(argv) {
  var i = argv.indexOf('--home')
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1])
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function entryFile(argv) {
  var i = argv.indexOf('--entry')
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1])
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js')
}

/** Replace the block (header line through the line before the next header / EOF). */
function patchBlock(text, replacement) {
  var lines = text.split('\n')
  var start = -1
  var quoted = '[mcp_servers."' + SERVER_KEY + '"]'
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim()
    if (t === HEADER || t === quoted) { start = i; break }
  }
  var block = replacement === null ? [] : replacement.split('\n')
  if (start === -1) {
    if (replacement === null) return { text: text, changed: false }
    if (text.length > 0 && !text.endsWith('\n')) text += '\n'
    return { text: text + '\n' + replacement.trimEnd() + '\n', changed: true }
  }
  var end = lines.length
  for (var j = start + 1; j < lines.length; j++) {
    if (/^\s*\[.*\]\s*$/.test(lines[j])) { end = j; break }
  }
  var out = lines.slice(0, start).concat(block, lines.slice(end)).join('\n')
  return { text: out, changed: true }
}

function blockText(entry) {
  // minimal key set: parsed by codex 0.77 through latest — richer keys
  // (startup_timeout_sec, cwd, ...) make some versions drop the whole entry
  return [
    HEADER,
    'type = "stdio"',
    'command = ' + JSON.stringify(process.execPath),
    'args = [' + JSON.stringify(entry) + ']',
    ''
  ].join('\n')
}

function configPath(home) { return path.join(home, 'config.toml') }

function loadConfig(home) {
  var p = configPath(home)
  try { return { p: p, text: fs.readFileSync(p, 'utf8') } } catch (e) { return { p: p, text: '' } }
}

function saveWithBackup(home, text) {
  var p = configPath(home)
  var bak = p + '.bak.save-token.' + new Date().toISOString().replace(/[:.]/g, '-')
  try { fs.copyFileSync(p, bak); console.error('backup: ' + bak) } catch (e) { /* fresh config */ }
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(p, text)
  console.error('written: ' + p)
}

function installSkill(home) {
  var src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill', 'SKILL.md')
  var dir = path.join(home, 'skills', SERVER_KEY)
  fs.mkdirSync(dir, { recursive: true })
  var dst = path.join(dir, 'SKILL.md')
  fs.copyFileSync(src, dst)
  console.error('skill installed: ' + dst)
}

var argv = process.argv.slice(2)
var verb = argv.find(function (a) { return !a.startsWith('--') }) || 'add'
var home = homeDir(argv)
var entry = entryFile(argv)

if (verb === 'status') {
  var cur = loadConfig(home)
  var hit = cur.text.split('\n').some(function (l) { return l.trim() === HEADER || l.trim() === '[mcp_servers."' + SERVER_KEY + '"]' })
  console.log(hit ? 'installed: ' + cur.p : 'not installed (' + cur.p + ')')
  process.exit(hit ? 0 : 1)
} else if (verb === 'remove') {
  var cur2 = loadConfig(home)
  var r2 = patchBlock(cur2.text, null)
  if (r2.changed) { saveWithBackup(home, r2.text); console.error('save-token server removed from codex config') }
  else console.error('nothing to remove')
} else if (verb === 'add') {
  if (!fs.existsSync(entry)) { console.error('entry not found: ' + entry); process.exit(1) }
  var cur3 = loadConfig(home)
  var r3 = patchBlock(cur3.text, blockText(entry))
  saveWithBackup(home, r3.text)
  console.error('save-token server registered: node ' + entry)
  if (argv.includes('--skill')) installSkill(home)
  console.error('next: restart codex (or run `codex mcp list`) and the tools save_token_run / save_token_read / save_token_expand appear.')
} else {
  console.error('usage: node scripts/install.mjs [add|remove|status] [--home <dir>] [--entry <file>] [--skill]')
  process.exit(2)
}
