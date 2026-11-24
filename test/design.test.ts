// The rules of docs/DESIGN.md that can be checked without a browser: one token set with identical dark blocks,
// contrast computed from the real CSS in both themes, the generated-UI tells absent, one reduced-motion block,
// safe areas, Dutch hyphenation, the rail and the grids. (Layout itself is measured in a real browser: see the run log.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const publicDir = path.join(import.meta.dirname, '..', 'public');
const read = (file: string) => fs.readFileSync(path.join(publicDir, file), 'utf8');
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]));

const rawCss = read('style.css');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

function tokens(block: string): Map<string, string> {
  return new Map([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] as string, (m[2] as string).trim()]));
}
const light = tokens(/(?:^|\})\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '');
const darkMedia = tokens(/prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? '');
const darkChosen = tokens(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '');

// ------------------------------------------------------------------ tokens

test('tokens: the colour roles of the light theme exist, and the dark theme redefines the same colours twice, identically', () => {
  assert.ok(light.size > 30, `found ${light.size} light tokens`);
  for (const t of ['--bg', '--surface', '--surface-2', '--text', '--muted', '--border', '--field-border', '--primary', '--on-primary', '--accent', '--on-accent', '--danger', '--on-danger', '--focus', '--ok-bg', '--ok-text', '--warn-bg', '--warn-text', '--bad-bg', '--bad-text', '--off-bg', '--off-text']) {
    assert.ok(light.has(t), `light: ${t}`);
    assert.ok(darkMedia.has(t), `dark (phone setting): ${t}`);
  }
  assert.deepEqual([...darkMedia].sort(), [...darkChosen].sort(), 'Donker chosen by hand is the same as Donker chosen by the phone');
  assert.deepEqual([...darkMedia.keys()].filter((t) => !light.has(t)), [], 'dark only redefines tokens that light has');
});

test('tokens: every var(--x) of the sheet is defined, and the scales exist (type, space, radius, elevation, motion)', () => {
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] as string));
  assert.deepEqual([...used].filter((t) => !light.has(t)), [], 'used but never defined');
  for (const family of ['--fs-', '--s-', '--r-', '--shadow-', '--dur-', '--ease', '--tap', '--font']) {
    assert.ok([...light.keys()].some((t) => t.startsWith(family)), `no ${family} token`);
  }
  assert.deepEqual([...light.keys()].filter((t) => t.startsWith('--shadow-')).sort(), ['--shadow-sheet', '--shadow-toast'], 'only what floats over the page has a shadow');
});

