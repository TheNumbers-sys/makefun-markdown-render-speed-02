// A fast, dependency-free drop-in for marked 18.1.3 (default options:
// gfm on, breaks off, pedantic off, async off). parse(markdown) returns
// exactly the HTML marked.parse(markdown) returns, for every string.
//
// Written from scratch for the make.fun markdown-render-speed-02 bounty.
// The behaviour follows the CommonMark 0.31.2 + GFM 0.29 specs as marked
// implements them; where marked departs from the specs, marked wins.
//
// Architecture: a block lexer turns the source into block tokens (each
// paragraph-like token queues its text for inline lexing), an inline
// lexer turns each queued text into inline tokens, and a renderer turns
// the token trees into HTML. Inline lexing is deferred until all block
// lexing is done, so link reference definitions anywhere in the document
// are known when any paragraph is parsed inline.

// ---------------------------------------------------------------------------
// Small building blocks for the patterns below.
// ---------------------------------------------------------------------------

// Block-level HTML tag names (CommonMark HTML blocks, type 6).
const TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// How a line may start an HTML block (used inside interruption lookaheads).
const HTML_START = `<\\/?(?:${TAG_LIST})(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[`;

// A thematic break, an ATX heading, a blockquote marker, a fence, a list
// marker or an HTML block start -- the things that stop a lazy line or a
// paragraph continuation. Two flavours: the blockquote flavour accepts any
// list marker, the paragraph flavour only unordered markers and ordered
// markers starting with "1".
const HR_PART = '(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,}';
const ATX_PART = '#{1,6}(?:\\s|$)';
const FENCE_PART = '(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const STOP_BQ = ` {0,3}(?:${HR_PART})(?:\\n+|$)| {0,3}${ATX_PART}| {0,3}>| {0,3}${FENCE_PART}| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)| {0,3}(?:${HTML_START})|[ \\t]+\\n`;
const STOP_PARA = ` {0,3}(?:${HR_PART})(?:\\n+|$)| {0,3}${ATX_PART}| {0,3}>| {0,3}${FENCE_PART}| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]| {0,3}(?:${HTML_START})`;
// The things that stop a table body row.
const STOP_ROW = ` {0,3}(?:${HR_PART})(?:\\n+|$)| {0,3}${ATX_PART}| {0,3}>|(?: {4}| {0,3}\\t)[^\\n]| {0,3}${FENCE_PART}| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:${HTML_START})`;
// A table delimiter row (header separator), without its leading/trailing pipes.
const TABLE_DELIM = '(?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?';

// ---------------------------------------------------------------------------
// Block patterns (GFM).
// ---------------------------------------------------------------------------

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: new RegExp(`^ {0,3}((?:${HR_PART}))(?:\\n+|$)`),
  blockquote: new RegExp(
    `^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?!${STOP_BQ})[^\\n]+)*))|[^\\n]*)(?:\\n|$))+`),
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: new RegExp(
    `^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)` +
    `|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)` +
    `|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)` +
    `|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)` +
    `|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)` +
    `|<\\/?(${TAG_LIST})(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)` +
    `|<(?!((?:script|pre|style|textarea)(?![a-z0-9-])))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *'[^'\\n]*'| *= *[^\\s"'=<>\\\`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)` +
    `|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))`, 'i'),
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  table: new RegExp(
    `^ *([^\\n ].*)\\n {0,3}(${TABLE_DELIM})(?:\\n((?:(?! *\\n|${STOP_ROW}).*(?:\\n|$))*)\\n*|$)`),
  lheading: new RegExp(
    `^(?! {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:\`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)` +
    `((?:.|\\n(?!\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:\`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}(?:${HR_PART})(?:\\n+|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)`),
  paragraph: new RegExp(
    `^([^\\n]+(?:\\n(?!${STOP_PARA}| *([^\\n ].*)\\n {0,3}(${TABLE_DELIM})(?:\\n((?:(?! *\\n|${STOP_ROW}).*(?:\\n|$))*)\\n*|$)|[ \\t]+\\n)[^\\n]+)*)`),
  text: /^[^\n]+/,
};

// ---------------------------------------------------------------------------
// Inline patterns (GFM).
// ---------------------------------------------------------------------------

// A link label: nested brackets (two levels), backslash escapes, complete
// code spans, double backticks before a closing bracket, or any character
// except '[', ']', '\' and '`'. A lone backtick never belongs to a label.
const LABEL = '(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
// A link reference: non-empty, no unescaped ']', may span lines but never
// across a blank line.
const REF = `((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)`;
const EMAIL = `[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])`;

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: new RegExp(
    `^!?\\[(${LABEL})\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)`),
  reflink: new RegExp(`^!?\\[(${LABEL})\\]\\[${REF}\\]`),
  nolink: new RegExp(`^!?\\[${REF}\\](?:\\[\\])?`),
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  url: new RegExp(
    `^(?:mailto:${EMAIL}|xmpp:${EMAIL}(?:\\/[A-Za-z0-9@.]+)?)` +
    `|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*` +
    `|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])`),
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  reflinkSearch: new RegExp("!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()", "g"),
};

