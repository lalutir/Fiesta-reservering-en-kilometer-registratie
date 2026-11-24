// The kilometre check on the client: the odometer chain the server derives (src/odometer.ts) shown to
// everybody. First the pure helpers (what the last known reading is, when to warn, what to prefill, which
// findings touch a drive), then the one DOM component, the "Kilometre check" section.
//
// Nothing here blocks a save: a warning is only text. The server derives the chain (the list of findings);
// the client only repeats two small rules that the forms need before anything is saved (the latest reading
// at or before a moment, and whether a fill-up lies inside a drive's own readings). test/odometer-view.test.ts
// ties both to what the server answers.
import { del, post } from './api.js';
import { field, fmtWhen, h, showFieldErrors } from './dom.js';
import { S, errorText } from './strings.js';
import { button, linkButton } from './ui.js';
import { deferDelete, isPending } from './undo.js';

/** The same zero tolerance as the server (GAP_TOLERANCE_KM in src/odometer.ts): any difference is a finding. */
export const GAP_TOLERANCE_KM = 0;

/** @typedef {import('./api.js').OdometerReading} Reading */
/** @typedef {import('./api.js').OdometerItem} Item */
/** @typedef {import('./api.js').OdometerChain} Chain */
/** @typedef {{ drive?: number | null, fuel?: number | null }} Excluded the drive or fill-up being edited: its own readings are not "the reading before" */
/** @typedef {{ last: Reading | null, trip: { start: Reading, end: Reading } | null }} Context */

const MINUTE_MS = 60_000;

// ------------------------------------------------------------------ pure helpers

/**
 * @param {Reading} r
 * @param {Excluded} exclude
 */
function isExcluded(r, exclude) {
  const id = r.source === 'fuel' ? exclude.fuel : exclude.drive;
  return id !== undefined && id !== null && r.id === id;
}

/**
 * The latest reading at or before an instant: what the car's odometer last showed, as far as anybody
 * wrote it down. `readings` is in chain order (time, then the server's tie-break), so the last match
 * wins. Null when there is none.
 * @param {Reading[]} readings
 * @param {string} iso
 * @param {Excluded} [exclude]
 * @returns {Reading | null}
 */
export function readingBefore(readings, iso, exclude = {}) {
  for (let i = readings.length - 1; i >= 0; i--) {
    const r = /** @type {Reading} */ (readings[i]);
    if (r.at <= iso && !isExcluded(r, exclude)) return r;
  }
  return null;
}

/**
 * What a typed reading is compared with. For a new or edited drive that is the reading before it; for a
 * fill-up that falls strictly inside a completed drive (the pump stop was part of the trip) it is that
 * drive's own start and end readings, as on the server, where such a fill-up is not a link in the chain.
 * @param {Reading[]} readings
 * @param {string} iso when the drive starts or the fill-up happens
 * @param {Excluded} [exclude]
 * @param {boolean} [forFuel] a fill-up form (the only one where a trip can apply)
 * @returns {Context}
 */
export function odometerContext(readings, iso, exclude = {}, forFuel = false) {
  /** @type {Context['trip']} */
  let trip = null;
  if (forFuel) {
    for (const start of readings) {
      if (start.source !== 'drive-start' || start.at >= iso || isExcluded(start, exclude)) continue;
      const end = readings.find((r) => r.source === 'drive-end' && r.id === start.id && r.at > iso);
      if (end) {
        trip = { start, end };
        break;
      }
    }
  }
  return { last: readingBefore(readings, iso, exclude), trip };
}

/**
 * Does a typed reading not fit? Null when it does, when nothing is typed or when nothing is known.
 * @param {number | null} typed
 * @param {Context} ctx
 * @returns {{ kind: 'lower', diff: number, known: number } | { kind: 'higher', diff: number } | { kind: 'outside', start: number, end: number } | null}
 */
