// Playwright probe of Copilot's origin/main prototype, run against the scratch export.
// Usage: node pw-run.cjs   (expects the server on BASE, default http://127.0.0.1:4590/)
const { chromium } = require('/home/claude/hushloom/node_modules/playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:4590/';
const OUT = '/tmp/claude-0/-home-claude-hushloom/ef68adc1-eb6d-56e0-b7e4-cbc2303fcdd6/scratchpad/ctx/copilot-shots';
fs.mkdirSync(OUT, { recursive: true });

const lines = [];
const out = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); lines.push(s); console.log(s); };

async function newPage(browser, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const ev = { console: [], pageerrors: [], failed: [], responses: [] };
  page.on('console', (m) => ev.console.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => ev.pageerrors.push(String(e)));
  page.on('requestfailed', (r) => ev.failed.push(`${r.method()} ${r.url()} -> ${r.failure() && r.failure().errorText}`));
  page.on('response', (r) => ev.responses.push(`${r.status()} ${r.request().method()} ${r.url()}`));
  return { ctx, page, ev };
}

async function load(page) {
  await page.goto(BASE, { waitUntil: 'load', timeout: 20000 });
  await page.waitForSelector('#template-grid .template-card', { timeout: 10000 });
  await page.waitForTimeout(400);
}

async function snap(page) {
  return page.evaluate(() => {
    const $ = (s) => document.querySelector(s);
    const toast = $('#toast');
    const ls = (k) => localStorage.getItem(k);
    const a = document.activeElement;
    return {
      hash: location.hash,
      count: $('#result-count').textContent,
      cards: [...document.querySelectorAll('#template-grid .template-card .title-link')].map((e) => e.textContent.trim()),
      title: $('#gallery-title').textContent,
      kicker: $('#gallery-kicker').textContent,
      selected: [...document.querySelectorAll('.side-link.is-selected, .category-chip.is-selected')].map((b) => b.dataset.category),
      navActive: [...document.querySelectorAll('[data-view-link].is-active')].map((l) => l.dataset.viewLink),
      toast: toast.classList.contains('is-visible') ? toast.textContent : '',
      dialogOpen: $('#template-dialog').open,
      notice: $('#generation-notice').hidden ? '' : $('#generation-notice').textContent,
      empty: !$('#empty-state').hidden,
      clearHistory: !$('#clear-history').hidden,
      welcomeHidden: $('#welcome').hidden,
      savedCount: $('#saved-count').textContent,
      search: $('#search').value,
      active: a ? (a.id ? '#' + a.id : a.tagName.toLowerCase() + (a.className ? '.' + String(a.className).split(' ')[0] : '')) : null,
      ls: { fav: ls('playbox.favorites.v1'), recent: ls('playbox.recentlyViewed.v1'), edits: ls('playbox.edits.v1') },
      scrollY: Math.round(scrollY),
    };
  });
}

function diff(a, b) {
  const d = {};
  for (const k of Object.keys(b)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) d[k] = b[k];
  return d;
}

// Click via a real pointer click; report what changed (or that nothing did).
async function tryClick(page, label, locator, opts = {}) {
  const before = await snap(page);
  let err = null;
  try { await locator.click({ timeout: opts.timeout ?? 3000, ...(opts.click || {}) }); } catch (e) { err = e.message.split('\n').filter((l) => /intercepts|Timeout|not visible|outside|hidden/.test(l)).slice(0, 2).join(' | ') || e.message.split('\n')[0]; }
  await page.waitForTimeout(opts.wait ?? 150);
  const after = await snap(page);
  const d = diff(before, after);
  out(`  [click] ${label}: ${err ? 'CLICK FAILED: ' + err : Object.keys(d).length ? 'changed ' + JSON.stringify(d) : 'NO CHANGE'}`);
  return { err, d, after };
}

