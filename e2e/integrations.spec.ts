// The Account page cards for the two read-only integrations, in a real browser at both phone widths: an access token is
// made, shown once, works on the token API, and is gone from the page and from the server when revoked; a calendar link
// is made, serves a calendar, is replaced (the old address dies) and turned off.
//
// Both tests clean up after themselves, because the two phone projects share one database. The token API and the feed
// are called through Playwright's own request context (not the page), so what the page does stays under the guard in
// ./fixtures.ts: no console errors, no failed requests, no 4xx or 5xx response, no sideways scroll.
// Role-, label- and text-based locators only.
import { expect, expectNoHorizontalScroll, test } from './fixtures.ts';
import { openScreen, signInAsAdmin } from './session.ts';

/** What a person reads on screen (see public/strings.js). When the wording changes, change it here only. */
const UI = {
  tokens: 'Toegangstokens',
  makeToken: 'Token maken',
  makeTokenTitle: 'Nieuw toegangstoken',
  nameLabel: 'Naam van het token',
  shownTitle: 'Je nieuwe token',
  tokenLabel: 'Token',
  copyToken: 'Token kopiëren',
  done: 'Klaar',
  noTokens: 'Je hebt nog geen toegangstokens.',
  calendar: 'Agenda-abonnement',
  makeLink: 'Agendalink maken',
  linkLabel: 'Jouw agendalink',
  copyLink: 'Link kopiëren',
  renew: 'Nieuwe link maken',
  turnOff: 'Link uitzetten',
  noLink: 'Je hebt nog geen agendalink.',
} as const;

test('an access token is made in a sheet, shown once, works on the read-only API, and stops working when it is revoked', async ({ page, request }, testInfo) => {
  const name = `E2E token ${testInfo.project.name} ${Date.now()}`;
  const bearer = (token: string): { Authorization: string } => ({ Authorization: `Bearer ${token}` });
  await signInAsAdmin(page);
  await openScreen(page, '#/account', /^Account/);
  await expect(page.getByRole('heading', { name: UI.tokens, exact: true })).toBeVisible();
  await expect(page.getByText(UI.noTokens, { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page, 'account with the token card');

  let token = '';
  await test.step('make a token: the form is a sheet, and the token is shown once in the next one', async () => {
    await page.getByRole('button', { name: UI.makeToken }).click();
    const form = page.getByRole('dialog', { name: UI.makeTokenTitle });
    await expect(form).toBeVisible();
    await form.getByLabel(UI.nameLabel).fill(name);
    await expectNoHorizontalScroll(page, 'the make-a-token sheet');
    await form.getByRole('button', { name: UI.makeToken }).click();

    const shown = page.getByRole('dialog', { name: UI.shownTitle });
    await expect(shown).toBeVisible();
    const box = shown.getByLabel(UI.tokenLabel, { exact: true });
    await expect(box).toHaveValue(/^pat_[A-Za-z0-9_-]{43}$/);
    token = await box.inputValue();
    await expectNoHorizontalScroll(page, 'the sheet that shows the token');
    // Copying either works or says that it did not (a headless browser may refuse the clipboard): both are an answer.
    await shown.getByRole('button', { name: UI.copyToken }).click();
    await expect(shown.getByText(/^(Token gekopieerd\.|Kopiëren lukte niet)/)).toBeVisible();
    await shown.getByRole('button', { name: UI.done }).click();
    await expect(shown).toBeHidden();
  });

  await test.step('the token is gone from the page, and the list names it', async () => {
    expect(await page.content(), 'the token is nowhere in the page after the sheet closed').not.toContain(token);
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByText(/^Nog niet gebruikt$/)).toBeVisible();
    await expectNoHorizontalScroll(page, 'account with a token in the list');
  });

  await test.step('it reads the API as its owner, and nothing can be written with it', async () => {
    const me = await request.get('/api/v1/me', { headers: bearer(token) });
    expect(me.status()).toBe(200);
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe(process.env['E2E_ADMIN_USERNAME']);
    expect((await request.get('/api/v1/status', { headers: bearer(token) })).status()).toBe(200);
    expect((await request.post('/api/v1/me', { headers: bearer(token), data: {} })).status()).toBe(404);
    expect((await request.get('/api/auth/me', { headers: bearer(token) })).status(), 'a token does not open the app\'s own API').toBe(401);
  });

  await test.step('revoking asks first, and then the token is refused', async () => {
    await page.getByRole('button', { name: `Intrekken: token ${name}` }).click();
    const sure = page.getByRole('dialog');
    await expect(sure).toBeVisible();
    await sure.getByRole('button', { name: 'Intrekken' }).click();
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    await expect(page.getByText(UI.noTokens, { exact: true })).toBeVisible();
    expect((await request.get('/api/v1/me', { headers: bearer(token) })).status()).toBe(401);
    await expectNoHorizontalScroll(page, 'account after revoking');
  });
});

test('a calendar link is made, serves a calendar, is replaced (the old address dies at once) and is turned off', async ({ page, request }) => {
  await signInAsAdmin(page);
  await openScreen(page, '#/account', /^Account/);
  await expect(page.getByRole('heading', { name: UI.calendar, exact: true })).toBeVisible();
  await expect(page.getByText(UI.noLink, { exact: true })).toBeVisible();

  /** The address in the field, as the page offers it: https only. The test calls the same path on the local server. */
  const addressOnPage = async (): Promise<{ address: string; path: string }> => {
    const box = page.getByLabel(UI.linkLabel);
    await expect(box).toHaveValue(/^https:\/\/[^/]+\/api\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
    const address = await box.inputValue();
    expect(address).not.toMatch(/webcal|^http:/);
    return { address, path: new URL(address).pathname };
  };

  await page.getByRole('button', { name: UI.makeLink }).click();
  const first = await addressOnPage();
  await expectNoHorizontalScroll(page, 'account with a calendar link');
  await page.getByRole('button', { name: UI.copyLink }).click();
  await expect(page.getByText(/^(Link gekopieerd\.|Kopiëren lukte niet)/)).toBeVisible();

  await test.step('the address serves a calendar, and a second request with its ETag gets 304', async () => {
    const res = await request.get(first.path);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(await res.text()).toMatch(/^BEGIN:VCALENDAR\r\n/);
    const etag = res.headers()['etag'] ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await request.get(first.path, { headers: { 'If-None-Match': etag } })).status()).toBe(304);
  });

  await test.step('a new link replaces it after a question, and the old address answers 404', async () => {
    await page.getByRole('button', { name: UI.renew }).click();
    const sure = page.getByRole('dialog');
    await expect(sure).toBeVisible();
    await sure.getByRole('button', { name: UI.renew }).click();
    await expect(sure).toBeHidden();
    await expect.poll(async () => (await addressOnPage()).path).not.toBe(first.path);
    const second = await addressOnPage();
    expect((await request.get(first.path)).status()).toBe(404);
    expect((await request.get(second.path)).status()).toBe(200);
    await expectNoHorizontalScroll(page, 'account with a replaced link');
  });

  await test.step('turning it off asks first and takes the address away', async () => {
    const current = (await addressOnPage()).path;
    await page.getByRole('button', { name: UI.turnOff }).click();
    const sure = page.getByRole('dialog');
    await expect(sure).toBeVisible();
    await sure.getByRole('button', { name: UI.turnOff }).click();
    await expect(page.getByText(UI.noLink, { exact: true })).toBeVisible();
    expect((await request.get(current)).status()).toBe(404);
  });
});
