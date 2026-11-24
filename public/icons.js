// One icon set for the whole app, drawn as inline SVG with createElementNS (no markup strings, no external file,
// nothing for the CSP to object to). The shapes are from Lucide (https://lucide.dev, ISC licence, lucide-static 0.468.0);
// the licence text is kept in docs/third-party.md. Every icon is a 24x24 stroke icon that takes its colour from the
// text around it (currentColor) and its size from the CSS class "icon".
//
// An icon is decoration: it is hidden from assistive technology (aria-hidden). The name of a control comes from its
// text or, for a button with only an icon, from the label that ui.iconButton() requires. There are no emoji.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** @type {Record<string, Array<[string, Record<string, string>]>>} */
const SHAPES = {
  home: [['path', { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' }], ['path', { d: 'M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  calendar: [['path', { d: 'M8 2v4' }], ['path', { d: 'M16 2v4' }], ['rect', { width: '18', height: '18', x: '3', y: '4', rx: '2' }], ['path', { d: 'M3 10h18' }], ['path', { d: 'M8 14h.01' }], ['path', { d: 'M12 14h.01' }], ['path', { d: 'M16 14h.01' }], ['path', { d: 'M8 18h.01' }], ['path', { d: 'M12 18h.01' }], ['path', { d: 'M16 18h.01' }]],
  plus: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
  car: [['path', { d: 'M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2' }], ['circle', { cx: '7', cy: '17', r: '2' }], ['path', { d: 'M9 17h6' }], ['circle', { cx: '17', cy: '17', r: '2' }]],
  more: [['circle', { cx: '12', cy: '12', r: '1' }], ['circle', { cx: '19', cy: '12', r: '1' }], ['circle', { cx: '5', cy: '12', r: '1' }]],
  inbox: [['polyline', { points: '22 12 16 12 14 15 10 15 8 12 2 12' }], ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }]],
  history: [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }], ['path', { d: 'M12 7v5l4 2' }]],
  fuel: [['line', { 'x1': '3', 'x2': '15', 'y1': '22', 'y2': '22' }], ['line', { 'x1': '4', 'x2': '14', 'y1': '9', 'y2': '9' }], ['path', { d: 'M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18' }], ['path', { d: 'M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2a2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5' }]],
  alert: [['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]],
  wrench: [['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }]],
  user: [['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }], ['circle', { cx: '12', cy: '7', r: '4' }]],
  'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
  close: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  shield: [['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }], ['path', { d: 'm9 12 2 2 4-4' }]],
  info: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 16v-4' }], ['path', { d: 'M12 8h.01' }]],
  route: [['circle', { cx: '6', cy: '19', r: '3' }], ['path', { d: 'M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15' }], ['circle', { cx: '18', cy: '5', r: '3' }]],
  sort: [['path', { d: 'm21 16-4 4-4-4' }], ['path', { d: 'M17 20V4' }], ['path', { d: 'm3 8 4-4 4 4' }], ['path', { d: 'M7 4v16' }]],
  'sort-up': [['path', { d: 'm5 12 7-7 7 7' }], ['path', { d: 'M12 19V5' }]],
  'sort-down': [['path', { d: 'M12 5v14' }], ['path', { d: 'm19 12-7 7-7-7' }]],
  'check-circle': [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm9 12 2 2 4-4' }]],
  'alert-circle': [['circle', { cx: '12', cy: '12', r: '10' }], ['line', { 'x1': '12', 'x2': '12', 'y1': '8', 'y2': '12' }], ['line', { 'x1': '12', 'x2': '12.01', 'y1': '16', 'y2': '16' }]],
};

/** The names that exist, for a test that every icon a view asks for is drawn. */
export const ICON_NAMES = Object.keys(SHAPES);

/**
 * @param {string} name one of ICON_NAMES
 * @param {string} [extraClass] added to the "icon" class
 * @returns {SVGElement}
 */
export function icon(name, extraClass) {
  const shapes = SHAPES[name];
  if (!shapes) throw new Error(`unknown icon "${name}"`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', extraClass ? `icon ${extraClass}` : 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.appendChild(shape);
  }
  return /** @type {SVGElement} */ (svg);
}
