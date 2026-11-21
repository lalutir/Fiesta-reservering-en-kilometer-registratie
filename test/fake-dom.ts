// A small fake DOM, a stubbed fetch and a mocked clock: just enough to render the
// client views in Node and use them like a person does (fill in a field, press a
// button) without a browser. It is not a DOM implementation: it supports what
// public/dom.js and the views call, and anything else fails loudly.
//
// Used by forms.test.ts. Real layout, focus rings and the service worker are out of
// reach here and stay with the headless Chromium pass.
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { App, User } from '../public/api.js';
import type { Json } from './helpers.ts';

// ---------------------------------------------------------------- the nodes

export class FakeNode {
  parent: FakeElement | null = null;
  get isConnected(): boolean {
    if (this.parent) return this.parent.isConnected;
    return this instanceof FakeElement && this.attached;
  }
  get textContent(): string {
    return '';
  }
}

export class FakeText extends FakeNode {
  data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
  override get textContent(): string {
    return this.data;
  }
}

type Listener = (event: Json) => unknown;

/** One compound selector: optional tag, any number of .class, #id and [attr], [attr="value"], [attr^="prefix"]. */
function matchesCompound(el: FakeElement, compound: string): boolean {
  const re = /^([a-z][a-z0-9]*)?((?:\.[\w-]+|\[[\w-]+(?:\^?="[^"]*")?\]|#[\w-]+)*)$/i;
  const m = re.exec(compound);
  if (!m) throw new Error(`fake DOM: unsupported selector "${compound}"`);
  if (m[1] && el.tagName !== m[1].toLowerCase()) return false;
  for (const part of m[2]?.match(/\.[\w-]+|\[[^\]]+\]|#[\w-]+/g) ?? []) {
    if (part.startsWith('.')) {
      if (!el.className.split(/\s+/).includes(part.slice(1))) return false;
    } else if (part.startsWith('#')) {
      if (el.id !== part.slice(1)) return false;
    } else {
      const parsed = /^([\w-]+)(?:(\^?=)"(.*)")?$/.exec(part.slice(1, -1));
      const actual = parsed ? el.getAttribute(parsed[1] as string) : null;
      if (actual === null) return false;
      if (parsed?.[2] === '=' && actual !== parsed[3]) return false;
      if (parsed?.[2] === '^=' && !actual.startsWith(parsed[3] as string)) return false;
    }
  }
  return true;
}

/** Lists ("a, b") and descendant selectors ("a b.c") are supported, child and sibling combinators are not. */
function matches(el: FakeElement, selector: string): boolean {
  return selector.split(',').some((one) => matchesChain(el, one));
}

function matchesChain(el: FakeElement, selector: string): boolean {
  const parts = selector.trim().split(/\s+/);
  if (!matchesCompound(el, parts[parts.length - 1] as string)) return false;
  let up: FakeElement | null = el.parent;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (up && !matchesCompound(up, parts[i] as string)) up = up.parent;
    if (!up) return false;
    up = up.parent;
  }
  return true;
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  children: FakeNode[] = [];
  className = '';
  hidden = false;
  disabled = false;
  required = false;
  checked = false;
  readOnly = false;
  multiple = false;
  selected = false;
  /** Set on the document body: what counts as "in the page" for isConnected. */
  attached = false;
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();
  private current = '';

  constructor(tag: string) {
    super();
    this.tagName = tag.toLowerCase();
  }

  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  set id(v: string) {
    this.attrs.set('id', v);
  }

  get classList(): { add(c: string): void; remove(c: string): void; toggle(c: string, force?: boolean): boolean; contains(c: string): boolean } {
    const tokens = () => this.className.split(/\s+/).filter(Boolean);
    const set = (t: string[]) => {
      this.className = t.join(' ');
    };
    return {
      add: (c) => set([...new Set([...tokens(), c])]),
      remove: (c) => set(tokens().filter((t) => t !== c)),
      toggle: (c, force) => {
        const on = force ?? !tokens().includes(c);
        set(on ? [...new Set([...tokens(), c])] : tokens().filter((t) => t !== c));
        return on;
      },
      contains: (c) => tokens().includes(c),
    };
  }

  /** A select holds the value of one of its options (the first when nothing else was chosen). */
  get value(): string {
    if (this.tagName !== 'select') return this.current;
    const options = this.descendants().filter((e) => e.tagName === 'option');
    return options.some((o) => o.value === this.current) ? this.current : (options[0]?.value ?? '');
  }
  set value(v: string) {
    this.current = String(v);
  }

  override get textContent(): string {
    return this.children.map((c) => c.textContent).join('');
  }
  override set textContent(v: string) {
    this.replaceChildren();
    if (v !== '') this.appendChild(new FakeText(String(v)));
  }

  setAttribute(name: string, value: string): void {
    if (name === 'value' && this.tagName === 'option') this.current = value;
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** Runs the listeners like the browser would and waits for the async ones. */
  async fire(type: string, extra: Json = {}): Promise<void> {
    const event = { type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of this.listeners.get(type) ?? []) await fn(event);
  }

  appendChild(child: FakeNode): void {
    child.parent = this;
    this.children.push(child);
  }
  replaceChildren(...next: FakeNode[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    for (const c of next) this.appendChild(c);
  }

  focus(): void {
    ((globalThis as Json)['document'] as FakeDocument).activeElement = this;
  }
  select(): void {}

  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) {
      if (c instanceof FakeElement) out.push(c, ...c.descendants());
    }
    return out;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((e) => matches(e, selector));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector: string): FakeElement | null {
    return matches(this, selector) ? this : (this.parent?.closest(selector) ?? null);
  }
}

export interface FakeDocument {
  body: FakeElement;
  activeElement: FakeElement | null;
  createElement(tag: string): FakeElement;
  createTextNode(data: string): FakeText;
  getElementById(id: string): FakeElement | null;
  querySelector(selector: string): FakeElement | null;
}

// ------------------------------------------------------------ the whole page

export interface FakeDom {
  body: FakeElement;
  /** What confirm() answers next (true by default) and every question it was asked. */
  answer: boolean;
  confirms: string[];
  /** Put a rendered view in the page, so isConnected and getElementById see it. */
  mount(el: unknown): FakeElement;
  /** The element that has keyboard focus (what the last focus() call was on). */
  focused(): FakeElement | null;
  uninstall(): void;
}

const GLOBALS = ['document', 'Node', 'Element', 'HTMLElement', 'confirm'] as const;

export function installFakeDom(): FakeDom {
  const g = globalThis as Json;
  const saved = GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  const body = new FakeElement('body');
  body.attached = true;
  const document: FakeDocument = {
    body,
    activeElement: null,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (data) => new FakeText(data),
    getElementById: (id) => body.descendants().find((e) => e.id === id) ?? null,
    querySelector: (selector) => body.querySelector(selector),
  };
  const dom: FakeDom = {
    body,
    answer: true,
    confirms: [],
    mount(el) {
      body.appendChild(el as FakeElement);
      return el as FakeElement;
    },
    focused: () => document.activeElement,
    uninstall() {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(g, k, d);
        else delete g[k];
      }
    },
  };
  const define = (k: string, value: unknown) => Object.defineProperty(g, k, { value, configurable: true, writable: true });
  define('document', document);
  define('Node', FakeNode);
  define('Element', FakeElement);
  define('HTMLElement', FakeElement);
  define('confirm', (question: string) => {
    dom.confirms.push(question);
    return dom.answer;
  });
  return dom;
}

// --------------------------------------------------- the browser's push side

export interface FakeSubscription {
  endpoint: string;
  toJSON(): Json;
  unsubscribe(): Promise<boolean>;
}

export interface FakeBrowser {
  /** What Notification.permission says, and what the person answers when asked. */
  permission: 'default' | 'granted' | 'denied';
  answer: 'granted' | 'denied';
  asked: number;
  /** The push subscription this browser holds (null: none), and what subscribe() was called with. */
  subscription: FakeSubscription | null;
  subscribeCalls: Json[];
  unsubscribed: number;
  uninstall(): void;
}

/**
 * The parts of the browser the Account page's Reminders card talks to: navigator
 * (service worker, user agent), window (is there a PushManager and Notification at
 * all), Notification, and a service worker registration with a pushManager.
 * `sw: 'never'` is a browser whose service worker never becomes ready.
 */
export function installFakeBrowser(
  opts: { permission?: FakeBrowser['permission']; answer?: 'granted' | 'denied'; subscribed?: boolean; push?: boolean; serviceWorker?: boolean | 'never'; ios?: boolean } = {},
): FakeBrowser {
  const g = globalThis as Json;
  const keys = ['navigator', 'window', 'Notification'];
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  const state: FakeBrowser = {
    permission: opts.permission ?? 'default',
    answer: opts.answer ?? 'granted',
    asked: 0,
    subscription: null,
    subscribeCalls: [],
    unsubscribed: 0,
    uninstall() {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(g, k, d);
        else delete g[k];
      }
    },
  };
  const makeSubscription = (): FakeSubscription => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
    toJSON() {
      return { endpoint: this.endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-secret' } };
    },
    unsubscribe: async () => {
      state.unsubscribed++;
      state.subscription = null;
      return true;
    },
  });
  if (opts.subscribed) state.subscription = makeSubscription();
  const registration = {
    pushManager: {
      getSubscription: async () => state.subscription,
      subscribe: async (options: Json) => {
        state.subscribeCalls.push(options);
        state.subscription = makeSubscription();
        return state.subscription;
      },
    },
  };
  const hasWorker = opts.serviceWorker !== false;
  const nav: Json = { userAgent: opts.ios ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' : 'Mozilla/5.0 (Linux; Android 14)', platform: opts.ios ? 'iPhone' : 'Linux armv81', maxTouchPoints: 5 };
  if (hasWorker) nav.serviceWorker = { ready: opts.serviceWorker === 'never' ? new Promise(() => {}) : Promise.resolve(registration) };
  const notification = {
    get permission() {
      return state.permission;
    },
    requestPermission: async () => {
      state.asked++;
      state.permission = state.answer;
      return state.permission;
    },
  };
  const win: Json = {};
  if (opts.push !== false) win.PushManager = class {};
  win.Notification = notification;
  const define = (k: string, value: unknown) => Object.defineProperty(g, k, { value, configurable: true, writable: true });
  define('navigator', nav);
  define('window', win);
  define('Notification', notification);
  return state;
}

