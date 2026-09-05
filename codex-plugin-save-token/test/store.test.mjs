import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SpillStore, resolveSpillRoot } from '../src/store.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'save-token-store-'))
}

test('resolveSpillRoot: explicit dir wins and is created', () => {
  var root = path.join(tmpRoot(), 'nested', 'spill')
  assert.equal(resolveSpillRoot(root), path.resolve(root))
  assert.ok(fs.existsSync(root))
})

test('saveText/readLocator: roundtrip with a locator inside the root', async () => {
  var store = new SpillStore(tmpRoot())
  var ref = await store.saveText({ toolName: 'run', content: 'hello\nworld\n' })
  assert.ok(ref.locator.startsWith(store.root))
  assert.equal(ref.bytes, 12)
  assert.equal(await store.readLocator(ref.locator), 'hello\nworld\n')
})

test('readLocator: refuses paths outside the root (path-safety)', async () => {
  var store = new SpillStore(tmpRoot())
  var outside = path.join(os.tmpdir(), 'definitely-outside-' + Date.now() + '.txt')
  fs.writeFileSync(outside, 'secret')
  assert.equal(await store.readLocator(outside), null)
  assert.equal(await store.readLocator('/etc/passwd'), null)
  assert.equal(await store.readLocator(''), null)
})

test('readLocator: missing file reads as null, not a throw', async () => {
  var store = new SpillStore(tmpRoot())
  assert.equal(await store.readLocator(path.join(store.root, '20000101', 'gone.txt')), null)
})

test('prune: drops day dirs older than maxAgeDays', async () => {
  var root = tmpRoot()
  var store = new SpillStore(root, { maxAgeDays: 7 })
  var oldDay = '20200101'
  fs.mkdirSync(path.join(root, oldDay), { recursive: true })
  fs.writeFileSync(path.join(root, oldDay, 'a.txt'), 'old')
  var today = path.join(root, '' + new Date().toISOString().slice(0, 10).replace(/-/g, ''))
  fs.mkdirSync(today, { recursive: true })
  fs.writeFileSync(path.join(today, 'b.txt'), 'new')
  await store.prune(Date.now())
  assert.equal(fs.existsSync(path.join(root, oldDay)), false)
  assert.equal(fs.existsSync(path.join(today, 'b.txt')), true)
})