export function odometerWarning(typed, ctx) {
  if (typed === null || !Number.isFinite(typed)) return null;
  if (ctx.trip) {
    const { start, end } = ctx.trip;
    return typed < start.km || typed > end.km ? { kind: 'outside', start: start.km, end: end.km } : null;
  }
  if (!ctx.last) return null;
  const diff = typed - ctx.last.km;
  if (diff < -GAP_TOLERANCE_KM) return { kind: 'lower', diff: -diff, known: ctx.last.km };
  if (diff > GAP_TOLERANCE_KM) return { kind: 'higher', diff };
  return null;
}

/** @param {ReturnType<typeof odometerWarning>} warning */
export function warningText(warning) {
  if (!warning) return '';
  if (warning.kind === 'lower') return S.kmcheck.warnLower(warning.diff, warning.known);
  if (warning.kind === 'higher') return S.kmcheck.warnHigher(warning.diff);
  return S.kmcheck.warnOutsideDrive(warning.start, warning.end);
}

/**
 * @param {Reading} reading
 * @param {{ tz: string, meId: number }} o
 */
function whoAndWhen(reading, o) {
  return { who: reading.userId === o.meId ? S.meLabel : reading.userName, when: fmtWhen(reading.at, o.tz) };
}

/**
 * What the form says about the reading before this one: "Last known: 45,210 km, Anna, Tue, 15 Jun, 14:05"
 * and, when the typed value does not fit, a warning. The warning sits in a polite live region that is always
 * in the page (a live region has to exist before its text changes, or the first message is missed); it is a
 * status, never an alert, because nothing is wrong enough to interrupt: saving is still allowed.
 * @param {{ tz: string, meId: number }} o
 */
export function odometerNote(o) {
  const last = h('div', { class: 'hint km-last' });
  const warn = h('p', { class: 'km-warn', role: 'status', 'aria-live': 'polite' });
  return {
    el: h('div', { class: 'km-note' }, [last, warn]),
    /**
     * @param {Context} ctx
     * @param {number | null} typed
     */
    show: (ctx, typed) => {
      if (ctx.last) {
        const { who, when } = whoAndWhen(ctx.last, o);
        last.textContent = S.kmcheck.lastKnown(ctx.last.km, who, when);
      } else {
        last.textContent = '';
      }
      warn.textContent = warningText(odometerWarning(typed, ctx));
    },
  };
}

/**
 * The findings that touch one drive, as the lines to show under it: a gap or mismatch before or after it, a
 * fill-up during it that reads outside its own readings, or the note of an explanation.
 * @param {{ id: number, status?: string, odometerStart: number | null, odometerEnd: number | null }} drive
 * @param {Item[]} items
 * @returns {HTMLElement[]}
 */
export function kmMarkers(drive, items) {
  const M = S.kmcheck.marker;
  // Only a finished drive with both readings has a span a pump stop can fall inside.
  const hasSpan = drive.status !== 'draft' && drive.odometerStart !== null && drive.odometerEnd !== null;
  /** @param {Reading} r */
  const isThisDrive = (r) => r.source !== 'fuel' && r.id === drive.id;
  /** @type {HTMLElement[]} */
  const out = [];
  for (const item of items) {
    const { prev, next, kind, km } = item;
    /** @type {string | null} */
    let text = null;
    if (hasSpan && prev.source === 'drive-start' && isThisDrive(prev) && next.source === 'fuel') text = M.fuelBelow(km);
    else if (hasSpan && next.source === 'drive-end' && isThisDrive(next) && prev.source === 'fuel') text = M.fuelAbove(km);
    else if (isThisDrive(next)) text = kind === 'gap' ? M.gapBefore(km) : M.mismatchBefore(km);
    else if (isThisDrive(prev)) text = kind === 'gap' ? M.gapAfter(km) : M.mismatchAfter(km);
    if (text === null) continue;
    const { explained } = item;
    out.push(h('div', { class: explained ? 'sub km-flag explained' : 'sub km-flag', text: explained ? M.explained(explained.note) : text }));
  }
  return out;
}