/** Wait until something an unawaited handler does has happened (the views fire and forget their clicks). */
export async function until(condition: () => boolean, what = 'the view to settle'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`gave up waiting for ${what}`);
}

// ------------------------------------------------------------ finding things

export function all(root: unknown, selector: string): FakeElement[] {
  return (root as FakeElement).querySelectorAll(selector);
}

export function one(root: unknown, selector: string): FakeElement {
  const found = (root as FakeElement).querySelector(selector);
  assert.ok(found, `nothing matches "${selector}"`);
  return found;
}

/** An element of this tag whose text is exactly this (a button or link by its label). */
export function byText(root: unknown, tag: string, text: string): FakeElement {
  const found = all(root, tag).find((e) => e.textContent === text);
  assert.ok(found, `no <${tag}> with the text "${text}"`);
  return found;
}

/** The .field row whose label is exactly this text. */
export function fieldRow(root: unknown, label: string): FakeElement {
  const row = all(root, '.field').find((r) => r.children[0]?.textContent === label);
  assert.ok(row, `no field labelled "${label}"`);
  return row;
}

/** The input, select or textarea of a field row. */
export function control(row: FakeElement): FakeElement {
  const found = row.descendants().find((e) => ['input', 'select', 'textarea'].includes(e.tagName));
  assert.ok(found, 'the field has no control');
  return found;
}