// ------------------------------------------------------------------ contrast

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function ratio(a: string, b: string): number {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_PAIRS: Array<[string, string]> = [
  ['--text', '--bg'], ['--text', '--surface'], ['--text', '--surface-2'], ['--muted', '--bg'], ['--muted', '--surface'], ['--muted', '--surface-2'],
  ['--on-primary', '--primary'], ['--on-primary', '--primary-press'], ['--on-accent', '--accent'], ['--on-danger', '--danger'], ['--danger', '--surface'], ['--danger', '--bg'],
  ['--ok-text', '--ok-bg'], ['--ok-text', '--surface'], ['--warn-text', '--warn-bg'], ['--warn-text', '--surface'], ['--bad-text', '--bad-bg'], ['--bad-text', '--surface'],
  ['--off-text', '--off-bg'], ['--link', '--bg'], ['--link', '--surface'], ['--bg', '--text'],
];
const UI_PAIRS: Array<[string, string]> = [
  ['--field-border', '--surface'], ['--field-border', '--bg'], ['--focus', '--bg'], ['--focus', '--surface'], ['--focus', '--surface-2'], ['--primary', '--bg'], ['--accent-edge', '--bg'],
];

for (const [name, theme] of [['light', light], ['dark', darkMedia]] as const) {
  test(`contrast (${name}): every text pair is at least 4.5:1 and every component and focus pair at least 3:1, computed from the sheet`, () => {
    const failures: string[] = [];
    for (const [fg, bg] of TEXT_PAIRS) {
      const a = theme.get(fg) ?? light.get(fg);
      const b = theme.get(bg) ?? light.get(bg);
      assert.ok(a?.startsWith('#') && b?.startsWith('#'), `${fg} and ${bg} are plain hex colours`);
      const r = ratio(a as string, b as string);
      if (r < 4.5) failures.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
    }
    for (const [fg, bg] of UI_PAIRS) {
      const a = theme.get(fg) ?? light.get(fg);
      const b = theme.get(bg) ?? light.get(bg);
      const r = ratio(a as string, b as string);
      if (r < 3) failures.push(`${fg} against ${bg}: ${r.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('the signal yellow is never text on paper: it may only be used by the Boeken tab and the "car is out" block, always with ink on it', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] as string).trim().replace(/\s+/g, ' '), body: m[2] as string }));
  const users = rules.filter((r) => /var\(--accent\)/.test(r.body)).map((r) => r.selector);
  assert.ok(users.length >= 2);
  for (const selector of users) assert.match(selector, /tab-book|car-now/, `${selector} uses the signal colour`);
  for (const r of rules.filter((x) => /var\(--accent\)/.test(x.body))) assert.match(r.body, /var\(--on-accent\)|background:\s*var\(--accent\)/, 'ink on yellow');
  assert.ok(ratio(light.get('--accent') as string, light.get('--bg') as string) < 3, 'it IS too pale for text on paper (that is why it has an outline)');
  assert.ok(ratio(light.get('--accent-edge') as string, light.get('--bg') as string) >= 3, 'the outline is what makes the button visible in light');
});

// ------------------------------------------------------------------ interaction states

/** The declarations of every rule whose selector is exactly this one (spaces collapsed). */
function bodyOf(selector: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] as string).trim().replace(/\s+/g, ' ') === selector)
    .map((m) => m[2] as string)
    .join('');
}

test('states: the primary button is ink on paper, so hovering and pressing it needs a colour of its own, in both themes', () => {
  for (const [name, theme] of [['light', light], ['dark', darkMedia]] as const) {
    assert.ok(theme.get('--primary-press'), `${name} defines --primary-press`);
    assert.notEqual(theme.get('--primary-press'), theme.get('--primary'), `${name}: the press colour differs from the rest colour`);
  }
  for (const state of ['hover', 'active']) {
    const body = bodyOf(`.btn.primary:${state}:not(:disabled)`);
    assert.match(body, /background:\s*var\(--primary-press\)/, `${state} changes the background`);
  }
  assert.doesNotMatch(css, /\.btn\.primary:(?:hover|active):not\(:disabled\)\s*\{[^}]*background:\s*var\(--text\)/, '--text is the same colour as --primary: no change at all');
});

test('focus: a ring inside a box that clips is drawn inside the edge, and no ring is yellow on yellow', () => {
  // A list and a switcher clip their contents (overflow: hidden): a ring outside the row or the segment would be cut off.
  for (const selector of ['.list', '.segmented']) assert.match(bodyOf(selector), /overflow:\s*hidden/, `${selector} clips`);
  assert.match(bodyOf('.list-row:focus-visible'), /outline-offset:\s*-\d+px/);
  assert.match(bodyOf('.segmented .btn.seg:focus-visible'), /outline-offset:\s*-\d+px/);
  // The pressed segment is filled with the primary colour: an inset ring of the focus colour would be ink on ink.
  assert.match(bodyOf(".segmented .btn.seg[aria-pressed='true']:focus-visible"), /outline-color:\s*var\(--on-primary\)/);
  // In Donker the focus colour IS the signal yellow, so on the yellow block and the yellow rail button the ring is ink.
  assert.equal(darkMedia.get('--focus'), darkMedia.get('--accent'), 'the reason for the two rules below');
  assert.match(bodyOf('.car-now.out :focus-visible'), /outline-color:\s*var\(--on-accent\)/);
  assert.match(bodyOf(".tab-book:not([aria-current='page']):focus-visible"), /outline-color:\s*var\(--on-accent\)/);
});

test('the toast: once it has faded out its button is out of the tab order and out of the accessibility tree', () => {
  assert.match(bodyOf('.toast:not(.show) .toast-action'), /visibility:\s*hidden/);
  assert.match(bodyOf('.toast'), /opacity:\s*0/, 'it is hidden by opacity, which alone leaves a button focusable');
});

// ------------------------------------------------------------------ the tells

test('generated-UI tells are absent from the sheet: no gradients, blur, glass, filters or stray shadows', () => {
  assert.doesNotMatch(css, /gradient\(/);
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.doesNotMatch(css, /blur\(/);
  assert.doesNotMatch(css, /(?:^|[;{\s])filter\s*:/);
  const shadows = [...css.matchAll(/box-shadow\s*:\s*([^;]+);/g)].map((m) => (m[1] as string).trim());
  const allowed = [/^var\(--shadow-(sheet|toast)\)$/, /^inset 0 0 0 1px var\(--danger\)$/, /^inset 0 3px 0 var\(--primary\)$/, /^none$/];
  assert.deepEqual(shadows.filter((s) => !allowed.some((re) => re.test(s))), [], 'a box-shadow that is not the sheet, the toast or an inset marker');
});

test('no emoji anywhere in the client code, the pages or the styles (the icons are one SVG set)', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
  const found = walk(publicDir)
    .filter((f) => /\.(js|css|html|webmanifest)$/.test(f))
    .filter((f) => emoji.test(read(f)));
  assert.deepEqual(found, []);
});

test('pills are for counts only: --r-pill is used by badges and counts, not by buttons, cards or status chips', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] as string).trim().replace(/\s+/g, ' '), body: m[2] as string }));
  const users = rules.filter((r) => /var\(--r-pill\)/.test(r.body)).map((r) => r.selector);
  assert.deepEqual(users.sort(), ['.badge', '.cal-count'].sort());
});

// ------------------------------------------------------------------ motion, safe areas, language

test('one prefers-reduced-motion block switches every animation and transition off', () => {
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{/g)];
  assert.equal(blocks.length, 1, 'exactly one block');
  const block = css.slice(blocks[0]?.index ?? 0);
  assert.match(block, /\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation:\s*none\s*!important;[^}]*transition:\s*none\s*!important;/);
  // Every animation the sheet uses is a named keyframe or a transition that this block covers.
  assert.ok([...css.matchAll(/@keyframes\s+([\w-]+)/g)].length >= 2);
});

test('safe areas: the top bar, the tab bar, the view, the sheet footer and the login keep clear of notches and the home indicator', () => {
  for (const side of ['top', 'right', 'bottom', 'left']) assert.match(css, new RegExp(`env\\(safe-area-inset-${side}\\)`), side);
  const tabs = /\.tabs\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(tabs, /safe-area-inset-bottom/);
  assert.match(/\.sheet-foot\s*\{([^}]*)\}/.exec(css)?.[1] ?? '', /safe-area-inset-bottom/);
  assert.match(read('index.html'), /viewport-fit=cover/);
});

test('Dutch: the page is lang="nl", running text hyphenates and labels, buttons and navigation never do', () => {
  assert.match(read('index.html'), /<html lang="nl">/);
  assert.match(read('admin/index.html'), /<html lang="nl">/);
  const auto = /([^{}]*)\{[^{}]*hyphens:\s*auto/.exec(css)?.[1] ?? '';
  for (const s of ['p', '.note', '.sub', '.hint']) assert.ok(auto.includes(s), `${s} hyphenates`);
  for (const selector of ['.btn', '.tab-label', 'h1,', '.row-title']) {
    const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => (m[1] as string).includes(selector) && /hyphens:\s*manual/.test(m[2] as string));
    assert.ok(rule, `${selector} never hyphenates`);
  }
});

// ------------------------------------------------------------------ layouts

test('layouts: a rail from 768 px, two and three columns for Start, a list beside its form from 1024 px, Meer hidden in the rail', () => {
  assert.match(css, /@media \(min-width: 48rem\)\s*\{[\s\S]*?\.shell\s*\{[^}]*grid-template-columns:\s*var\(--rail-w\) minmax\(0, 1fr\)/);
  assert.match(css, /@media \(min-width: 48rem\)[\s\S]*?\.tab-more\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(min-width: 48rem\)[\s\S]*?\.tab-secondary\s*\{\s*display:\s*flex/);
  assert.match(css, /@media \(min-width: 48rem\)[\s\S]*?\.home\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(min-width: 80rem\)\s*\{\s*\.home\s*\{\s*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(min-width: 64rem\)[\s\S]*?\.split\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  // The phone bar has five columns: four places and the raised Boeken.
  assert.match(/\.tabs\s*\{([^}]*)\}/.exec(css)?.[1] ?? '', /grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
});

test('the manifest no longer locks the orientation, and its colours are the paper of the sheet', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.orientation, undefined, 'a tablet app must be allowed to be wide');
  assert.equal(manifest.theme_color, light.get('--bg'));
  assert.equal(manifest.background_color, light.get('--bg'));
});

test('a dialog is a native <dialog> (no hand-made overlay, no role=dialog on a div)', () => {
  const ui = read('ui.js');
  assert.match(ui, /h\('dialog'/);
  assert.match(ui, /showModal\(\)/);
  assert.doesNotMatch(ui, /role:\s*'dialog'/);
  assert.doesNotMatch(rawCss, /\.overlay|\.modal\b/);
});

// ------------------------------------------------------------------ what the documents promise

const docsDir = path.join(import.meta.dirname, '..', 'docs');
// The documents are read with LF endings: a Windows checkout (core.autocrlf) turns them into CRLF, and the section regexes below match on LF.
const readDoc = (file: string) => fs.readFileSync(path.join(docsDir, file), 'utf8').replace(/\r\n/g, '\n');
const designDoc = readDoc('DESIGN.md');

test('docs/DESIGN.md names every generated-UI tell, says how it is kept out, and the evidence it points at exists', () => {
  const section = /## Generated-UI tells\n([\s\S]*?)\n## /.exec(designDoc)?.[1] ?? '';
  const rows = section.split('\n').filter((line) => line.startsWith('|') && !/^\|\s*(Tell|-+)/.test(line));
  const tells = rows.map((row) => (row.split('|')[1] ?? '').trim().toLowerCase());
  // The ten that make an interface look generated (the first nine are the usual list, the tenth is this app's own risk: yellow everywhere).
  const required = ['gradient', 'glassmorphism', 'soft-shadow card', 'emoji', 'centred hero', 'blobs', 'pill overload', 'gratuitous animation', 'filler copy', 'accent colour'];
  for (const tell of required) assert.ok(tells.some((t) => t.includes(tell)), `DESIGN.md has no row for "${tell}"`);
  assert.equal(rows.length, required.length, 'a tell was added or dropped without this list following');
  for (const row of rows) {
    const [, , inApp, evidence] = row.split('|').map((cell) => cell.trim());
    assert.ok((inApp ?? '') !== '' && (evidence ?? '').length > 10, `a tell without an answer or without evidence: ${row.slice(0, 60)}`);
  }
  // The test files the table names are real files (a rename must not leave the document pointing at nothing).
  const named = new Set([...section.matchAll(/`([\w-]+\.test\.ts)`/g)].map((m) => m[1]));
  assert.ok(named.size >= 3, 'the table names its evidence');
  for (const file of named) assert.ok(fs.existsSync(path.join(import.meta.dirname, file as string)), `${file} is named in DESIGN.md but does not exist`);
});

test('docs/third-party.md keeps the licence of the icons and counts the icons that are really in the code', async () => {
  const doc = readDoc('third-party.md');
  const { ICON_NAMES } = await import('../public/icons.js');
  assert.match(doc, /Lucide/);
  assert.match(doc, /ISC License/);
  assert.match(doc, /Permission to use, copy, modify, and\/or distribute this software for any/, 'the licence text itself is kept, not only its name');
  assert.match(doc, new RegExp(`path data of the ${ICON_NAMES.length} icons in use`), `the document says how many icons were copied: ${ICON_NAMES.length}`);
  assert.match(read('icons.js'), /third-party\.md/, 'the code points at the licence');
  assert.match(designDoc, /third-party\.md/, 'DESIGN.md points at the licence');
});

test('no font is fetched: the style sheet and the pages ask for no external file, and the document says the stack is the system one', () => {
  for (const file of ['style.css', 'index.html', 'admin/index.html']) {
    const text = read(file);
    assert.doesNotMatch(text, /@import|@font-face|fonts\.googleapis|fonts\.gstatic|cdn\./i, `${file} loads something from outside`);
    assert.doesNotMatch(text, /(?:src|href)=["']https?:\/\//i, `${file} points at another site`);
    assert.doesNotMatch(text, /url\(\s*["']?https?:/i, `${file} has a remote url()`);
  }
  assert.match(css, /font-family:\s*var\(--font\)|--font:\s*system-ui/, 'the stack is a custom property that starts at system-ui');
  assert.match(readDoc('third-party.md'), /## Fonts\s+None\./);
  const fontFiles = walk(publicDir).filter((f) => /\.(woff2?|ttf|otf|eot)$/i.test(f));
  assert.deepEqual(fontFiles, [], 'a font file appeared without its licence in docs/third-party.md');
});