/**
 * What "Add the missing drive" starts the form with: the gap's two readings and, when they fit, the times of
 * the two neighbours. The times are rounded inward to whole minutes (the start up, the end down), so the new
 * drive cannot overlap either neighbour; when nothing is left between them the times are null and the form
 * keeps its normal default times (the readings stay).
 * @param {Item} item
 * @returns {{ start: string | null, end: string | null, odometerStart: number, odometerEnd: number }}
 */
export function gapDefaults(item) {
  const start = Math.ceil(Date.parse(item.prev.at) / MINUTE_MS) * MINUTE_MS;
  const end = Math.floor(Date.parse(item.next.at) / MINUTE_MS) * MINUTE_MS;
  const fits = start < end;
  return {
    start: fits ? new Date(start).toISOString() : null,
    end: fits ? new Date(end).toISOString() : null,
    odometerStart: item.prev.km,
    odometerEnd: item.next.km,
  };
}

// ----------------------------------------------------------------- the component

const HEADING_ID = 'km-check-title';
/** How many open findings show before the rest folds away. */
const OPEN_SHOWN = 3;

/**
 * The "Kilometre check" section: findings in the odometer chain, for everybody. Null when there is no
 * reading at all yet (nothing to check). Open findings show newest first, the newest few in full and the
 * rest folded; explained ones fold away under their own heading with the note and who wrote it.
 * @param {Chain} rawChain
 * @param {object} o
 * @param {number} o.meId
 * @param {boolean} o.isAdmin
 * @param {string} o.tz
 * @param {string} o.hrefBase '' in the member app, '/' on the admin page (links go to the member app)
 * @param {'h2' | 'h3'} [o.heading]
 * @param {import('./api.js').Toast} o.toast
 * @param {() => Promise<unknown>} o.onChange reload the view after an explanation was saved or removed
 * @returns {HTMLElement | null}
 */