/** The date and time inputs of a date-time field row. */
export function dateTime(row: FakeElement): { date: FakeElement; time: FakeElement } {
  const [date, time] = row.descendants().filter((e) => e.tagName === 'input');
  assert.ok(date && time, 'not a date-time field');
  return { date, time };
}

export const errorOf = (row: FakeElement): string => one(row, '.field-error').textContent;
export const hintOf = (row: FakeElement): string | null => row.querySelector('small.hint')?.textContent ?? null;

/** Type into a field the way a person does: set the value, then fire input. */
export async function typeInto(el: FakeElement, value: string): Promise<void> {
  el.value = value;
  await el.fire('input');
}

/** Press a form's submit button: the form gets its submit event. */
export async function submitForm(root: unknown): Promise<void> {
  await one(root, 'form').fire('submit');
}

// ------------------------------------------------------------------ the API

export class Reply {
  status: number;
  body: Json;
  constructor(body: Json, status = 200) {
    this.status = status;
    this.body = body;
  }
}

/** A failed API call in the server's error shape. */
export const refuse = (status: number, code: string, extra: Json = {}): Reply => new Reply({ error: { code, message: code, ...extra } }, status);

export interface Call {
  method: string;
  path: string;
  /** The query string without the "?" ('' when there is none). */
  query: string;
  body: Json;
}

