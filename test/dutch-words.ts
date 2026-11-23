// Helpers of the Dutch guard (test/dutch.test.ts): the English words the app used to say, the few of them that are
// also Dutch (with the reason), and a small reader of string literals in source files. This file is not a test.
//
// FORMER_ENGLISH was generated once from the user-visible strings of the English version (commit 30130fc:
// public/strings.js, src/notify-texts.ts and src/payments.ts), lower-cased. A word that is still in a Dutch text is
// either a missed translation or a word that is the same in Dutch, and then it is listed in ALSO_DUTCH with the reason.
import ts from 'typescript';

export const FORMER_ENGLISH: ReadonlySet<string> = new Set(
  `
    about above accept accepted account accounts actions active add added address admin admins after again
    against agenda ago ahead all allow allowed already amount an and android another answer answered any anyone
    anything apk app appear approve approved approves are aren't as ask asked at attempts automatically back
    backup backups bank be bearer becomes been before belongs ben between blocked both browser but button by can
    cancel cancelled cancels cannot car caused change changed changes changing characters check checked choice
    choose chrome close come comes coming conclusion config confirmed connection contain contradict copied copy
    correct corrected cost costs could count counted counts create created current cutoff daily damage dash
    dashboard dashed data date dated day days deactivate deactivated decline declined declines delete deleted
    deleting demoted dent depends description device devices did different disable disabled disabling display do
    does door dot down draft drive driven driver drives driving drove due during each earlier edit edited
    editing else elsewhere empty enable enabled enabling end ended ends enter entered enters equally eur every
    everybody everyone everything everywhere example exists expired expires expiry explained explanation
    explanations failed falls few fields file files fill finish finished first flagged for forget form format
    fri from front fuel fuelled future gap garage gave generate get gets gone had happened has have help helps
    here hi higher highlighted history home hour household how http https if in inbox includes incorrect
    information inside inspection install installed interior into invalid ios ipad iphone is it item its js kb
    keep keeps kept key kilometre kilometres km know known knows large last later least leave left less letter
    letters lie link linked list litre litres loading local log logged long longer lower lowercase made make
    many mark marked match me means meantime mechanical member menu message mine minus minutes mismatch missing
    mistake moment mon money month months more much must name need needs never new newest next no nobody not
    note nothing noticed notification notifications notified now number numbers odometer of off offence older
    oldest on once one only open optional or order other others otherwise out outline outside outsider overlaps
    owe owed owes own paid password paste pay payment payments pays per period permanently person phone pick
    place please plus positive post press previous price privately probably progress pump purge purged push
    ratio reach reactivate read reading readings reads ready rear reason receive recent recommended record
    refresh register registered registers reminder reminders remove removed removes rename reopen reopened
    repair repaired repairing report reported reports request requested requests required reservation
    reservations reserve reserved reset restored retention right role roof rotate run runs safari same sat save
    saved saving say says screen see seen select send sends sent server service session sessions set settings
    settled share shared short should show showing shown shows side sign signed since size small so somebody
    something soon speeding split start started starting starts station status still stops stored stretch such
    suggested suggestion suggestions suggests sun supported switched tab taken tap test text than thanks that
    the their them then these they third this thu ticket tickets tikkie time times tip to today together told
    tomorrow too took total traffic trip try ts tue turn turned two typo tyres unaccounted underscore undo
    undone unfinished unknown unpaid unregistered until up update updated updates ups use used user username
    users valid view visible wait waiting was wed week went were what whatsapp wheels when where which while who
    whole whom whose why will window windows with withdraw withdrawn withdraws withdrew without work worked
    would wrong wrote year years yesterday yet you your yours yourself zone
`
    .trim()
    .split(/\s+/),
);

/**
 * English words that must never show up in a Dutch text, whatever the old texts said: function words, and the
 * unit words of the old formatting. Words that are also Dutch are not here (is, of, in, was, over, even, ten).
 */
export const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set(
  `the and you your yours with for not are were this that from have has will would can could should please
  hi thanks yes eur euro kilometre kilometres litre litres minutes months month hours hour days day weeks week
  today tomorrow yesterday ago ahead back later earlier next previous
  u uw`
    .trim()
    .split(/\s+/),
);

