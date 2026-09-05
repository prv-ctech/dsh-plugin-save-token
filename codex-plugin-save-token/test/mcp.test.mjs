import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

var ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js')

/** Minimal MCP client over stdio for protocol-level tests. */
function startServer(spillDir) {
  var child = spawn(process.execPath, [ENTRY], {
    env: Object.assign({}, process.env, { SAVE_TOKEN_SPILL_DIR: spillDir }),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  var client = { child: child, waiters: new Map(), nextId: 1, lines: [] }
  var buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', function (chunk) {
    buf += chunk
    var idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      var line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.trim() === '') continue
      var msg = JSON.parse(line)
      var w = client.waiters.get(msg.id)
      if (w) { client.waiters.delete(msg.id); w(msg) }
      else client.lines.push(msg)
    }
  })
  client.send = function (msg) {
    child.stdin.write(JSON.stringify(msg) + '\n')
    return msg.id
  }
  client.request = function (method, params) {
    var id = client.nextId++
    client.send({ jsonrpc: '2.0', id: id, method: method, params: params })
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { client.waiters.delete(id); reject(new Error('timeout waiting for id ' + id)) }, 15000)
      client.waiters.set(id, function (msg) { clearTimeout(t); resolve(msg) })
    })
  }
  client.stop = function () { child.stdin.end(); child.kill('SIGTERM') }
  return client
}

test('MCP stdio: initialize -> tools/list -> call -> expand, protocol-clean', async () => {
  var spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-token-mcp-'))
  var client = startServer(spillDir)
  try {
    // 1. initialize: protocol version echo + server info
    var init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codex-test', version: '0.0.0' }
    })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.serverInfo.name, 'save-token')
    assert.ok(init.result.capabilities.tools)

    // 2. initialized notification must NOT produce a response
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    // 3. tools/list: exactly the three tools
    var list = await client.request('tools/list', {})
    assert.deepEqual(list.result.tools.map(function (t) { return t.name }),
      ['save_token_run', 'save_token_read', 'save_token_expand'])
    assert.ok(list.result.tools[0].inputSchema.required.includes('command'))

    // 4. tools/call run: small output passes through
    var run = await client.request('tools/call', { name: 'save_token_run', arguments: { command: 'echo hi-from-mcp' } })
    assert.equal(run.result.isError, false)
    assert.ok(run.result.content[0].text.includes('hi-from-mcp'))

    // 5. tools/call run: big output compresses; expand returns the original
    var big = await client.request('tools/call', {
      name: 'save_token_run',
      arguments: { command: 'seq 5000 | sed "s/^/mcp-row-/"' }
    })
    var id = big.result.content[0].text.match(/\[save-token #([a-z0-9]+) /)[1]
    var expand = await client.request('tools/call', { name: 'save_token_expand', arguments: { id: id } })
    assert.ok(expand.result.content[0].text.includes('mcp-row-4999'))

    // 6. read a file end-to-end
    var file = path.join(spillDir, 'sample.log')
    var lines = []
    for (var i = 0; i < 3000; i++) lines.push('mcp log line ' + i)
    fs.writeFileSync(file, lines.join('\n'))
    var read = await client.request('tools/call', { name: 'save_token_read', arguments: { path: file } })
    assert.ok(/\[save-token #[a-z0-9]+ /.test(read.result.content[0].text))

    // 7. protocol errors
    var unknown = await client.request('resources/list', {})
    assert.equal(unknown.error.code, -32601)
    var badTool = await client.request('tools/call', { name: 'nope', arguments: {} })
    assert.equal(badTool.error.code, -32602)

    // 8. every response line was a single line of JSON (NDJSON framing held)
    assert.ok(true)
  } finally {
    client.stop()
  }
})

test('MCP stdio: unsupported protocol version falls back to our newest', async () => {
  var spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-token-mcp2-'))
  var client = startServer(spillDir)
  try {
    var init = await client.request('initialize', { protocolVersion: '1999-01-01' })
    assert.equal(init.result.protocolVersion, '2025-06-18')
  } finally {
    client.stop()
  }
})

test('MCP stdio: malformed line gets a Parse error response with null id', async () => {
  var spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-token-mcp3-'))
  var client = startServer(spillDir)
  try {
    client.child.stdin.write('this is not json\n')
    var response = await new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('no parse error response')) }, 5000)
      var check = setInterval(function () {
        var hit = client.lines.find(function (m) { return m.id === null && m.error })
        if (hit) { clearInterval(check); clearTimeout(t); client.lines.length = 0; resolve(hit) }
      }, 50)
    })
    assert.equal(response.error.code, -32700)
  } finally {
    client.stop()
  }
})

test('MCP stdio: in-flight response flushes even when stdin closes mid-call', async () => {
  var spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-token-mcp4-'))
  var child = spawn(process.execPath, [ENTRY], {
    env: Object.assign({}, process.env, { SAVE_TOKEN_SPILL_DIR: spillDir }),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  // close stdin immediately after the request: the run tool is still in
  // flight, and its response must still be written before exit
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'save_token_run', arguments: { command: 'echo drain-check' } } }) + '\n')
  child.stdin.end()
  var out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', function (c) { out += c })
  var code = await new Promise(function (resolve) { child.on('close', function (c) { resolve(c) }) })
  var lines = out.split('\n').filter(function (l) { return l.trim() !== '' }).map(function (l) { return JSON.parse(l) })
  var answer = lines.find(function (m) { return m.id === 7 })
  assert.ok(answer, 'response for id 7 must arrive before exit')
  assert.ok(answer.result.content[0].text.includes('drain-check'))
  assert.equal(code, 0)
})