export type Routes = Record<string, (call: Call) => Reply | Json>;

export interface ApiStub {
  calls: Call[];
  /** Requests nobody planned for: a test fails if there are any. */
  unhandled: string[];
  /** Only the writes (everything but GET). */
  writes(): Call[];
  restore(): void;
}

/**
 * Routes are keyed "METHOD /path" (query string ignored); a plain object answers 200, a Reply anything else.
 * GET /api/odometer (the kilometre check every drive, fill-up and history screen asks for) answers an empty
 * chain unless a test plans something else, so a test about something else does not have to know about it.
 */
export function stubApi(planned: Routes): ApiStub {
  const routes: Routes = { 'GET /api/odometer': () => odometerChain(), ...planned };
  const g = globalThis as Json;
  const before = Object.getOwnPropertyDescriptor(g, 'fetch');
  const stub: ApiStub = {
    calls: [],
    unhandled: [],
    writes: () => stub.calls.filter((c) => c.method !== 'GET'),
    restore() {
      if (before) Object.defineProperty(g, 'fetch', before);
    },
  };
  g.fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    const [path = '', query = ''] = url.split('?');
    const call: Call = { method, path, query, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    stub.calls.push(call);
    const route = routes[`${method} ${path}`];
    if (!route) {
      stub.unhandled.push(`${method} ${url}`);
      return new Response(JSON.stringify({ error: { code: 'unhandled', message: 'unhandled' } }), { status: 500 });
    }
    const out = route(call);
    const reply = out instanceof Reply ? out : new Reply(out);
    return reply.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  return stub;
}

// ------------------------------------------------------------- shared fixtures

/** The moment every client test stands still at: 12:00 in Amsterdam. */
export const NOW = '2026-06-15T10:00:00.000Z';
export const TZ = 'Europe/Amsterdam';
export const at = (minutes: number): string => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

/** A confirmed reservation of Anna that starts in 20 minutes, with nothing registered. */
export function reservation(over: Json = {}): Json {
  return {
    id: 7,
    userId: 1,
    userName: 'Anna',
    createdBy: 1,
    createdByName: 'Anna',
    status: 'confirmed',
    suggestion: false,
    start: at(20),
    end: at(180),
    note: '',
    can: { edit: true, cancel: true, approve: false, decline: false },
    drive: null,
    kmState: 'missing',
    ...over,
  };
}

/** A finished drive of Ben with both readings. */
export function usage(over: Json = {}): Json {
  return {
    id: 3,
    userId: 2,
    userName: 'Ben',
    status: 'completed',
    start: at(-600),
    end: at(-480),
    odometerStart: 41000,
    odometerEnd: 41120,
    distanceKm: 120,
    reservationId: null,
    note: '',
    can: { edit: false, delete: false },
    fuelLocked: false,
    ...over,
  };
}

/** Anna's drive that has started and not ended. */
export const draft = (over: Json = {}): Json =>
  usage({ id: 9, userId: 1, userName: 'Anna', status: 'draft', start: at(-60), end: null, odometerStart: 41120, odometerEnd: null, distanceKm: null, reservationId: 7, note: 'Groceries', can: { edit: true, delete: true }, ...over });

// ------------------------------------------------------- the odometer chain

/** One reading in the chain: by default the end of Ben's drive 3 (see usage()). */
export function reading(over: Json = {}): Json {
  return { source: 'drive-end', id: 3, km: 41120, at: at(-480), userId: 2, userName: 'Ben', draft: false, ...over };
}

/** A finding between two readings, open (not explained) and open to everybody who is involved. */
export function finding(prev: Json, next: Json, over: Json = {}): Json {
  const km = (next['km'] as number) - (prev['km'] as number);
  const key = [prev, next].map((r) => `${r['source']}:${r['id']}:${r['km']}:${r['at']}:${r['userId']}`).join('>');
  return { key, kind: km > 0 ? 'gap' : 'mismatch', km: Math.abs(km), prev, next, explained: null, can: { explain: true, unexplain: false }, ...over };
}

/** The answer of GET /api/odometer: readings in chain order, findings newest first. */
export function odometerChain(readings: Json[] = [], items: Json[] = []): Json {
  return {
    window: { from: '2025-12-15T00:00:00.000Z', to: '2026-12-15T00:00:00.000Z' },
    readings,
    items,
    latest: readings[readings.length - 1] ?? null,
  };
}

export const odometerRoutes = (chain: Json = odometerChain()): Routes => ({ 'GET /api/odometer': () => chain });

// ------------------------------------------------------------------ the app

export const ANNA: User = { id: 1, username: 'anna', displayName: 'Anna', role: 'member', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
export const BEN: User = { id: 2, username: 'ben', displayName: 'Ben', role: 'member', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
export const ADMIN: User = { id: 3, username: 'root', displayName: 'Root', role: 'admin', active: true, createdAt: '2026-01-01T00:00:00.000Z' };

export interface TestApp {
  app: App;
  toasts: Array<{ message: string; isError: boolean }>;
  navigated: string[];
  /** Every call of signedOut(quiet). */
  signedOut: boolean[];
  refreshes: () => number;
}

export function makeApp(me: User = ANNA, users: User[] = [ANNA, BEN, ADMIN]): TestApp {
  const toasts: TestApp['toasts'] = [];
  const navigated: string[] = [];
  const signedOut: boolean[] = [];
  let refreshed = 0;
  const app = {
    session: { user: me, timeZone: 'Europe/Amsterdam', windowMonths: 6, serverTime: '2026-06-15T10:00:00.000Z' },
    tz: 'Europe/Amsterdam',
    users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })),
    navigate: (hash: string) => {
      navigated.push(hash);
    },
    refresh: async () => {
      refreshed++;
    },
    toast: (message: string, isError = false) => {
      toasts.push({ message, isError });
    },
    signedOut: async (quiet = false) => {
      signedOut.push(quiet);
    },
  };
  return { app: app as unknown as App, toasts, navigated, signedOut, refreshes: () => refreshed };
}

// ------------------------------------------------------- one test's whole world

/**
 * Run a client test with the fake DOM, the stubbed API and a clock that stands still
 * at `now` (so "starts in 20 minutes" means the same thing every run). setTimeout is
 * mocked too: a timer only fires when the test calls tick(ms), so nothing waits for
 * real seconds. Everything is put back afterwards, and a request that no route
 * answers fails the test.
 */
export async function withClient(
  opts: { now: string; routes: Routes },
  fn: (c: { dom: FakeDom; api: ApiStub; tick: (ms: number) => void }) => Promise<void>,
): Promise<void> {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse(opts.now) });
  const dom = installFakeDom();
  const api = stubApi(opts.routes);
  try {
    await fn({ dom, api, tick: (ms) => mock.timers.tick(ms) });
    assert.deepEqual(api.unhandled, [], 'the view asked for something the test did not plan for');
  } finally {
    api.restore();
    dom.uninstall();
    mock.timers.reset();
  }
}
