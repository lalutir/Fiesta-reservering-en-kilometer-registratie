// What the design promises about touch and text, measured in a real browser at both phone widths: every link, button and
// field on every key screen is at least 44 by 44 CSS px (the exceptions are the ones docs/DESIGN.md lists, "Targets under
// 44 px"), no text is cut off by its own box, nothing sticks out sideways, and a long word wraps instead of widening the page.
// The unit tests can pin the CSS rules; only a browser can say what they add up to.
//
// Nothing here finds elements by markup: the screens are opened by their address and their title, the forms by their labels.
// The measuring script walks every element and reads boxes, which is what it is for; it has no CSS selectors (the suite bans
// them, see test/ci.test.ts) and tells visually hidden text from visible text by its size, not by a class. The two exceptions
// that DESIGN.md names and that no size can express are written out in EXEMPT_CLASSES: if a class is renamed the cells or the
// table wrapper are measured like everything else and this fails loudly, which is the moment to update DESIGN.md and this list.
// A failing check is a rule to fix in public/style.css, never a reason to loosen this list.
import { expect, expectNoHorizontalScroll, test } from './fixtures.ts';
import { openScreen, signInAsAdmin } from './session.ts';
import type { Page } from '@playwright/test';

/** The screens of the member app a person uses with a thumb. The hash is the address, the title is what the tab says. */
const SCREENS: ReadonlyArray<{ name: string; hash: string; title: RegExp }> = [
  { name: 'Start', hash: '#/home', title: /^Start/ },
  { name: 'Agenda, list', hash: '#/', title: /^Agenda/ },
  { name: 'Agenda, month', hash: '#/?view=month', title: /^Agenda/ },
  { name: 'Boeken', hash: '#/reserve', title: /^Boeken/ },
  { name: 'Ritten (the drive form and the kilometre check)', hash: '#/usage', title: /^Ritten/ },
  { name: 'Brandstof en kosten', hash: '#/fuel', title: /^Brandstof en kosten/ },
  { name: 'Verkeersboetes', hash: '#/tickets', title: /^Verkeersboetes/ },
  { name: 'Statistieken', hash: '#/stats', title: /^Statistieken/ },
  { name: 'Inbox', hash: '#/inbox', title: /^Inbox/ },
  { name: 'Historie', hash: '#/history', title: /^Historie/ },
  { name: 'Auto', hash: '#/car', title: /^Auto/ },
  { name: 'Account', hash: '#/account', title: /^Account/ },
  { name: 'Meer', hash: '#/more', title: /^Meer/ },
];

interface Measured {
  coarse: boolean;
  small: string[];
  clipped: string[];
  sticksOut: string[];
}

/**
 * Runs in the page. A string, not a function: this project's TypeScript setup for tests has no DOM types.
 *  - EXEMPT_CLASSES: 'cal-cell' is a day of the month grid (38 by 52 px, the whole cell is the target), 'table-wrap' is the box
 *    in which an admin table scrolls sideways on purpose.
 *  - A checkbox is measured by its label (the label is the target). A link inside running text is inline. Anything that is only
 *    a pixel or two wide is visually hidden text, and anything entirely above or left of the window (the skip link, until it
 *    has focus) is not on screen.
 */
