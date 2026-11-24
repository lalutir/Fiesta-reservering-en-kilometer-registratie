// The wider layouts, at 768 and 1280 px: from 768 px the bar of places is a rail that lists everything that is under
// Meer on a phone, Start has a heading per block, and the admin page is a dashboard. Only the guard of ./fixtures.ts and
// reading the page are used (nothing is created: the other specs share this database). Role-, label- and text-based
// locators only, like the rest of the suite.
import { NAV_NAME, expect, expectNoHorizontalScroll, test } from './fixtures.ts';

for (const width of [768, 1280]) {
  test(`at ${width} px the app has a rail with every place, Start shows its blocks, and the admin page fits`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const username = process.env['E2E_ADMIN_USERNAME'] ?? '';
    const password = process.env['E2E_ADMIN_PASSWORD'] ?? '';
    expect(username !== '' && password !== '', 'the config exports the admin sign-in').toBe(true);

    await page.goto('/');
    await page.getByLabel('Gebruikersnaam').fill(username);
    await page.getByLabel('Wachtwoord', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Inloggen' }).click();
    const nav = page.getByRole('navigation', { name: NAV_NAME });
    await expect(nav).toBeVisible();

    await test.step('the rail lists the places that a phone keeps under Meer, and Meer itself is not needed', async () => {
      for (const place of ['Start', 'Agenda', 'Ritten', 'Inbox', 'Historie', 'Auto', 'Account', 'Admin']) {
        await expect(nav.getByRole('link', { name: new RegExp(`^${place}`) }), place).toBeVisible();
      }
      await expect(nav.getByRole('link', { name: /^Meer/ })).toBeHidden();
      await expect(nav.getByRole('link', { name: 'Boeken', exact: true })).toBeVisible();
    });

    await test.step('Start has its blocks and nothing scrolls sideways', async () => {
      await expect(page.getByRole('heading', { name: 'Start', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'De auto nu' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Snel erbij' })).toBeVisible();
      await expectNoHorizontalScroll(page, `Start at ${width}`);
    });

    await test.step('a place under Meer opens from the rail in one tap and is the one that is lit', async () => {
      await nav.getByRole('link', { name: /^Auto/ }).click();
      await expect(page.getByRole('heading', { name: 'Auto', exact: true })).toBeVisible();
      await expect(nav.getByRole('link', { name: /^Auto/ })).toHaveAttribute('aria-current', 'page');
      await expectNoHorizontalScroll(page, `Auto at ${width}`);
    });

    await test.step('the admin page is a dashboard of four sections and fits', async () => {
      // Leave no request in flight when the page is replaced: an aborted request is a failed request.
      await page.waitForLoadState('networkidle');
      await page.goto('/admin/');
      await expect(page.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
      for (const section of ['Gebruikers', 'Reserveringen', 'Ritten', 'Bewaartermijn']) {
        await expect(page.getByRole('button', { name: section, exact: true })).toBeVisible();
      }
      await expectNoHorizontalScroll(page, `admin at ${width}`);
      await page.waitForLoadState('networkidle');
    });
  });
}
