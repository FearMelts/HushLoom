// Follow-up checks: settled Recently viewed screenshot, mobile search with touch, programmatic focus.
const { chromium } = require('/home/claude/hushloom/node_modules/playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:4590/';
const OUT = '/tmp/claude-0/-home-claude-hushloom/ef68adc1-eb6d-56e0-b7e4-cbc2303fcdd6/scratchpad/ctx/copilot-shots';

(async () => {
  const browser = await chromium.launch();

  // 1. Recently viewed shelf, settled (seeded via localStorage, most recent first)
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.evaluate(() => localStorage.setItem('playbox.recentlyViewed.v1', JSON.stringify(['after-hours', 'petal-study', 'slow-bloom', 'cloud-nine', 'moon-motel'])));
    await page.reload();
    await page.waitForSelector('#template-grid .template-card');
    await page.locator('.side-link[data-category="Recently viewed"]').click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => ({
      stored: localStorage.getItem('playbox.recentlyViewed.v1'),
      shown: [...document.querySelectorAll('#template-grid .title-link')].map((e) => e.textContent.trim()),
      selected: [...document.querySelectorAll('.side-link.is-selected')].map((b) => b.dataset.category),
    }));
    console.log('recent (settled):', JSON.stringify(r));
    await page.locator('.gallery').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/copilot-1440-recent.png` });
    await ctx.close();
  }

  // 2. Mobile search with a touch device
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForSelector('#template-grid .template-card');
    const box = await page.locator('.search-box').boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(200);
    const afterTap = await page.evaluate(() => ({ active: document.activeElement.id || document.activeElement.tagName, inputDisplay: getComputedStyle(document.querySelector('#search')).display }));
    console.log('touch tap on search icon:', JSON.stringify(afterTap));
    await page.locator('.search-box svg').tap({ force: true }).catch((e) => console.log('tap svg error', e.message.split('\n')[0]));
    await page.waitForTimeout(200);
    console.log('tap on svg icon -> active:', await page.evaluate(() => document.activeElement.id || document.activeElement.tagName));
    const prog = await page.evaluate(() => { document.querySelector('#search').focus(); return { active: document.activeElement.id || document.activeElement.tagName, focusable: document.activeElement === document.querySelector('#search') }; });
    console.log('programmatic #search.focus():', JSON.stringify(prog));
    const tabStops = [];
    await page.evaluate(() => document.activeElement.blur());
    for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); tabStops.push(await page.evaluate(() => document.activeElement.id || document.activeElement.dataset.category || document.activeElement.dataset.open || document.activeElement.dataset.favorite || document.activeElement.className)); }
    console.log('#search among first 40 Tab stops?', tabStops.includes('search'));
    await page.screenshot({ path: `${OUT}/copilot-390-search-tap.png` });
    await ctx.close();
  }

  await browser.close();
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });
