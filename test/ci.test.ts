// Policy tests for the continuous-integration setup. Nothing here runs the workflow (only GitHub
// can); these read the workflow, Dependabot config, Node pin and package files as text or JSON and
// fail when one of the rules the setup relies on is broken by a later edit: Node version drift, an
// action that is not pinned to a commit, a token that can write, runtime dependencies creeping in,
// a browser test that uses a CSS selector. They assert structure (which commands exist, in which
// order), not YAML formatting, so an ordinary edit of the workflow does not need a change here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A repository file as text with LF line endings (.gitattributes lets Windows check out CRLF). */
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const WORKFLOW = '.github/workflows/ci.yml';
const workflow = read(WORKFLOW);

// ------------------------------------------------------------------ YAML text helpers

/** The lines below a top-level key (column 0) up to the next top-level key, comments and blank lines dropped. */
function topLevel(text: string, key: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `));
  assert.ok(start >= 0, `a top-level "${key}:" key`);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) break;
    out.push(line);
  }
  return out;
}

/** Each job of the workflow: its id and its text (the `jobs:` map has 2-space keys). */
function jobs(text: string): Map<string, string> {
  const body = topLevel(text, 'jobs');
  const out = new Map<string, string>();
  let id: string | null = null;
  for (const line of body) {
    const m = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (m) {
      id = m[1] as string;
      out.set(id, '');
    } else if (id !== null) {
      out.set(id, `${out.get(id)}${line}\n`);
    }
  }
  return out;
}

/** Every command a job runs: single-line `run:` values and the lines of `run: |` blocks. */
function runLines(jobText: string): string[] {
  const lines = jobText.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i] as string);
    if (!m) continue;
    const indent = (m[1] as string).length;
    const value = (m[2] as string).trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      for (const next of lines.slice(i + 1)) {
        if (next.trim() === '') continue;
        if (next.length - next.trimStart().length <= indent) break;
        out.push(next.trim());
      }
    } else if (value !== '') {
      out.push(value);
    }
  }
  return out;
}

/** The text of the step of a job whose name (steps are "      - name: ..." items) starts with `prefix`. */
function step(jobText: string, prefix: string): string | undefined {
  return jobText.split(/^ {6}- name: /m).slice(1).find((chunk) => chunk.startsWith(prefix));
}

/** The job names as GitHub shows them (and branch protection refers to them), with the matrix filled in. */
function jobDisplayNames(text: string): string[] {
  const names: string[] = [];
  for (const body of jobs(text).values()) {
    const name = /^ {4}name:\s*(.+)$/m.exec(body)?.[1]?.trim();
    assert.ok(name, 'every job has an explicit name (a required status check is matched by that name)');
    const os = /^ {8}os:\s*\[(.+)\]\s*$/m.exec(body)?.[1];
    if (name.includes('${{ matrix.os }}')) {
      assert.ok(os, 'a job name that uses matrix.os has a matrix of os values');
      for (const value of os.split(',')) names.push(name.replace('${{ matrix.os }}', value.trim()));
    } else {
      names.push(name);
    }
  }
  return names;
}

// ------------------------------------------------------------------------ Node version

test('.nvmrc is the Node version of the Docker image, and satisfies engines', () => {
  const nvmrc = read('.nvmrc');
  assert.match(nvmrc, /^\d+\.\d+\n$/, '.nvmrc holds one major.minor version and a newline, nothing else');
  const dockerfile = read('Dockerfile');
  const arg = /^ARG NODE_VERSION=(\d+\.\d+)$/m.exec(dockerfile);
  assert.ok(arg, 'the Dockerfile has ARG NODE_VERSION=major.minor');
  assert.equal(nvmrc.trim(), arg[1], '.nvmrc and the Dockerfile ARG NODE_VERSION default must be changed together (docs/DEPLOYMENT.md section 13)');

  const engines = /^>=(\d+)\.(\d+)/.exec((JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node);
  assert.ok(engines, 'package.json engines.node is ">=major.minor"');
  const [major, minor] = nvmrc.trim().split('.').map(Number) as [number, number];
  const [minMajor, minMinor] = [Number(engines[1]), Number(engines[2])];
  assert.ok(major > minMajor || (major === minMajor && minor >= minMinor), `Node ${major}.${minor} satisfies engines >=${minMajor}.${minMinor}`);
});

test('.nvmrc keeps LF line endings on Windows checkouts, because CI passes it to docker build', () => {
  assert.match(read('.gitattributes'), /^\.nvmrc\s+text\s+eol=lf$/m);
});

test('every setup-node step reads .nvmrc, and no Node version is written in the workflow', () => {
  const setups = [...workflow.matchAll(/uses: actions\/setup-node@[^\n]*\n((?: {8,}[^\n]*\n)+)/g)].map((m) => m[1] as string);
  assert.ok(setups.length >= 3, 'each of the three jobs sets up Node');
  for (const setup of setups) assert.match(setup, /^\s+node-version-file: \.nvmrc$/m, 'setup-node reads the version from .nvmrc');
  assert.doesNotMatch(workflow, /^\s+node-version:/m, 'no literal node-version: it would be a second source of truth');
});

// -------------------------------------------------------------------------- workflow

test('the workflow runs on pull requests and on pushes to main, and on nothing else', () => {
  const on = topLevel(workflow, 'on');
  const keys = on.filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().replace(/:.*$/, ''));
  assert.deepEqual(keys.sort(), ['pull_request', 'push']);
  assert.match(on.join('\n'), /^ {2}push:\n {4}branches: \[main\]$/m, 'push is limited to main');
  assert.doesNotMatch(workflow, /pull_request_target/, 'pull_request_target runs fork code with secrets: never');
});

test('the token is read-only, there are no secrets and nothing can write', () => {
  assert.deepEqual(topLevel(workflow, 'permissions').map((l) => l.trim()), ['contents: read']);
  assert.doesNotMatch(workflow, /:\s*write\b/, 'no permission is ever raised to write');
  assert.doesNotMatch(workflow, /secrets\./, 'CI needs no secret');
  assert.doesNotMatch(workflow, /continue-on-error/, 'a failing step fails the job');
  for (const [id, body] of jobs(workflow)) assert.match(body, /^ {4}timeout-minutes: \d+$/m, `job ${id} has a timeout`);
});

test('superseded pull request runs are cancelled, pushes to main are not', () => {
  const concurrency = topLevel(workflow, 'concurrency').map((l) => l.trim());
  assert.ok(concurrency.some((l) => /^group: .*github\.workflow.*(pull_request\.number|github\.ref)/.test(l)), 'a group per workflow and pull request or branch');
  assert.ok(concurrency.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
});

test('every action is pinned to a full commit SHA with a version comment', () => {
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(.+)$/gm)].map((m) => (m[1] as string).trim());
  assert.ok(uses.length >= 8, `found ${uses.length} uses: lines`);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `pinned with a version comment: ${u}`);
  assert.ok(!uses.some((u) => u.startsWith('./') || u.startsWith('docker://')), 'only pinned actions from GitHub');
});

test('no run block uses a ${{ }} expression: values arrive through env, not by string substitution', () => {
  for (const [id, body] of jobs(workflow)) {
    for (const line of runLines(body)) assert.doesNotMatch(line, /\$\{\{/, `job ${id}: ${line}`);
  }
});

test('Check runs on Linux and Windows without OS conditions, and runs the whole gate as separate steps in order', () => {
  const check = jobs(workflow).get('check');
  assert.ok(check, 'a job with the id "check"');
  assert.match(check, /^ {4}runs-on: \$\{\{ matrix\.os \}\}$/m);
  assert.match(check, /^ {6}fail-fast: false$/m, 'a failure on one OS must not hide the other');
  assert.match(check, /^ {8}os: \[ubuntu-latest, windows-latest\]$/m);
  assert.doesNotMatch(check, /^\s+if:/m, 'no OS conditionals and no skipped steps: both legs run everything');
  assert.match(check, /^\s+cache: npm$/m, 'npm cache');

  const commands = runLines(check);
  let from = 0;
  for (const wanted of ['npm ci', 'npm run typecheck', 'npm run lint', 'npm test', 'npm run build', 'npm run smoke', 'npm audit --omit=dev']) {
    const at = commands.indexOf(wanted, from);
    assert.ok(at >= from, `"${wanted}" is a step of Check, after the previous one: ${commands.join(' | ')}`);
    from = at + 1;
  }
});

test('Docker validates compose and the Caddyfile, runs the real app service, checks it, and always cleans up', () => {
  const docker = jobs(workflow).get('docker');
  assert.ok(docker, 'a job with the id "docker"');
  const commands = runLines(docker);
  const all = commands.join('\n');
  assert.ok(commands.includes('docker compose config --quiet'));
  assert.match(all, /caddy validate/, 'the Caddyfile is validated');
  const caddyStep = step(docker, 'Validate the Caddyfile');
  assert.ok(caddyStep && caddyStep.includes('caddy validate') && caddyStep.includes('docker-compose.yml'), 'the Caddyfile is validated with the Caddy image named in docker-compose.yml, not a second copy of the tag');
  assert.match(all, /docker compose build --build-arg "NODE_VERSION=\$\(cat \.nvmrc\)" app/, 'the image is built with the .nvmrc version');
  assert.match(all, /node scripts\/container-check\.mjs/, 'the login and API checks run against the container');
  assert.match(all, /--wait\b/, 'it waits for the health check');
  for (const up of commands.filter((c) => c.startsWith('docker compose up'))) assert.match(up, / app$/, `only the app service is started (Caddy never): ${up}`);
  assert.match(docker, /^ {6}COMPOSE_PROJECT_NAME: \S+$/m, 'its own compose project name');
  const logs = step(docker, 'Show the container logs');
  assert.ok(logs && /^ {8}if: failure\(\)$/m.test(logs), 'logs are printed when something failed');
  const cleanup = step(docker, 'Remove the containers');
  assert.ok(cleanup && /^ {8}if: always\(\)$/m.test(cleanup) && cleanup.includes('docker compose down -v'), 'containers and the throw-away volume are removed whatever happened');
});

test('a docker run in the workflow names its image by digest, except the Caddy image taken from docker-compose.yml', () => {
  const runs = runLines(jobs(workflow).get('docker') as string).filter((c) => c.includes('docker run'));
  assert.ok(runs.length >= 2, 'actionlint and caddy validate');
  for (const run of runs) {
    for (const image of run.match(/\b[a-z0-9][a-z0-9._-]*\/[a-z0-9._/-]+:[\w.-]+(?:@sha256:[0-9a-f]{64})?/g) ?? []) {
      assert.match(image, /@sha256:[0-9a-f]{64}$/, `${image} must be pinned by digest`);
    }
    assert.ok(/@sha256:[0-9a-f]{64}/.test(run) || run.includes('"$image"'), `an image is pinned by digest or comes from docker-compose.yml: ${run}`);
  }
});

test('the workflow set has no deploy or release workflow', () => {
  const files = fs.readdirSync(path.join(root, '.github', 'workflows'));
  assert.ok(files.includes('ci.yml'));
  for (const file of files) {
    assert.doesNotMatch(file, /deploy|release|publish/i, `${file} looks like a deploy workflow`);
    assert.doesNotMatch(read(`.github/workflows/${file}`), /^name:.*(deploy|release|publish)/im, `${file} is named like a deploy workflow`);
  }
  assert.doesNotMatch(workflow, /\b(ssh|scp|rsync|doctl|docker push)\b/, 'CI never talks to a server');
});

// ------------------------------------------------------------------------ dependencies

test('the server has no runtime dependencies, and Playwright is a development dependency only', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies?: unknown; devDependencies?: Record<string, string>; scripts: Record<string, string> };
  assert.equal('dependencies' in pkg, false, 'package.json has no "dependencies" key: the app runs on Node alone');
  assert.ok(pkg.devDependencies?.['@playwright/test'], '@playwright/test is a devDependency');
  assert.ok(pkg.scripts['e2e'], 'npm run e2e exists');
  assert.equal(pkg.scripts['test'], 'node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts"', 'npm test runs the Node tests in test/ only, not the browser specs');

  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { dev?: boolean }> };
  const entries = Object.entries(lock.packages).filter(([name]) => name !== '');
  assert.ok(entries.length > 50, `the lock file lists ${entries.length} packages`);
  const production = entries.filter(([, p]) => p.dev !== true).map(([name]) => name);
  assert.deepEqual(production, [], 'every package in the lock file is a development tool (npm audit --omit=dev has nothing to check)');
});

test('Dependabot watches npm, docker, docker-compose and GitHub Actions, weekly and grouped', () => {
  const text = read('.github/dependabot.yml');
  assert.match(text, /^version: 2$/m);
  const blocks = text.split(/^ {2}- package-ecosystem: /m).slice(1);
  const found = new Map(blocks.map((b) => [b.split('\n')[0]?.trim() as string, b]));
  for (const ecosystem of ['npm', 'docker', 'docker-compose', 'github-actions']) {
    const block = found.get(ecosystem);
    assert.ok(block, `an entry for ${ecosystem}`);
    assert.match(block, /^ {6}interval: weekly$/m, `${ecosystem} is checked weekly`);
    assert.match(block, /^ {4}groups:$/m, `${ecosystem} has a groups block`);
  }
});

// --------------------------------------------------------------------- browser suite

function e2eFiles(dir = 'e2e'): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? e2eFiles(rel) : [rel];
  });
}

test('the browser suite runs at 390 and 320 px, and is not part of npm test', () => {
  const config = read('e2e/playwright.config.ts');
  assert.match(config, /width: 390\b/);
  assert.match(config, /width: 320\b/);
  const files = e2eFiles();
  assert.ok(files.some((f) => f.endsWith('.spec.ts')), 'there is at least one spec');
  assert.deepEqual(files.filter((f) => /\.test\.ts$/.test(f)), [], 'e2e files are *.spec.ts: "test/**/*.test.ts" must not pick them up');
});

test('every spec that imports test from fixtures.ts gets the guard: an automatic fixture that ends with expectNoProblems', () => {
  const fixtures = read('e2e/fixtures.ts');
  assert.match(fixtures, /guard: \[\n\s+async \(\{ page \}, use\) => \{\n\s+const problems = watch\(page\);\n\s+await use\(problems\);\n\s+expectNoProblems\(problems\);\n\s+\},\n\s+\{ auto: true \},\n\s+\],/, 'the guard fixture is automatic, and checks after the test body has run');
  const app = read('e2e/app.spec.ts');
  assert.match(app, /from '\.\/fixtures\.ts'/, 'the journey uses the guarded test');
  assert.doesNotMatch(app, /from '@playwright\/test'/, 'and not Playwright\'s plain test, which has no guard');
  assert.ok(app.includes('expectNoHorizontalScroll(page,'), 'and checks sideways scrolling');
});

test('browser tests find things by role, label or text, never by CSS or XPath', () => {
  for (const file of e2eFiles().filter((f) => f.endsWith('.ts'))) {
    const text = read(file);
    assert.doesNotMatch(text, /\.locator\(/, `${file}: use getByRole, getByLabel or getByText, not locator()`);
    assert.doesNotMatch(text, /\.\$\$?\(/, `${file}: no page.$() or page.$$()`);
    assert.doesNotMatch(text, /\$\$?eval\(|evalOnSelector/, `${file}: no $eval`);
    assert.doesNotMatch(text, /\bxpath=|\bcss=|querySelector/i, `${file}: no xpath=, css= or querySelector`);
  }
});

test('generated Playwright output is kept out of git, the Docker build, lint and the secret scan', () => {
  for (const file of ['.gitignore', '.dockerignore', 'eslint.config.mjs', 'test/deploy.test.ts']) {
    const text = read(file);
    for (const dir of ['playwright-report', 'test-results']) assert.ok(text.includes(dir), `${file} names ${dir}`);
  }
  const dockerignore = read('.dockerignore');
  for (const name of ['.github', 'e2e']) assert.match(dockerignore, new RegExp(`^${name.replace('.', '\\.')}$`, 'm'), `.dockerignore keeps ${name} out of the build context`);
  assert.match(read('tsconfig.json'), /"include": \[[^\]]*"e2e"/, 'the browser suite is type-checked with the rest');
});

// ------------------------------------------------------------------------------ docs

test('the README names every check and gives the command that requires them on main', () => {
  const readme = read('README.md');
  const names = jobDisplayNames(workflow);
  assert.deepEqual(names.sort(), ['Browser', 'Check (ubuntu-latest)', 'Check (windows-latest)', 'Docker']);
  assert.match(readme, /branches\/main\/protection/, 'the README gives the gh api command for branch protection');
  for (const name of names) assert.ok(readme.includes(`"${name}"`), `the required-checks JSON in the README contains "${name}"`);
  assert.match(readme, /npm run e2e/);
  assert.match(readme, /npx playwright install chromium/);
});

// ============================================================================================
// Acceptance criteria that the tests above leave open: the Browser job, the files the workflow's
// shell commands depend on, the wording of the docs, the lock file, and the "no skipped test" rule.
// ============================================================================================

// -------------------------------------------------------------------- Browser job

test('Browser caches Chromium by Playwright version, installs only Chromium, runs the suite, and uploads the evidence on failure', () => {
  const browser = jobs(workflow).get('browser');
  assert.ok(browser, 'a job with the id "browser"');
  assert.match(browser, /^ {4}runs-on: ubuntu-latest$/m, 'the browser suite runs on Linux, the platform of production');
  const commands = runLines(browser);
  assert.ok(commands.includes('npm ci'));
  assert.ok(commands.includes('npm run e2e'), 'the suite is started with the same command as on a developer machine');

  const version = step(browser, 'Read the Playwright version');
  assert.ok(version && version.includes('@playwright/test/package.json') && version.includes('GITHUB_OUTPUT'), 'the cache key input is the installed Playwright version');
  const cache = step(browser, 'Cache the Playwright browsers');
  assert.ok(cache && cache.includes('uses: actions/cache@'), 'the browsers are cached');
  assert.match(cache, /^\s+path: ~\/\.cache\/ms-playwright$/m, 'the cache holds the directory Playwright downloads into on Linux');
  assert.match(cache, /^\s+key: .*\$\{\{ steps\.playwright\.outputs\.version \}\}/m, 'the cache key contains the Playwright version, so a new version downloads a new browser');

  const installs = commands.filter((c) => c.includes('playwright install'));
  assert.equal(installs.length, 1, `one install command: ${installs.join(' | ')}`);
  assert.match(installs[0] as string, /^npx playwright install (--with-deps )?chromium$/, 'only Chromium (no Firefox, no WebKit)');
  const at = (needle: string): number => browser.indexOf(needle);
  assert.ok(at('Cache the Playwright browsers') < at('playwright install') && at('playwright install') < at('npm run e2e'), 'order: restore the cache, install what is missing, run the suite');

  const upload = step(browser, 'Upload the report');
  assert.ok(upload, 'an upload step');
  assert.match(upload, /^ {8}if: failure\(\)$/m, 'the evidence is uploaded when the suite failed');
  assert.match(upload, /uses: actions\/upload-artifact@/);
  assert.match(upload, /^\s+playwright-report\/$/m, 'the HTML report (it embeds the traces) is uploaded');
  assert.match(upload, /^\s+test-results\/$/m, 'traces and screenshots are uploaded');
  assert.match(upload, /^\s+retention-days: \d+$/m, 'the artifact expires');
  assert.ok(at('Upload the report') > at('npm run e2e'), 'the upload comes after the suite');
});

test('the files Browser uploads are where the Playwright configuration writes the report, traces and screenshots', () => {
  const config = read('e2e/playwright.config.ts');
  assert.match(config, /outputFolder: path\.join\(root, 'playwright-report'\)/);
  assert.match(config, /outputDir: path\.join\(root, 'test-results'\)/);
  assert.match(config, /trace: 'retain-on-failure'/, 'a trace of every failed test');
  assert.match(config, /screenshot: 'only-on-failure'/, 'a screenshot of every failed test');
  assert.match(config, /forbidOnly: !!process\.env\['CI'\]/, 'a committed .only cannot silently shrink the suite in CI');
  assert.match(config, /retries: 0/, 'a flaky browser test fails loudly instead of passing on the second try');
  assert.match(config, /testMatch: '\*\.spec\.ts'/);
  // The suite must never reach a push service or Tikkie, whatever the developer's shell sets.
  for (const key of ['PUSH_ENABLED', 'TIKKIE_PAYMENT_REQUEST_URL', 'TIKKIE_API_KEY', 'TIKKIE_ACCESS_TOKEN']) {
    assert.match(config, new RegExp(`${key}: (?:'false'|'')`), `the test server gets ${key} switched off`);
  }
  const script = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['e2e'];
  assert.equal(script, 'npm run build && playwright test --config e2e/playwright.config.ts', 'e2e builds first: it runs the built server, like the Docker image does');
});

// --------------------------------------------------- what the workflow's shell commands rely on

test('every step has a name and no two steps of a job share one', () => {
  for (const [id, body] of jobs(workflow)) {
    const items = body.split('\n').filter((l) => /^ {6}- /.test(l));
    assert.ok(items.length >= 5, `job ${id} lists its steps (${items.length})`);
    for (const item of items) assert.match(item, /^ {6}- name: \S/, `job ${id}: every step starts with a name, found "${item.trim()}"`);
    assert.equal(new Set(items).size, items.length, `job ${id}: step names are unique`);
  }
});

test('Check has the six gate steps, each one command, in their own steps', () => {
  const check = jobs(workflow).get('check') as string;
  const wanted: Array<[string, string]> = [
    ['Install dependencies', 'npm ci'],
    ['Typecheck', 'npm run typecheck'],
    ['Lint', 'npm run lint'],
    ['Test', 'npm test'],
    ['Build', 'npm run build'],
    ['Smoke test', 'npm run smoke'],
  ];
  for (const [name, command] of wanted) {
    const body = step(check, name);
    assert.ok(body, `a step named "${name}..."`);
    assert.deepEqual(runLines(`      - name: ${body}`), [command], `step "${name}" runs exactly "${command}"`);
  }
});

test('Docker lints the workflows with an actionlint image pinned by digest, as its first command', () => {
  const docker = jobs(workflow).get('docker') as string;
  const lint = step(docker, 'Lint workflows');
  assert.ok(lint, 'a step that lints the workflows');
  assert.match(lint, /rhysd\/actionlint:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}/, 'the actionlint image has a version and a digest');
  assert.ok(docker.indexOf('Lint workflows') < docker.indexOf('docker compose'), 'a workflow error is reported before anything is built or started');
});

test('the throw-away .env is built from .env.example, and the lines the workflow rewrites exist there', () => {
  const docker = jobs(workflow).get('docker') as string;
  const make = step(docker, 'Create a throw-away .env');
  assert.ok(make, 'a step that creates .env');
  assert.ok(make.includes('cp .env.example .env'), 'the real example file is the starting point');
  assert.ok(make.includes('openssl rand') && make.includes('::add-mask::'), 'a random password, masked in the log');
  assert.ok(make.includes('COOKIE_SECURE=false'), 'plain http to a container cannot use a Secure cookie');
  // sed does nothing, silently, when its pattern is gone: so the lines it rewrites or reads must exist.
  const example = read('.env.example');
  for (const key of ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'PUSH_ENABLED', 'DOMAIN']) {
    assert.match(example, new RegExp(`^${key}=`, 'm'), `.env.example has a ${key}= line (the workflow rewrites or reads it)`);
    assert.ok(docker.includes(`^${key}=`), `the workflow addresses ${key}= in .env`);
  }
  assert.match(example, /^ADMIN_PASSWORD=$/m, 'the example ships an empty admin password: CI fills it, nobody ships a default');
  // The setting is appended, so it must win over an earlier line: the app reads the LAST one, and there is none uncommented.
  assert.doesNotMatch(example, /^COOKIE_SECURE=/m, 'COOKIE_SECURE is only a comment in the example (default: secure)');
});

test('the Caddy image tag that the workflow reads from docker-compose.yml is found exactly once', () => {
  // The same pattern as the sed command of the "Validate the Caddyfile" step.
  const compose = read('docker-compose.yml');
  const tags = compose.split('\n').flatMap((line) => {
    const m = /^ *image: *(caddy:[^ ]*).*$/.exec(line);
    return m ? [m[1] as string] : [];
  });
  assert.equal(tags.length, 1, `one caddy image line, found ${tags.length}`);
  assert.match(tags[0] as string, /^caddy:\d+\.\d+-alpine$/, 'pinned to a minor');
  const docker = jobs(workflow).get('docker') as string;
  assert.ok(docker.includes("s/^ *image: *\\(caddy:[^ ]*\\).*/\\1/p"), 'the workflow uses that same pattern');
});

test('docker-compose.yml and the Dockerfile give the Docker job what its checks assert', () => {
  const compose = read('docker-compose.yml');
  const app = /^ {2}app:\n((?: {4}.*\n|\n)+)/m.exec(compose)?.[1] ?? '';
  assert.ok(app, 'an "app" service');
  assert.match(app, /^ {4}read_only: true$/m, 'the hardening step expects a read-only root filesystem');
  assert.match(app, /^ {6}- app_data:\/data/m, 'the data volume is mounted at /data (the hardening step touches a file there)');
  assert.match(app, /^ {4}expose:\n {6}- "3000"$/m, 'the app listens on 3000 inside the network (the check script is pointed at port 3000)');
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^USER node$/m, 'the process runs as a non-root user (the hardening step asserts uid != 0)');
  assert.match(dockerfile, /^HEALTHCHECK /m, 'a health check, so "up --wait" waits for a healthy app and not just a started one');
  assert.match(dockerfile, /\/api\/health/, 'and it asks the health endpoint');
});

test('Docker starts only the app service and the check script is handed the credentials it needs by environment', () => {
  const docker = jobs(workflow).get('docker') as string;
  const run = step(docker, 'Health, sign-in and API checks');
  assert.ok(run, 'a step that runs the container check');
  assert.match(run, /ADMIN_USERNAME="\$\(sed -n 's\/\^ADMIN_USERNAME=\/\/p' \.env\)"/);
  assert.match(run, /ADMIN_PASSWORD="\$\(sed -n 's\/\^ADMIN_PASSWORD=\/\/p' \.env\)"/);
  assert.match(run, /node scripts\/container-check\.mjs "http:\/\/\$ip:3000"/);
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'container-check.mjs')), 'the script exists');
  const source = read('scripts/container-check.mjs');
  assert.doesNotMatch(source, /process\.argv\[[3-9]\]/, 'it takes one address (credentials come from the environment, not from the command line, where ps shows them)');
  // After a failed check the script must set the exit code and END, not call process.exit(1): with fetch
  // sockets still closing, Node on Windows aborts ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)")
  // with a crash code instead of 1. Seen once in a full `npm test` run; only the usage error may exit early.
  assert.doesNotMatch(source, /process\.exit\(1\)/, 'a failed check ends with process.exitCode = 1, not process.exit(1)');
  assert.match(source, /process\.exitCode = 1;/);
  assert.deepEqual(source.match(/process\.exit\(\d\)/g), ['process.exit(2)'], 'the only early exit is the usage error, before anything is sent');
  // The usage text may NAME the variable; what must never be printed is its value.
  assert.doesNotMatch(source, /console\.\w+\([^\n]*(\$\{password\}|[(,+]\s*password\s*[,)+])/, 'it never prints the password');
});

// ----------------------------------------------------------------------- docs and comments

/** The text of one numbered section of docs/DEPLOYMENT.md (from its "## N." heading to the next one). */
function guideSection(heading: string): string {
  const guide = read('docs/DEPLOYMENT.md');
  const start = guide.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `a "## ${heading}" section`);
  const next = guide.indexOf('\n## ', start + 1);
  return guide.slice(start, next < 0 ? undefined : next);
}

test('docs/DEPLOYMENT.md section 13 says where the Node version lives and that two files change together', () => {
  const section = guideSection('13. Pinned versions');
  assert.ok(section.includes('.nvmrc'), 'section 13 names .nvmrc');
  assert.ok(section.includes('test/ci.test.ts'), 'and the test that fails when the two files differ');
  assert.ok(section.includes('ARG NODE_VERSION'), 'and the Dockerfile ARG');
  assert.doesNotMatch(section, /This is the only place it is set/i, 'the old "only place" claim is gone: there are two files now');
  // The guide is wrapped at a fixed width, so a sentence may break across lines.
  assert.match(section.replace(/\s+/g, ' '), /change `NODE_VERSION` in the `Dockerfile` and the number in `\.nvmrc`/, 'the upgrade steps change both files');
});

test('the Dockerfile header points at .nvmrc and no longer claims to be the one place', () => {
  const header = read('Dockerfile').split('\n').filter((l) => l.startsWith('#')).join('\n');
  assert.ok(header.includes('.nvmrc'));
  assert.ok(header.includes('test/ci.test.ts'));
  assert.doesNotMatch(header, /the ONE place/i);
});

test('the README gives the local command for every CI check, and the required-checks JSON is valid and complete', () => {
  const readme = read('README.md');
  for (const command of [
    'npm ci',
    'npm run check',
    'npm audit --omit=dev',
    'npm run e2e',
    'npx playwright install chromium',
    'npx playwright show-report',
    'docker compose config --quiet',
    'caddy validate',
    'docker compose build --build-arg "NODE_VERSION=$(cat .nvmrc)" app',
    'docker compose up -d --no-build --wait app',
    'docker compose down -v --remove-orphans',
    'rhysd/actionlint',
    'node /checks/container-check.mjs',
  ]) {
    assert.ok(readme.includes(command), `the README shows: ${command}`);
  }
  // Both variants of the command (bash heredoc, PowerShell here-string) carry the same JSON body: parse it.
  const bodies = [
    ...[...readme.matchAll(/<<'JSON'\n([\s\S]*?)\nJSON\n/g)].map((m) => m[1] as string),
    ...[...readme.matchAll(/@'\n([\s\S]*?)\n'@ \| gh api/g)].map((m) => m[1] as string),
  ];
  assert.equal(bodies.length, 2, 'a bash and a PowerShell variant');
  for (const body of bodies) {
    const rule = JSON.parse(body) as { required_status_checks: { strict: boolean; contexts: string[] }; enforce_admins: boolean; required_pull_request_reviews: unknown; restrictions: unknown };
    assert.deepEqual([...rule.required_status_checks.contexts].sort(), jobDisplayNames(workflow).sort(), 'the required contexts are exactly the job names of the workflow');
    for (const key of ['required_status_checks', 'enforce_admins', 'required_pull_request_reviews', 'restrictions']) {
      assert.ok(key in rule, `the branch-protection API requires "${key}" in the body`);
    }
  }
  assert.match(readme, /gh api -X PUT repos\/lalutir\/Fiesta-reservering-en-kilometer-registratie\/branches\/main\/protection --input -/);
  assert.match(readme, /Settings > Rules > Rulesets/, 'and the steps without the command');
});

// ----------------------------------------------------------------------- dependencies, more

test('Playwright is in the lock file as a development package, at a version package.json allows, and e2e builds first', () => {
  const pkg = JSON.parse(read('package.json')) as { devDependencies: Record<string, string> };
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string; dev?: boolean; devDependencies?: Record<string, string> }> };
  const range = pkg.devDependencies['@playwright/test'];
  assert.match(range ?? '', /^\^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages['']?.devDependencies?.['@playwright/test'], range, 'the lock file root lists the same range as package.json (else `npm ci` refuses to install)');
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name} is locked`);
    assert.equal(entry.dev, true, `${name} is a development package`);
  }
  const [major, minor, patch] = (range as string).slice(1).split('.').map(Number) as [number, number, number];
  const [lockedMajor, lockedMinor, lockedPatch] = (lock.packages['node_modules/@playwright/test']?.version ?? '0.0.0').split('.').map(Number) as [number, number, number];
  assert.equal(lockedMajor, major, 'the locked version is inside the caret range (same major)');
  assert.ok(lockedMinor > minor || (lockedMinor === minor && lockedPatch >= patch), 'and not older than the range start');
  assert.equal(lock.packages['node_modules/playwright']?.version, lock.packages['node_modules/@playwright/test']?.version, 'the browser driver is the same version as the test runner');
});

