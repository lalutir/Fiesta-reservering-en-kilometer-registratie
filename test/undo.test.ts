// "Ongedaan maken" (public/undo.js): a delete that waits six seconds, can be taken back, and is sent no later than
// the end of the window, the page going to the background, the next write or leaving the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { del, get, post } from '../public/api.js';
import { h, toaster as domToaster } from '../public/dom.js';
import { S } from '../public/strings.js';
import { UNDO_MS, deferDelete, enterPlace, flushPending, installUndoFlush, isPending, pendingIds, resetUndo } from '../public/undo.js';
import { NOW, Reply, withClient, type Call, type FakeElement } from './fake-dom.ts';

type Toast = { message: string; isError: boolean; action?: { label: string; run: () => void } };
function toaster() {
  const toasts: Toast[] = [];
  return { toasts, toast: (message: string, isError = false, action?: Toast['action']) => void toasts.push({ message, isError, ...(action ? { action } : {}) }) };
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

type Over = Partial<Parameters<typeof deferDelete>[0]> & { sink: ReturnType<typeof toaster>; log: string[]; id?: number };
function defer(over: Over) {
  const id = over.id ?? 12;
  deferDelete({
    key: `damage:${id}`,
    message: S.undo.damage,
    commit: (o) => {
      over.log.push(o.keepalive ? 'delete keepalive' : 'delete');
      return del(`/api/damage/${id}`, o);
    },
    onUndo: () => over.log.push('back'),
    onError: () => over.log.push('error'),
    toast: over.sink.toast,
    ...over,
  });
}
const lines = (calls: Call[]) => calls.map((c) => `${c.method} ${c.path}`);

test('the item goes at once, the toast offers Ongedaan maken, and the DELETE is sent after six seconds', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply(null, 204) } }, async ({ api, tick }) => {
    resetUndo();
    const sink = toaster();
    const log: string[] = [];
    defer({ sink, log });
    assert.equal(isPending('damage:12'), true);
    assert.deepEqual([...pendingIds('damage')], [12]);
    assert.equal(sink.toasts[0]?.message, S.undo.damage);
    assert.equal(sink.toasts[0]?.action?.label, 'Ongedaan maken');
    assert.equal(api.calls.length, 0, 'nothing is sent yet');
    tick(UNDO_MS - 1);
    await settle();
    assert.equal(api.calls.length, 0);
    tick(1);
    await settle();
    assert.deepEqual(lines(api.calls), ['DELETE /api/damage/12']);
    assert.equal(isPending('damage:12'), false);
    assert.deepEqual(log, ['delete']);
  }));

test('Ongedaan maken brings the item back and nothing is ever sent', () =>
  withClient({ now: NOW, routes: {} }, async ({ api, tick }) => {
    resetUndo();
    const sink = toaster();
    const log: string[] = [];
    defer({ sink, log });
    sink.toasts[0]?.action?.run();
    assert.deepEqual(log, ['back']);
    assert.equal(isPending('damage:12'), false);
    assert.equal(sink.toasts[1]?.message, S.undo.restored);
    tick(UNDO_MS * 2);
    await settle();
    assert.equal(api.calls.length, 0);
  }));

test('a request that fails brings the item back and says so', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply({ error: { code: 'forbidden', message: 'x' } }, 403) } }, async ({ tick }) => {
    resetUndo();
    const sink = toaster();
    const log: string[] = [];
    defer({ sink, log });
    tick(UNDO_MS);
    await settle();
    assert.deepEqual(log, ['delete', 'error']);
    assert.equal(isPending('damage:12'), false);
  }));

test('the page going to the background (visibilitychange) or closing (pagehide) sends it now, with keepalive so the browser finishes it', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply(null, 204), 'DELETE /api/damage/13': () => new Reply(null, 204) } }, async ({ dom, api }) => {
    resetUndo();
    installUndoFlush();
    installUndoFlush();
    const sink = toaster();
    const log: string[] = [];
    defer({ sink, log });
    dom.setHidden(true);
    dom.emitDocument('visibilitychange');
    await settle();
    assert.deepEqual(log, ['delete keepalive']);
    defer({ sink, log, id: 13 });
    dom.window.emit('pagehide');
    await settle();
    assert.deepEqual(log, ['delete keepalive', 'delete keepalive']);
    assert.equal(api.calls.length, 2);
  }));

