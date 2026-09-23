// Google Maps "Order online" destinations for a list of place_ids — the
// first-party signal of which delivery platforms list an outlet (Flora menu
// coverage plan, Track C1). Mirrors extractOrderingDestinations() in
// server/services/maps-intel/extractors.ts, run standalone with the repo's
// Playwright so it needs no API server.
//
//   node order_online.mjs <ids.txt> <out.jsonl> [concurrency=3] [delayMs=1500]
//
// The process exits after ORDER_ONLINE_MAX_PER_PROCESS outlets (default 1500)
// with code 3 when work remains; run it in a loop:
//   until node order_online.mjs ids.txt out.jsonl 6 1000; do :; done
//
// ids.txt: one place_id per line. out.jsonl: one line per place, appended;
// ids already present in out.jsonl are skipped, so re-running resumes.
// Lines: {place_id, status, name, order_button, button_href, destinations:[{label, href, host}], final_url, checked_at, error}
// status: ok | no_button | captcha | nav_error
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));
const { chromium } = require('playwright');

const [idsPath, outPath, concArg, delayArg] = process.argv.slice(2);
if (!idsPath || !outPath) { console.error('usage: order_online.mjs <ids.txt> <out.jsonl> [concurrency] [delayMs]'); process.exit(2); }
const CONC = Number(concArg || 3);
const DELAY = Number(delayArg || 1500);
const MAX_PER_PROCESS = Number(process.env.ORDER_ONLINE_MAX_PER_PROCESS || 1500);
const FOOTERS = ['policies.google.com', 'support.google.com', 'google.com/intl'];

// REDO_EMPTY=1: rows that had an Order-online button but captured no
// destinations are treated as not done (the picker tab was missed).
const REDO_EMPTY = process.env.REDO_EMPTY === '1';
const done = new Set();
if (fs.existsSync(outPath)) {
  for (const line of fs.readFileSync(outPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (REDO_EMPTY && r.status === 'ok' && (!r.destinations || r.destinations.length === 0)) continue;
      done.add(r.place_id);
    } catch { /* skip */ }
  }
}
const ids = fs.readFileSync(idsPath, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !done.has(s));
console.error(`to do ${ids.length} (skipping ${done.size} already in ${outPath})`);
const out = fs.createWriteStream(outPath, { flags: 'a' });
const emit = (row) => out.write(JSON.stringify(row) + '\n');

const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
let captchaHits = 0;
let pausedUntil = 0;
const COOLDOWN_MS = Number(process.env.ORDER_ONLINE_COOLDOWN_MS || 600000);
let next = 0;
const stats = { ok: 0, no_button: 0, captcha: 0, nav_error: 0 };

async function newCtx() {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-SA',
    timezoneId: 'Asia/Riyadh',
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  return ctx;
}

