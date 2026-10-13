const { chromium } = require('playwright');
(async () => {
  const B = process.argv[2], OUT = process.argv[3];
  const browser = await chromium.launch();
  const res = {};
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(B + '/', { waitUntil: 'load' });
    const rect = () => page.$eval('#template-dialog', d => { const r = d.getBoundingClientRect(); return { open: d.open, y: Math.round(r.y), h: Math.round(r.height), scrollY: Math.round(scrollY), inViewport: r.bottom > 0 && r.top < innerHeight }; });
    const r = {};
    r.load = await rect();
    await page.locator('[data-open="moon-motel"].art-open').click();
    r.open = await rect();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    r.afterEscape = await rect();
    await page.screenshot({ path: `${OUT}/after-escape-${w}.png` });
    await page.mouse.wheel(0, 300); await page.waitForTimeout(300);
    r.afterScroll = await rect();
    // can user open a different card that sits under the stale panel?
    try { await page.locator('[data-open="little-worlds"].title-link').click({ timeout: 3000 }); r.secondOpen = 'ok'; } catch (e) { r.secondOpen = 'blocked: ' + e.message.split('\n').find(l => l.includes('intercepts')); }
    res[w] = r;
    await page.close();
  }
  console.log(JSON.stringify(res, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
