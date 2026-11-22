import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { fmtRange, groupByDay, nextFullHour } from '../public/dom.js';
import { buildTimeline } from '../public/views/history.js';
import { fit } from '../src/notify.ts';
import { fuelCreated as fuelCreatedText } from '../src/notify-texts.ts';
import { createTestApp, rawRequest, type Json } from './helpers.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const sharedDir = path.join(root, 'shared');
const read = (...p: string[]): string => fs.readFileSync(path.join(...p), 'utf8');

/** All files under a directory as posix paths relative to it. */
function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

function pngSize(file: string): { width: number; height: number; colorType: number } {
  const buf = fs.readFileSync(file);
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`);
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] as number };
}

test('manifest has what installability needs: names, standalone display, start url, any and maskable icons', () => {
  const m = JSON.parse(read(publicDir, 'manifest.webmanifest'));
  assert.ok(m.name && m.short_name);
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  const purposes = (m.icons as Json[]).map((i) => `${i.sizes}/${i.purpose}`);
  assert.ok(purposes.includes('192x192/any'));
  assert.ok(purposes.includes('512x512/any'));
  assert.ok(purposes.includes('512x512/maskable'));
  for (const icon of m.icons as Json[]) {
    assert.equal(icon.type, 'image/png');
    const [w, h] = (icon.sizes as string).split('x').map(Number);
    const size = pngSize(path.join(publicDir, icon.src));
    assert.deepEqual([size.width, size.height], [w, h], icon.src);
  }
});

test('icons are RGBA PNGs of the documented sizes, and the iOS icon is opaque-corner full bleed', () => {
  for (const [file, px] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
    const size = pngSize(path.join(publicDir, 'icons', file));
    assert.deepEqual([size.width, size.height, size.colorType], [px, px, 6], file);
  }
});

test('index.html is a complete PWA shell with no inline script, style or handlers (CSP)', () => {
  const html = read(publicDir, 'index.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.match(html, /<meta name="viewport" content="[^"]*width=device-width[^"]*viewport-fit=cover/);
  assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}"/i);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes"/);
  assert.match(html, /<link rel="stylesheet" href="\/style\.css"/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'exactly one script');
  assert.match(scripts[0]?.[1] as string, /type="module"/);
  assert.match(scripts[0]?.[1] as string, /src="\/app\.js"/);
  assert.equal(scripts[0]?.[2], '', 'no inline script body');
  for (const page of ['index.html', 'admin/index.html']) {
    const text = read(publicDir, page);
    assert.doesNotMatch(text, /\sstyle\s*=/i, `${page}: inline style attribute`);
    assert.doesNotMatch(text, /<style\b/i, `${page}: inline style element`);
    assert.doesNotMatch(text, /\son[a-z]+\s*=/i, `${page}: inline event handler`);
  }
});

test('every file a page or module references exists, resolved the way the browser resolves it', () => {
  const exists = (urlPath: string): boolean => {
    if (urlPath.startsWith('/shared/')) return fs.existsSync(path.join(sharedDir, urlPath.slice('/shared/'.length)));
    return fs.existsSync(path.join(publicDir, urlPath));
  };
  const problems: string[] = [];
  for (const page of ['index.html', 'admin/index.html']) {
    for (const m of read(publicDir, page).matchAll(/(?:href|src)="([^"#?]+)"/g)) {
      const ref = m[1] as string;
      if (ref.startsWith('/') && !exists(ref)) problems.push(`${page}: ${ref}`);
      if (!ref.startsWith('/')) problems.push(`${page}: ${ref} should be an absolute path`);
    }
  }
  const modules = walk(publicDir).filter((f) => f.endsWith('.js'));
  assert.ok(modules.length >= 10);
  for (const file of modules) {
    const code = read(publicDir, file);
    for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
      const spec = (m[1] ?? m[2]) as string;
      const resolved = new URL(spec, `http://host/${file}`).pathname;
      if (!exists(resolved)) problems.push(`${file}: import '${spec}' -> ${resolved}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('client code never builds markup from strings or sets inline styles', () => {
  const banned = [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/, /setAttribute\(\s*['"]style['"]/, /\.style\.cssText/];
  const problems: string[] = [];
  for (const file of walk(publicDir).filter((f) => f.endsWith('.js'))) {
    const code = read(publicDir, file);
    for (const re of banned) if (re.test(code)) problems.push(`${file}: ${re}`);
    if (/\bstyle:\s*['"`{]/.test(code)) problems.push(`${file}: style prop passed to h()`);
  }
  assert.deepEqual(problems, []);
});

