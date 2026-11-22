// A test for the test suite's own safety net. app.spec.ts is only as strict as its guard
// (./fixtures.ts): if the guard silently stopped noticing console errors, failed requests or error
// responses, the journey would stay green while the app breaks. So here the guard watches a page
// that is made to misbehave in one way at a time, and each way must end up in the right list.
//
// No server is involved: the page lives on a fake origin whose answers come from page.route().
// These tests use Playwright's plain `test`, not the guarded one from ./fixtures.ts, because they
// are SUPPOSED to produce problems; they assert on what the guard collected instead.
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoProblems, expectTabsFit, isLoggedOutProbe, watch, type Problems } from './fixtures.ts';

const ORIGIN = 'http://guard.test';

interface Answer {
  status: number;
  body?: string;
}
/** What the fake server says to `method pathname`, or 'abort' for a connection that fails. */
type Handler = (method: string, pathname: string) => Answer | 'abort';

/** Open the fake app (a page with a viewport tag, like the real one) with the guard attached from the start. */
async function openFakeApp(page: Page, handler: Handler = () => ({ status: 200 })): Promise<Problems> {
  const problems = watch(page);
  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Guard</title></head><body><p>A page that is exactly as wide as the phone.</p></body></html>',
      });
      return;
    }
    const answer = handler(request.method(), pathname);
    if (answer === 'abort') {
      await route.abort('connectionrefused');
      return;
    }
    await route.fulfill({ status: answer.status, contentType: 'application/json', body: answer.body ?? '{}' });
  });
  await page.goto(`${ORIGIN}/`);
  return problems;
}

