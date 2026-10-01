import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// apply() resolves the sidecar path from $DSH_HOME at call time, so point the
// harness home at a throwaway dir before importing the module.
const home = mkdtempSync(join(tmpdir(), 'save-token-home-'))
process.env.DSH_HOME = home

const { apply } = await import('../src/index.js')

function makeCtx() {
  const handlers = {}
  const ctx = {
    on() {},
    get() { return undefined },
    tools: { register() {} },
    effect(fn) { fn() },
    webServer: { register(route) { handlers[route.path] = route.handler; return {} } }
  }
  return { ctx, handlers }
}

async function call(handler, method, url, body) {
  const req = {
    url, method, headers: { host: 'localhost' },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) }
  }
  let out
  const res = { writeHead() {}, end(s) { out = JSON.parse(s) } }
  await handler(req, res)
  return out
}

test('GUI toggle survives a restart via $DSH_HOME/plugin-state', async () => {
  const first = makeCtx()
  apply(first.ctx, {})
  const toggle = await call(first.handlers['/save-token'], 'POST', '/save-token/api/set-enabled', { key: 'dedupe', value: false })
  assert.equal(toggle.ok, true)

  // restart: a fresh apply must read the persisted override back
  const second = makeCtx()
  apply(second.ctx, {})
  const dash = await call(second.handlers['/save-token'], 'GET', '/save-token/api/dashboard')
  assert.equal(dash.flags.dedupe, false)

  const saved = JSON.parse(readFileSync(join(home, 'plugin-state', 'save-token-state.json'), 'utf8'))
  assert.equal(saved.config.dedupeEnabled, false)
})