test('Dependabot: every entry looks at the repository root, and Node is ignored in the Docker entry', () => {
  const blocks = read('.github/dependabot.yml').split(/^ {2}- package-ecosystem: /m).slice(1);
  assert.equal(blocks.length, 4);
  for (const block of blocks) assert.match(block, /^ {4}directory: \/$/m, `${block.split('\n')[0]}: directory /`);
  const docker = blocks.find((b) => b.startsWith('docker\n')) as string;
  assert.match(docker, /^ {4}ignore:\n {6}- dependency-name: node$/m, 'a Node bump alone would make the .nvmrc test fail, so Dependabot must not propose it');
  const npm = blocks.find((b) => b.startsWith('npm\n')) as string;
  assert.match(npm, /^ {8}dependency-type: development$/m, 'npm: development tools only (there are no others)');
});

// -------------------------------------------------------------------- no skipped tests

/** Every .ts file under a directory of the repository (relative paths). */
function tsFiles(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? tsFiles(rel) : rel.endsWith('.ts') ? [rel] : [];
  });
}

test('nothing in the browser suite or the CI tests is skipped, marked todo, focused or expected to fail', () => {
  const MARKER = /\.(skip|only|fixme|fail|slow)\s*\(|\b(skip|todo)\s*:|\.todo\s*\(|\btest\.describe\.(skip|only|fixme)\b/;
  for (const file of [...tsFiles('e2e'), 'test/ci.test.ts', 'test/container-check.test.ts']) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('//')) return;
      assert.doesNotMatch(line, MARKER, `${file}:${i + 1}: ${line.trim()}`);
    });
  }
});

test('a committed .only would shrink the suite silently: no test in test/ or e2e/ uses it', () => {
  for (const file of [...tsFiles('e2e'), ...tsFiles('test')]) {
    read(file).split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('//')) return;
      assert.doesNotMatch(line, /\b(?:test|it|describe|suite)\.only\s*\(|\{\s*only:\s*true/, `${file}:${i + 1}: ${line.trim()}`);
    });
  }
});