/** Call the fake server from inside the page, the way the app does. Resolves to the status, or 'failed'. */
const callApi = (page: Page, path: string, method = 'GET'): Promise<unknown> =>
  page.evaluate(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)} }).then((r) => r.status, () => 'failed')`);

/** Give the browser's late events (console lines arrive after the response) time to reach the guard. */
const settle = (page: Page): Promise<unknown> => page.evaluate('new Promise((resolve) => setTimeout(resolve, 200))');

const emptyLists = { consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [] };

// ------------------------------------------------------------------------ nothing wrong

test('guard: a page that behaves collects nothing, whatever it logs below error level', async ({ page }) => {
  const problems = await openFakeApp(page);
  expect(await callApi(page, '/api/ok')).toBe(200);
  expect(await callApi(page, '/api/created', 'POST')).toBe(200);
  await page.evaluate("console.log('log'); console.info('info'); console.warn('warn'); console.debug('debug')");
  await settle(page);
  expect(problems).toEqual(emptyLists);
});

test('guard: 2xx answers other than 200 are not problems', async ({ page }) => {
  const problems = await openFakeApp(page, (method) => (method === 'POST' ? { status: 201 } : { status: 204, body: '' }));
  expect(await callApi(page, '/api/things', 'POST')).toBe(201);
  expect(await callApi(page, '/api/things')).toBe(204);
  await settle(page);
  expect(problems).toEqual(emptyLists);
});

// ------------------------------------------------------- the one allowed exception

test('guard: the logged-out GET /api/auth/me 401 is allowed once, as a response and as a console line', async ({ page }) => {
  const problems = await openFakeApp(page, () => ({ status: 401 }));
  expect(await callApi(page, '/api/auth/me')).toBe(401);
  await settle(page);
  expect(problems).toEqual(emptyLists);
});

test('guard: the same probe a second time on the same page is a problem', async ({ page }) => {
  const problems = await openFakeApp(page, () => ({ status: 401 }));
  expect(await callApi(page, '/api/auth/me')).toBe(401);
  expect(await callApi(page, '/api/auth/me')).toBe(401);
  await expect.poll(() => problems.badResponses).toEqual([`GET ${ORIGIN}/api/auth/me -> 401`]);
  await expect.poll(() => problems.consoleErrors.length, 'the second console line is not covered by the allowance').toBe(1);
});

test('guard: the allowance is per page: a new page may probe once again', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    for (let i = 0; i < 2; i++) {
      const page = await context.newPage();
      const problems = await openFakeApp(page, () => ({ status: 401 }));
      expect(await callApi(page, '/api/auth/me')).toBe(401);
      await settle(page);
      expect(problems, `page ${i + 1}`).toEqual(emptyLists);
      await page.close();
    }
  } finally {
    await context.close();
  }
});

// Every status of 400 and up that is NOT that exact probe fails the test.
const NOT_THE_PROBE: Array<[string, string, string, number]> = [
  ['a 401 on another path', 'GET', '/api/reservations', 401],
  ['a 401 on /api/auth/me from a POST', 'POST', '/api/auth/me', 401],
  ['a 500 on /api/auth/me', 'GET', '/api/auth/me', 500],
  ['a 403 on /api/auth/me', 'GET', '/api/auth/me', 403],
  ['a 404 for a file', 'GET', '/missing.js', 404],
  ['a 400', 'POST', '/api/reservations', 400],
  ['a 409', 'POST', '/api/reservations', 409],
  ['a 503', 'GET', '/api/health', 503],
];
for (const [what, method, path, status] of NOT_THE_PROBE) {
  test(`guard: ${what} is a bad response`, async ({ page }) => {
    const problems = await openFakeApp(page, () => ({ status }));
    expect(await callApi(page, path, method)).toBe(status);
    await expect.poll(() => problems.badResponses).toEqual([`${method} ${ORIGIN}${path} -> ${status}`]);
  });
}

test('guard: a console line about a 401 from another URL is not covered by the allowance', async ({ page }) => {
  const problems = await openFakeApp(page, () => ({ status: 401 }));
  expect(await callApi(page, '/api/reservations')).toBe(401);
  await expect.poll(() => problems.consoleErrors.length).toBe(1);
  expect(problems.consoleErrors[0]).toContain('/api/reservations');
});

test('isLoggedOutProbe accepts exactly one method, one path and one status', () => {
  expect(isLoggedOutProbe('GET', `${ORIGIN}/api/auth/me`, 401)).toBe(true);
  expect(isLoggedOutProbe('GET', `${ORIGIN}/api/auth/me?x=1`, 401)).toBe(true);
  expect(isLoggedOutProbe('POST', `${ORIGIN}/api/auth/me`, 401)).toBe(false);
  expect(isLoggedOutProbe('GET', `${ORIGIN}/api/auth/me`, 403)).toBe(false);
  expect(isLoggedOutProbe('GET', `${ORIGIN}/api/auth/me`, 500)).toBe(false);
  expect(isLoggedOutProbe('GET', `${ORIGIN}/api/auth/me/`, 401)).toBe(false);
  expect(isLoggedOutProbe('GET', `${ORIGIN}/api/auth/login`, 401)).toBe(false);
  expect(isLoggedOutProbe('GET', `${ORIGIN}/x/api/auth/me`, 401)).toBe(false);
});

// ----------------------------------------------------------------- the other problems

test('guard: console.error is a console error', async ({ page }) => {
  const problems = await openFakeApp(page);
  await page.evaluate("console.error('something broke')");
  await expect.poll(() => problems.consoleErrors).toEqual([expect.stringContaining('something broke')]);
});

test('guard: an uncaught exception is a page error', async ({ page }) => {
  const problems = await openFakeApp(page);
  await page.evaluate("setTimeout(() => { throw new Error('uncaught boom'); }, 0)");
  await expect.poll(() => problems.pageErrors).toEqual([expect.stringContaining('uncaught boom')]);
});

test('guard: an unhandled promise rejection is a page error', async ({ page }) => {
  const problems = await openFakeApp(page);
  await page.evaluate("void Promise.reject(new Error('rejected boom'))");
  await expect.poll(() => problems.pageErrors).toEqual([expect.stringContaining('rejected boom')]);
});

test('guard: a request that never gets an answer is a failed request', async ({ page }) => {
  const problems = await openFakeApp(page, () => 'abort');
  expect(await callApi(page, '/api/slow')).toBe('failed');
  await expect.poll(() => problems.failedRequests).toEqual([expect.stringContaining('GET http://guard.test/api/slow')]);
  expect(problems.badResponses, 'an aborted request has no status').toEqual([]);
});

// ------------------------------------------------- what ends every guarded test

test('guard: expectNoProblems passes on empty lists and fails, naming the list, for each kind of problem', () => {
  expect(() => expectNoProblems({ consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [] })).not.toThrow();
  const one = ['x'];
  expect(() => expectNoProblems({ consoleErrors: [], pageErrors: one, failedRequests: [], badResponses: [] })).toThrow(/uncaught errors in the page/);
  expect(() => expectNoProblems({ consoleErrors: one, pageErrors: [], failedRequests: [], badResponses: [] })).toThrow(/console errors/);
  expect(() => expectNoProblems({ consoleErrors: [], pageErrors: [], failedRequests: one, badResponses: [] })).toThrow(/failed requests/);
  expect(() => expectNoProblems({ consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: one })).toThrow(/responses with status 400 or higher/);
});

// ---------------------------------------------------------------- sideways scrolling

test('guard: a page that fits the phone passes the horizontal-scroll check', async ({ page }) => {
  await openFakeApp(page);
  await expectNoHorizontalScroll(page, 'a narrow page');
});

test('guard: an element wider than the phone fails the horizontal-scroll check, and the message says where', async ({ page }) => {
  await openFakeApp(page);
  await page.evaluate("document.body.append(Object.assign(document.createElement('div'), { style: 'width: 2000px; height: 10px' }))");
  await expect(expectNoHorizontalScroll(page, 'the wide page')).rejects.toThrow(/the wide page: the page is \d+px wide/);
});

// ----------------------------------------------------------------------- the tab bar

/** A "Main" navigation of three tabs in a grid, each tab `tabPx` wide, the middle label drawn at `fontPx`. */
async function openTabBar(page: Page, tabPx: number, fontPx: number): Promise<void> {
  await openFakeApp(page);
  const tab = (name: string, px: number) =>
    `<a href="#/${name}" style="display:flex;justify-content:center;align-items:center;min-width:0;height:40px;color:black"><span style="white-space:nowrap;font:${px}px sans-serif">${name}</span></a>`;
  const html = `<nav aria-label="Main" style="display:grid;grid-template-columns:repeat(3,${tabPx}px);width:${tabPx * 3}px">${tab('Agenda', 12)}${tab('Account', fontPx)}${tab('Car', 12)}</nav>`;
  await page.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(html)})`);
}

test('guard: tabs whose words lie inside their tabs pass the tab-fit check', async ({ page }) => {
  await openTabBar(page, 100, 12);
  await expectTabsFit(page, 'a roomy bar', ['Agenda', 'Account', 'Car']);
});

test('guard: a label wider than its tab fails the tab-fit check, and the message names the tab', async ({ page }) => {
  await openTabBar(page, 100, 40);
  await expect(expectTabsFit(page, 'a cramped bar', ['Agenda', 'Account', 'Car'])).rejects.toThrow(/a cramped bar: the tab "Account" (starts at|ends at) [\d.]+px/);
});

test('guard: a tab narrower than a touch target fails the tab-fit check', async ({ page }) => {
  await openTabBar(page, 20, 8);
  await expect(expectTabsFit(page, 'a thin bar', ['Agenda', 'Account', 'Car'])).rejects.toThrow(/a thin bar: the tab "Agenda" is 20\.0px wide/);
});
