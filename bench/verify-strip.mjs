// Run: PLAYWRIGHT_MODULE=<playwright index.mjs> node bench/verify-strip.mjs
// Real app, real backend data, no route interception or timer stubs: verifies
// the composer strip stays a compact single line and expands stats on hover,
// and that the settings chart draws slim fixed-width columns.
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9222')
const original = browser.contexts()[0]
const context = await browser.newContext({ storageState: await original.storageState(), viewport: { width: 1200, height: 900 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
let failed = false
try {
  await page.goto('http://127.0.0.1:3080')
  await page.locator('button[aria-label^="Access mode, current:"]').waitFor({ timeout: 20000 })

  // The composer dock only mounts with an open session; open one read-only.
  // Prefer the currently running session (spinner marker); fall back to a title click.
  const running = page.locator('[role="treeitem"][data-row-key^="session:"]:has(svg[data-state="ongoing"])').first()
  if (await running.count()) await running.locator('span').first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const sessions = page.locator('[role="treeitem"][data-row-key^="session:"]')
  for (let i = 0; i < (await sessions.count()) && (await page.locator('.st-strip').count()) === 0; i++) {
    const row = sessions.nth(i)
    if (/^\s*new session/i.test(await row.innerText().catch(() => ''))) continue
    await row.locator('span').first().click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(1500)
  }
  const strip = page.locator('.st-strip')
  await strip.waitFor({ state: 'attached', timeout: 20000 })

  assert.equal(await strip.evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap', 'strip must not wrap')
  for (const width of [1013, 480, 360]) {
    await page.setViewportSize({ width, height: 841 })
    await page.waitForTimeout(200)
    const box = await strip.boundingBox()
    assert.ok(box.height <= 30, 'strip must stay one compact line at ' + width + 'px, got ' + box.height)
    assert.ok(box.x >= -1 && box.x + box.width <= width + 1, 'strip must stay inside the viewport at ' + width)
  }
  await page.setViewportSize({ width: 1013, height: 841 })
  const pop = page.locator('.st-strip-pop')
  assert.equal(await pop.isVisible(), false, 'stats popover must be hidden until hover')
  await strip.hover()
  await pop.waitFor({ state: 'visible', timeout: 5000 })
  assert.ok(await page.locator('.st-strip-pop .st-pr').count() >= 4, 'popover must list the stats rows')
  await page.mouse.move(5, 5)
  await pop.waitFor({ state: 'hidden', timeout: 5000 })
  console.log('strip compact + hover stats verified (real data)')

  // Settings chart: slim fixed-width columns, never one stretched bar.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Token Saver', exact: true }).click()
  await page.locator('.st-spark').waitFor({ timeout: 15000 })
  const cols = await page.locator('.st-col').count()
  assert.ok(cols >= 1, 'chart must render at least one request column')
  const widths = await page.locator('.st-col').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().width))
  for (const w of widths) assert.ok(w <= 12, 'chart column must stay slim, got ' + w)
  assert.ok(widths.length <= 60, 'chart must not render unbounded columns')
  console.log('chart slim-column layout verified over', cols, 'request(s)')
  await page.screenshot({ path: process.env.GUI_SCREENSHOT || '/tmp/save-token-strip.png' })
  assert.deepEqual(errors, [])
  console.log('strip + chart verification passed')
} catch (error) {
  failed = true
  console.error(error)
} finally {
  // Only the context we created; the shared CDP browser stays open. The CDP
  // socket would otherwise keep Node alive, so exit explicitly.
  await context.close()
  process.exit(failed ? 1 : 0)
}