// Layout cannot be measured without a browser, so this guards the rules that keep a phone-width
// page from scrolling sideways: border-box sizing, no viewport-width units, nothing fixed wider
// than a small phone except the data table, which scrolls inside its own box.
test('phone width: no fixed width wider than a phone outside the scrolling table box, and pinch zoom stays on', () => {
  const css = read(publicDir, 'style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] as string).trim().replace(/\s+/g, ' '), body: m[2] as string }));
  assert.ok(rules.length > 50, `parsed ${rules.length} rules`);
  const rule = (selector: string) => rules.filter((r) => r.selector.split(/\s*,\s*/).includes(selector));

  assert.ok(rules.some((r) => r.selector.split(/\s*,\s*/).includes('*') && /box-sizing:\s*border-box/.test(r.body)), 'padding and borders never add to a width');
  assert.ok(rule('body').some((r) => /overflow-x:\s*(hidden|clip)/.test(r.body)), 'the page never scrolls sideways');
  assert.ok(rule('.table-wrap').some((r) => /overflow-x:\s*auto/.test(r.body)), 'a wide table scrolls inside its own box');
  assert.doesNotMatch(css, /\d\s*(vw|vmax)\b/, 'viewport-width units ignore the scrollbar and overflow the page');

  const wide: string[] = [];
  for (const r of rules) {
    for (const m of r.body.matchAll(/(?:^|[\s;])(min-width|width)\s*:\s*(\d+(?:\.\d+)?)px/g)) {
      if (Number(m[2]) > 320) wide.push(`${r.selector} { ${m[1]}: ${m[2]}px }`);
    }
  }
  assert.deepEqual(wide, ['table.data { min-width: 640px }'], 'the only fixed width above 320px is the table that sits in .table-wrap');

  for (const page of ['index.html', 'admin/index.html']) {
    const viewport = /<meta name="viewport" content="([^"]*)"/.exec(read(publicDir, page))?.[1] ?? '';
    assert.match(viewport, /width=device-width/, page);
    assert.doesNotMatch(viewport, /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/, `${page} must allow pinch zoom`);
  }
});

test('the service worker precache list equals the files in public/ (plus the shared time module)', () => {
  const sw = read(publicDir, 'sw.js');
  const block = /const PRECACHE = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '';
  const listed = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
  assert.ok(listed.length > 10);
  assert.equal(new Set(listed).size, listed.length, 'no duplicates');
  const onDisk = walk(publicDir)
    .filter((f) => f !== 'sw.js' && !f.startsWith('admin/'))
    .map((f) => (f === 'index.html' ? '/' : `/${f}`));
  assert.deepEqual([...listed].sort(), [...onDisk, '/shared/time.js'].sort());
  assert.ok(fs.existsSync(path.join(sharedDir, 'time.js')));
});

/** Load sw.js into a sandbox with fake browser APIs and return its handlers. */
function loadServiceWorker(fetchImpl: (req: Json) => Promise<Json>, windows: Json[] = []) {
  const handlers: Record<string, (event: Json) => void> = {};
  const shown: Array<{ title: string; options: Json }> = [];
  const opened: string[] = [];
  const store = new Map<string, Json>();
  const deleted: string[] = [];
  const cache = {
    addAll: async (urls: string[]) => urls.forEach((u) => store.set(new URL(u, 'https://car.example').href, `precached ${u}`)),
    put: async (req: Json, res: Json) => void store.set(req.url, res),
    match: async (req: Json) => store.get(req.url),
  };
  const sandbox = {
    self: {
      addEventListener: (type: string, fn: (e: Json) => void) => (handlers[type] = fn),
      location: { origin: 'https://car.example' },
      skipWaiting: async () => {},
      registration: { showNotification: async (title: string, options: Json) => void shown.push({ title, options }) },
      clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (url: string) => void opened.push(url) },
    },
    caches: { open: async () => cache, keys: async () => ['old-cache', 'car-static-v4', 'car-static-v5'], delete: async (k: string) => deleted.push(k) },
    fetch: fetchImpl,
    URL,
  };
  vm.runInNewContext(fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8'), sandbox);
  const fire = (request: Json) => {
    const out: { response?: Promise<Json>; waits: Array<Promise<unknown>> } = { waits: [] };
    (handlers['fetch'] as (e: Json) => void)({
      request,
      respondWith: (p: Promise<Json>) => (out.response = p),
      waitUntil: (p: Promise<unknown>) => out.waits.push(p),
    });
    return out;
  };
  return { handlers, store, deleted, fire, shown, opened };
}