test('the next write sends the pending delete first, so a deferred delete cannot make the following request fail', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply(null, 204), 'POST /api/usage': () => new Reply({ usage: {} }, 201) } }, async ({ api }) => {
    resetUndo();
    const sink = toaster();
    defer({ sink, log: [] });
    await post('/api/usage', { status: 'draft' });
    assert.deepEqual(lines(api.calls), ['DELETE /api/damage/12', 'POST /api/usage']);
    assert.equal(isPending('damage:12'), false);
  }));

test('a read leaves it waiting, and the delete itself does not flush again (no loop)', () =>
  withClient({ now: NOW, routes: { 'GET /api/damage': () => ({ items: [] }), 'DELETE /api/damage/12': () => new Reply(null, 204) } }, async ({ api }) => {
    resetUndo();
    const sink = toaster();
    defer({ sink, log: [] });
    await get('/api/damage');
    assert.equal(isPending('damage:12'), true);
    await flushPending();
    assert.deepEqual(api.calls.map((c) => c.method), ['GET', 'DELETE']);
  }));

test('flushPending (leaving the screen) sends everything that waits and resolves when done', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply(null, 204), 'DELETE /api/damage/13': () => new Reply(null, 204) } }, async ({ api }) => {
    resetUndo();
    const sink = toaster();
    defer({ sink, log: [] });
    defer({ sink, log: [], id: 13 });
    assert.deepEqual([...pendingIds('damage')].sort(), [12, 13]);
    await flushPending();
    assert.equal(api.calls.length, 2);
    assert.equal(pendingIds('damage').size, 0);
  }));

test('walking to another place sends what waits; drawing the same place again (a refresh, the background render, a move inside it) leaves it waiting', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply(null, 204) } }, async ({ api }) => {
    resetUndo();
    const sink = toaster();
    const log: string[] = [];
    await enterPlace('car'); // the first screen: nothing waits yet
    defer({ sink, log });
    await enterPlace('car'); // app.refresh()
    await enterPlace('car'); // the one-minute background render
    await enterPlace('car'); // #/car?edit=9, the same place with another address
    assert.equal(api.calls.length, 0, 'nothing is sent while the person is still there');
    assert.equal(isPending('damage:12'), true);
    sink.toasts[0]?.action?.run();
    assert.deepEqual(log, ['back'], 'and Ongedaan maken still brings it back after all those redraws');

    defer({ sink, log });
    await enterPlace('home');
    assert.deepEqual(lines(api.calls), ['DELETE /api/damage/12'], 'leaving sends it, and resolves when it is sent');
    assert.equal(isPending('damage:12'), false);
    // Back where the item came from is another walk, but nothing waits any more: nothing more is sent.
    await enterPlace('car');
    assert.equal(api.calls.length, 1);
  }));

test('two draws of the next place that start together both wait for the same single delete', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply(null, 204) } }, async ({ api }) => {
    resetUndo();
    await enterPlace('car');
    defer({ sink: toaster(), log: [] });
    const first = enterPlace('home');
    const second = enterPlace('home'); // a hashchange and a refresh in the same moment
    await Promise.all([first, second]);
    assert.deepEqual(lines(api.calls), ['DELETE /api/damage/12'], 'one request, and neither draw went ahead before it was done');
    assert.equal(isPending('damage:12'), false);
  }));

test('deferring the same item twice does not queue two deletes', () =>
  withClient({ now: NOW, routes: {} }, async () => {
    resetUndo();
    const sink = toaster();
    defer({ sink, log: [] });
    defer({ sink, log: [] });
    assert.equal(sink.toasts.length, 1);
    resetUndo();
  }));

test('the toast offers Ongedaan maken for exactly as long as it works: the button leaves with the window, not half a second later', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply(null, 204) } }, async ({ tick }) => {
    resetUndo();
    const sink = toaster();
    defer({ sink, log: [] });
    assert.equal(sink.toasts[0]?.action && 'ms' in sink.toasts[0].action ? sink.toasts[0].action.ms : undefined, UNDO_MS, 'the toast is told how long the action works');
    // The real toaster, on a toast element: it follows that time instead of its own default of 6.5 seconds.
    resetUndo();
    const el = h('div', { class: 'toast' });
    deferDelete({ key: 'damage:12', message: S.undo.damage, commit: (o) => del('/api/damage/12', o), onUndo: () => {}, onError: () => {}, toast: domToaster(() => el) });
    assert.match(el.className, /\bshow\b/);
    assert.equal(el.querySelector('.toast-action')?.textContent, 'Ongedaan maken');
    tick(UNDO_MS - 1);
    assert.match(el.className, /\bshow\b/, 'still offered while it works');
    tick(1);
    await settle();
    assert.doesNotMatch(el.className, /\bshow\b/, 'gone at the end of the window');
    assert.equal(isPending('damage:12'), false, 'and the delete was sent at that moment');
  }));

