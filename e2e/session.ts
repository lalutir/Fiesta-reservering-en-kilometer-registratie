// Signing in as the admin of the throw-away database, and going to a screen by its address, for the specs that read the
// app (touch targets, the offline shell, the loading and error states). The guard in ./fixtures.ts is not touched.
// Role-, label- and text-based locators only, like the rest of the suite.
import type { Page } from '@playwright/test';
import { NAV_NAME, expect } from './fixtures.ts';

/** The admin's sign-in, exported by playwright.config.ts to every worker. */
export function adminLogin(): { username: string; password: string } {
  const username = process.env['E2E_ADMIN_USERNAME'] ?? '';
  const password = process.env['E2E_ADMIN_PASSWORD'] ?? '';
  expect(username !== '' && password !== '', 'the config exports the admin sign-in').toBe(true);
  return { username, password };
}

/** Open the app, sign in through the real form and wait for the bar of places. */
export async function signInAsAdmin(page: Page): Promise<void> {
  const { username, password } = adminLogin();
  await page.goto('/');
  await page.getByLabel('Gebruikersnaam').fill(username);
  await page.getByLabel('Wachtwoord', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Inloggen' }).click();
  await expect(page.getByRole('navigation', { name: NAV_NAME })).toBeVisible();
}

/**
 * Go to a screen by its address (the hash is the router) and wait until it has been drawn: the page title names the
 * place, the skeleton is gone and no request is left in flight (an aborted request would count as a failed one).
 */
export async function openScreen(page: Page, hash: string, title: RegExp): Promise<void> {
  // A string, not a function: this project's TypeScript setup for tests has no DOM types.
  await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
  await expect(page).toHaveTitle(title);
  await expect(page.getByText('Laden…')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
}
