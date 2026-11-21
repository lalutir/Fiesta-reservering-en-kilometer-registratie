// Browser smoke suite (Playwright). It starts the BUILT server (dist/src/server.js, the same
// layout the Docker image runs) on a throw-away data directory and drives it in Chromium at
// two phone widths. Run it with `npm run e2e` (builds first); see the README, "Continuous
// integration".
//
// The suite is deliberately written against what a person sees (roles, labels and visible
// text), not against markup, so it keeps working when the frontend is rebuilt.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUSEHOLD_TZ = 'Europe/Amsterdam';

// Playwright loads this file in the main process and again in every worker. The first load
// decides the data directory and the admin password and exports them, so the workers (which
// run the tests and have to sign in) see the same values as the server the main process starts.
const createdDataDir = process.env['E2E_DATA_DIR'] === undefined;
const dataDir = process.env['E2E_DATA_DIR'] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'car-e2e-'));
process.env['E2E_DATA_DIR'] = dataDir;
process.env['E2E_ADMIN_USERNAME'] ??= 'e2eadmin';
process.env['E2E_ADMIN_PASSWORD'] ??= randomBytes(18).toString('base64url');
const port = Number(process.env['E2E_PORT'] ?? 4173);
process.env['E2E_BASE_URL'] = `http://127.0.0.1:${port}`;
if (createdDataDir) {
  // Best effort: on Windows the server may still hold the database file for a moment.
  process.on('exit', () => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // a leftover folder in the temp directory is harmless
    }
  });
}

// Optional escape hatch for a machine whose Playwright browser build does not match this
// Playwright version: E2E_CHROMIUM_PATH points at a local Chromium or Chrome. Never set in CI.
const executablePath = process.env['E2E_CHROMIUM_PATH'] || undefined;

const phone = {
  ...devices['Desktop Chrome'],
  // The household time zone, so "a few hours ago" means the same on every runner.
  timezoneId: HOUSEHOLD_TZ,
  locale: 'en-GB',
  isMobile: true,
  hasTouch: true,
  // The service worker is not what is under test here and would add caching to every request.
  serviceWorkers: 'block' as const,
  launchOptions: executablePath ? { executablePath } : {},
};

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // The two projects share one database (one server), so they run one after the other.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env['CI'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(root, 'playwright-report') }]],
  outputDir: path.join(root, 'test-results'),
  use: {
    baseURL: process.env['E2E_BASE_URL'] as string,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mobile-390', use: { ...phone, viewport: { width: 390, height: 844 } } },
    { name: 'mobile-320', use: { ...phone, viewport: { width: 320, height: 568 } } },
  ],
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning dist/src/server.js',
    cwd: root,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    // The server writes one JSON line per request to stdout; only its errors are worth showing.
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      // Plain http on localhost cannot use Secure cookies.
      COOKIE_SECURE: 'false',
      ADMIN_USERNAME: process.env['E2E_ADMIN_USERNAME'],
      ADMIN_PASSWORD: process.env['E2E_ADMIN_PASSWORD'],
      // Cheap password hashing, like scripts/smoke.mjs: the suite is about the app, not scrypt.
      SCRYPT_N: '1024',
      SCRYPT_P: '1',
      // Nothing may reach a push service or Tikkie. Empty counts as "not set" in src/config.ts, and
      // this overrides whatever the developer's own shell has.
      PUSH_ENABLED: 'false',
      PUSH_CONTACT: '',
      DOMAIN: '',
      TRUST_PROXY: '',
      PUBLIC_DIR: '',
      SHARED_DIR: '',
      HOUSEHOLD_TZ,
      BACKUP_KEEP_DAYS: '',
      SCRYPT_R: '',
      TIKKIE_PAYMENT_REQUEST_URL: '',
      TIKKIE_API_KEY: '',
      TIKKIE_ACCESS_TOKEN: '',
    },
  },
});
