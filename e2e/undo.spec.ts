// "Ongedaan maken" in a real browser: deleting your own damage report takes it off the screen at once and offers to take
// it back, and the delete only goes out when the person walks away (or the six seconds are over). A refresh of the screen
// must not send it, and a reload after "Ongedaan maken" must still show the report.
// (test/shell-undo.test.ts runs the same rule against the fake page; this is the browser.)
//
// The report is created and removed again inside the test, so the database both phone projects share ends up as it was
// (app.spec.ts expects an empty damage list). Role-, label- and text-based locators only.
import { expect, test } from './fixtures.ts';
import { openScreen, signInAsAdmin } from './session.ts';

/** What a person reads on screen (see public/strings.js). When the wording changes, change it here only. */
const UI = {
  where: 'Waar op de auto',
  description: 'Beschrijving',
  save: 'Schademelding opslaan',
  saved: 'Schademelding opgeslagen.',
  remove: /^Verwijderen/,
  undo: 'Ongedaan maken',
  restored: 'Teruggezet.',
  none: 'Nog geen schademeldingen. Maak de eerste met het formulier hierboven.',
  agenda: 'Agenda',
} as const;

test('deleting my own damage report can be taken back, and the delete goes out only when the person walks away', async ({ page }, testInfo) => {
  const text = `E2E undo ${testInfo.project.name} ${Date.now()}`;
  const card = () => page.getByRole('article').filter({ hasText: text });
  const deletes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE') deletes.push(new URL(request.url()).pathname);
  });

  await signInAsAdmin(page);
  await openScreen(page, '#/car', /^Auto/);

  await test.step('file a report', async () => {
    await page.getByLabel(UI.where).selectOption({ index: 1 });
    await page.getByLabel(UI.description, { exact: true }).fill(text);
    await page.getByRole('button', { name: UI.save }).click();
    await expect(page.getByText(UI.saved, { exact: true })).toBeVisible();
    await expect(card()).toBeVisible();
  });

  await test.step('delete it: gone at once, nothing sent, and Ongedaan maken is offered', async () => {
    await card().getByRole('button', { name: UI.remove }).click();
    await expect(card()).toHaveCount(0);
    await expect(page.getByRole('button', { name: UI.undo })).toBeVisible();
    // The screen was redrawn without the report (the list is rebuilt after a delete), and that did not send anything.
    expect(deletes, 'a redraw of the same screen must not send the delete').toEqual([]);
  });

  await test.step('Ongedaan maken brings it back, and a reload still shows it', async () => {
    await page.getByRole('button', { name: UI.undo }).click();
    await expect(page.getByText(UI.restored, { exact: true })).toBeVisible();
    await expect(card()).toBeVisible();
    await page.reload();
    await expect(card()).toBeVisible();
    expect(deletes, 'taken back: nothing was ever sent').toEqual([]);
  });

  await test.step('delete it again and walk to another place: the delete goes out, and the report is gone after a reload', async () => {
    await card().getByRole('button', { name: UI.remove }).click();
    await expect(card()).toHaveCount(0);
    expect(deletes).toEqual([]);
    const sent = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.status() === 204);
    await page.getByRole('navigation', { name: 'Hoofdmenu' }).getByRole('link', { name: UI.agenda, exact: true }).click();
    await sent;
    expect(deletes).toHaveLength(1);
    // The delete is on its way, so the offer to take it back is gone from the screen (not a button that does nothing).
    // (A short timeout on purpose: the offer would leave by itself after the six seconds, which must not pass for the check.)
    await expect(page.getByRole('button', { name: UI.undo })).toBeHidden({ timeout: 1000 });
    await openScreen(page, '#/car', /^Auto/);
    await expect(card()).toHaveCount(0);
    await expect(page.getByText(UI.none, { exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
  });
});