export function kmCheckSection(rawChain, o) {
  if (rawChain.readings.length === 0) return null;
  // An explanation that was taken back a moment ago (and can still be restored) is not shown: its finding is open again.
  const chain = { ...rawChain, items: rawChain.items.map((i) => (i.explained && isPending(`explanation:${i.explained.id}`) ? { ...i, explained: null } : i)) };
  const K = S.kmcheck;
  const open = chain.items.filter((i) => !i.explained);
  const explainedItems = chain.items.filter((i) => i.explained);

  /**
   * After a change the view is rebuilt: keyboard and screen reader focus goes back to the section heading.
   * @param {string} done
   */
  const changed = async (done) => {
    o.toast(done);
    await o.onChange();
    const target = document.getElementById(HEADING_ID);
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
  };

  /** @param {Reading} r */
  const neighbour = (r) => {
    const { who, when } = whoAndWhen(r, o);
    return h('div', { class: 'sub', text: K.neighbour(K.source[r.source], r.km, who, when) });
  };

  /**
   * @param {Reading} r
   * @param {string} text
   */
  const editLink = (r, text) =>
    o.isAdmin || r.userId === o.meId ? linkButton({ label: text, href: `${o.hrefBase}#/${r.source === 'fuel' ? 'fuel' : 'usage'}?edit=${r.id}`, small: true }) : null;

  /** @param {Item} item */
  const explainForm = (item) => {
    const note = h('input', { type: 'text', maxlength: '500', autocomplete: 'off' });
    const f = field(K.explainLabel, note, K.explainHint);
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const save = button({ label: K.explainSave, small: true, variant: 'primary', type: 'submit' });
    return h(
      'form',
      {
        novalidate: true,
        onsubmit: async (/** @type {Event} */ e) => {
          e.preventDefault();
          f.setError(null);
          error.hidden = true;
          // The reason is the point of an explanation: nothing is sent without one.
          if (note.value.trim() === '') {
            f.setError('required');
            note.focus();
            return;
          }
          save.disabled = true;
          try {
            await post('/api/odometer/explain', { key: item.key, note: note.value.trim() });
            await changed(K.explainSaved);
          } catch (err) {
            const apiErr = /** @type {import('./api.js').ApiError} */ (err);
            showFieldErrors({ note: f, key: f }, apiErr);
            error.textContent = errorText(apiErr);
            error.hidden = false;
            save.disabled = false;
          }
        },
      },
      [f.row, error, h('div', { class: 'actions' }, [save])],
    );
  };

  /**
   * Taking an explanation back tells nobody anything, so it needs no question: the finding is open again at once and the
   * toast offers "Ongedaan maken" for a few seconds (public/undo.js); the DELETE goes out after that.
   * @param {number} id the explanation to remove
   */
  const removeButton = (id) =>
    button({
      label: K.removeExplanation,
      small: true,
      onclick: () => {
        deferDelete({
          key: `explanation:${id}`,
          message: S.undo.explanation,
          commit: (opts) => del(`/api/odometer/explained/${id}`, opts),
          onUndo: () => void o.onChange(),
          onError: (err) => {
            o.toast(errorText(/** @type {Error} */ (err)), true);
            void o.onChange();
          },
          toast: o.toast,
        });
        return o.onChange();
      },
    });

  /** @param {Item} item */
  const itemRow = (item) => {
    const { prev, next, explained } = item;
    const from = fmtWhen(prev.at, o.tz);
    const to = fmtWhen(next.at, o.tz);
    const prevIsDraft = prev.source === 'draft-start';
    const fix =
      item.kind !== 'gap'
        ? null
        : prevIsDraft
          ? editLink(prev, K.finishDrive)
          : linkButton({ label: K.addMissing, href: `${o.hrefBase}#/usage?gap=${encodeURIComponent(item.key)}`, small: true, variant: 'primary' });
    // An open finding is resolved by adding the drive or correcting a reading; an explained one only offers to take the note back.
    const actions = explained ? [item.can.unexplain ? removeButton(explained.id) : null] : [fix, editLink(prev, K.editEarlier), editLink(next, K.editLater)];
    return h('li', { class: `km-item ${item.kind}` }, [
      h('strong', { class: 'km-headline', text: item.kind === 'gap' ? K.gap(item.km, from, to) : K.mismatch(item.km, from, to) }),
      neighbour(prev),
      neighbour(next),
      prevIsDraft ? h('div', { class: 'hint', text: K.draftHint }) : null,
      explained
        ? h('div', {}, [
            h('div', { class: 'note', text: explained.note }),
            h('div', { class: 'sub', text: K.explainedBy(explained.byId === o.meId ? S.me : explained.byName) }),
          ])
        : null,
      h('div', { class: 'actions' }, actions),
      !explained && item.can.explain ? h('details', { class: 'km-explain' }, [h('summary', { text: K.explainSummary }), explainForm(item)]) : null,
    ]);
  };

  const shown = open.slice(0, OPEN_SHOWN);
  const folded = open.slice(OPEN_SHOWN);
  const heading = h(o.heading ?? 'h3', { id: HEADING_ID, tabindex: '-1', text: K.title });
  return h('section', { class: 'card km-check', 'aria-labelledby': HEADING_ID }, [
    heading,
    h('p', { class: 'hint', text: K.intro }),
    open.length === 0 ? h('p', { class: 'km-ok', text: K.allAddUp }) : h('ul', { class: 'km-list' }, shown.map(itemRow)),
    folded.length > 0 ? h('details', { class: 'km-more' }, [h('summary', { text: K.showMore(folded.length) }), h('ul', { class: 'km-list' }, folded.map(itemRow))]) : null,
    explainedItems.length > 0
      ? h('details', { class: 'km-more' }, [h('summary', { text: K.explainedHeading(explainedItems.length) }), h('ul', { class: 'km-list' }, explainedItems.map(itemRow))])
      : null,
  ]);
}
