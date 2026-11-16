import { get } from '../api.js';
import { h } from '../dom.js';
import { S } from '../strings.js';
import { reservationCard } from './agenda.js';

export const live = true;

/**
 * Suggestions waiting for my answer, and the ones I sent to others.
 * @param {import('../api.js').App} app
 * @returns {Promise<HTMLElement>}
 */
export async function render(app) {
  /** @type {{ incoming: import('../api.js').Reservation[], outgoing: import('../api.js').Reservation[] }} */
  const { incoming, outgoing } = await get('/api/inbox');
  return h('div', { class: 'inbox' }, [
    h('h2', { text: S.inbox.incoming }),
    incoming.length === 0 ? h('p', { class: 'empty', text: S.inbox.nothingIncoming }) : incoming.map((r) => reservationCard(app, r, false)),
    h('h2', { text: S.inbox.outgoing }),
    outgoing.length === 0 ? h('p', { class: 'empty', text: S.inbox.nothingOutgoing }) : outgoing.map((r) => reservationCard(app, r, r.status === 'expired' || r.status === 'declined')),
  ]);
}
