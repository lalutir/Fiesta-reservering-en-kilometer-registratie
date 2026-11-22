// Shared test helpers: the page guard that makes every spec fail on browser errors, the
// horizontal-scroll check, and a date helper for the household time zone.
import { expect, test as base, type ConsoleMessage, type Page, type Request, type Response } from '@playwright/test';
import { utcToLocalInput } from '../shared/time.js';

const HOUSEHOLD_TZ = 'Europe/Amsterdam';

/** A date (YYYY-MM-DD) and a time (HH:MM), the values the form fields take. */
type FormParts = ReturnType<typeof utcToLocalInput>;

/** What the guard collected; every list must be empty when a test ends. */
export interface Problems {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
}

/**
 * The ONE thing that is allowed to go wrong: before anybody is signed in the app asks
 * GET /api/auth/me, the server says 401, and that is how the app learns it must show the sign-in
 * screen (Chromium also logs the 401 as a console error). It may happen once per page; a second
 * one, or any other 4xx or 5xx, fails the test. Do not widen this.
 */
export const isLoggedOutProbe = (method: string, url: string, status: number): boolean =>
  method === 'GET' && status === 401 && new URL(url).pathname === '/api/auth/me';

const describeRequest = (r: Request): string => `${r.method()} ${r.url()} (${r.failure()?.errorText ?? 'failed'})`;

/** Record everything that would be a sign of a broken page. Returns the collected lists. */
export function watch(page: Page): Problems {
  const problems: Problems = { consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [] };
  // The allowance is used up by the first matching response and by the first matching console line.
  let probeResponses = 0;
  let probeConsoleLines = 0;

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    // "Failed to load resource: the server responded with a status of 401" carries the URL in its location.
    const where = msg.location().url;
    if (probeConsoleLines === 0 && /status of 401/.test(msg.text()) && where !== '' && new URL(where).pathname === '/api/auth/me') {
      probeConsoleLines++;
      return;
    }
    problems.consoleErrors.push(`${msg.text()} [${where}]`);
  });
  page.on('pageerror', (err: Error) => problems.pageErrors.push(err.message));
  page.on('requestfailed', (req: Request) => problems.failedRequests.push(describeRequest(req)));
  page.on('response', (res: Response) => {
    const status = res.status();
    if (status < 400) return;
    const req = res.request();
    if (probeResponses === 0 && isLoggedOutProbe(req.method(), res.url(), status)) {
      probeResponses++;
      return;
    }
    problems.badResponses.push(`${req.method()} ${res.url()} -> ${status}`);
  });
  return problems;
}

/** Fail (with every list that has entries) unless the page behaved: this is what ends every guarded test. */
export function expectNoProblems(problems: Problems): void {
  expect(problems.pageErrors, 'uncaught errors in the page').toEqual([]);
  expect(problems.consoleErrors, 'console errors').toEqual([]);
  expect(problems.failedRequests, 'failed requests').toEqual([]);
  expect(problems.badResponses, 'responses with status 400 or higher').toEqual([]);
}

export const test = base.extend<{ guard: Problems }>({
  // An automatic fixture: it runs for every test, before the test body, and checks after it.
  guard: [
    async ({ page }, use) => {
      const problems = watch(page);
      await use(problems);
      expectNoProblems(problems);
    },
    { auto: true },
  ],
});

export { expect };

/** The page must not scroll sideways: nothing is wider than the phone. */
export async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
  // A string, not a function: this project's TypeScript setup for tests has no DOM types.
  const sizes = (await page.evaluate(
    '({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, inner: window.innerWidth, body: document.body.scrollWidth })',
  )) as { scroll: number; client: number; inner: number; body: number };
  const limit = Math.min(sizes.client, sizes.inner);
  expect(sizes.scroll, `${where}: the page is ${sizes.scroll}px wide in a ${limit}px window`).toBeLessThanOrEqual(limit);
  expect(sizes.body, `${where}: the body is ${sizes.body}px wide in a ${limit}px window`).toBeLessThanOrEqual(limit);
}

/**
 * Every tab in the bar can be read: the words of each tab lie inside that tab (nothing is cut off or runs into its
 * neighbour) and no tab is narrower than the minimum size of a touch target (24 px, WCAG 2.2). A failing check is a
 * font size or padding to fix in public/style.css, never a reason to loosen this.
 *
 * It looks at what a person sees: each tab is found by its name as a link of the "Main" navigation, its words by
 * their text inside it, and both are measured on screen. A count floating over a corner is not part of the words.
 */
export async function expectTabsFit(page: Page, where: string, names: readonly string[]): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const name of names) {
    // A tab's name may carry a count ("Drives, 2 ..."), so it is matched from the start.
    const tab = nav.getByRole('link', { name: new RegExp(`^${name}`) });
    await expect(tab, `${where}: the tab "${name}" is in the bar`).toHaveCount(1);
    const words = tab.getByText(name, { exact: true }).first();
    const box = await tab.boundingBox();
    const text = await words.boundingBox();
    expect(box && text, `${where}: the tab "${name}" and its words are on screen`).toBeTruthy();
    if (!box || !text) continue;
    const label = `${where}: the tab "${name}"`;
    const textRight = text.x + text.width;
    expect(box.width, `${label} is ${box.width.toFixed(1)}px wide`).toBeGreaterThanOrEqual(24);
    expect(text.x, `${label} starts at ${text.x.toFixed(1)}px, left of its own tab (${box.x.toFixed(1)}px)`).toBeGreaterThanOrEqual(box.x - 0.5);
    expect(textRight, `${label} ends at ${textRight.toFixed(1)}px, right of its own tab (${(box.x + box.width).toFixed(1)}px)`).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
}

/**
 * A slot that lies entirely in the past, `fromHoursAgo` to `toHoursAgo` hours before now, as the
 * household-time-zone date (YYYY-MM-DD) and time (HH:MM) the form fields take.
 */
export function pastSlot(fromHoursAgo: number, toHoursAgo: number): { start: FormParts; end: FormParts } {
  const minute = 60_000;
  const now = Math.floor(Date.now() / minute) * minute;
  return {
    start: utcToLocalInput(now - fromHoursAgo * 3_600_000, HOUSEHOLD_TZ),
    end: utcToLocalInput(now - toHoursAgo * 3_600_000, HOUSEHOLD_TZ),
  };
}
