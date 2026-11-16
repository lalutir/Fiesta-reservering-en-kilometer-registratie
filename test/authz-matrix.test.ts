import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/db.ts';
import { at, createHousehold, insertReservation, type Client, type Household, type Reply } from './helpers.ts';

// Role-by-action matrix for reservations. Rows are fixtures (a reservation in a
// given state), columns are actors, cells are the expected HTTP status. The
// `can` flags the API returns must agree with the same table.

type ActorName = 'anonymous' | 'creator' | 'target' | 'other' | 'admin';
type ActionName = 'view' | 'edit' | 'cancel' | 'approve' | 'decline';
type FixtureName = 'ownConfirmed' | 'pendingSuggestion' | 'declinedSuggestion' | 'expiredSuggestion' | 'approvedSuggestion';

const ACTORS: ActorName[] = ['anonymous', 'creator', 'target', 'other', 'admin'];
const ACTIONS: ActionName[] = ['view', 'edit', 'cancel', 'approve', 'decline'];

//                       anonymous creator target other admin
type Row = [number, number, number, number, number];

const MATRIX: Record<FixtureName, Record<ActionName, Row>> = {
  // Anna books for herself (creator and driver are the same person).
  ownConfirmed: {
    view: [401, 200, 200, 200, 200],
    edit: [401, 200, 200, 403, 200],
    cancel: [401, 204, 204, 403, 204],
    approve: [401, 409, 409, 403, 403],
    decline: [401, 409, 409, 403, 403],
  },
  // Anna suggests a future slot to Ben.
  pendingSuggestion: {
    view: [401, 200, 200, 403, 200],
    edit: [401, 200, 403, 403, 200],
    cancel: [401, 204, 403, 403, 204],
    approve: [401, 403, 200, 403, 403],
    decline: [401, 403, 200, 403, 403],
  },
  declinedSuggestion: {
    view: [401, 200, 200, 403, 200],
    edit: [401, 409, 403, 403, 409],
    cancel: [401, 204, 403, 403, 204],
    approve: [401, 403, 409, 403, 403],
    decline: [401, 403, 409, 403, 403],
  },
  // Pending, but its start time has passed.
  expiredSuggestion: {
    view: [401, 200, 200, 403, 200],
    edit: [401, 409, 403, 403, 409],
    cancel: [401, 204, 403, 403, 204],
    approve: [401, 403, 409, 403, 403],
    decline: [401, 403, 409, 403, 403],
  },
  // Anna's suggestion that Ben approved: Ben is the driver, Anna only the creator.
  approvedSuggestion: {
    view: [401, 200, 200, 200, 200],
    edit: [401, 403, 200, 403, 200],
    cancel: [401, 403, 204, 403, 204],
    approve: [401, 403, 409, 403, 403],
    decline: [401, 403, 409, 403, 403],
  },
};

function seed(h: Household, fixture: FixtureName): number {
  const { t, anna, ben } = h;
  run(t.db, 'DELETE FROM reservations');
  const future = { start: at(t.clock, 24), end: at(t.clock, 26) };
  switch (fixture) {
    case 'ownConfirmed':
      return insertReservation(t, { userId: anna.id, ...future });
    case 'pendingSuggestion':
      return insertReservation(t, { userId: ben.id, createdBy: anna.id, status: 'pending', ...future });
    case 'declinedSuggestion':
      return insertReservation(t, { userId: ben.id, createdBy: anna.id, status: 'declined', ...future });
    case 'expiredSuggestion':
      return insertReservation(t, { userId: ben.id, createdBy: anna.id, status: 'pending', start: at(t.clock, -3), end: at(t.clock, -1) });
    case 'approvedSuggestion':
      return insertReservation(t, { userId: ben.id, createdBy: anna.id, status: 'confirmed', ...future });
  }
}

function clientFor(h: Household, fixture: FixtureName, actor: ActorName): Client {
  switch (actor) {
    case 'anonymous':
      return h.t.client();
    case 'creator':
      return h.anna;
    case 'target':
      return fixture === 'ownConfirmed' ? h.anna : h.ben;
    case 'other':
      return h.carla;
    case 'admin':
      return h.admin;
  }
}

function perform(client: Client, action: ActionName, id: number): Promise<Reply> {
  switch (action) {
    case 'view':
      return client.get(`/api/reservations/${id}`);
    case 'edit':
      return client.patch(`/api/reservations/${id}`, { note: 'matrix' });
    case 'cancel':
      return client.del(`/api/reservations/${id}`);
    case 'approve':
      return client.post(`/api/reservations/${id}/approve`);
    case 'decline':
      return client.post(`/api/reservations/${id}/decline`);
  }
}

test('role-by-action matrix: every actor, action and reservation state returns the expected status', async () => {
  const h = await createHousehold();
  try {
    const failures: string[] = [];
    for (const fixture of Object.keys(MATRIX) as FixtureName[]) {
      for (const action of ACTIONS) {
        const expected = MATRIX[fixture][action];
        for (const [i, actor] of ACTORS.entries()) {
          const id = seed(h, fixture); // fresh row each time: cancel and approve change it
          const res = await perform(clientFor(h, fixture, actor), action, id);
          if (res.status !== expected[i]) {
            failures.push(`${fixture} / ${action} / ${actor}: expected ${expected[i]}, got ${res.status} ${res.text}`);
          }
        }
      }
    }
    assert.deepEqual(failures, []);
  } finally {
    await h.t.close();
  }
});

test('the can flags in the API agree with the matrix for everyone who may see the reservation', async () => {
  const h = await createHousehold();
  try {
    const failures: string[] = [];
    for (const fixture of Object.keys(MATRIX) as FixtureName[]) {
      for (const [i, actor] of ACTORS.entries()) {
        if (actor === 'anonymous') continue;
        const id = seed(h, fixture);
        const res = await clientFor(h, fixture, actor).get(`/api/reservations/${id}`);
        if (MATRIX[fixture].view[i] !== 200) {
          if (res.status !== 403) failures.push(`${fixture} / ${actor}: hidden reservation answered ${res.status}`);
          continue;
        }
        const can = res.body.reservation.can as Record<string, boolean>;
        for (const action of ['edit', 'cancel', 'approve', 'decline'] as const) {
          const expectedOk = MATRIX[fixture][action][i]! < 300;
          if (can[action] !== expectedOk) failures.push(`${fixture} / ${actor}: can.${action} is ${can[action]}, matrix says ${expectedOk}`);
        }
      }
    }
    assert.deepEqual(failures, []);
  } finally {
    await h.t.close();
  }
});

test('lists respect the same visibility as the matrix', async () => {
  const h = await createHousehold();
  try {
    for (const fixture of Object.keys(MATRIX) as FixtureName[]) {
      for (const [i, actor] of ACTORS.entries()) {
        if (actor === 'anonymous') continue;
        const id = seed(h, fixture);
        const listed = (await clientFor(h, fixture, actor).get('/api/reservations?from=2020-01-01T00:00:00Z')).body.items.map((x: { id: number }) => x.id);
        assert.equal(listed.includes(id), MATRIX[fixture].view[i] === 200, `${fixture} / ${actor}`);
      }
    }
  } finally {
    await h.t.close();
  }
});

test('unknown reservations are 404 for every authenticated actor and action', async () => {
  const h = await createHousehold();
  try {
    for (const client of [h.anna, h.admin]) {
      for (const action of ACTIONS) {
        assert.equal((await perform(client, action, 31337)).status, 404, action);
      }
    }
  } finally {
    await h.t.close();
  }
});