const NAME = 'A name or a loanword the Dutch interface keeps as it is (see docs/GLOSSARY.md)';
const LOANWORD = 'A Dutch loanword listed in the Dutch dictionary (Van Dale): browser, dashboard, server, station, garage';
const BACKUP = 'Part of the Dutch loanword back-up (back-ups)';
const SAME_WITH_EXAMPLES ='The same word in Dutch with the same meaning: later, letters, log (of inloggen)';
const SAME = 'The same word in Dutch with the same meaning';

/**
 * Former English words that are also fine Dutch (or are names and loanwords the Dutch app keeps), each with the reason.
 * test/dutch.test.ts checks that no entry is stale: every word is in FORMER_ENGLISH and is used in a Dutch text.
 */
export const ALSO_DUTCH: Readonly<Record<string, string>> = {
  admin: NAME,
  admins: NAME,
  agenda: NAME,
  account: NAME,
  accounts: NAME,
  apk: NAME,
  app: NAME,
  android: NAME,
  ios: NAME,
  ipad: NAME,
  iphone: NAME,
  chrome: NAME,
  safari: NAME,
  tikkie: NAME,
  whatsapp: NAME,
  inbox: NAME,
  km: NAME,
  kb: NAME,
  https: 'A technical token of an address, not a sentence word',
  browser: LOANWORD,
  dashboard: LOANWORD,
  server: LOANWORD,
  station: LOANWORD,
  garage: LOANWORD,
  back: BACKUP,
  up: BACKUP,
  ups: BACKUP,
  later: SAME_WITH_EXAMPLES,
  letters: SAME_WITH_EXAMPLES,
  log: SAME_WITH_EXAMPLES,
  do: 'Abbreviation of donderdag in the weekday heading',
  ben: 'A first name used in examples, and also the Dutch verb ben (am)',
  in: SAME,
  is: SAME,
  of: SAME,
  was: SAME,
  had: SAME,
  door: SAME,
  start: SAME,
  tip: SAME,
  plus: SAME,
  per: SAME,
  moment: SAME,
  status: SAME,
  item: SAME,
  open: SAME,
  link: SAME,
  menu: SAME,
  week: SAME,
  bank: SAME,
};

/** Words of a text, lower-cased, without a trailing 's (Dutch writes auto's). */
export function wordsOf(text: string): string[] {
  return (text.match(/\p{L}+(?:'\p{L}+)?/gu) ?? []).map((w) => w.toLowerCase().replace(/'s$/, ''));
}

/** The English words in a text: former English words and function words, minus the reviewed Dutch ones. */
export function englishHits(text: string): string[] {
  const hits: string[] = [];
  for (const word of wordsOf(text)) {
    if (Object.hasOwn(ALSO_DUTCH, word)) continue;
    if (FORMER_ENGLISH.has(word) || ENGLISH_FUNCTION_WORDS.has(word)) hits.push(word);
  }
  return [...new Set(hits)];
}

export interface Literal {
  text: string;
  line: number;
  /** A property name such as { 'drive-start': ... }: code, not text. */
  isKey: boolean;
  /** The kind of node it was found in. */
  kind: 'string' | 'template';
}

/** Every string and template literal of a source file (JavaScript or TypeScript), with its line. Uses the parser only. */
export function literals(source: string, fileName: string): Literal[] {
  const kind = fileName.endsWith('.js') || fileName.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found: Literal[] = [];
  const visit = (node: ts.Node): void => {
    const k = node.kind;
    const isString = k === ts.SyntaxKind.StringLiteral;
    const isTemplate =
      k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || k === ts.SyntaxKind.TemplateHead || k === ts.SyntaxKind.TemplateMiddle || k === ts.SyntaxKind.TemplateTail;
    if (isString || isTemplate) {
      const parent = node.parent;
      // 'import x from "../shared/format.js"' and 'export ... from': a path, not text.
      if (isString && parent !== undefined && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) {
        ts.forEachChild(node, visit);
        return;
      }
      const isKey = isString && parent !== undefined && (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node;
      const text = (node as ts.StringLiteral).text;
      found.push({ text, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, isKey, kind: isString ? 'string' : 'template' });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * A literal that is probably text for a person and not a code such as 'owner', 'wheels_tyres' or a path such as
 * '/views/fuel.js': it has a space, a capital first letter, an ellipsis or sentence punctuation (a full stop only at
 * the end of a sentence, not in a file name).
 */
export function isTextBearing(text: string): boolean {
  return /\s/.test(text) || /^[A-Z][a-z]/.test(text) || /[:,!?…]/.test(text) || /\p{L}\.(\s|$)/u.test(text);
}
