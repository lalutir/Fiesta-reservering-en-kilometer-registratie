// The admin page for people who are not admins. The server already refuses them
// (http.test.ts); this is the page's own side: it sends them back to the app and
// builds nothing, so no admin data is even requested. The page script starts itself
// when it is loaded, so each case loads a fresh copy of it (the ?case suffix).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, ANNA, NOW, TZ, all, refuse, until, withClient, type FakeElement } from './fake-dom.ts';
import type { Json } from './helpers.ts';

const session = (user: typeof ANNA) => ({ user, timeZone: TZ, windowMonths: 6, serverTime: NOW });

for (const [name, answer, builds] of [
  ['a member', session(ANNA), false],
  ['a signed-out visitor', refuse(401, 'unauthenticated'), false],
  ['an admin (the control: the page does build)', session(ADMIN), true],
] as const) {
  test(`admin page: ${name} ${builds ? 'gets the page' : 'is sent back to the app and nothing is built or requested'}`, async () => {
    const routes = { 'GET /api/auth/me': () => answer, 'GET /api/admin/users': () => ({ users: [ANNA, ADMIN] }) };
    await withClient({ now: NOW, routes }, async ({ dom, api }) => {
      const make = (id: string): FakeElement => {
        const el = (globalThis as Json)['document'].createElement('div') as FakeElement;
        el.id = id;
        return dom.mount(el);
      };
      const root = make('admin');
      make('toast');
      const redirects: string[] = [];
      Object.defineProperty(globalThis, 'location', { value: { replace: (to: string) => redirects.push(to) }, configurable: true, writable: true });
      try {
        await import(`../public/admin/admin.js?case=${encodeURIComponent(name)}`);
        if (builds) {
          await until(() => all(root, '.admin-tabs button').length === 4 && all(root, 'table').length > 0, 'the page to be built');
          assert.deepEqual(redirects, []);
        } else {
          await until(() => redirects.length > 0, 'the redirect');
          assert.ok(redirects.every((to) => to === '/'), `sent to ${redirects.join(', ')}`);
          assert.equal(all(root, 'button').length, 0, 'no tabs, no data');
          assert.deepEqual(
            api.calls.map((c) => c.path),
            ['/api/auth/me'],
            'nothing but the session was asked for',
          );
        }
      } finally {
        delete (globalThis as Json)['location'];
      }
    });
  });
}
