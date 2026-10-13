const { chromium } = require('playwright');
(async () => {
  const B = process.argv[2];
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(B + '/');
  for (const id of ['slow-bloom', 'cloud-nine', 'moon-motel', 'slow-bloom']) {
    await page.$eval(`[data-open="${id}"].title-link`, e => e.click());
    await page.$eval('.dialog-close', e => e.click());
  }
  await page.$eval('.side-link[data-category="Recently viewed"]', e => e.click());
  const shown = await page.$$eval('.template-card h3', els => els.map(e => e.textContent.trim()));
  const stored = await page.evaluate(() => localStorage.getItem('playbox.recentlyViewed.v1'));
  // keyboard shortcut and Escape in search
  await page.$eval('.side-link[data-category="For you"]', e => e.click());
  await page.keyboard.press('/');
  const focused = await page.evaluate(() => document.activeElement.id);
  console.log(JSON.stringify({ stored, shown, slashFocuses: focused }));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
