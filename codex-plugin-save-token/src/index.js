#!/usr/bin/env node
/*!
 * codex-plugin-save-token — entry point (MCP stdio server)
 *
 * Register it once in ~/.codex/config.toml:
 *   node scripts/install.mjs
 * which adds:
 *   [mcp_servers.save-token]
 *   type = "stdio"
 *   command = "<node>"
 *   args = ["<this file>"]
 *
 * All configuration is env-based (SAVE_TOKEN_*), so the config.toml block
 * stays static; see defaultConfig in src/tools.js for every key.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpStdioServer } from './mcp.js'
import { SpillStore, resolveSpillRoot } from './store.js'
import { TokenSaver, defaultConfig, applyEnv, toolDefinitions } from './tools.js'

export var VERSION = '1.0.1'

export function createServer(opts) {
  opts = opts || {}
  var cfg = applyEnv(Object.assign({}, defaultConfig, opts.config), process.env)
  var store = opts.store || new SpillStore(resolveSpillRoot(opts.spillDir))
  var saver = new TokenSaver(cfg, store, opts.log)
  return new McpStdioServer({
    name: 'save-token',
    version: VERSION,
    tools: toolDefinitions(saver),
    instructions: 'save-token cuts token cost without cutting intelligence: prefer save_token_run for commands and save_token_read for files that produce large output. Every compressed [save-token #id] notice keeps both recovery channels: the save_token_expand tool and the on-disk full-original path.',
    log: opts.log
  })
}

function main(argv) {
  var spillDir
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i]
    if (a === '--help' || a === '-h') {
      console.log('save-token MCP server v' + VERSION + ' — usage: node src/index.js [--spill-dir <dir>]')
      console.log('config: SAVE_TOKEN_* env vars (see README); logs go to stderr')
      return 0
    }
    if (a === '--version') { console.log(VERSION); return 0 }
    if (a === '--spill-dir') { spillDir = argv[++i] }
  }
  var root = resolveSpillRoot(spillDir)
  createServer({ spillDir: spillDir }).start()
  console.error('save-token v' + VERSION + ' listening on stdio (spill root: ' + root + ')')
  return 0
}

// run when executed directly (bin symlink included), import cleanly otherwise
var isMain = false
try {
  isMain = fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url))
} catch (e) { isMain = false }
if (isMain) process.exitCode = main(process.argv.slice(2))
