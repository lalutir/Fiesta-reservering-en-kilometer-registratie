import { get } from '../api.js';
import { h } from '../dom.js';
import { ADMIN_ITEM, SECONDARY } from '../nav.js';
import { S } from '../strings.js';
import { themeCard } from '../theme.js';
import { button, listRow } from '../ui.js';
import { signOut } from './account.js';

export const live = false;

/**
 * The page Meer: the places that do not fit in the bar, the choice of theme, who is signed in and the way out.
 * A plain page (not a menu that pops up), so Back works and the address can be shared.
 * @param {import('../api.js').App} app
 * @returns {Promise<HTMLElement>}
 */
export async function render(app) {
  const { user } = app.session;
  /** The count that waits on the Inbox row; the row works without it when the request fails. */
  let waiting = 0;
  try {
    /** @type {{ incomingCount: number }} */
    const inbox = await get('/api/inbox');
    waiting = inbox.incomingCount;
  } catch {
    // the count is a convenience
  }
  const subs = /** @type {Record<string, string>} */ (S.more.sub);
  const rows = SECONDARY.map((item) =>
    listRow({
      title: item.label,
      sub: subs[item.name],
      href: item.href,
      icon: item.icon,
      trailing: item.name === 'inbox' && waiting > 0 ? h('span', { class: 'badge', text: String(waiting), 'aria-label': S.inbox.tabLabel(waiting) }) : null,
    }),
  );
  if (user.role === 'admin') rows.push(listRow({ title: ADMIN_ITEM.label, sub: S.more.sub.admin, href: ADMIN_ITEM.href, icon: ADMIN_ITEM.icon }));
  return h('div', { class: 'more' }, [
    h('h2', { text: S.more.title }),
    h('div', { class: 'list' }, rows),
    themeCard(app.toast),
    h('p', { class: 'more-user' }, [h('strong', { text: user.displayName }), h('span', { class: 'hint', text: `${user.username}, ${S.account.role[user.role]}` })]),
    button({ label: S.account.signOut, block: true, onclick: () => signOut(app) }),
  ]);
}
