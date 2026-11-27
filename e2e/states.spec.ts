// What a person sees while a screen loads and when it cannot: a skeleton once the answer is slow, and an error that says what
// failed with Opnieuw proberen, which gets the screen back when the server does. On Start a failing request costs only its own
// block. The unit tests drive each view with a fake page; this is the shell, the router and the real network layer together.
//
// These specs make the server "fail" on purpose (a 500 for one address, or a slow answer), which is exactly what the guard in
// ./fixtures.ts reports, so they use Playwright's plain test and keep two checks by hand: no uncaught error in the page, and no
// request to another site. Names, labels and visible text only.
import { expect, test, type Page, type Route } from '@playwright/test';
import { NAV_NAME } from './fixtures.ts';
import { signInAsAdmin } from './session.ts';

/** The screens that fetch their list as a whole: if that one request fails there is nothing to show but the error. */
const SCREENS: ReadonlyArray<{ name: string; hash: string; title: RegExp; path: string }> = [
  { name: 'Agenda', hash: '#/', title: /^Agenda/, path: '/api/reservations' },
  { name: 'Ritten', hash: '#/usage', title: /^Ritten/, path: '/api/usage' },
  { name: 'Brandstof en kosten', hash: '#/fuel', title: /^Brandstof en kosten/, path: '/api/fuel' },
  { name: 'Verkeersboetes', hash: '#/tickets', title: /^Verkeersboetes/, path: '/api/tickets' },
  { name: 'Statistieken', hash: '#/stats', title: /^Statistieken/, path: '/api/stats' },
  { name: 'Historie', hash: '#/history', title: /^Historie/, path: '/api/history' },
  { name: 'Auto', hash: '#/car', title: /^Auto/, path: '/api/damage' },
  { name: 'Inbox', hash: '#/inbox', title: /^Inbox/, path: '/api/inbox' },
];

const serverFails = (route: Route) =>
  route.request().method() === 'GET'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'internal' } }) })
    : route.fallback();

/** A matcher that Playwright can find again for unroute: the same function, not an equal one. */
const pathIs = (path: string) => (url: URL): boolean => url.pathname === path;

const goTo = (page: Page, hash: string) => page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);

/** Collect what must stay empty whatever the server does: uncaught errors, and requests to any other site. */
function watchPage(page: Page, baseURL: string | undefined): { errors: string[]; elsewhere: string[] } {
  const seen = { errors: [] as string[], elsewhere: [] as string[] };
  page.on('pageerror', (e) => seen.errors.push(e.message));
  page.on('request', (r) => {
    if (!r.url().startsWith(baseURL ?? '') && !r.url().startsWith('data:')) seen.elsewhere.push(r.url());
  });
  return seen;
}

test('a screen whose list cannot be fetched says what went wrong, keeps the bar usable, and Opnieuw proberen brings it back', async ({ page, baseURL }) => {
  const seen = watchPage(page, baseURL);
  await signInAsAdmin(page);
  await page.waitForLoadState('networkidle');

  for (const screen of SCREENS) {
    await test.step(screen.name, async () => {
      const matcher = pathIs(screen.path);
      await page.route(matcher, serverFails);
      await goTo(page, screen.hash);
      await expect(page).toHaveTitle(screen.title);
      const alert = page.getByRole('alert').filter({ hasText: 'Er ging iets mis op de server.' });
      await expect(alert, `${screen.name}: the error says what happened`).toBeVisible();
      await expect(alert.getByRole('button', { name: 'Opnieuw proberen' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: NAV_NAME }), `${screen.name}: the person can still leave the screen`).toBeVisible();

      await page.unroute(matcher, serverFails);
      await alert.getByRole('button', { name: 'Opnieuw proberen' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Er ging iets mis op de server.' }), `${screen.name}: the error is gone`).toHaveCount(0);
      await expect(page.getByRole('main').getByRole('heading').first(), `${screen.name}: the screen is drawn`).toBeVisible();
      await page.waitForLoadState('networkidle');
    });
  }
  expect(seen.errors, 'uncaught errors in the page').toEqual([]);
  expect(seen.elsewhere, 'requests to any other site').toEqual([]);
});

test('on Start one failing request only costs its own block, and that block can try again by itself', async ({ page, baseURL }) => {
  const seen = watchPage(page, baseURL);
  await signInAsAdmin(page);
  await page.waitForLoadState('networkidle');
  await goTo(page, '#/more');
  await expect(page).toHaveTitle(/^Meer/);

  const apk = pathIs('/api/car/apk');
  await page.route(apk, serverFails);
  await goTo(page, '#/home');
  await expect(page).toHaveTitle(/^Start/);
  const failed = page.getByRole('alert').filter({ hasText: 'APK (keuring) kon niet worden geladen.' });
  await expect(failed, 'the APK block says it failed').toBeVisible();
  await expect(page.getByRole('heading', { name: 'De auto nu' }), 'the rest of Start is there').toBeVisible();
  await expect(page.getByRole('heading', { name: 'Jouw volgende reservering' })).toBeVisible();
  await expect(page.getByRole('alert'), 'only the one block failed').toHaveCount(1);

  await page.unroute(apk, serverFails);
  await failed.getByRole('button', { name: 'Opnieuw proberen' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'APK (keuring)' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(seen.errors, 'uncaught errors in the page').toEqual([]);
  expect(seen.elsewhere, 'requests to any other site').toEqual([]);
});

test('a slow screen shows a loading skeleton that a screen reader announces, then the screen', async ({ page, baseURL }) => {
  const seen = watchPage(page, baseURL);
  await signInAsAdmin(page);
  await page.waitForLoadState('networkidle');

  // The answer takes a second and a half: long enough that the skeleton (shown after 120 ms) has to appear.
  const slow = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return route.fallback();
  };
  const tickets = pathIs('/api/tickets');
  await page.route(tickets, slow);
  await goTo(page, '#/tickets');
  const loading = page.getByRole('status').filter({ hasText: 'Laden…' });
  await expect(loading, 'while it loads there is a status that says so').toBeAttached();
  await expect(page.getByRole('heading', { name: 'Verkeersboetes', exact: true }), 'then the screen').toBeVisible({ timeout: 10_000 });
  await expect(loading, 'the skeleton leaves').toHaveCount(0);
  await page.unroute(tickets, slow);
  await page.waitForLoadState('networkidle');
  expect(seen.errors, 'uncaught errors in the page').toEqual([]);
  expect(seen.elsewhere, 'requests to any other site').toEqual([]);
});
