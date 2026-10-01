// Run against an already authenticated project browser. No production POSTs.
// PLAYWRIGHT_MODULE may point to an installed Playwright index.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9222')
const original = browser.contexts()[0]
const context = await browser.newContext({ storageState: await original.storageState(), viewport: { width: 1013, height: 841 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
let holdNextGet = false, notifyHeld
const nextHeld = () => new Promise(resolve => { notifyHeld = resolve })
const heldGets = new Set()
function releaseGets() { for (const resolve of heldGets) resolve(); heldGets.clear() }
let fixture
let failed = false
try {
  const response = await context.request.get('http://127.0.0.1:3080/save-token/api/dashboard')
  assert.equal(response.status(), 200)
  fixture = await response.json()
  fixture.flags.compress = true
  fixture.flags.dedupe = true
  fixture.totals.requests = 41
  fixture.totals.inputTokens = Number.MAX_SAFE_INTEGER
  fixture.totals.outputTokens = Number.MAX_SAFE_INTEGER
  // Disable automatic dashboard timers, retain callbacks for controlled races.
  await page.addInitScript(() => {
    const originalInterval = window.setInterval
    window.__saveTokenPolls = []
    window.setInterval = function (fn, ms, ...args) {
      if (ms === 2500 || ms === 4000) { window.__saveTokenPolls.push({ fn, ms }); return 0 }
      return originalInterval(fn, ms, ...args)
    }
  })
  fixture.byTool = [{ name: 'long_tool_' + 'identifier'.repeat(30), count: 2, savedBytes: 10000 }]
  fixture.recent = [{ ts: Date.now(), kind: 'compress', label: 'model_' + 'verylongname'.repeat(30), detail: 'Long detail ' + 'unbrokentext'.repeat(50) + ' 中文详细信息'.repeat(30), saved: 100 }]
  fixture.totals.avoidedTokens = 12345
  fixture.compression = Object.assign({ count: 3, bytesBefore: 100000, bytesAfter: 25000, dedupeHits: 1, dedupeSavedBytes: 4000, replays: 1, losslessEncodes: 2, tabularWindows: 1, topLevelCalls: 3, nestedCalls: 0 }, fixture.compression || {})
  await page.route('**/save-token/api/**', async route => {
    const request = route.request(), action = new URL(request.url()).pathname.split('/').pop()
    if (action === 'dashboard') {
      const payload = structuredClone(fixture)
      if (holdNextGet) {
        holdNextGet = false
        await new Promise(resolve => { heldGets.add(resolve); notifyHeld?.(); notifyHeld = undefined })
      }
      await route.fulfill({ json: payload })
    } else if (action === 'set-enabled') {
      const body = request.postDataJSON()
      fixture.flags[body.key] = body.value
      await route.fulfill({ json: { ok: true, flags: fixture.flags } })
    } else if (action === 'reset') {
      fixture.totals.requests = 0
      await route.fulfill({ json: { ok: true } })
    } else throw new Error('Unexpected API action: ' + action)
  })
  await page.goto('http://127.0.0.1:3080')
  // Wait for the workspace-dependent access control before opening settings.
  await page.locator('button[aria-label^="Access mode, current:"]').waitFor()
  // Live strip lives in the composer dock, which mounts with an open session.
  // Best-effort here (fixture/timer stubs can keep the dock unmounted); the
  // dedicated real-app audit bench/verify-strip.mjs asserts strip behavior.
  if (await page.locator('.st-strip').count() === 0) {
    await page.setViewportSize({ width: 1440, height: 900 })
    const sessions = page.locator('[role="treeitem"][data-row-key^="session:"]')
    const total = await sessions.count()
    for (let i = 0; i < total && (await page.locator('.st-strip').count()) === 0; i++) {
      const row = sessions.nth(i)
      const label = (await row.innerText().catch(() => '')) || ''
      if (/^\s*new session/i.test(label)) continue
      await row.locator('span').first().click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(1200)
    }
    if ((await page.locator('.st-strip').count()) === 0) console.log('note: composer dock not mounted under fixture stubs; strip covered by bench/verify-strip.mjs')
  }
  if (await page.locator('.st-strip').count() > 0) {
    const strip = page.locator('.st-strip')
    assert.ok((await strip.boundingBox()).height > 0, 'strip must be laid out')
    await page.waitForFunction(() => document.querySelector('.st-strip b')?.textContent?.includes('12.3k'))
    assert.equal(await strip.evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap')
    assert.ok((await strip.evaluate(el => el.scrollWidth)) <= (await strip.evaluate(el => el.clientWidth)) + 1, 'strip must not overflow horizontally')
    for (const width of [1013, 480]) {
      await page.setViewportSize({ width, height: 841 })
      assert.ok((await strip.boundingBox()).height <= 30, 'strip must stay one line at ' + width + 'px')
    }
    const pop = page.locator('.st-strip-pop')
    assert.equal(await pop.isVisible(), false)
    await strip.hover()
    assert.ok(await pop.isVisible(), 'hover must reveal the stats popover')
    const popText = await pop.innerText()
    assert.ok(popText.includes('12.3k') && popText.includes('3'), 'popover must show live stats')
    console.log('compact strip + hover stats verified')
  }
  await page.setViewportSize({ width: 1013, height: 841 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Token Saver', exact: true }).click()
  await page.locator('.st-table').waitFor()
  // Confirm the actual server-carried client bundle contains the rebuilt CSS.
  const bundleUrl = await page.evaluate(() => performance.getEntriesByType('resource').find(r => r.name.includes('/plugins/??') && r.name.includes('dsh-plugin-save-token/client.js'))?.name)
  assert.ok(bundleUrl, 'Actual loaded combo bundle must include plugin')
  const bundle = await context.request.get(bundleUrl)
  assert.equal(bundle.status(), 200)
  const local = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/, '').trimEnd()
  assert.ok((await bundle.text()).includes(local), 'Served executable plugin bytes must match build')

  for (const width of [1013, 780, 480]) {
    await page.setViewportSize({ width, height: 841 })
    const dimensions = await page.locator('.st-wrap').evaluate(root => {
      const nodes = [root, ...root.querySelectorAll('.st-card, .st-kpi, .st-v, .st-barrow, .st-table, .st-table td')]
      return { viewport: innerWidth, width: root.clientWidth, scroll: root.scrollWidth,
        overflow: nodes.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => ({ tag: e.tagName, class: e.className, width: e.clientWidth, scroll: e.scrollWidth })) }
    })
    assert.equal(dimensions.viewport, width)
    assert.deepEqual(dimensions.overflow, [], 'Long content must wrap inside panel at viewport ' + width)
    assert.ok((await page.locator('.st-table').innerText()).includes(fixture.recent[0].detail), 'Full detail must remain in DOM')
    console.log('layout verified', JSON.stringify(dimensions))
  }

  async function mutate(button, expected) {
    const held = nextHeld()
    holdNextGet = true
    const post = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/save-token/api/'))
    const refresh = page.waitForRequest(r => r.method() === 'GET' && r.url().endsWith('/save-token/api/dashboard'))
    await button.click()
    assert.equal((await post).status(), 200)
    await refresh
    await held
    assert.equal(await page.locator('.st-wrap').count(), 1, 'Dashboard must remain visible while refetch is pending')
    assert.equal(await page.getByText('Loading token stats...', { exact: true }).count(), 0)
    releaseGets()
    await expected()
  }
  await mutate(page.getByRole('button', { name: 'Compress: ON', exact: true }), async () => {
    await page.getByRole('button', { name: 'Compress: OFF', exact: true }).waitFor()
  })
  await mutate(page.getByRole('button', { name: 'Reset', exact: true }), async () => {
    await page.waitForFunction(() => document.querySelector('.st-kpi .st-v')?.textContent === '0')
  })
  await mutate(page.getByRole('button', { name: 'Dedupe: ON', exact: true }), async () => {
    await page.getByRole('button', { name: 'Dedupe: OFF', exact: true }).waitFor()
  })
  console.log('all toggle/reset refetches verified with polling disabled; production mutations intercepted')

  // An older poll must not overwrite a newer post-mutation snapshot.
  const oldHeld = nextHeld()
  holdNextGet = true
  const oldRequestPromise = page.waitForRequest(r => r.method() === 'GET' && r.url().endsWith('/save-token/api/dashboard'))
  await page.evaluate(() => { window.__saveTokenPolls.find(p => p.ms === 2500).fn() })
  const oldRequest = await oldRequestPromise
  await oldHeld
  const oldResponse = page.waitForResponse(r => r.request() === oldRequest)
  const newResponse = page.waitForResponse(r => r.request() !== oldRequest && r.request().method() === 'GET' && r.url().endsWith('/save-token/api/dashboard'))
  await page.getByRole('button', { name: 'Compress: OFF', exact: true }).click()
  await newResponse
  await page.getByRole('button', { name: 'Compress: ON', exact: true }).waitFor()
  releaseGets()
  await (await oldResponse).finished()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.getByRole('button', { name: 'Compress: ON', exact: true }).count(), 1, 'Late older response must not revert latest state')
  console.log('out-of-order response protection verified')

  // Drive two real registered poll callbacks before either response completes.
  // The first completed response must still update UI while a later poll waits.
  fixture.totals.requests = 42
  const firstHeld = nextHeld()
  holdNextGet = true
  const firstPoll = page.waitForRequest(r => r.method() === 'GET' && r.url().endsWith('/save-token/api/dashboard'))
  await page.evaluate(() => { window.__saveTokenPolls.find(p => p.ms === 2500).fn() })
  const firstPollRequest = await firstPoll
  await firstHeld
  const firstPollResponse = page.waitForResponse(r => r.request() === firstPollRequest)
  fixture.totals.requests = 43
  const secondHeld = nextHeld()
  holdNextGet = true
  const secondPoll = page.waitForRequest(r => r.method() === 'GET' && r.url().endsWith('/save-token/api/dashboard'))
  await page.evaluate(() => { window.__saveTokenPolls.find(p => p.ms === 2500).fn() })
  await secondPoll
  await secondHeld
  assert.equal(heldGets.size, 2)
  const releaseFirst = heldGets.values().next().value
  heldGets.delete(releaseFirst)
  releaseFirst()
  await (await firstPollResponse).finished()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.locator('.st-kpi .st-v').first().innerText(), '42', 'Slow overlapping polls must not starve completed responses')
  releaseGets()
  await page.waitForFunction(() => document.querySelector('.st-kpi .st-v')?.textContent === '43')
  console.log('slow overlapping poll progress verified')
  assert.deepEqual(errors, [])
  await page.setViewportSize({ width: 1013, height: 841 })
  await page.locator('.st-table').scrollIntoViewIfNeeded()
  await page.screenshot({ path: process.env.GUI_SCREENSHOT || '/tmp/save-token-gui-regression.png' })
  console.log('GUI verification passed; served bundle matches local build')
} catch (error) {
  failed = true
  console.error('GUI diagnostic:', (await page.locator('body').innerText()).slice(-1200), errors)
  await page.screenshot({ path: '/tmp/save-token-gui-failure.png' })
  console.error(error)
} finally {
  holdNextGet = false
  releaseGets()
  // Only the context we created; the shared CDP browser stays open. The CDP
  // socket would otherwise keep Node alive, so exit explicitly.
  await context.close()
  process.exit(failed ? 1 : 0)
}