// ------------------------------------------------------------------ the offer ends when the delete goes out

/** The real toaster on a real toast element, with one delete waiting. */
function realOffer(log: string[]) {
  resetUndo();
  const el = h('div', { class: 'toast' });
  const toast = domToaster(() => el);
  deferDelete({ key: 'damage:12', message: S.undo.damage, commit: (o) => del('/api/damage/12', o), onUndo: () => log.push('back'), onError: () => log.push('error'), toast });
  assert.match(el.className, /\bshow\b/, 'the offer is on screen');
  assert.equal(el.querySelector('.toast-action')?.textContent, S.undo.action);
  return { el, toast };
}

/** Whatever is left of the offer: gone from the screen, and a press that still reached the button would change nothing. */
async function assertOfferWithdrawn(el: ReturnType<typeof h>, api: { calls: Call[] }, log: string[]) {
  assert.doesNotMatch(el.className, /\bshow\b/, 'the toast left with the delete');
  assert.equal(isPending('damage:12'), false);
  await (el.querySelector('.toast-action') as unknown as FakeElement | null)?.fire('click');
  await settle();
  assert.deepEqual(log, [], 'no restore, no error');
  assert.equal(el.querySelector('.toast-text')?.textContent, S.undo.damage, 'and no "restored" message either');
  assert.equal(api.calls.filter((c) => c.method === 'DELETE').length, 1, 'the delete was sent once');
}

test('walking to another place sends the delete and takes Ongedaan maken off the screen with it', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply(null, 204) } }, async ({ api }) => {
    const log: string[] = [];
    const { el } = realOffer(log); // (starts from a clean slate)
    await enterPlace('car');
    await enterPlace('home');
    await assertOfferWithdrawn(el, api, log);
  }));

test('the next write sends the delete and takes Ongedaan maken off the screen with it', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply(null, 204), 'POST /api/usage': () => new Reply({ usage: {} }, 201) } }, async ({ api }) => {
    const log: string[] = [];
    const { el } = realOffer(log);
    await post('/api/usage', { status: 'draft' });
    await assertOfferWithdrawn(el, api, log);
  }));

test('the page going to the background sends the delete and takes Ongedaan maken off the screen with it', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply(null, 204) } }, async ({ dom, api }) => {
    const log: string[] = [];
    const { el } = realOffer(log);
    installUndoFlush();
    dom.setHidden(true);
    dom.emitDocument('visibilitychange');
    await settle();
    await assertOfferWithdrawn(el, api, log);
  }));

test('a message that has taken the toast\'s place is not taken away with the delete', () =>
  withClient({ now: NOW, routes: { 'DELETE /api/damage/12': () => new Reply(null, 204) } }, async ({ api }) => {
    const log: string[] = [];
    const { el, toast } = realOffer(log);
    toast('Opgeslagen.');
    await flushPending();
    assert.equal(api.calls.length, 1);
    assert.match(el.className, /\bshow\b/, 'the newer message stays');
    assert.equal(el.querySelector('.toast-text')?.textContent, 'Opgeslagen.');
  }));

test('toast.dismiss(action) removes only the toast that carries that action, and its timer goes with it', () =>
  withClient({ now: NOW, routes: {} }, async ({ tick }) => {
    const el = h('div', { class: 'toast' });
    const toast = domToaster(() => el);
    const offer = { label: S.undo.action, run: () => {}, ms: UNDO_MS };
    const other = { label: S.undo.action, run: () => {}, ms: UNDO_MS };
    toast('Eerst.', false, offer);
    toast.dismiss?.(other);
    assert.match(el.className, /\bshow\b/, 'another action is not this one');
    toast.dismiss?.(offer);
    assert.doesNotMatch(el.className, /\bshow\b/);
    // The timer of the dismissed toast must not hide the next message early.
    toast('Daarna.');
    tick(3999);
    assert.match(el.className, /\bshow\b/);
    toast.dismiss?.(offer);
    assert.match(el.className, /\bshow\b/, 'a plain message has no action to dismiss');
  }));

// ------------------------------------------------------------------ what may be undone