test('service worker: the cache name is bumped with the app files, so phones drop the old copy of the shell', () => {
  // A new view file changes what the shell is: without a new name an installed app keeps serving the old one.
  const source = read(publicDir, 'sw.js');
  assert.match(source, /const CACHE = 'car-static-v5';/);
  assert.match(source, /'\/views\/tickets\.js',/, 'the tickets view is precached');
  assert.match(source, /'\/kmcheck\.js',/, 'the kilometre check module is precached');
});

test('service worker: precaches on install, drops old caches on activate', async () => {
  const sw = loadServiceWorker(async () => ({ ok: true }));
  let installed: Promise<unknown> | undefined;
  (sw.handlers['install'] as (e: Json) => void)({ waitUntil: (p: Promise<unknown>) => (installed = p) });
  await installed;
  assert.ok(sw.store.has('https://car.example/app.js'));
  assert.ok(sw.store.has('https://car.example/shared/time.js'));
  assert.ok(sw.store.has('https://car.example/views/tickets.js'));
  assert.ok(sw.store.has('https://car.example/kmcheck.js'));
  let activated: Promise<unknown> | undefined;
  (sw.handlers['activate'] as (e: Json) => void)({ waitUntil: (p: Promise<unknown>) => (activated = p) });
  await activated;
  assert.deepEqual(sw.deleted, ['old-cache', 'car-static-v4'], 'the previous version of the shell goes, the current one stays');
});

test('service worker never handles /api, /admin, non-GET or cross-origin requests', async () => {
  const sw = loadServiceWorker(async () => ({ ok: true, clone() { return this; } }));
  const untouched = [
    ['GET', 'https://car.example/api/reservations'],
    ['GET', 'https://car.example/api'],
    ['GET', 'https://car.example/admin'],
    ['GET', 'https://car.example/admin/'],
    ['GET', 'https://car.example/admin/admin.js'],
    ['POST', 'https://car.example/app.js'],
    ['GET', 'https://other.example/app.js'],
  ];
  for (const [method, url] of untouched) {
    assert.equal(sw.fire({ method, url }).response, undefined, `${method} ${url}`);
  }
  const handled = [
    sw.fire({ method: 'GET', url: 'https://car.example/app.js' }),
    sw.fire({ method: 'GET', url: 'https://car.example/' }),
  ];
  for (const h of handled) {
    assert.ok(h.response, 'static files and the start page are handled');
    await h.response;
    await Promise.all(h.waits);
  }
});

test('service worker is network first, refreshes its cache, and falls back to it offline', async () => {
  let online = true;
  const network = { ok: true, body: 'fresh', clone() { return this; } };
  const sw = loadServiceWorker(async () => {
    if (!online) throw new TypeError('offline');
    return network;
  });
  const request = { method: 'GET', url: 'https://car.example/app.js?v=1' };
  const first = sw.fire(request);
  assert.equal(await first.response, network);
  await Promise.all(first.waits);
  assert.equal(sw.store.get(request.url), network, 'successful responses are cached');

  online = false;
  assert.equal(await sw.fire(request).response, network, 'offline: served from cache');
  await assert.rejects(sw.fire({ method: 'GET', url: 'https://car.example/never-cached.js' }).response as Promise<Json>, TypeError);

  online = true;
  const failing = { ok: false, status: 500, clone() { return this; } };
  const sw2 = loadServiceWorker(async () => failing);
  const res = sw2.fire(request);
  assert.equal(await res.response, failing);
  assert.equal(sw2.store.has(request.url), false, 'error responses are not cached');
});