const MEASURE = `(() => {
  const EXEMPT_CLASSES = ['cal-cell', 'table-wrap'];
  const root = document.documentElement;
  const out = { coarse: window.matchMedia('(pointer: coarse)').matches, small: [], clipped: [], sticksOut: [] };
  const words = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.tagName).trim().split(' ').filter(Boolean).join(' ').slice(0, 40);
  const hidden = (el) => { const r = el.getBoundingClientRect(); return r.width <= 2 || r.height <= 2; };
  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.right > 0;
  };
  const within = (el, name) => { for (let p = el; p; p = p.parentElement) if (p.classList.contains(name)) return true; return false; };
  const exempt = (el) => EXEMPT_CLASSES.some((name) => within(el, name));
  const isTarget = (el) => {
    const tag = el.tagName;
    if (tag === 'INPUT') return el.getAttribute('type') !== 'hidden';
    return tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY' || (tag === 'A' && el.hasAttribute('href')) || el.getAttribute('role') === 'button';
  };
  for (const el of document.body.getElementsByTagName('*')) {
    if (!onScreen(el) || hidden(el)) continue;
    if (isTarget(el) && !exempt(el) && !(el.tagName === 'A' && getComputedStyle(el).display === 'inline')) {
      const label = (el.tagName === 'INPUT' && el.labels && el.labels[0] && (el.type === 'checkbox' || el.type === 'radio')) ? el.labels[0] : el;
      const r = label.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) out.small.push(el.tagName.toLowerCase() + ' "' + words(el) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    const cs = getComputedStyle(el);
    const cuts = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.textOverflow === 'ellipsis';
    if (cuts && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) out.clipped.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 30) + ' "' + words(el) + '"');
    const r = el.getBoundingClientRect();
    if (r.right > root.clientWidth + 1 && !within(el, 'table-wrap')) out.sticksOut.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 30) + ' "' + words(el) + '"');
  }
  out.small = out.small.slice(0, 30);
  out.clipped = out.clipped.slice(0, 20);
  out.sticksOut = out.sticksOut.slice(0, 20);
  return out;
})()`;

async function measure(page: Page): Promise<Measured> {
  return (await page.evaluate(MEASURE)) as Measured;
}

function expectFits(m: Measured, where: string): void {
  expect.soft(m.small, `${where}: links, buttons or fields under 44 by 44 CSS px`).toEqual([]);
  expect.soft(m.clipped, `${where}: text cut off by its own box`).toEqual([]);
  expect.soft(m.sticksOut, `${where}: something reaches past the right edge of the window`).toEqual([]);
}

test('the sign-in page: 44 px targets, nothing cut off', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Inloggen' })).toBeVisible();
  const m = await measure(page);
  expect(m.coarse, 'the browser reports a touch screen, so the compact buttons are at their touch size').toBe(true);
  expectFits(m, 'sign-in');
  await expectNoHorizontalScroll(page, 'sign-in');
});

test('every key screen of the member app keeps 44 px targets, cuts no text and sticks out nowhere', async ({ page }) => {
  await signInAsAdmin(page);
  for (const screen of SCREENS) {
    await test.step(screen.name, async () => {
      await openScreen(page, screen.hash, screen.title);
      expectFits(await measure(page), screen.name);
      await expectNoHorizontalScroll(page, screen.name);
    });
  }
});

test('the admin page keeps 44 px targets on a phone, in each of its four sections', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/admin/');
  await expect(page.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
  for (const section of ['Gebruikers', 'Reserveringen', 'Ritten', 'Bewaartermijn']) {
    await test.step(section, async () => {
      await page.getByRole('button', { name: section, exact: true }).click();
      await page.waitForLoadState('networkidle');
      expectFits(await measure(page), `admin ${section}`);
      await expectNoHorizontalScroll(page, `admin ${section}`);
    });
  }
});

test('a long word in a ticket wraps inside its card instead of widening the page, and the ticket can be removed again', async ({ page }) => {
  // One unbroken word of 120 characters: longer than any phone is wide, so only wrapping can keep it on screen.
  const word = 'Snelheidsovertredingbuitenbebouwdekom'.repeat(3) + 'X'.repeat(9);
  await signInAsAdmin(page);
  await openScreen(page, '#/tickets', /^Verkeersboetes/);
  await page.getByLabel('Reden (optioneel)').fill(word);
  await page.getByRole('button', { name: 'Verkeersboete opslaan' }).click();
  await expect(page.getByText('Verkeersboete opgeslagen.')).toBeVisible();
  await expect(page.getByText(word)).toBeVisible();
  await page.waitForLoadState('networkidle');
  expectFits(await measure(page), 'a ticket with a long word');
  await expectNoHorizontalScroll(page, 'a ticket with a long word');

  // Leave the database as it was found: the other specs share it.
  await page.getByRole('article').filter({ hasText: word }).getByRole('button', { name: /^Verwijder/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Verwijderen', exact: true }).click();
  await expect(page.getByText('Verkeersboete verwijderd.')).toBeVisible();
  await expect(page.getByText(word)).toHaveCount(0);
});
