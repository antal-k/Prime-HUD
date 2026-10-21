// Downloads an HLTV demo archive with headless Chrome so Cloudflare lets it through.
// The id is in the match page's "Demo download" link: hltv.org/download/demo/<id>
// Usage: node hltv-demo.cjs <demoId> [outDir]
// Unpack with macOS bsdtar (Homebrew 7zz has no RAR support): bsdtar -xf <archive>.rar
const path = require('path')
const fs = require('fs')
const REPO = path.resolve(__dirname, '../..')
const { chromium } = require(path.join(REPO, 'node_modules/playwright'))

const [demoId, outDir = path.join(REPO, '.worktrees/demo')] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
;(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--headless=new', '--disable-blink-features=AutomationControlled']
  })
  // Cloudflare blocks the default "HeadlessChrome" user agent.
  const version = browser.version().split('.')[0]
  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`
  })
  const page = await context.newPage()
  try {
    await page.goto('https://www.hltv.org/', { waitUntil: 'domcontentloaded' })
    for (let i = 0; i < 30 && /Just a moment/i.test(await page.title()); i++)
      await page.waitForTimeout(1000)
    const download = page.waitForEvent('download', { timeout: 60000 })
    await page.evaluate((id) => {
      const a = document.createElement('a')
      a.href = `/download/demo/${id}`
      document.body.appendChild(a)
      a.click()
    }, demoId)
    const d = await download
    console.log('downloading', d.url())
    const file = path.join(outDir, d.suggestedFilename())
    await d.saveAs(file)
    console.log('saved', file, fs.statSync(file).size)
  } catch (e) {
    console.error('failed:', e.message, '| page title:', await page.title().catch(() => '?'))
    process.exitCode = 1
  } finally {
    await browser.close()
  }
})()
