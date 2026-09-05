/*!
 * codex-plugin-save-token — dependency-free MCP stdio server (JSON-RPC 2.0)
 *
 * Speaks exactly the slice of the Model Context Protocol that a tool server
 * needs (initialize / ping / tools/list / tools/call) over the stdio
 * transport: newline-delimited JSON, one message per line. Logs go to stderr
 * ONLY — stdout carries protocol messages and nothing else. Zero npm
 * dependencies so the config.toml entry is a plain `node src/index.js`.
 */

export var SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export var ERR_PARSE = -32700
export var ERR_METHOD_NOT_FOUND = -32601
export var ERR_INVALID_PARAMS = -32602
export var ERR_INTERNAL = -32603

function rpcError(code, message) {
  var e = new Error(message)
  e.rpcCode = code
  return e
}

export class McpStdioServer {
  constructor(opts) {
    this.name = opts.name
    this.version = opts.version
    this.tools = opts.tools || []
    this.instructions = opts.instructions || ''
    this.log = opts.log || function () {}
    this.input = opts.input || process.stdin
    this.output = opts.output || process.stdout
    this.stopped = false
    this.buffer = ''
    this.pending = 0 // in-flight dispatches (a client may close stdin mid-call)
  }

  start() {
    this.onData = (chunk) => {
      this.buffer += chunk
      var idx
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        var line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 1)
        if (line.trim() !== '') void this.dispatch(line)
      }
    }
    this.onEnd = () => this.stop()
    this.onError = (e) => { this.log('stream error: ' + String(e)); this.stop() }
    this.input.setEncoding('utf8')
    this.input.on('data', this.onData)
    this.input.on('end', this.onEnd)
    this.input.on('error', this.onError)
    this.output.on('error', this.onError)
    return this
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.pending === 0) this.finishStop()
  }

  finishStop() {
    this.input.removeListener('data', this.onData)
    this.input.removeListener('end', this.onEnd)
    this.input.removeListener('error', this.onError)
    this.log('server stopped')
  }

  write(msg) {
    if (this.stopped) return
    this.output.write(JSON.stringify(msg) + '\n')
  }

  async dispatch(line) {
    this.pending++
    try {
      var msg
      try { msg = JSON.parse(line) } catch (e) {
        this.write({ jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: 'Parse error' } })
        return
      }
      if (process.env.SAVE_TOKEN_DEBUG) this.log('<- ' + line.slice(0, 400))
      if (!msg || typeof msg.method !== 'string') return // a response or junk: nothing to answer
      if (typeof msg.id === 'undefined') return // notifications never get a response
      try {
        var result = await this.handle(msg)
        this.write({ jsonrpc: '2.0', id: msg.id, result: result })
      } catch (e) {
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: e.rpcCode || ERR_INTERNAL, message: String(e.message || e) } })
      }
    } finally {
      this.pending--
      if (this.stopped && this.pending === 0) this.finishStop()
    }
  }

  async handle(msg) {
    switch (msg.method) {
      case 'initialize': {
        var requested = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : SUPPORTED_PROTOCOL_VERSIONS[0]
        // echo a version we actually speak; otherwise offer our newest
        var version = SUPPORTED_PROTOCOL_VERSIONS.indexOf(requested) >= 0 ? requested : SUPPORTED_PROTOCOL_VERSIONS[0]
        return {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: this.version },
          instructions: this.instructions
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return {
          tools: this.tools.map(function (t) {
            return { name: t.name, description: t.description, inputSchema: t.inputSchema }
          })
        }
      case 'tools/call': {
        var params = msg.params || {}
        var tool = null
        for (var i = 0; i < this.tools.length; i++) {
          if (this.tools[i].name === params.name) { tool = this.tools[i]; break }
        }
        if (tool === null) throw rpcError(ERR_INVALID_PARAMS, 'Unknown tool: ' + String(params.name))
        var args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}
        return await tool.handler(args)
      }
      default:
        throw rpcError(ERR_METHOD_NOT_FOUND, 'Method not found: ' + msg.method)
    }
  }
}