// ---------------------------------------------------------------------------
// Assorted small patterns.
// ---------------------------------------------------------------------------

const OTHER = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  setextUnderline: /\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericRef: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericRefOrAmp: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

// Does `src` start with 0-3 spaces followed by one of `chars`? The
// block patterns all allow that much leading indent before their marker,
// so this is a cheap necessary condition for them to match at all.
function startsBlock(src, chars) {
  let i = 0;
  while (i < 3 && src[i] === ' ') i++;
  return chars.indexOf(src[i]) !== -1;
}
// these through a helper that clamps the indent to 0..3 (after subtracting
// one): a nested bullet indented by the item's own content width is NOT a
// new bullet at this level -- that is what makes sublists nest instead of
// flattening. The cache is keyed by the clamped value, as in marked.
const _rxCache = new Map();
function _cached(key, make) {
  let r = _rxCache.get(key);
  if (!r) { r = make(); _rxCache.set(key, r); }
  return r;
}
const _clampIndent = (n) => Math.max(0, Math.min(3, n - 1));
const listItemRegex = (marker) => _cached('li:' + marker,
  () => new RegExp(`^( {0,3}${marker})((?:[\t ][^\\n]*)?(?:\\n|$))`));
const nextBulletRegex = (n) => _cached('nb:' + _clampIndent(n),
  () => new RegExp(`^ {0,${_clampIndent(n)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRegex = (n) => _cached('hr:' + _clampIndent(n),
  () => new RegExp(`^ {0,${_clampIndent(n)}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = (n) => _cached('fe:' + _clampIndent(n),
  () => new RegExp(`^ {0,${_clampIndent(n)}}(?:\\\`\\\`\\\`|~~~)`));
const headingBeginRegex = (n) => _cached('he:' + _clampIndent(n),
  () => new RegExp(`^ {0,${_clampIndent(n)}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = (n) => _cached('ht:' + _clampIndent(n),
  () => new RegExp(`^ {0,${_clampIndent(n)}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = (n) => _cached('bq:' + _clampIndent(n),
  () => new RegExp(`^ {0,${_clampIndent(n)}}>`));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _escChar = (c) => HTML_ESCAPES[c];
// Escape HTML special characters. When `encodeAll` is set, every '&' is
// escaped; otherwise an '&' that already starts a valid character
// reference is left alone.
function escHtml(s, encodeAll) {
  if (encodeAll) {
    return OTHER.escapeTest.test(s) ? s.replace(OTHER.escapeReplace, _escChar) : s;
  }
  return OTHER.escapeTestNoEncode.test(s) ? s.replace(OTHER.escapeReplaceNoEncode, _escChar) : s;
}
// Decode numeric character references in a text run; a bare '&' becomes
// '&amp;'. Named references are intentionally left alone (marked does not
// decode them -- they reach the browser as-is).
function decodeEntities(s) {
  if (!OTHER.numericRef.test(s)) return s;
  return s.replace(OTHER.numericRefOrAmp, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}
// Encode a link/image href the way encodeURI does, except a literal '%'
// stays a '%'. Returns null when the href cannot be encoded at all.
function encodeHref(href) {
  try { return encodeURI(href).replace(OTHER.percentDecode, '%'); } catch { return null; }
}
// Remove trailing `ch` characters from the end of `s` (like rstrip, but
// for one repeated character). Returns the shortened string.
function stripTrailing(s, ch) {
  let n = s.length;
  while (n > 0 && s.charAt(n - 1) === ch) n--;
  return s.slice(0, n);
}
// Find the index of the ')' that closes an unbalanced '(' run in `s`
// (parenthesis balance, backslash-aware). -1: no parens at all or balanced;
// -2: more '(' than ')'; otherwise the index of the premature ')'.
function parenBalance(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}
// Normalise a link reference label for lookup: trim, collapse inner
// whitespace to single spaces, case-fold (the lower-upper-lower round
// trip matches marked's Unicode handling).
function normalizeLabel(s) {
  return s.trim().replace(OTHER.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// Expand tabs in `s` to spaces, tracking the column starting at `col`.
function expandTabs(s, col = 0) {
  let out = '', at = col;
  for (const ch of s) {
    if (ch === '\t') { const w = 4 - (at % 4); out += ' '.repeat(w); at += w; }
    else { out += ch; at++; }
  }
  return out;
}
// Drop trailing blank lines from a block's raw text, keeping at most one
// trailing blank line's worth of shape (mirrors marked's trim of indented
// code / HTML blocks).
function trimBlankTail(raw) {
  const lines = raw.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && OTHER.blankLine.test(lines[last])) last--;
  return lines.length - last <= 2 ? raw : lines.slice(0, last + 1).join('\n');
}
// Compensate the indent of a fenced code block whose fence line itself was
// indented (e.g. inside a list item): strip that much leading space from
// every content line.
function fenceIndentCompensation(fenceRaw, text) {
  const m = fenceRaw.match(OTHER.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text.split('\n').map((line) => {
    const lead = line.match(OTHER.beginningSpace);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, indent.length));
  }).join('\n');
}
// Split a table row on unescaped pipes, trim the cells, and pad/truncate
// to `count` cells when given.
function splitTableRow(row, count) {
  const withMarks = row.replace(OTHER.findPipe, (bar, off, full) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && full[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = withMarks.split(OTHER.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(OTHER.slashPipe, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// Inline lexer.
// ---------------------------------------------------------------------------

// Build the "closer map" for a masked source: for each of '*', '_' and
// '~', the start index of the LAST delimiter run whose preceding character
// is not whitespace. emStrong/del use it as an early-exit bound: if the
// last possible closer lies before the end of the opener, there is no
// closer at all and the run is literal text.
function closerMap(masked) {
  const last = { '*': -1, _: -1 };
  let lastTilde = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') lastTilde = s; else last[r] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: masked, lastEm: last, lastDel: lastTilde };
}

// Does `label` contain a valid HTML tag or autolink whose closing '>'
// lies past the end of the label? (CommonMark: such a label can never be
// a link label.) `full` is the source at the link start, `off` the offset
// of the label inside it.
function labelHasTag(full, label, off) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const c = INLINE.code.exec(label.slice(s));
      if (c) { s += c[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = full.slice(off + s);
    const m = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// Build one link/image token from a regex match `m` and a link definition
// `{href, title}`. The label is parsed inline; a link whose label itself
// contains a link is rejected (returns undefined), which makes the caller
// fall through to plain text.
function buildLink(m, def, lexer) {
  const href = def.href;
  const title = def.title || null;
  const label = m[1].replace(OTHER.outputLinkReplace, '$1');
  const isImage = m[0].charAt(0) === '!';
  const wasInLink = lexer.state.inLink;
  const wasEmitted = lexer.state.linkEmitted;
  const wasRaw = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const inner = lexer.inlineTokens(label);
  const emittedInside = lexer.state.linkEmitted;
  lexer.state.linkEmitted = wasEmitted;
  lexer.state.inLink = wasInLink;
  if (!isImage) {
    if (emittedInside) { lexer.state.inRawBlock = wasRaw; return undefined; }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw: m[0], href, title, text: label, tokens: inner };
}

class InlineLexer {
  constructor(links) {
    this.links = links;
    this.hasLinks = false;
    this.inLink = false;
    this.inRawBlock = false;
    this.linkEmitted = false;
    this.linkParenPossible = true;
    this.maskStack = [];
  }

  get state() { return this; }

  // Mask a source for emphasis/delimiter scanning: links, code spans and
  // raw HTML are replaced by same-length filler so '*'/'_'/'~' inside
  // them can never act as delimiters. All replacements preserve length,
  // so positions in the masked source line up with the original. Each
  // step is skipped when the source cannot contain what it masks.
  maskSource(src) {
    let t = src;
    if (this.hasLinks && src.includes('[')) {
      const search = INLINE.reflinkSearch;
      const maskOne = (r) => {
        const o = r.lastIndexOf('[');
        if (!Object.hasOwn(this.links, normalizeLabel(r.slice(o + 1, -1)))) return r;
        if (o > 1 && r.charAt(0) !== '!') {
          const label = r.slice(1, o - 1);
          if (this.linkInText(label)) {
            return '[' + label.replace(search, maskOne) + '][' + 'a'.repeat(r.length - o - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(r.length - 2) + ']';
      };
      t = t.replace(search, maskOne);
    }
    if (src.includes('`') || src.includes('\\')) {
      t = t.replace(INLINE.anyPunctuationOutsideCode, (m, ticks, punct) =>
        punct ? '+'.repeat(m.length)
          : ticks ? ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
          : m);
    }
    if (src.includes('[') || src.includes('`') || src.includes('<')) {
      t = t.replace(INLINE.blockSkip, (m, a, empty) => {
        const o = empty ? empty.length : 0;
        return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
      });
    }
    return t;
  }

  // Does `src` contain a link (inline or reference)? Used while masking
  // nested reference labels.
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const r = s.lastIndexOf('[');
      if (!(s.charAt(0) === '!' || !Object.hasOwn(this.links, normalizeLabel(s.slice(r + 1, -1))))
        && !(r > 1 && this.linkInText(s.slice(1, r - 1)))) return true;
    }
    return false;
  }

  lastEmCloser(masked, delim) {
    const top = this.maskStack.at(-1);
    return top && top.maskedSrc === masked ? top.lastEm[delim] : closerMap(masked).lastEm[delim];
  }
  lastDelCloser(masked) {
    const top = this.maskStack.at(-1);
    return top && top.maskedSrc === masked ? top.lastDel : closerMap(masked).lastDel;
  }

  // Entry point: parse `src` into `tokens` (created if omitted).
  inlineTokens(src, tokens = []) {
    const saved = this.linkParenPossible;
    this.linkParenPossible = saved && src.includes(')');
    try {
      const hasDelims = src.includes('*') || src.includes('_') || src.includes('~');
      // Masking only changes the source when it can contain a link, a
      // code span, an escape or a tag; otherwise the masked source is the
      // source itself. And with no delimiters there is nothing to look
      // up a closer for, so the closer map is a constant.
      const masked = hasDelims
        && (src.includes('[') || src.includes('`') || src.includes('\\') || src.includes('<'))
        ? this.maskSource(src) : src;
      this.maskStack.push(hasDelims
        ? closerMap(masked)
        : { maskedSrc: masked, lastEm: { '*': -1, _: -1 }, lastDel: -1 });
      try { return this.scanInline(src, masked, tokens); }
      finally { this.maskStack.pop(); }
    } finally { this.linkParenPossible = saved; }
  }

  scanInline(src, masked, tokens) {
    let producedText = false;
    let prevChar = '';
    let guard = Infinity;
    while (src) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!producedText) prevChar = '';
      producedText = false;
      let tok;
      // Dispatch on the first character: every inline tokenizer is
      // anchored, and each can only match when the source starts with a
      // character from its own small set. Trying only the ones that can
      // match -- in their original order -- gives the same tokens with
      // far fewer failed regex executions. A plain letter, digit or
      // punctuation mark can only start a bare URL/email, so it goes
      // straight to the URL check and then to text.
      const ch = src[0];
      if (ch === '\\') {
        if ((tok = this.escapeTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.brTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (ch === '<') {
        if ((tok = this.tagTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.autolinkTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (ch === '[' || ch === '!') {
        if ((tok = this.linkTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.reflinkTok(src))) {
          src = src.substring(tok.raw.length);
          const last = tokens.at(-1);
          if (tok.type === 'text' && last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
          else tokens.push(tok);
          continue;
        }
      } else if (ch === '*') {
        if ((tok = this.emStrongTok(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (ch === '_') {
        if ((tok = this.emStrongTok(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if (!this.inLink && (tok = this.urlTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (ch === '`') {
        if ((tok = this.codespanTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (ch === '~') {
        if ((tok = this.delTok(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (ch === ' ') {
        if ((tok = this.brTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      } else if (!this.inLink && (tok = this.urlTok(src))) {
        src = src.substring(tok.raw.length); tokens.push(tok); continue;
      }
      if ((tok = this.textTok(src))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        producedText = true;
        const last = tokens.at(-1);
        if (last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  }

  escapeTok(src) {
    const m = INLINE.escape.exec(src);
    return m ? { type: 'escape', raw: m[0], text: m[1] } : undefined;
  }

  tagTok(src) {
    const m = INLINE.tag.exec(src);
    if (!m) return undefined;
    if (!this.inLink && OTHER.startATag.test(m[0])) this.inLink = true;
    else if (this.inLink && OTHER.endATag.test(m[0])) this.inLink = false;
    if (!this.inRawBlock && OTHER.startPreScriptTag.test(m[0])) this.inRawBlock = true;
    else if (this.inRawBlock && OTHER.endPreScriptTag.test(m[0])) this.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: this.inLink, inRawBlock: this.inRawBlock, block: false, text: m[0] };
  }

  linkTok(src) {
    if (this.linkParenPossible === false) return undefined;
    const m = INLINE.link.exec(src);
    if (!m) return undefined;
    const labelOff = m[0].charAt(0) === '!' ? 2 : 1;
    if (labelHasTag(src, m[1], labelOff)) return undefined;
    const angleSrc = m[2].trim();
    if (OTHER.startAngleBracket.test(angleSrc)) {
      if (!OTHER.endAngleBracket.test(angleSrc)) return undefined;
      const stripped = stripTrailing(angleSrc.slice(0, -1), '\\');
      if ((angleSrc.length - stripped.length) % 2 === 0) return undefined;
    } else {
      const bal = parenBalance(m[2]);
      if (bal === -2) return undefined;
      if (bal > -1) {
        const keep = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
        m[2] = m[2].substring(0, bal);
        m[0] = m[0].substring(0, keep).trim();
        m[3] = '';
      }
    }
    const strippedRaw = stripTrailing(m[0].slice(0, -1), '\\');
    if ((m[0].length - strippedRaw.length) % 2 === 0) return undefined;
    // NOTE: read m[2] again here -- the paren-balance step above may have
    // truncated it (a href that runs past its closing paren is cut back).
    let href = m[2].trim();
    let title = m[3] ? m[3].slice(1, -1) : '';
    if (OTHER.startAngleBracket.test(href)) href = href.slice(1, -1);
    return buildLink(m, {
      href: href && href.replace(INLINE.anyPunctuation, '$1'),
      title: title && title.replace(INLINE.anyPunctuation, '$1'),
    }, this);
  }

  reflinkTok(src) {
    const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (!m) return undefined;
    const labelOff = m[0].charAt(0) === '!' ? 2 : 1;
    if (labelHasTag(src, m[1], labelOff)) return undefined;
    const def = this.links[normalizeLabel(m[2] || m[1])];
    if (!def) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return buildLink(m, def, this);
  }

  // CommonMark delimiter-stack emphasis. `src` is the remaining source,
  // `masked` the masked source for this inline run, `prev` the character
  // before the current position ("" when the previous token was not text).
  emStrongTok(src, masked, prev) {
    const m = INLINE.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
    const delim = m[0][0];
    const prevIsDelim = prev === delim;
    const pos = masked.length - src.length;
    let runStart = pos;
    while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
    const beforeRun = runStart > 0
      ? [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? ''
      : '';
    const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
    if (runStart < pos) prev = beforeRun;
    const prevIsPunct = runStart < pos ? beforeIsPunct : !!INLINE.punctuation.exec(prev);
    if (m[4] && prev.match(OTHER.unicodeAlphaNumeric)) return undefined;
    const afterIsPunct = m[1] || m[3] || '';
    if (!afterIsPunct || !prev || prevIsPunct) {
      const runLen = [...m[0]].length - 1;
      let g, b, remaining = runLen, extra = 0;
      const totalRun = pos - runStart + runLen;
      const canAlsoClose = !!beforeRun.trim() && (!!afterIsPunct || (delim === '*' && !beforeIsPunct));
      if (delim !== '*' && delim !== '_') return undefined;
      const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = this.lastEmCloser(masked, delim);
      const afterOpener = pos + runLen;
      if (lastCloser < afterOpener) return undefined;
      const rest = masked.slice(-src.length + runLen);
      const maxIndex = lastCloser - afterOpener;
      let hit;
      for (closerRe.lastIndex = 0; (hit = closerRe.exec(rest)) !== null && !(hit.index > maxIndex);) {
        g = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
        if (!g) continue;
        b = [...g].length;
        if (hit[3] || hit[4]) { remaining += b; continue; }
        if (hit[5] || hit[6] || canAlsoClose) {
          if (prevIsDelim && (hit[5] || hit[6])) break;
          if (totalRun % 3 && !((totalRun + b) % 3)) { extra += b; continue; }
        }
        remaining -= b;
        if (remaining > 0) continue;
        b = Math.min(b, b + remaining + extra);
        const leadLen = [...hit[0]][0].length;
        const raw = src.slice(0, runLen + hit.index + leadLen + b);
        if (Math.min(runLen, b) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  codespanTok(src) {
    const m = INLINE.code.exec(src);
    if (!m) return undefined;
    let text = m[2].replace(OTHER.newLineCharGlobal, ' ');
    const hasNonSpace = OTHER.nonSpaceChar.test(text);
    const wrapped = text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ';
    if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  }

  brTok(src) {
    const m = INLINE.br.exec(src);
    return m ? { type: 'br', raw: m[0] } : undefined;
  }

  // GFM strikethrough: the opener and closer runs must be the same
  // length (one or two tildes); three or more tildes never delete.
  delTok(src, masked, prev) {
    const m = INLINE.delLDelim.exec(src);
    if (!m) return undefined;
    if (!(m[1] || '') || !prev || INLINE.punctuation.exec(prev)) {
      const runLen = [...m[0]].length - 1;
      let remaining = runLen;
      const lastCloser = this.lastDelCloser(masked);
      const afterOpener = masked.length - src.length + runLen;
      if (lastCloser < afterOpener) return undefined;
      const rest = masked.slice(-src.length + runLen);
      const maxIndex = lastCloser - afterOpener;
      const re = INLINE.delRDelim;
      let hit;
      for (re.lastIndex = 0; (hit = re.exec(rest)) !== null && !(hit.index > maxIndex);) {
        const g = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
        if (!g) continue;
        const len = [...g].length;
        if (len !== runLen) continue;
        if (hit[3] || hit[4]) { remaining += len; continue; }
        remaining -= len;
        if (remaining > 0) continue;
        const use = Math.min(len, len + remaining);
        const leadLen = [...hit[0]][0].length;
        const raw = src.slice(0, runLen + hit.index + leadLen + use);
        const inner = raw.slice(runLen, -runLen);
        return { type: 'del', raw, text: inner, tokens: this.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  autolinkTok(src) {
    const m = INLINE.autolink.exec(src);
    if (!m) return undefined;
    let text, href;
    if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
    else { text = m[1]; href = text; }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  urlTok(src) {
    const m = INLINE.url.exec(src);
    if (!m) return undefined;
    let text, href;
    if (m[2] === '@') { text = m[0]; href = 'mailto:' + text; }
    else {
      let cur;
      do { cur = m[0]; m[0] = INLINE.backpedal.exec(m[0])?.[0] ?? ''; } while (cur !== m[0]);
      text = m[0];
      href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  textTok(src) {
    const m = INLINE.text.exec(src);
    if (!m) return undefined;
    const raw = this.inRawBlock;
    return { type: 'text', raw: m[0], text: raw ? m[0] : decodeEntities(m[0]), escaped: raw };
  }
}

// ---------------------------------------------------------------------------
// Block lexer.
// ---------------------------------------------------------------------------

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.inline = new InlineLexer(this.tokens.links);
    this.inlineQueue = [];
    this.state = { top: true };
  }

  // Queue `text` for inline lexing and return the (initially empty)
  // token array that will hold its inline tokens.
  queueInline(text) {
    const tokens = [];
    this.inlineQueue.push({ src: text, tokens });
    return tokens;
  }

  lex(src) {
    src = src.replace(OTHER.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (const item of this.inlineQueue) {
      this.inline.inRawBlock = false;
      this.inline.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens = [], merge = false) {
    let guard = Infinity;
    while (src) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      if ((tok = this.spaceTok(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.codeTok(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if (startsBlock(src, '`\u007e') && (tok = this.fencesTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (startsBlock(src, '#') && (tok = this.headingTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.hrTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (startsBlock(src, '>') && (tok = this.blockquoteTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.listTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (startsBlock(src, '<') && (tok = this.htmlTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (startsBlock(src, '[') && (tok = this.defTok(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.tokens.links[tok.tag]) {
            this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
            this.inline.hasLinks = true;
          }
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tableTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.lheadingTok(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (this.state.top && (tok = this.paragraphTok(src))) {
        const prev = tokens.at(-1);
        if (merge && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        // marked: merge = o.length !== e.length, with o === e here, so
        // only the first paragraph of a chunk may merge with the previous.
        merge = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.textTok(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  spaceTok(src) {
    const m = BLOCK.newline.exec(src);
    return m && m[0].length > 0 ? { type: 'space', raw: m[0] } : undefined;
  }

  codeTok(src) {
    const m = BLOCK.code.exec(src);
    if (!m) return undefined;
    const raw = trimBlankTail(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(OTHER.codeRemoveIndent, '') };
  }

  fencesTok(src) {
    const m = BLOCK.fences.exec(src);
    if (!m) return undefined;
    return {
      type: 'code',
      raw: m[0],
      lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2],
      text: fenceIndentCompensation(m[0], m[3] || ''),
    };
  }

  headingTok(src) {
    const m = BLOCK.heading.exec(src);
    if (!m) return undefined;
    let text = m[2].trim();
    if (OTHER.endingHash.test(text)) {
      const stripped = stripTrailing(text, '#');
      if (!stripped || OTHER.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: stripTrailing(m[0], '\n'), depth: m[1].length, text, tokens: this.queueInline(text) };
  }

  hrTok(src) {
    const m = BLOCK.hr.exec(src);
    return m ? { type: 'hr', raw: stripTrailing(m[0], '\n') } : undefined;
  }

  blockquoteTok(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return undefined;
    let lines = stripTrailing(m[0], '\n').split('\n');
    let raw = '', text = '';
    const tokens = [];
    while (lines.length > 0) {
      let hasMarker = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (OTHER.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); hasMarker = true; }
        else if (!hasMarker) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const chunkRaw = chunk.join('\n');
      const stripped = chunkRaw
        .replace(OTHER.blockquoteMarkerWhitespace, (g, b, ws) => b + expandTabs(ws, b.length))
        .replace(OTHER.blockquoteSetextReplace, '\n    $1')
        .replace(OTHER.blockquoteSetextReplace2, '');
      raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
      text = text ? text + '\n' + stripped : stripped;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(stripped, tokens, true);
      this.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr'
        || last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const inner = last;
        const rest = lines.join('\n');
        const joined = inner.raw + '\n' + rest.replace(OTHER.blockquoteSetextReplace2, '');
        const relexed = this.blockquoteTok(joined);
        tokens[tokens.length - 1] = relexed;
        const leftover = joined.substring(relexed.raw.length).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
        if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
        text = text.substring(0, text.length - inner.text.length) + relexed.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && OTHER.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const inner = last;
        const joined = inner.raw + '\n' + lines.join('\n');
        const relexed = this.listTok(joined);
        tokens[tokens.length - 1] = relexed;
        const extra = relexed.raw.length > inner.raw.length
          ? joined.slice(inner.raw.length + 1, relexed.raw.length).split('\n').length : 0;
        if (extra > 0) {
          const extraLines = lines.slice(0, extra).join('\n');
          raw = raw + '\n' + extraLines;
          text = text + '\n' + extraLines;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  listTok(src) {
    const m = BLOCK.list.exec(src);
    if (!m) return undefined;
    const full = src;
    let e = src;
    const consumed = () => full.length - e.length;
    let marker = m[1].trim();
    const ordered = marker.length > 1;
    const list = {
      type: 'list', raw: '', ordered,
      start: ordered ? +marker.slice(0, -1) : '',
      loose: false, items: [],
    };
    marker = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRe = listItemRegex(marker);
    let sawDoubleBlank = false;
    while (e) {
      let emptyItem = false;
      let content = '';
      const mm = itemRe.exec(e);
      if (!mm || BLOCK.hr.test(e)) break;
      const itemStart = consumed();
      e = e.substring(mm[0].length);
      const firstLine = mm[2] ? mm[2].split('\n', 1)[0] : '';
      const markerLen = mm[1].length;
      let line = firstLine.replace(OTHER.leadingSpaceTab, (v) => expandTabs(v, markerLen));
      const nextLine = e.split('\n', 1)[0];
      let isBlank = !line.trim();
      let indent = 0;
      if (isBlank) indent = markerLen + 1;
      else {
        indent = line.search(OTHER.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        content = line.slice(indent);
        indent += markerLen;
      }
      if (isBlank && OTHER.blankLine.test(nextLine)) {
        e = e.substring(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        const nextBullet = nextBulletRegex(indent);
        const hrAt = hrRegex(indent);
        const fenceAt = fencesBeginRegex(indent);
        const headingAt = headingBeginRegex(indent);
        const htmlAt = htmlBeginRegex(indent);
        const quoteAt = blockquoteBeginRegex(indent);
        const maxLead = _clampIndent(indent);
        while (e) {
          const curLine = e.split('\n', 1)[0];
          const expanded = curLine.replace(OTHER.leadingSpaceTab, (v) => expandTabs(v));
          // Cheap pre-filter for the six block-start tests: they can only
          // match when the line's first non-space character starts a block
          // and sits within the allowed indent (spaces only -- a tab
          // before it makes every one of them fail).
          let lead = 0;
          while (lead < curLine.length && curLine[lead] === ' ') lead++;
          const firstCh = curLine[lead];
          if (lead <= maxLead && firstCh !== undefined
            && (firstCh === '`' || firstCh === '~' || firstCh === '#' || firstCh === '<'
              || firstCh === '>' || firstCh === '*' || firstCh === '+' || firstCh === '-'
              || firstCh === '_' || (firstCh >= '0' && firstCh <= '9'))
            && (fenceAt.test(curLine) || headingAt.test(curLine) || htmlAt.test(curLine)
              || quoteAt.test(curLine) || nextBullet.test(curLine) || hrAt.test(curLine))) break;
          if (expanded.search(OTHER.nonSpaceChar) >= indent || !curLine.trim()) {
            content += '\n' + expanded.slice(indent);
          } else {
            if (isBlank || line.replace(OTHER.tabCharGlobal, '    ').search(OTHER.nonSpaceChar) >= 4
              || fenceAt.test(line) || headingAt.test(line) || htmlAt.test(line) || hrAt.test(line)) break;
            const setextLine = /^ {0,3}(?:=+|-+) *$/.test(curLine) && BLOCK.lheading.test(`${line}\n${curLine}`)
              ? '    ' + expanded.replace(/^ {0,3}/, '') : curLine;
            content += '\n' + setextLine;
          }
          isBlank = !curLine.trim();
          e = e.substring(curLine.length + 1);
          line = expanded.slice(indent);
        }
      }
      const itemRaw = full.slice(itemStart, consumed());
      if (!list.loose) {
        if (sawDoubleBlank) list.loose = true;
        else if (OTHER.doubleBlankLine.test(itemRaw)) sawDoubleBlank = true;
      }
      list.items.push({
        type: 'list_item', raw: itemRaw,
        task: OTHER.listIsTask.test(content), loose: false, text: content, tokens: [],
      });
    }
    const lastItem = list.items.at(-1);
    if (lastItem) { lastItem.raw = lastItem.raw.trimEnd(); lastItem.text = lastItem.text.trimEnd(); }
    else return undefined;
    list.raw = full.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => OTHER.anyLine.test(t.raw))) list.loose = true;
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(OTHER.listReplaceTask, '');
        first.raw = first.raw.replace(OTHER.listReplaceTask, '');
        first.text = first.text.replace(OTHER.listReplaceTask, '');
        for (let g = this.inlineQueue.length - 1; g >= 0; g--) {
          if (OTHER.listIsTask.test(this.inlineQueue[g].src)) {
            this.inlineQueue[g].src = this.inlineQueue[g].src.replace(OTHER.listReplaceTask, '');
            break;
          }
        }
        const cb = OTHER.listTaskCheckbox.exec(item.raw);
        if (cb) {
          const box = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = box.checked;
          if (list.loose) {
            const head = item.tokens[0];
            if (head && (head.type === 'paragraph' || head.type === 'text') && 'tokens' in head && head.tokens) {
              head.raw = box.raw + head.raw;
              head.text = box.raw + head.text;
              head.tokens.unshift(box);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) item.task = false;
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return list;
  }

  htmlTok(src) {
    const m = BLOCK.html.exec(src);
    if (!m) return undefined;
    const raw = trimBlankTail(m[0]);
    return {
      type: 'html', block: true, raw,
      pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      text: raw,
    };
  }

  defTok(src) {
    const m = BLOCK.def.exec(src);
    if (!m) return undefined;
    if (!OTHER.startAngleBracket.test(m[2]) && parenBalance(m[2]) !== -1) return undefined;
    const tag = normalizeLabel(m[1]);
    const href = m[2] ? m[2].replace(OTHER.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3];
    return { type: 'def', tag, raw: stripTrailing(m[0], '\n'), href, title };
  }

  tableTok(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !OTHER.tableDelimiter.test(m[2])) return undefined;
    const header = splitTableRow(m[1]);
    const aligns = m[2].replace(OTHER.tableAlignChars, '').split('|');
    const bodyRows = m[3]?.trim() ? m[3].replace(OTHER.tableRowBlankLine, '').split('\n') : [];
    const table = { type: 'table', raw: stripTrailing(m[0], '\n'), header: [], align: [], rows: [] };
    if (header.length !== aligns.length) return undefined;
    for (const a of aligns) {
      if (OTHER.tableAlignRight.test(a)) table.align.push('right');
      else if (OTHER.tableAlignCenter.test(a)) table.align.push('center');
      else if (OTHER.tableAlignLeft.test(a)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < header.length; i++) {
      table.header.push({ text: header[i], tokens: this.queueInline(header[i]), header: true, align: table.align[i] });
    }
    for (const row of bodyRows) {
      table.rows.push(splitTableRow(row, table.header.length).map((cell, j) => ({
        text: cell, tokens: this.queueInline(cell), header: false, align: table.align[j],
      })));
    }
    return table;
  }

  lheadingTok(src) {
    // Cheap necessary condition: a setext underline line must exist
    // somewhere; without one the full pattern cannot match.
    if (!OTHER.setextUnderline.test(src)) return undefined;
    const m = BLOCK.lheading.exec(src);
    if (!m) return undefined;
    const text = m[1].trim();
    return {
      type: 'heading', raw: stripTrailing(m[0], '\n'),
      depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.queueInline(text),
    };
  }

  paragraphTok(src) {
    const m = BLOCK.paragraph.exec(src);
    if (!m) return undefined;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.queueInline(text) };
  }

  textTok(src) {
    const m = BLOCK.text.exec(src);
    if (!m) return undefined;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.queueInline(m[0]) };
  }
}

// ---------------------------------------------------------------------------
// Renderer: token trees -> HTML.
// ---------------------------------------------------------------------------

// Render block tokens to HTML.
function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading':
        out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
        break;
      case 'code': {
        const lang = (tok.lang || '').match(OTHER.notSpaceStart)?.[0] || '';
        const body = tok.text ? tok.text.replace(OTHER.endingNewline, '') + '\n' : '';
        out += lang
          ? `<pre><code class="language-${escHtml(lang)}">${escHtml(body, true)}</code></pre>\n`
          : `<pre><code>${escHtml(body, true)}</code></pre>\n`;
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell);
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        let items = '';
        for (const item of tok.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'html':
        out += tok.text;
        break;
      case 'def': break;
      case 'paragraph':
        out += `<p>${renderInline(tok.tokens)}</p>\n`;
        break;
      case 'text':
        out += renderTextToken(tok, false);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return `${open}${renderInline(cell.tokens)}</${tag}>\n`;
}

// Render a text token: with inline tokens -> render them; raw (escaped) ->
// as-is; otherwise HTML-escape.
function renderTextToken(tok, plain) {
  if ('tokens' in tok && tok.tokens) {
    return plain ? renderPlain(tok.tokens) : renderInline(tok.tokens);
  }
  if ('escaped' in tok && tok.escaped) return tok.text;
  return escHtml(tok.text);
}

// Render inline tokens to HTML.
function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += escHtml(tok.text); break;
      case 'html': out += tok.text; break;
      case 'link': {
        const inner = tok.autolink ? escHtml(tok.text, true) : renderInline(tok.tokens);
        const href = encodeHref(tok.href);
        if (href === null) { out += inner; break; }
        let a = `<a href="${escHtml(href, tok.autolink)}"`;
        if (tok.title) a += ` title="${escHtml(tok.title)}"`;
        out += a + `>${inner}</a>`;
        break;
      }
      case 'image': {
        const alt = tok.tokens ? renderPlain(tok.tokens) : tok.text;
        const href = encodeHref(tok.href);
        if (href === null) { out += escHtml(alt); break; }
        let img = `<img src="${escHtml(href)}" alt="${escHtml(alt)}"`;
        if (tok.title) img += ` title="${escHtml(tok.title)}"`;
        out += img + '>';
        break;
      }
      case 'checkbox':
        out += `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'strong': out += `<strong>${renderInline(tok.tokens)}</strong>`; break;
      case 'em': out += `<em>${renderInline(tok.tokens)}</em>`; break;
      case 'codespan': out += `<code>${escHtml(tok.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInline(tok.tokens)}</del>`; break;
      case 'text': out += renderTextToken(tok, false); break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

// Render inline tokens to plain text (used for image alt text): no tags,
// no escaping, line breaks dropped.
function renderPlain(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong': case 'em': case 'del': case 'link': case 'image':
        out += tok.tokens ? renderPlain(tok.tokens) : tok.text;
        break;
      case 'codespan': case 'html': case 'text':
        out += tok.text;
        break;
      case 'checkbox': out += tok.raw; break;
      case 'br': break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return renderBlocks(tokens);
}

export default parse;
