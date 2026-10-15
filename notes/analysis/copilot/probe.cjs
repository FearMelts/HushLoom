const { chromium } = require('playwright');
(async () => {
  const B = process.argv[2];
  const browser = await chromium.launch();
  const out = {};
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const requests = []; const consoleMsgs = [];
  page.on('request', r => requests.push(r.method() + ' ' + r.url()));
  page.on('console', m => consoleMsgs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => consoleMsgs.push('pageerror: ' + e.message));
  await page.goto(B + '/', { waitUntil: 'load' });
  const jsClick = 0;
  const cards = () => page.$$eval('.template-card h3', els => els.map(e => e.textContent.trim()));
  const count = () => page.textContent('#result-count');
  out.initial = { cards: await cards(), count: await count(), title: await page.title(), h2: await page.textContent('#gallery-title') };
  await page.$eval('.side-link[data-category="All templates"]', e => e.click());
  out.allTemplates = { cards: (await cards()).length, h2: await page.textContent('#gallery-title') };
  await page.$eval('.side-link[data-category="Videos"]', e => e.click());
  out.videos = { cards: await cards(), h2: await page.textContent('#gallery-title') };
  await page.$eval('.side-link[data-category="Images"]', e => e.click());
  out.images = { cards: await cards() };
  await page.$eval('.side-link[data-category="For you"]', e => e.click());
  await page.fill('#search', 'moon');
  out.searchMoon = await cards();
  await page.fill('#search', 'playbox');
  out.searchPlaybox = (await cards()).length;
  await page.fill('#search', 'terrarium');
  out.searchPromptOnlyWord = { cards: await cards(), emptyVisible: await page.isVisible('#empty-state'), clearFiltersVisible: await page.isVisible('#clear-filters') };
  await page.fill('#search', '');
  // open templates in order: slow-bloom then moon-motel
  await page.$eval('[data-open="slow-bloom"].title-link', e => e.click());
  out.dialog = {
    open: await page.$eval('#template-dialog', d => d.open),
    kicker: await page.textContent('#dialog-kicker'),
    type: await page.textContent('#dialog-type'),
    prompt: await page.inputValue('#prompt'),
    aspect: await page.inputValue('#aspect-ratio'),
  };
  await page.fill('#prompt', 'EDITED PROMPT');
  await page.$eval('.advanced-settings summary', e => e.click());
  await page.selectOption('#aspect-ratio', 'square');
  await page.$eval('#generate-button', e => e.click());
  out.generateNotice = await page.textContent('#generation-notice');
  await page.keyboard.press('Escape');
  out.escapeClosedAfterGenerate = !(await page.$eval('#template-dialog', d => d.open));
  if (!out.escapeClosedAfterGenerate) await page.$eval('.dialog-close', e => e.click());
  out.closeButtonClosed = !(await page.$eval('#template-dialog', d => d.open));
  await page.$eval('[data-open="moon-motel"].title-link', e => e.click());
  await page.keyboard.press('Escape');
  out.escapeClosedFresh = !(await page.$eval('#template-dialog', d => d.open));
  if (!out.escapeClosedFresh) await page.$eval('.dialog-close', e => e.click());
  await page.$eval('.side-link[data-category="Recently viewed"]', e => e.click());
  out.recentlyViewedOrder = await cards();
  out.recentStorage = await page.evaluate(() => localStorage.getItem('playbox.recentlyViewed.v1'));
  out.clearHistoryVisible = await page.isVisible('#clear-history');
  // favorite
  await page.$eval('.side-link[data-category="For you"]', e => e.click());
  await page.$eval('[data-favorite="petal-study"]', e => e.click());
  out.afterFavorite = { saved: await page.textContent('#saved-count'), toast: await page.textContent('#toast') };
  await page.$eval('a[data-view-link="collection"]', e => e.click());
  await page.waitForTimeout(100);
  out.collection = { hash: await page.evaluate(() => location.hash), cards: await cards(), welcomeHidden: await page.$eval('#welcome', e => e.hidden), h2: await page.textContent('#gallery-title') };
  await page.reload();
  out.afterReloadCollection = await cards();
  await page.goto(B + '/#explore');
  await page.$eval('[data-open="slow-bloom"].title-link', e => e.click());
  out.persistedEdit = { prompt: await page.inputValue('#prompt'), aspect: await page.inputValue('#aspect-ratio') };
  out.storage = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
  await page.$eval('.dialog-close', e => e.click());
  // corrupted storage robustness
  await page.evaluate(() => localStorage.setItem('playbox.favorites.v1', '{"a":1}'));
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.reload();
  await page.waitForTimeout(200);
  out.corruptFavorites = { errors: errs, cards: (await cards()).length };
  await page.evaluate(() => localStorage.clear());
  // grid columns per width
  out.columns = {};
  for (const w of [1500, 1280, 800, 600, 390, 360]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(B + '/');
    out.columns[w] = await page.$eval('#template-grid', g => getComputedStyle(g).gridTemplateColumns.split(' ').length);
  }
  // mobile chips
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(B + '/');
  out.mobile = {
    sideNavVisible: await page.isVisible('.side-nav'),
    chips: await page.$$eval('.category-chip', els => els.filter(e => e.offsetParent).map(e => e.dataset.category)),
    footerVisible: await page.isVisible('.footer'),
    scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth),
  };
  out.requests = [...new Set(requests)];
  out.console = consoleMsgs;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