async function geometry(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('#template-grid');
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
    const vis = (s) => { const e = document.querySelector(s); if (!e) return 'missing'; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 ? 'hidden' : `visible ${Math.round(r.width)}x${Math.round(r.height)} @(${Math.round(r.x)},${Math.round(r.y)})`; };
    const d = document.querySelector('#template-dialog');
    const dr = d.getBoundingClientRect();
    return {
      columns: cols,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      sideNav: vis('.side-nav'),
      chipStrip: vis('.category-strip'),
      chips: [...document.querySelectorAll('.category-chip')].filter((c) => getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().width > 0).map((c) => c.dataset.category),
      searchInput: vis('#search'),
      searchBox: vis('.search-box'),
      avatar: vis('.avatar'),
      favoriteBtn: vis('.favorite-button'),
      dialog: { open: d.open, display: getComputedStyle(d).display, position: getComputedStyle(d).position, rect: [Math.round(dr.x), Math.round(dr.y), Math.round(dr.width), Math.round(dr.height)] },
    };
  });
}

async function hitTestFirstCard(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('#template-grid .art-open');
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { cardCentre: [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)], topElement: el ? (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]) : null, insideDialog: !!(el && el.closest('#template-dialog')) };
  });
}

(async () => {
  const browser = await chromium.launch();
  out(`Chromium ${browser.version()}  base=${BASE}`);

  // ---------- Screenshots + geometry at the three sizes ----------
  for (const [w, h] of [[390, 844], [820, 1180], [1440, 900]]) {
    const { ctx, page, ev } = await newPage(browser, w, h);
    await load(page);
    const s = await snap(page);
    const g = await geometry(page);
    await page.screenshot({ path: `${OUT}/copilot-${w}.png` });
    await page.screenshot({ path: `${OUT}/copilot-${w}-full.png`, fullPage: true });
    out(`\n=== ${w}x${h} initial ===`);
    out('  count:', s.count, '| cards:', s.cards.join(', '));
    out('  title:', s.title, '| kicker:', s.kicker, '| selected:', s.selected);
    out('  geometry:', g);
    out('  responses:', ev.responses);
    out('  failed requests:', ev.failed);
    out('  console:', ev.console, '| pageerrors:', ev.pageerrors);
    await ctx.close();
  }

  // ---------- Desktop interaction pass (1440x900) ----------
  {
    const { ctx, page, ev } = await newPage(browser, 1440, 900);
    await load(page);
    out('\n=== 1440x900 interactions ===');
    out('  (1) Side-nav category buttons');
    for (const cat of ['All templates', 'Images', 'Videos', 'Recently viewed', 'Saved', 'For you']) {
      const r = await tryClick(page, `side-link "${cat}"`, page.locator(`.side-link[data-category="${cat}"]`));
      out(`      -> count=${r.after.count} cards=[${r.after.cards.join(', ')}] title="${r.after.title}" empty=${r.after.empty} clearHistory=${r.after.clearHistory}`);
      if (cat === 'Recently viewed') {
        out('      never-opened dialog while the gallery is empty:', (await geometry(page)).dialog);
        await page.screenshot({ path: `${OUT}/copilot-1440-empty-recent.png` });
      }
    }

    out('  (2) Search');
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press('/');
    out('      "/" shortcut -> activeElement', (await snap(page)).active);
    for (const q of ['moon', 'MOON ', 'playbox', 'video', 'terrarium', 'cassette']) {
      await page.locator('#search').fill(q);
      await page.waitForTimeout(100);
      const s = await snap(page);
      out(`      query ${JSON.stringify(q)} -> ${s.count} [${s.cards.join(', ')}] empty=${s.empty}`);
    }
    await tryClick(page, 'empty-state "Back to exploring"', page.locator('#clear-filters'));
    await page.locator('#search').fill('moon');
    await page.locator('#search').press('Escape');
    await page.waitForTimeout(100);
    { const s = await snap(page); out(`      Escape in search -> value=${JSON.stringify(s.search)} count=${s.count} active=${s.active}`); }
    await page.locator('#search').fill('bloom');
    await page.locator('.side-link[data-category="Videos"]').click();
    { const s = await snap(page); out(`      "bloom" + Videos -> ${s.count} [${s.cards.join(', ')}]`); }
    await page.locator('#search').fill('');
    await page.locator('.side-link[data-category="For you"]').click();

    out('  (3) Avatar, brand, static elements');
    await tryClick(page, 'avatar "Y"', page.locator('.avatar'));
    await tryClick(page, 'media tag on first card', page.locator('.media-tag').first(), { click: { force: true } });
    await tryClick(page, 'quick-arrow on first card', page.locator('.quick-arrow').first());
    await tryClick(page, 'welcome note', page.locator('.welcome-note'));
    await tryClick(page, 'sidebar note', page.locator('.sidebar-note'));

    out('  (4) Favorites and Collection');
    await tryClick(page, 'favorite on card 1 (Moon Motel)', page.locator('[data-favorite="moon-motel"]'));
    await tryClick(page, 'favorite on card 6 (Velvet Sky)', page.locator('[data-favorite="velvet-sky"]'));
    await tryClick(page, 'top nav "Collection"', page.locator('[data-view-link="collection"]'));
    await tryClick(page, 'top nav "Explore"', page.locator('[data-view-link="explore"]'));
    await tryClick(page, 'side "Saved"', page.locator('.side-link[data-category="Saved"]'));
    out('      never-opened dialog with 2 saved cards:', (await geometry(page)).dialog);
    await page.screenshot({ path: `${OUT}/copilot-1440-saved-view.png` });
    await tryClick(page, 'brand "playbox." (while in Saved, hash #explore)', page.locator('.brand'));
    await tryClick(page, 'un-favorite Velvet Sky (inside Saved view)', page.locator('[data-favorite="velvet-sky"]'));
    await tryClick(page, 'side "For you"', page.locator('.side-link[data-category="For you"]'));

    out('  (5) Template dialog');
    const g0 = await geometry(page);
    out('      before any open: dialog', g0.dialog);
    await tryClick(page, 'card title "Cloud Nine"', page.locator('.title-link[data-open="cloud-nine"]'));
    {
      const t = await page.evaluate(() => ({ kicker: document.querySelector('#dialog-kicker').textContent, title: document.querySelector('#dialog-title').textContent, type: document.querySelector('#dialog-type').textContent, prompt: document.querySelector('#prompt').value, aspect: document.querySelector('#aspect-ratio').value, motion: document.querySelector('#motion').value, motionLabel: document.querySelector('#motion-value').textContent }));
      out('      dialog fields:', t);
    }
    await page.screenshot({ path: `${OUT}/copilot-1440-dialog-open.png` });
    await tryClick(page, 'details "Make it more yours"', page.locator('.advanced-settings summary'));
    out('      details open =', await page.evaluate(() => document.querySelector('.advanced-settings').open));
    await page.locator('#prompt').fill('A tiny cloud city at dusk, with paper lanterns', { timeout: 5000 });
    await page.locator('#aspect-ratio').selectOption('square', { timeout: 5000 });
    await page.locator('#motion').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
    out('      after edits: motion label =', await page.locator('#motion-value').textContent(), '| stored edits =', (await snap(page)).ls.edits);
    const reqBefore = ev.responses.length;
    await tryClick(page, '"Start creating"', page.locator('#generate-button'));
    out('      network responses caused by Start creating:', ev.responses.slice(reqBefore));
    await page.screenshot({ path: `${OUT}/copilot-1440-dialog-notice.png` });

    out('  (6) Close dialog with the x button, then try to use the gallery');
    await tryClick(page, 'dialog close x', page.locator('.dialog-close'));
    out('      after close:', (await geometry(page)).dialog);
    await page.screenshot({ path: `${OUT}/copilot-1440-after-close.png` });
    out('      hit test at first card centre:', await hitTestFirstCard(page));
    await tryClick(page, 'card "Moon Motel" art after close', page.locator('.art-open[data-open="moon-motel"]'), { timeout: 2500 });
    await tryClick(page, 'side-link "Images" after close', page.locator('.side-link[data-category="Images"]'), { timeout: 2500 });
    await tryClick(page, 'search box after close', page.locator('#search'), { timeout: 2500 });

    out('  (7) Escape and backdrop close');
    await page.reload(); await page.waitForSelector('#template-grid .template-card');
    await page.locator('.title-link[data-open="moon-motel"]').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    out('      Escape -> open =', await page.evaluate(() => document.querySelector('#template-dialog').open), '| dialog', (await geometry(page)).dialog);
    await page.reload(); await page.waitForSelector('#template-grid .template-card');
    await page.locator('.title-link[data-open="moon-motel"]').click();
    await page.mouse.click(8, 8);
    await page.waitForTimeout(150);
    out('      backdrop click at (8,8) -> open =', await page.evaluate(() => document.querySelector('#template-dialog').open), '| dialog', (await geometry(page)).dialog);

    out('  (8) Persistence after reload');
    await page.reload(); await page.waitForSelector('#template-grid .template-card');
    {
      const s = await snap(page);
      out(`      savedCount=${s.savedCount} fav=${s.ls.fav} recent=${s.ls.recent}`);
      await page.locator('.title-link[data-open="cloud-nine"]').click();
      const t = await page.evaluate(() => ({ prompt: document.querySelector('#prompt').value, aspect: document.querySelector('#aspect-ratio').value, motion: document.querySelector('#motion').value, motionLabel: document.querySelector('#motion-value').textContent }));
      out('      reopened Cloud Nine after reload:', t);
    }

    out('  (9) Recently viewed order and Clear history');
    await page.reload(); await page.waitForSelector('#template-grid .template-card');
    // open three templates in order, reloading in between so the closed-dialog overlay does not block the next click
    for (const id of ['slow-bloom', 'petal-study', 'after-hours']) {
      await page.locator(`.title-link[data-open="${id}"]`).click();
      await page.reload(); await page.waitForSelector('#template-grid .template-card');
    }
    await page.locator('.side-link[data-category="Recently viewed"]').click();
    { const s = await snap(page); out(`      opened slow-bloom, petal-study, after-hours (last). stored=${s.ls.recent}`); out(`      shelf shows: [${s.cards.join(', ')}] count=${s.count} clearHistory visible=${s.clearHistory}`); }
    await page.screenshot({ path: `${OUT}/copilot-1440-recent.png` });
    await tryClick(page, '"Clear history"', page.locator('#clear-history'));

    out('  (10) Skip link');
    await page.reload(); await page.waitForSelector('#template-grid .template-card');
    await page.keyboard.press('Tab');
    out('      first Tab focuses:', (await snap(page)).active, await page.evaluate(() => document.activeElement.textContent.trim()));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    { const s = await snap(page); out(`      Enter -> hash=${s.hash} scrollY=${s.scrollY}`); }

    out('  console:', ev.console, '| pageerrors:', ev.pageerrors, '| failed:', ev.failed);
    await ctx.close();
  }

  // ---------- Tablet pass (820x1180) ----------
  {
    const { ctx, page, ev } = await newPage(browser, 820, 1180);
    await load(page);
    out('\n=== 820x1180 interactions ===');
    await tryClick(page, 'side-link "Videos"', page.locator('.side-link[data-category="Videos"]'));
    await tryClick(page, 'side-link "Recently viewed"', page.locator('.side-link[data-category="Recently viewed"]'));
    await page.locator('#search').fill('moon');
    out('      search "moon" ->', (await snap(page)).count);
    await page.locator('#search').fill('');
    await page.locator('.side-link[data-category="For you"]').click();
    await page.locator('.title-link[data-open="velvet-sky"]').click();
    await page.screenshot({ path: `${OUT}/copilot-820-dialog-open.png` });
    await page.locator('.dialog-close').click();
    out('      after close:', (await geometry(page)).dialog, '| hit test:', await hitTestFirstCard(page));
    await page.screenshot({ path: `${OUT}/copilot-820-after-close.png` });
    out('  console:', ev.console, '| pageerrors:', ev.pageerrors, '| failed:', ev.failed);
    await ctx.close();
  }

  // ---------- Mobile pass (390x844) ----------
  {
    const { ctx, page, ev } = await newPage(browser, 390, 844);
    await load(page);
    out('\n=== 390x844 interactions ===');
    out('  (1) Chips');
    for (const cat of ['All templates', 'Images', 'Videos', 'Saved', 'For you']) {
      const r = await tryClick(page, `chip "${cat}"`, page.locator(`.category-chip[data-category="${cat}"]`));
      out(`      -> count=${r.after.count}`);
    }
    await page.locator('.category-chip[data-category="Saved"]').click();
    out('      never-opened dialog with Saved (0 cards) at 390:', (await geometry(page)).dialog);
    await page.screenshot({ path: `${OUT}/copilot-390-empty-saved.png` });
    await page.locator('.category-chip[data-category="For you"]').click();
    out('      side-link "Recently viewed" visible?', await page.locator('.side-link[data-category="Recently viewed"]').isVisible(), '| any Recently viewed chip?', await page.locator('.category-chip[data-category="Recently viewed"]').count());
    out('  (2) Search on mobile');
    out('      #search visible?', await page.locator('#search').isVisible());
    await tryClick(page, 'search icon (.search-box)', page.locator('.search-box'));
    out('      activeElement after tapping search icon:', (await snap(page)).active, '| input visible now?', await page.locator('#search').isVisible());
    await page.keyboard.type('moon');
    await page.waitForTimeout(100);
    { const s = await snap(page); out(`      typed "moon" -> search=${JSON.stringify(s.search)} count=${s.count}`); }
    await page.locator('body').click({ position: { x: 200, y: 600 } }).catch(() => {});
    await page.keyboard.press('/');
    { const s = await snap(page); out(`      "/" shortcut -> active=${s.active}`); }
    await page.locator('.search-box').focus().catch(() => {});
    out('      tabbing order (first 6 Tab stops):');
    await page.reload(); await page.waitForSelector('#template-grid .template-card');
    const stops = [];
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); stops.push((await snap(page)).active); }
    out('       ', stops.join(' -> '));
    { const s = await snap(page); }
    out('  (3) Favorite and dialog on mobile');
    await tryClick(page, 'favorite Moon Motel', page.locator('[data-favorite="moon-motel"]'));
    await tryClick(page, 'card art "Cloud Nine"', page.locator('.art-open[data-open="cloud-nine"]'));
    await page.screenshot({ path: `${OUT}/copilot-390-dialog-open.png` });
    await tryClick(page, '"Start creating"', page.locator('#generate-button'));
    await tryClick(page, 'dialog close x', page.locator('.dialog-close'));
    out('      after close:', (await geometry(page)).dialog);
    out('      hit test:', await hitTestFirstCard(page));
    await page.screenshot({ path: `${OUT}/copilot-390-after-close.png` });
    await tryClick(page, 'chip "Images" after close', page.locator('.category-chip[data-category="Images"]'), { timeout: 2500 });
    await tryClick(page, 'card "Moon Motel" after close', page.locator('.art-open[data-open="moon-motel"]'), { timeout: 2500 });
    await tryClick(page, 'top nav "Collection" after close', page.locator('[data-view-link="collection"]'), { timeout: 2500 });
    out('  console:', ev.console, '| pageerrors:', ev.pageerrors, '| failed:', ev.failed);
    await ctx.close();
  }

  // ---------- Corrupt storage ----------
  {
    const { ctx, page, ev } = await newPage(browser, 1440, 900);
    await page.goto(BASE);
    await page.evaluate(() => localStorage.setItem('playbox.favorites.v1', '{"a":1}'));
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(500);
    const n = await page.locator('#template-grid .template-card').count();
    out('\n=== corrupt localStorage (favorites = {"a":1}) ===');
    out(`  cards rendered: ${n} | result-count: ${JSON.stringify(await page.locator('#result-count').textContent())}`);
    out('  pageerrors:', ev.pageerrors, '| console:', ev.console);
    await page.screenshot({ path: `${OUT}/copilot-1440-corrupt-storage.png` });
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(`${OUT}/pw-run.log`, lines.join('\n') + '\n');
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });
