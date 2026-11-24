// The parts of "an installed app" that only a real browser can show: with the service worker ENABLED (the rest of the suite
// blocks it) the shell is precached, the browser reads the manifest without a complaint, and with the network gone the shell
// still opens from the worker and says in its own words that the server cannot be reached, with a way to try again. And the theme
// choice (Systeem, Licht, Donker) on the real page: the colours, the two theme-color metas, a reload that keeps the choice.
// Nothing here finds elements by markup: names, labels and visible text only.
import fs from 'node:fs';
import path from 'node:path';
import { test as unguarded } from '@playwright/test';
import { NAV_NAME, expect, test } from './fixtures.ts';
import { signInAsAdmin } from './session.ts';

const root = path.resolve(import.meta.dirname, '..');
/** The cache the service worker fills at install, read from its source so a bump of the version needs no edit here. */
const CACHE = /const CACHE = '([^']+)'/.exec(fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8'))?.[1] ?? '';

// ------------------------------------------------------------------ the shell, installed

// This describe is NOT guarded on purpose: going offline makes requests fail, which the guard exists to report. What it
// still checks by hand: no uncaught error in the page, and no request to any other site (no CDN, no web font).
unguarded.describe('installed: the service worker is on', () => {
  unguarded.use({ serviceWorkers: 'allow' });

  unguarded('the shell is precached, the manifest is read, and it opens offline with its own message and a way back', async ({ page, context, baseURL }) => {
    expect(CACHE, 'sw.js names its cache').toMatch(/^car-static-v\d+$/);
    const elsewhere: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith(baseURL ?? '') && !r.url().startsWith('data:')) elsewhere.push(r.url());
    });
    page.on('pageerror', (e) => errors.push(e.message));

    await signInAsAdmin(page);
    await page.evaluate('navigator.serviceWorker.ready.then(() => true)');

    await unguarded.step('the shell is in the cache, and no older cache is left behind', async () => {
      const cached = (await page.evaluate(
        `caches.keys().then(async (keys) => ({ keys, count: keys.includes(${JSON.stringify(CACHE)}) ? (await (await caches.open(${JSON.stringify(CACHE)})).keys()).length : 0 }))`,
      )) as { keys: string[]; count: number };
      expect(cached.keys, 'the current cache exists').toContain(CACHE);
      expect(cached.keys.filter((k) => k.startsWith('car-static-') && k !== CACHE), 'only the current cache is left').toEqual([]);
      expect(cached.count, 'the pages, scripts and styles are precached').toBeGreaterThan(25);
    });

    // What this step can and cannot say. The browser reads the manifest itself and reports what it could not parse or had to
    // ignore (broken JSON, a start_url on another site). Chromium's installability verdict (Page.getInstallabilityErrors) is NOT
    // used: in the headless browser it answers "no errors" even for a manifest whose icons were removed or whose display is
    // "browser" (measured), so it would prove nothing. The facts that make an app installable are pinned from the files by
    // test/pwa.test.ts; whether a phone offers "Add to Home Screen" has to be looked at on a phone.
    await unguarded.step('the browser reads the manifest without a complaint', async () => {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Page.enable');
      const manifest = (await cdp.send('Page.getAppManifest')) as { errors?: unknown[]; url?: string; data?: string };
      expect(manifest.url, 'the page links a manifest').toMatch(/manifest\.webmanifest$/);
      expect(manifest.errors ?? [], 'manifest errors').toEqual([]);
      expect(JSON.parse(manifest.data ?? '{}').start_url, 'the manifest was read').toBe('/');
    });

    await unguarded.step('without a network the shell comes from the worker and the app says so itself', async () => {
      await context.setOffline(true);
      const response = await page.reload({ waitUntil: 'load' });
      expect(response?.fromServiceWorker(), 'the page was served by the service worker').toBe(true);
      await expect(page.getByText('Je kunt de server niet bereiken')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Opnieuw proberen' })).toBeVisible();
      // The style sheet came from the cache too: the page has its own background, not the browser's white.
      const background = (await page.evaluate('getComputedStyle(document.body).backgroundColor')) as string;
      expect(background, 'the style sheet applies offline').not.toBe('rgba(0, 0, 0, 0)');
    });

    await unguarded.step('when the network is back, Opnieuw proberen brings the app back', async () => {
      await context.setOffline(false);
      await page.getByRole('button', { name: 'Opnieuw proberen' }).click();
      await expect(page.getByRole('navigation', { name: NAV_NAME })).toBeVisible();
    });

    expect(errors, 'uncaught errors in the page').toEqual([]);
    expect(elsewhere, 'requests to any other site').toEqual([]);
  });
});

// ------------------------------------------------------------------ the theme

/** "#rrggbb" as the browser reports a colour: "rgb(r, g, b)". */
function asRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

test('the theme choice: Donker, Licht and Systeem change the page, the two theme-color metas and what a reload shows', async ({ page }) => {
  const state = async () =>
    (await page.evaluate(
      `({ attr: document.documentElement.getAttribute('data-theme'), metas: [...document.head.getElementsByTagName('meta')].filter((m) => m.getAttribute('name') === 'theme-color').map((m) => m.getAttribute('content')), background: getComputedStyle(document.body).backgroundColor })`,
    )) as { attr: string | null; metas: string[]; background: string };
  const choose = (name: string) => page.getByRole('button', { name, exact: true }).first().click();

  await signInAsAdmin(page);
  await page.evaluate('window.location.hash = "#/more"');
  await expect(page.getByRole('button', { name: 'Donker', exact: true }).first()).toBeVisible();

  await choose('Donker');
  const dark = await state();
  expect(dark.attr).toBe('dark');
  expect(new Set(dark.metas).size, 'both theme-color metas agree').toBe(1);
  expect(dark.background, 'the status bar colour is the colour of the page').toBe(asRgb(dark.metas[0] ?? ''));

  await page.reload();
  await expect(page.getByRole('navigation', { name: NAV_NAME })).toBeVisible();
  expect((await state()).attr, 'a reload keeps the choice').toBe('dark');
  expect((await state()).background).toBe(dark.background);

  await page.evaluate('window.location.hash = "#/more"');
  await choose('Licht');
  const light = await state();
  expect(light.attr).toBe('light');
  expect(light.background, 'the status bar colour is the colour of the page').toBe(asRgb(light.metas[0] ?? ''));
  expect(light.background, 'the two themes are not the same colour').not.toBe(dark.background);

  await choose('Systeem');
  const system = await state();
  expect(system.attr, 'Systeem puts no theme on the page').toBeNull();
  expect(system.metas.length, 'each scheme keeps its own colour').toBe(2);
  expect(new Set(system.metas).size, 'the two metas are different colours again').toBe(2);
  // Without a choice the page follows the phone.
  await page.emulateMedia({ colorScheme: 'dark' });
  expect((await state()).background, 'the phone is dark: so is the page').toBe(dark.background);
  await page.emulateMedia({ colorScheme: 'light' });
  expect((await state()).background, 'the phone is light: so is the page').toBe(light.background);
});