/** Objects made inside the vm sandbox have another Object.prototype: compare them as plain JSON. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** Fire the push handler with a payload (a string, or a function that throws) and wait for what it started. */
async function firePush(sw: ReturnType<typeof loadServiceWorker>, data: string | null | (() => never)) {
  const waits: Array<Promise<unknown>> = [];
  const event = {
    data: data === null ? null : { json: () => (typeof data === 'function' ? data() : JSON.parse(data)) },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  };
  (sw.handlers['push'] as (e: Json) => void)(event);
  await Promise.all(waits);
  return waits.length;
}

test('service worker push: shows the reminder it was sent, and always shows something', async () => {
  const sw = loadServiceWorker(async () => ({ ok: true }));
  const waited = await firePush(sw, JSON.stringify({ title: 'Register your kilometres', body: 'Your reservation ended at 17:00.', url: '/#/usage?res=7', tag: 'km-7' }));
  assert.equal(waited, 1, 'the notification is tied to the event with waitUntil');
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0]?.title, 'Register your kilometres');
  assert.equal(sw.shown[0]?.options.body, 'Your reservation ended at 17:00.');
  assert.equal(sw.shown[0]?.options.tag, 'km-7', 'the same reservation replaces its earlier notification');
  assert.equal(sw.shown[0]?.options.renotify, true, 'the replacement alerts again: an ignored start reminder must not swallow the end reminder');
  assert.deepEqual(plain(sw.shown[0]?.options.data), { url: '/#/usage?res=7' });
  assert.equal(sw.shown[0]?.options.icon, '/icons/icon-192.png');

  // Unreadable, missing, empty or wrongly typed data still ends in a generic notification (iOS withdraws silent pushes).
  const generic = { title: 'Shared car', body: 'Open the app to see what is waiting.', tag: 'car', data: { url: '/' } };
  const cases: Array<string | null | (() => never)> = [
    'not json{',
    () => {
      throw new SyntaxError('bad payload');
    },
    null,
    '{}',
    JSON.stringify({ title: 42, body: ['x'], url: {}, tag: null }),
    JSON.stringify({ title: '   ', body: '' }),
  ];
  for (const data of cases) {
    sw.shown.length = 0;
    await firePush(sw, data);
    assert.equal(sw.shown.length, 1, String(data));
    const { title, options } = sw.shown[0] as { title: string; options: Json };
    assert.equal(title, generic.title);
    assert.equal(options.body, generic.body);
    assert.equal(options.tag, generic.tag);
    assert.equal(options.renotify, true, 'renotify needs a tag, and the generic notification has one');
    assert.deepEqual(plain(options.data), generic.data);
  }

  sw.shown.length = 0;
  await firePush(sw, JSON.stringify({ title: 'T'.repeat(500), body: 'B'.repeat(5000) }));
  assert.equal((sw.shown[0]?.title as string).length, 100);
  assert.equal((sw.shown[0]?.options.body as string).length, 300);
});