async function one(ctx, placeId) {
  const page = await ctx.newPage();
  const row = { place_id: placeId, status: 'nav_error', name: null, order_button: false, button_href: null, destinations: [], final_url: null, checked_at: new Date().toISOString(), error: null };
  try {
    await page.goto(`https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const consent = page.locator('button:has-text("Accept all"), button[aria-label*="Accept"]').first();
    if (await consent.isVisible({ timeout: 2000 }).catch(() => false)) await consent.click().catch(() => null);
    await page.waitForTimeout(3500);
    row.final_url = page.url();
    const body = await page.locator('body').innerText().catch(() => '');
    if (/unusual traffic|verify you'?re not a robot|recaptcha/i.test(body.slice(0, 5000)) || /\/sorry\//.test(row.final_url)) {
      row.status = 'captcha';
      return row;
    }
    row.name = await page.locator('h1').first().innerText({ timeout: 3000 }).catch(() => null);
    const btn = page.locator('a:has-text("Order online"), button:has-text("Order online")').first();
    if (!(await btn.isVisible({ timeout: 2500 }).catch(() => false))) {
      row.status = 'no_button';
      return row;
    }
    row.order_button = true;
    row.button_href = await btn.getAttribute('href').catch(() => null);
    // The button's href IS the picker page (google.com/searchviewer/…). Open
    // it directly instead of clicking and hoping the new tab arrives inside
    // a timeout — the first run marked 3,481 outlets "ok" with no
    // destinations because the tab came late and the Maps page was read.
    let popup = null;
    if (row.button_href && /^https?:\/\//.test(row.button_href)) {
      popup = await ctx.newPage();
      await popup.goto(row.button_href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      row.picker_page = 'href';
    } else {
      const before = new Set(ctx.pages());
      await btn.click().catch(() => null);
      for (let i = 0; i < 24 && !popup; i++) {
        popup = ctx.pages().find((p) => !before.has(p)) || null;
        if (!popup) await page.waitForTimeout(500);
      }
      if (popup) await popup.waitForLoadState('domcontentloaded').catch(() => null);
      row.picker_page = popup ? 'new_tab' : 'in_panel';
    }
    const target = popup || page;
    await target.waitForTimeout(3000);
    row.picker_url = target.url().slice(0, 200);
    // Google rate-limits the picker endpoint separately from Maps: a 429 lands
    // on /sorry/ with an empty body. That is a block, not "no destinations".
    const pickerHtmlLen = (await target.content().catch(() => '')).length;
    if (/\/sorry\//.test(row.picker_url) || /unusual traffic/i.test(row.picker_text) || (popup && pickerHtmlLen < 500)) {
      // Either the explicit 429 → /sorry/ page, or the soft block: HTTP 200
      // with an empty 54-byte document. Both mean "this IP is done for now".
      row.status = 'captcha';
      row.error = pickerHtmlLen < 500 ? 'picker soft-blocked (empty document)' : 'picker rate-limited (429 /sorry/)';
      return row;
    }
    row.picker_text = (await target.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
    const rows = await target.locator('a[href]').evaluateAll((els, footers) => els.map((e) => {
      const href = e.getAttribute('href') || '';
      const text = (e.textContent || '').trim();
      let host = '';
      try { host = new URL(href).host; } catch { /* relative */ }
      return { label: text.slice(0, 80), href: href.slice(0, 300), host };
    }).filter((r) => r.href.startsWith('http') && r.host && !r.host.endsWith('google.com') && !r.host.endsWith('gstatic.com') && !footers.some((f) => r.href.includes(f))), FOOTERS).catch(() => []);
    // Dedupe by host; keep the first label per host.
    const seen = new Set();
    for (const r of rows) {
      const key = r.host.replace(/^www\./, '');
      if (seen.has(key)) continue;
      seen.add(key);
      row.destinations.push({ label: r.label, href: r.href, host: key });
    }
    if (popup) await popup.close().catch(() => null);
    row.status = 'ok';
    return row;
  } catch (e) {
    row.error = String(e && e.message ? e.message : e).slice(0, 200);
    return row;
  } finally {
    // Close EVERY page in the context, not just ours: a picker popup that
    // opened after the waitForEvent timeout is otherwise never closed, and
    // 4,700 leaked pages took the first run down with a heap OOM.
    for (const p of ctx.pages()) await p.close().catch(() => null);
  }
}

async function worker(n) {
  let ctx = await newCtx();
  let used = 0;
  while (next < ids.length) {
    const id = ids[next++];
    const row = await one(ctx, id);
    stats[row.status] = (stats[row.status] || 0) + 1;
    emit(row);
    if (row.status === 'captcha') {
      captchaHits++;
      // One IP, one limit: every worker pauses, not just the one that hit it.
      pausedUntil = Math.max(pausedUntil, Date.now() + COOLDOWN_MS);
      console.error(`[w${n}] captcha on ${id} (hit ${captchaHits}) — all workers cooling ${COOLDOWN_MS / 60000} min`);
      await ctx.close().catch(() => null);
      while (Date.now() < pausedUntil) await new Promise((r) => setTimeout(r, 5000));
      ctx = await newCtx();
      used = 0;
      continue;
    }
    while (Date.now() < pausedUntil) await new Promise((r) => setTimeout(r, 5000));
    if (++used >= 40) { await ctx.close().catch(() => null); ctx = await newCtx(); used = 0; }
    // Bound the process lifetime too: the caller's loop relaunches, and a
    // relaunch resumes from out.jsonl, so exiting every MAX_PER_PROCESS
    // outlets keeps browser and heap growth from ever mattering.
    if (stats.ok + stats.no_button + stats.captcha + stats.nav_error >= MAX_PER_PROCESS) break;
    const total = stats.ok + stats.no_button + stats.captcha + stats.nav_error;
    if (total % 25 === 0) console.error(`${total}/${ids.length} ${JSON.stringify(stats)}`);
    await new Promise((r) => setTimeout(r, DELAY + Math.random() * DELAY));
  }
  await ctx.close().catch(() => null);
}

await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
await browser.close();
out.end();
const remaining = ids.length - next;
console.error(`${remaining > 0 ? 'chunk done' : 'done'} ${JSON.stringify(stats)} remaining ${Math.max(0, remaining)}`);
process.exit(remaining > 0 ? 3 : 0);