test('only deletes that tell nobody anything may be undone; everything that notifies uses a confirm sheet', () => {
  const root = path.join(import.meta.dirname, '..');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const rel = (f: string): string => path.relative(root, f).split(path.sep).join('/');
  const code = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<![:'"`])\/\/.*$/gm, '');
  const client = walk(path.join(root, 'public')).filter((f) => f.endsWith('.js')).map(rel);

  // 1. Three places defer a delete, and only these paths: an own unfinished drive, an own damage report, an explanation of a gap.
  const deferring = client.filter((f) => f !== 'public/undo.js' && /\bdeferDelete\(/.test(code(f))).sort();
  assert.deepEqual(deferring, ['public/kmcheck.js', 'public/views/car.js', 'public/views/usage.js'], 'a screen started deferring a delete, or one stopped');
  const deferred = deferring.flatMap((f) => [...code(f).matchAll(/commit:\s*\(\w+\)\s*=>\s*del\(`([^`$]*)\$/g)].map((m) => m[1])).sort();
  assert.deepEqual(deferred, ['/api/damage/', '/api/odometer/explained/', '/api/usage/'], 'a delete that somebody is told about must not be deferrable');

  // 2. Every delete that is not a deferral sits behind a question. The screens whose deletes tell another person (a cancelled or
  //    withdrawn reservation, a fill-up, a ticket, anything the admin removes) never defer at all; car.js and usage.js do both, so their
  //    plain deletes (somebody else's report, a drive that is not the person's own, the cancel of an unused reservation) are counted too.
  const plainDeletes = (file: string): number => code(file).split('\n').filter((line) => /[^\w.]del\(/.test(line) && !/commit:/.test(line)).length;
  const questions = (file: string): number => [...code(file).matchAll(/confirmSheet\(/g)].length;
  for (const file of ['public/views/agenda.js', 'public/views/fuel.js', 'public/views/tickets.js']) {
    assert.doesNotMatch(code(file), /\bdeferDelete\b|undo\.js/, `${file} must not offer Ongedaan maken`);
    assert.ok(plainDeletes(file) >= 1 && questions(file) >= plainDeletes(file), `${file}: ${plainDeletes(file)} delete(s) but ${questions(file)} confirm sheet(s)`);
  }
  // The admin page defers nothing of its own: its deletes ask first. It does show the kilometre check (kmcheck.js), which
  // defers the removal of an explanation, so what the admin page may do with undo.js is install the page-hide flush (point 4).
  assert.doesNotMatch(code('public/admin/admin.js'), /\bdeferDelete\b/, 'the admin page must not defer a delete itself');
  for (const file of ['public/admin/admin.js', 'public/views/car.js', 'public/views/usage.js']) {
    assert.ok(plainDeletes(file) >= 1 && questions(file) >= plainDeletes(file), `${file}: ${plainDeletes(file)} plain delete(s) but ${questions(file)} confirm sheet(s)`);
  }

  // 4. A page that reaches a deferral through its imports, not only through its own text, sends it when the page goes away:
  //    a delete in its six seconds must not be lost to a link that opens another document (the admin page's links open the app).
  const importsOf = (file: string): string[] =>
    [...code(file).matchAll(/^import\s[^;]*?from\s+'(\.[^']+)'/gm)].map((m) => rel(path.resolve(path.dirname(path.join(root, file)), m[1] as string)));
  const reach = (entry: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    for (const next of importsOf(entry)) reach(next, seen);
    return seen;
  };
  for (const entry of ['public/app.js', 'public/admin/admin.js']) {
    const reached = deferring.filter((f) => reach(entry).has(f));
    assert.ok(reached.length > 0, `${entry} was expected to reach a deferral through its imports: the walk over imports is broken`);
    assert.match(code(entry), /\binstallUndoFlush\(\)/, `${entry} can show a deferred delete (${reached.join(', ')}) but never installs the page-hide flush`);
  }

  // 3. What the server says about the three deferred deletes: nothing is sent to anybody for an explanation or a damage report.
  //    (The delete of a drive does emit an event; the client defers only the drive that is the person's own with no one else involved.)
  const server = (f: string): string => fs.readFileSync(path.join(root, 'src', f), 'utf8');
  assert.doesNotMatch(server('odometer.ts'), /notifier|emit\(/, 'removing an explanation tells nobody');
  assert.deepEqual([...server('car.ts').matchAll(/emit\('([\w.]+)'/g)].map((m) => m[1]), ['damage.created'], 'a damage report is announced when it is filed, never when it is deleted');
});