/** Fire notificationclick with the data the push handler stored. */
async function fireClick(sw: ReturnType<typeof loadServiceWorker>, data: Json | undefined) {
  const closed: boolean[] = [];
  const waits: Array<Promise<unknown>> = [];
  (sw.handlers['notificationclick'] as (e: Json) => void)({
    notification: { close: () => closed.push(true), data },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  return closed.length;
}

test('service worker notificationclick: closes it and opens the registration form in this app only', async () => {
  const win = (url: string, extra: Json = {}) => {
    const calls: string[] = [];
    return {
      url,
      calls,
      navigate: async (to: string) => {
        calls.push(`navigate ${to}`);
        return { focus: async () => void calls.push('focus navigated') };
      },
      focus: async () => void calls.push('focus'),
      ...extra,
    } as Json;
  };

  // An open window of the app is reused: navigated to the form, then focused.
  const open = win('https://car.example/#/');
  const sw = loadServiceWorker(async () => ({ ok: true }), [win('https://elsewhere.example/'), open]);
  assert.equal(await fireClick(sw, { url: '/#/usage?res=7' }), 1, 'the notification is closed');
  assert.deepEqual(open.calls, ['navigate https://car.example/#/usage?res=7', 'focus navigated']);
  assert.deepEqual(sw.opened, []);

  // Another origin in the payload is never followed: the start page opens instead.
  for (const bad of ['https://evil.example/#/usage', '//evil.example/x', 'javascript:alert(1)', undefined, 42, {}]) {
    const w = win('https://car.example/');
    const s = loadServiceWorker(async () => ({ ok: true }), [w]);
    await fireClick(s, bad === undefined ? undefined : { url: bad });
    assert.deepEqual(w.calls[0], 'navigate https://car.example/', String(bad));
  }

  // No open window of the app (or only a foreign one): a new window opens at the form.
  const none = loadServiceWorker(async () => ({ ok: true }), [win('https://elsewhere.example/')]);
  await fireClick(none, { url: '/#/usage?res=9' });
  assert.deepEqual(none.opened, ['https://car.example/#/usage?res=9']);
  const empty = loadServiceWorker(async () => ({ ok: true }));
  await fireClick(empty, { url: '/#/usage?res=9' });
  assert.deepEqual(empty.opened, ['https://car.example/#/usage?res=9']);

  // A browser without navigate() just focuses the window; one whose navigate() fails gets a new window.
  const noNavigate = win('https://car.example/', { navigate: undefined });
  const a = loadServiceWorker(async () => ({ ok: true }), [noNavigate]);
  await fireClick(a, { url: '/#/usage?res=3' });
  assert.deepEqual(noNavigate.calls, ['focus']);
  assert.deepEqual(a.opened, []);
  const failing = win('https://car.example/', {
    navigate: async () => {
      throw new TypeError('not allowed');
    },
  });
  const b = loadServiceWorker(async () => ({ ok: true }), [failing]);
  await fireClick(b, { url: '/#/usage?res=3' });
  assert.deepEqual(b.opened, ['https://car.example/#/usage?res=3']);
});

test('the server serves the app shell, the service worker and the exact shared time module', async () => {
  const t = await createTestApp(); // default config: the real public/ and shared/ directories
  try {
    const shared = await rawRequest(t.port, 'GET', '/shared/time.js');
    assert.equal(shared.status, 200);
    assert.equal(shared.text, fs.readFileSync(path.join(sharedDir, 'time.js'), 'utf8'));
    const home = await rawRequest(t.port, 'GET', '/');
    assert.equal(home.text, read(publicDir, 'index.html'));
    const sw = await rawRequest(t.port, 'GET', '/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers['content-type'] as string, /^text\/javascript/);
    assert.equal(sw.headers['cache-control'], 'no-cache', 'the browser must always re-check the service worker');
    for (const file of walk(publicDir).filter((f) => !f.startsWith('admin/') && f !== 'sw.js' && f !== 'index.html')) {
      assert.equal((await rawRequest(t.port, 'GET', `/${file}`)).status, 200, file);
    }
  } finally {
    await t.close();
  }
});

// -- pure client logic that runs in Node (no DOM needed) -----------------------------

const TZ = 'Europe/Amsterdam';

test('fmtRange shows one day compactly and several days in full, in the household zone', () => {
  assert.match(fmtRange('2026-06-20T07:00:00.000Z', '2026-06-20T11:30:00.000Z', TZ), /Saturday.*20 June, 09:00 – 13:30/);
  assert.match(fmtRange('2026-06-20T07:00:00.000Z', '2026-06-22T11:30:00.000Z', TZ), /20 Jun 2026.*09:00 – 22 Jun 2026.*13:30/);
  // 22:30 UTC is already the next day in Amsterdam.
  assert.match(fmtRange('2026-06-20T22:30:00.000Z', '2026-06-20T23:30:00.000Z', TZ), /Sunday.*21 June, 00:30 – 01:30/);
});

test('groupByDay groups consecutive items by local calendar day', () => {
  const items = [
    { id: 1, start: '2026-06-20T07:00:00.000Z' },
    { id: 2, start: '2026-06-20T20:00:00.000Z' },
    { id: 3, start: '2026-06-20T22:30:00.000Z' }, // 00:30 local on the 21st
    { id: 4, start: '2026-06-22T08:00:00.000Z' },
  ];
  const groups = groupByDay(items, (i) => i.start, TZ);
  assert.deepEqual(groups.map((g) => [g.key, g.items.map((i) => i.id)]), [
    ['2026-06-20', [1, 2]],
    ['2026-06-21', [3]],
    ['2026-06-22', [4]],
  ]);
  assert.match(groups[0]?.label as string, /Saturday/);
  assert.deepEqual(groupByDay([], (i: { start: string }) => i.start, TZ), []);
});

test('nextFullHour always moves forward to a whole hour', () => {
  assert.equal(nextFullHour(new Date('2026-06-15T10:00:00.000Z')).toISOString(), '2026-06-15T11:00:00.000Z');
  assert.equal(nextFullHour(new Date('2026-06-15T10:00:00.001Z')).toISOString(), '2026-06-15T11:00:00.000Z');
  assert.equal(nextFullHour(new Date('2026-06-15T10:59:59.999Z')).toISOString(), '2026-06-15T11:00:00.000Z');
});

// A tiny fake DOM, just enough to prove h() builds text nodes only and maps props correctly.
class FakeNode {}
class FakeText extends FakeNode {
  data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
}
class FakeElement extends FakeNode {
  tag: string;
  className = '';
  textContent = '';
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  listeners: Record<string, unknown[]> = {};
  hidden = false;
  disabled = false;
  valueSetWithChildren = -1;
  private current = '';
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  get value(): string {
    return this.current;
  }
  set value(v: string) {
    this.valueSetWithChildren = this.children.length;
    this.current = v;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  addEventListener(type: string, fn: unknown): void {
    (this.listeners[type] ??= []).push(fn);
  }
  appendChild(child: FakeNode): void {
    this.children.push(child);
  }
  replaceChildren(): void {
    this.children = [];
  }
}

test('h() only ever creates text nodes, flattens children and maps props', async () => {
  const g = globalThis as Json;
  g.Node = FakeNode;
  g.document = { createElement: (tag: string) => new FakeElement(tag), createTextNode: (data: string) => new FakeText(data) };
  try {
    const { h, setContent } = await import('../public/dom.js');
    const click = () => {};
    const el = h(
      'div',
      { class: 'card big', 'data-id': 7, hidden: true, disabled: false, title: null, onclick: click, text: undefined },
      'plain ',
      ['<b>not markup</b>', null, false, [42]],
      h('span', { text: '<img src=x onerror=alert(1)>' }),
    ) as unknown as FakeElement;
    assert.equal(el.className, 'card big');
    assert.equal(el.attrs['data-id'], '7');
    assert.equal(el.hidden, true);
    assert.equal(el.disabled, false);
    assert.equal(el.attrs['title'], undefined, 'null props are skipped');
    assert.deepEqual(el.listeners['click'], [click]);
    const kinds = el.children.map((c) => (c instanceof FakeText ? `text:${c.data}` : `el:${(c as FakeElement).tag}`));
    assert.deepEqual(kinds, ['text:plain ', 'text:<b>not markup</b>', 'text:42', 'el:span']);
    assert.equal(((el.children[3] as FakeElement).textContent), '<img src=x onerror=alert(1)>', 'text goes in as textContent');

    // value is applied after the <option> children exist, so a <select> can pick one.
    const select = h('select', { value: 'b' }, [h('option', { value: 'a' }), h('option', { value: 'b' })]) as unknown as FakeElement;
    assert.equal(select.value, 'b');
    assert.equal(select.valueSetWithChildren, 2);

    setContent(el as never, 'only this');
    assert.equal(el.children.length, 1);
  } finally {
    delete g.Node;
    delete g.document;
  }
});

test('history timeline: drives with their reservation, plus reservations nobody drove', () => {
  const drive = (id: number, start: string, end: string, reservationId: number | null) =>
    ({ id, userId: 1, userName: 'Anna', start, end, reservationId, reservation: null, sameDriver: null }) as Json;
  const res = (id: number, start: string, end: string) => ({ id, userId: 2, userName: 'Ben', start, end, status: 'confirmed' }) as Json;
  const now = '2026-06-15T10:00:00.000Z';
  const usage = [
    drive(10, '2026-06-10T08:00:00.000Z', '2026-06-10T10:00:00.000Z', 1), // linked
    drive(11, '2026-06-05T08:00:00.000Z', '2026-06-05T10:00:00.000Z', null), // unlinked, but inside reservation 2
  ];
  const reservations = [
    res(1, '2026-06-10T07:00:00.000Z', '2026-06-10T12:00:00.000Z'), // used (linked)
    res(2, '2026-06-05T07:00:00.000Z', '2026-06-05T12:00:00.000Z'), // used (overlapping drive)
    res(3, '2026-06-01T07:00:00.000Z', '2026-06-01T12:00:00.000Z'), // nobody drove
    res(4, '2026-06-20T07:00:00.000Z', '2026-06-20T12:00:00.000Z'), // still in the future
  ];
  const timeline = buildTimeline(usage, reservations, now);
  assert.deepEqual(
    timeline.map((e) => [e.kind, e.kind === 'drive' ? e.usage.id : e.reservation.id]),
    [['drive', 10], ['drive', 11], ['unused', 3]],
    'newest first',
  );
});

test('service worker: the notification for a new fill-up is shown whole whatever the names and amounts, and a tap opens the History screen', async () => {
  // The message as the notifier sends it: the words (notify-texts.ts), where a tap opens and the tag (the event table), cut to what the worker shows.
  const fuelMessage = (id: number, fueler: string, shareCents: number, carriedCents: number, dueCents: number) =>
    fit({ ...fuelCreatedText({ fueler, shareCents, carriedCents, dueCents }), url: '/#/history', tag: `fuel-${id}` });
  const worst = [
    fuelMessage(1_234_567, 'N'.repeat(300), 99_999_999, 99_999_999, 199_999_998),
    fuelMessage(1_234_567, 'N'.repeat(300), 99_999_999, -99_999_999, 1),
    fuelMessage(7, 'Anna', 1500, 0, 1500),
  ];
  for (const message of worst) {
    // The worker cuts titles at 100, bodies at 300, tags at 64 and addresses at 300 characters, and the push at 1000 bytes: none of it may bite.
    assert.ok(message.title.length <= 100 && message.body.length <= 300 && message.tag.length <= 64 && message.url.length <= 300, JSON.stringify(message));
    assert.ok(Buffer.byteLength(JSON.stringify(message)) < 1000, 'small enough for the push service');
    const sw = loadServiceWorker(async () => ({ ok: true }));
    await firePush(sw, JSON.stringify(message));
    assert.equal(sw.shown.length, 1);
    const shown = sw.shown[0] as { title: string; options: Json };
    assert.deepEqual([shown.title, shown.options.body, shown.options.tag], [message.title, message.body, message.tag], 'shown as sent, nothing cut off');
    assert.deepEqual(plain(shown.options.data), { url: '/#/history' });
  }
  assert.ok(worst[0]?.title.includes('…'), 'a long name is shortened on purpose, not cut off by the worker');

  // A tap goes to the History screen of this app, and History is a route the app has.
  const calls: string[] = [];
  const open = {
    url: 'https://car.example/#/usage',
    navigate: async (to: string) => {
      calls.push(`navigate ${to}`);
      return { focus: async () => void calls.push('focus') };
    },
  } as Json;
  const sw = loadServiceWorker(async () => ({ ok: true }), [open]);
  await firePush(sw, JSON.stringify(worst[2]));
  await fireClick(sw, (sw.shown[0] as { options: Json }).options.data);
  assert.deepEqual(calls, ['navigate https://car.example/#/history', 'focus']);
  assert.match(read(publicDir, 'app.js'), /const VIEWS = \{[^}]*\bhistory\b[^}]*\}/, 'the hash the notification opens belongs to a view');
});
