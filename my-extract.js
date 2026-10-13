// =====================================================================
// my-extract.js  -  "Extract" window: export games as text / Markdown / CSV
//
// HOW IT WORKS
//  * "Extract" button (top bar, after List) opens the window. It can also be
//    opened from the bottom bar of Select mode ("Extract…").
//  * Games: the selected games, or all games that pass the filters
//    (the List filter is part of the filters).
//  * Format: Names (one name per line), Compact (one line per game),
//    For AI (Markdown with a field legend), CSV (opens in Excel).
//  * Fields are chips you switch on / off. Each format remembers its own
//    fields, description level and sort order in this browser (localStorage).
//  * The preview and the counter update live. Copy and Download always use
//    the FULL text, even when the preview is cut.
//  * Read-only: nothing is saved to GitHub, no token, no network.
//
// The part up to "Extract window" does not touch the page (except
// decodeHtmlEntities), so buildExport() can be tested alone.
//
// TO ADD A NEW FIELD: add one row to EXTRACT_FIELDS below. The chip, the
// Markdown line, the Compact part and the CSV column come by themselves.
//
// Needs from my-edit.js: editState, editEl, editToast, openModal, closeModal,
//   gameById, getHeaderActions
// Needs from my-tags.js: TAG_GROUPS, labelForTag
// Needs from app-sqlite.js: allGames, filteredGames, parsePlayerCount,
//   getComplexityName
// =====================================================================

// ---------- settings (change the numbers here) ----------

const EXTRACT_PREFS_KEY = 'meplay_extract_prefs';
const EXTRACT_PREFS_VERSION = 1;
const DESC_SHORT_CHARS = 300;          // length of a "Short" description
const DESC_SHORT_MIN_RATIO = 0.6;      // a sentence end is used only after this part of the length
const PREVIEW_MAX_CHARS = 50000;       // the preview shows no more than this
const PREVIEW_DEBOUNCE_MS = 150;       // wait after a change before rebuilding the preview
const COUNT_WARN_CHARS = 100000;       // warn when the output is longer than this
const CHARS_PER_TOKEN = 4;             // rough size of an AI token
const DOWNLOAD_REVOKE_DELAY_MS = 1000; // keep the download link alive a little
const CSV_BOM = '\uFEFF';              // makes Excel read UTF-8 correctly
const BGG_GAME_URL = 'https://boardgamegeek.com/boardgame/';

const EXTRACT_DESC_LEVELS = [
  { value: 'none', label: 'None' },
  { value: 'short', label: 'Short' },
  { value: 'full', label: 'Full' }
];

const EXTRACT_SORTS = [
  { value: 'name', label: 'A–Z' },
  { value: 'rating', label: 'Rating (high to low)' },
  { value: 'rank', label: 'Rank (best first)' }
];

// What each personal tag means (for the "Field legend" of the For AI format).
// Key = "group/option", the same keys as TAG_COLORS in my-tags.js.
const TAG_DEFINITIONS = {
  'type/mine': 'I own the physical copy.',
  'type/mohsen': 'The physical copy is with my friend Mohsen.',
  'type/amirali': 'The physical copy is with my friend Amirali.',
  'type/other': 'The physical copy is with someone else.',
  'type/bga_ready': 'Full version on Board Game Arena.',
  'type/bga_beta': 'Alpha/beta version on Board Game Arena.',
  'type/other_site': 'Digital version outside Board Game Arena.',
  'production/pnp': 'Print-and-play.',
  'production/produced_iran': 'Produced/translated by an Iranian publisher.',
  'production/produced_original': 'Official original edition.',
  'status/interested': 'I want it, no experience yet.',
  'status/learned': "I know the rules but haven't played.",
  'status/played': 'I have played it at least once.',
  'status/replay': 'I played it and want to play again.'
};

// ---------- the formats ----------

// hasFields: the Fields chips are used. hasDesc: the Description level is used.
// fields: which fields are on by default. desc: default description level.
const EXTRACT_FORMATS = [
  { key: 'names',   label: 'Names',   mime: 'text/plain',    ext: 'txt', hasFields: false, hasDesc: false,
    defaults: { fields: [], desc: 'none', sort: 'name' } },
  { key: 'compact', label: 'Compact', mime: 'text/plain',    ext: 'txt', hasFields: true,  hasDesc: false,
    defaults: { fields: ['players', 'time', 'weight', 'rating'], desc: 'none', sort: 'name' } },
  { key: 'ai',      label: 'For AI',  mime: 'text/markdown', ext: 'md',  hasFields: true,  hasDesc: true,
    defaults: { fields: 'all', desc: 'short', sort: 'name' } },
  { key: 'csv',     label: 'CSV',     mime: 'text/csv',      ext: 'csv', hasFields: true,  hasDesc: true,
    defaults: { fields: 'all', desc: 'none', sort: 'name' } }
];

function extractFormat(key) {
  return EXTRACT_FORMATS.find(f => f.key === key) || EXTRACT_FORMATS[0];
}

// ---------- small helpers (no page needed, except decodeHtmlEntities) ----------

// "Tom &amp; Jerry" -> "Tom & Jerry" (a textarea never runs scripts)
function decodeHtmlEntities(text) {
  const t = document.createElement('textarea');
  t.innerHTML = String(text);
  return t.value;
}

// A positive finite number, or null (0, empty and bad values mean "no value")
function exNum(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const exPlural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Cut a string without splitting a surrogate pair (emoji and so on)
function exSafeSlice(text, end) {
  if (text.length <= end) return text;
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xD800 && code <= 0xDBFF ? end - 1 : end);
}

function exList(value) {
  return Array.isArray(value) ? value.map(v => String(v).trim()).filter(Boolean) : [];
}

// ---------- the fields ----------
//
// key:    id (saved in the settings)      label: chip text and CSV header
// line:   name of the line in the Markdown (For AI)
// text:   the full value ('' = empty, the line is left out)
// short:  the short value (Compact). Default: same as text.
// csv:    the value in CSV. Default: same as text.

function playersInfo(game) {
  const best = [];
  const recommended = [];
  let min = Infinity;
  let upper = 0;
  let open = false;
  (Array.isArray(game.players) ? game.players : []).forEach(entry => {
    if (!Array.isArray(entry)) return;
    const [count, type] = entry;
    if (type === 'not_recommended' || type === 'not recommended') return;
    const p = parsePlayerCount(count);
    if (!p.min && !p.max) return;
    min = Math.min(min, p.min);
    upper = Math.max(upper, p.open ? p.min : p.max);
    if (p.open) open = true;
    if (type === 'best') best.push(String(count));
    else if (type === 'recommended') recommended.push(String(count));
  });
  if (min === Infinity) return null;
  let range = min === upper ? `${min}` : `${min}-${upper}`;
  if (open) range += '+';
  return { range, best, recommended };
}

function playersText(game) {
  const info = playersInfo(game);
  if (!info) return '';
  const extra = [];
  if (info.best.length) extra.push(`best: ${info.best.join(', ')}`);
  if (info.recommended.length) extra.push(`recommended: ${info.recommended.join(', ')}`);
  return extra.length ? `${info.range} (${extra.join('; ')})` : info.range;
}

function playersShort(game) {
  const info = playersInfo(game);
  if (!info) return '';
  return `${info.range}p` + (info.best.length ? ` (best ${info.best.join(', ')})` : '');
}

// Leaf tags only (never the parent heading like "physical"), in TAG_GROUPS order
function myTagItems(game) {
  const items = [];
  const tags = game.my_tags || {};
  TAG_GROUPS.forEach(group => {
    const set = tags[group.id];
    if (!set || typeof set.has !== 'function') return;
    group.sections.forEach(section => section.options.forEach(opt => {
      if (set.has(opt.key)) items.push({ id: `${group.id}/${opt.key}`, label: labelForTag(group.id, opt.key) });
    }));
  });
  return items;
}

function expansionNames(game) {
  return exList((Array.isArray(game.expansions) ? game.expansions : []).map(e => e && decodeHtmlEntities(e.name || '')));
}

const EXTRACT_FIELDS = [
  { key: 'link', label: 'Link', line: 'BGG', group: 'Links',
    text: g => `${BGG_GAME_URL}${g.id}` },
  { key: 'image', label: 'Image', line: 'Image', group: 'Links',
    text: g => (g.image ? String(g.image) : '') },

  { key: 'players', label: 'Players', line: 'Players', group: 'Play',
    text: playersText, short: playersShort },
  { key: 'time', label: 'Time', line: 'Time', group: 'Play',
    text: g => (g.playing_time ? String(g.playing_time) : '') },
  { key: 'weight', label: 'Weight', line: 'Weight', group: 'Play',
    text: g => {
      const w = exNum(g.weight);
      return w ? `${w.toFixed(1)}/5 (${getComplexityName(w)})` : '';
    },
    short: g => {
      const w = exNum(g.weight);
      return w ? `w${w.toFixed(1)}` : '';
    } },
  { key: 'age', label: 'Min age', line: 'Min age', group: 'Play',
    text: g => {
      const a = exNum(g.min_age);
      return a ? `${a}+` : '';
    } },

  { key: 'rating', label: 'Rating', line: 'BGG rating', group: 'Rating',
    text: g => {
      const r = exNum(g.rating);
      return r ? r.toFixed(1) : '';
    },
    short: g => {
      const r = exNum(g.rating);
      return r ? `★${r.toFixed(1)}` : '';
    } },
  { key: 'rank', label: 'Rank', line: 'BGG rank', group: 'Rating',
    text: g => {
      const r = exNum(g.rank);
      return r ? String(Math.round(r)) : '';
    },
    short: g => {
      const r = exNum(g.rank);
      return r ? `#${Math.round(r)}` : '';
    } },

  { key: 'categories', label: 'Categories', line: 'Categories', group: 'Content',
    text: g => exList(g.categories).join(', '),
    csv: g => exList(g.categories).join('; ') },
  { key: 'mechanics', label: 'Mechanics', line: 'Mechanics', group: 'Content',
    text: g => exList(g.mechanics).join(', '),
    csv: g => exList(g.mechanics).join('; ') },
  { key: 'expansions', label: 'Expansions', line: 'Expansions', group: 'Content',
    text: g => {
      const names = expansionNames(g);
      return names.length ? `${names.join(', ')} (${names.length})` : '';
    },
    short: g => {
      const n = expansionNames(g).length;
      return n ? exPlural(n, 'expansion') : '';
    },
    csv: g => expansionNames(g).join('; ') },

  { key: 'tags', label: 'My tags', line: 'My tags', group: 'Mine',
    text: g => myTagItems(g).map(t => t.label).join(', '),
    csv: g => myTagItems(g).map(t => t.label).join('; ') },
  { key: 'plays', label: 'My plays', line: 'My plays', group: 'Mine',
    text: g => {
      const n = exNum(g.numplays);
      return n ? String(n) : '';
    },
    short: g => {
      const n = exNum(g.numplays);
      return n ? exPlural(n, 'play') : '';
    } }
];

const exFieldText = (field, game) => String(field.text(game) || '');
const exFieldShort = (field, game) => String((field.short || field.text)(game) || '');
const exFieldCsv = (field, game) => String((field.csv || field.text)(game) || '');

// ---------- descriptions ----------

// Decoded, without extra spaces and empty lines. oneLine: everything on one line.
function cleanDescription(text, oneLine) {
  const decoded = decodeHtmlEntities(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ');
  if (oneLine) return decoded.replace(/\s+/g, ' ').trim();
  return decoded.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// About DESC_SHORT_CHARS letters: cut at the end of a sentence if there is one
// near that length, otherwise at a word, with "…". Works on decoded text, so an
// entity is never cut in the middle.
function shortDescription(text) {
  const t = cleanDescription(text, true);
  if (t.length <= DESC_SHORT_CHARS) return t;

  const windowText = exSafeSlice(t, DESC_SHORT_CHARS);
  const minEnd = Math.floor(DESC_SHORT_CHARS * DESC_SHORT_MIN_RATIO);
  for (let i = windowText.length - 1; i >= minEnd; i--) {
    const c = windowText[i];
    if ((c === '.' || c === '!' || c === '?') && (i + 1 === t.length || /\s/.test(t[i + 1]))) {
      return windowText.slice(0, i + 1);
    }
  }

  const space = windowText.lastIndexOf(' ');
  const cut = space > 0 ? windowText.slice(0, space) : windowText;
  return cut.replace(/[\s,;:\-–—(]+$/, '') + '…';
}

function exDescription(game, level, oneLine) {
  if (level === 'short') return shortDescription(game.description);
  if (level === 'full') return cleanDescription(game.description, oneLine);
  return '';
}

// A line that would turn into a heading / list / quote in Markdown gets a backslash
function exEscapeMd(line) {
  return /^([#>*+-]|\d+[.)]\s|`{3}|~{3}|[=_]{3,})/.test(line) ? `\\${line}` : line;
}

// ---------- sorting ----------

const exCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

// Returns [{ game, name }] sorted. Games without a value are always last.
function sortGames(games, sort) {
  const items = games.map(game => ({
    game,
    name: decodeHtmlEntities(game.name == null ? '' : game.name),
    rating: exNum(game.rating),
    rank: exNum(game.rank)
  }));
  const byName = (a, b) => exCollator.compare(a.name, b.name);
  const withValue = (key, dir) => (a, b) => {
    if (a[key] === null && b[key] === null) return byName(a, b);
    if (a[key] === null) return 1;
    if (b[key] === null) return -1;
    return (a[key] - b[key]) * dir || byName(a, b);
  };
  if (sort === 'rating') items.sort(withValue('rating', -1));
  else if (sort === 'rank') items.sort(withValue('rank', 1));
  else items.sort(byName);
  return items;
}

// ---------- the builders ----------

const exOneLine = text => text.replace(/\s+/g, ' ').trim();

function buildNames(items) {
  return items.map(i => i.name).join('\n');
}

function buildCompact(items, fields) {
  return items.map(({ game, name }) => {
    const parts = fields.map(f => exFieldShort(f, game)).filter(Boolean);
    const title = exOneLine(name);
    return parts.length ? `${title} — ${parts.join(' · ')}` : title;
  }).join('\n');
}

// The "Field legend" block: only for the fields that are on
function buildLegend(fields, items) {
  const on = new Set(fields.map(f => f.key));
  const lines = [];
  if (on.has('weight')) lines.push('- Weight: BGG complexity scale, 1 (light) to 5 (heavy).');
  if (on.has('rating')) lines.push('- BGG rating: average rating of BGG users, out of 10.');
  if (on.has('rank')) lines.push('- BGG rank: overall BGG rank (a lower number is better).');
  if (on.has('players')) lines.push('- Players: "best" and "recommended" are opinions of the BGG community.');
  if (on.has('time')) lines.push('- Time: play-time range.');
  if (on.has('tags')) {
    const used = new Set();
    items.forEach(({ game }) => myTagItems(game).forEach(t => used.add(t.id)));
    const defs = [];
    TAG_GROUPS.forEach(group => group.sections.forEach(section => section.options.forEach(opt => {
      const id = `${group.id}/${opt.key}`;
      if (used.has(id) && TAG_DEFINITIONS[id]) defs.push(`  - ${labelForTag(group.id, opt.key)}: ${TAG_DEFINITIONS[id]}`);
    })));
    if (defs.length) lines.push('- My tags: my personal labels:', ...defs);
  }
  return lines.length ? ['**Field legend**', ...lines].join('\n') : '';
}

function buildMarkdown(items, fields, descLevel, options) {
  const blocks = [];
  const instruction = String(options.instruction || '').trim();
  if (instruction) blocks.push(instruction);
  blocks.push(`# My board games (${items.length})`);
  if (options.legend) {
    const legend = buildLegend(fields, items);
    if (legend) blocks.push(legend);
  }

  items.forEach(({ game, name }) => {
    const lines = [`## ${exOneLine(name)}`];
    fields.forEach(f => {
      const value = exFieldText(f, game);
      if (value) lines.push(`- ${f.line}: ${value}`);
    });
    const desc = exDescription(game, descLevel, false);
    if (desc) {
      // first line sits in the bullet; other paragraphs stay un-indented
      const [first, ...rest] = desc.split('\n');
      lines.push(`- Description: ${first}`);
      rest.forEach(line => lines.push(line ? exEscapeMd(line) : ''));
    }
    blocks.push(lines.join('\n'));
  });
  return blocks.join('\n\n') + '\n';
}

// RFC 4180: a cell with a comma, a quote or a new line goes inside "..."
function csvCell(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(items, fields, descLevel) {
  const withDesc = descLevel !== 'none';
  const rows = [['Name', ...fields.map(f => f.label), ...(withDesc ? ['Description'] : [])]];
  items.forEach(({ game, name }) => {
    rows.push([name, ...fields.map(f => exFieldCsv(f, game)), ...(withDesc ? [exDescription(game, descLevel, true)] : [])]);
  });
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// options: { format, fields: [keys], desc: 'none'|'short'|'full', sort,
//            instruction, legend }
// Returns { text, mime, ext, count, chars, bom }. The BOM is NOT in text:
// only the downloaded CSV file gets it (bom + text).
function buildExport(games, options) {
  const opts = options || {};
  const format = extractFormat(opts.format);
  const keys = Array.isArray(opts.fields) ? opts.fields : [];
  const fields = format.hasFields ? EXTRACT_FIELDS.filter(f => keys.includes(f.key)) : [];
  const descLevel = format.hasDesc ? (opts.desc || 'none') : 'none';
  const items = games.length ? sortGames(games, opts.sort) : [];

  let text = '';
  if (items.length) {
    if (format.key === 'names') text = buildNames(items);
    else if (format.key === 'compact') text = buildCompact(items, fields);
    else if (format.key === 'ai') text = buildMarkdown(items, fields, descLevel, opts);
    else text = buildCsv(items, fields, descLevel);
  }
  return {
    text, mime: format.mime, ext: format.ext, count: items.length, chars: text.length,
    bom: format.key === 'csv' ? CSV_BOM : ''
  };
}

function estimateTokens(chars) {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function formatTokens(tokens) {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function exportFileName(ext, date) {
  const d = date || new Date();
  const two = n => String(n).padStart(2, '0');
  return `meplay-extract-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}.${ext}`;
}

// ---------- settings of the window ----------
//
// extractPrefs = { v, format, formats: { names: {fields, desc, sort}, ... } }
// Each format keeps its own fields, description level and sort order.

function defaultFormatSettings(formatKey) {
  const d = extractFormat(formatKey).defaults;
  return {
    fields: d.fields === 'all' ? EXTRACT_FIELDS.map(f => f.key) : d.fields.slice(),
    desc: d.desc,
    sort: d.sort
  };
}

function defaultExtractPrefs() {
  const formats = {};
  EXTRACT_FORMATS.forEach(f => { formats[f.key] = defaultFormatSettings(f.key); });
  return { v: EXTRACT_PREFS_VERSION, format: 'names', formats };
}

// Keeps only what is known; anything else falls back to the default
function sanitizeExtractPrefs(raw) {
  const prefs = defaultExtractPrefs();
  if (!raw || typeof raw !== 'object' || raw.v !== EXTRACT_PREFS_VERSION) return prefs;
  if (EXTRACT_FORMATS.some(f => f.key === raw.format)) prefs.format = raw.format;
  const saved = raw.formats && typeof raw.formats === 'object' ? raw.formats : {};
  EXTRACT_FORMATS.forEach(format => {
    const s = saved[format.key];
    const target = prefs.formats[format.key];
    if (!s || typeof s !== 'object') return;
    if (format.hasFields && Array.isArray(s.fields)) {
      target.fields = EXTRACT_FIELDS.map(f => f.key).filter(key => s.fields.includes(key));
    }
    if (format.hasDesc && EXTRACT_DESC_LEVELS.some(d => d.value === s.desc)) target.desc = s.desc;
    if (EXTRACT_SORTS.some(o => o.value === s.sort)) target.sort = s.sort;
  });
  return prefs;
}

// Storage can be blocked or hold broken JSON: then the defaults are used
function loadExtractPrefs() {
  try {
    const text = localStorage.getItem(EXTRACT_PREFS_KEY);
    return text ? sanitizeExtractPrefs(JSON.parse(text)) : defaultExtractPrefs();
  } catch (e) {
    return defaultExtractPrefs();
  }
}

function saveExtractPrefs() {
  try {
    localStorage.setItem(EXTRACT_PREFS_KEY, JSON.stringify(extractPrefs));
  } catch (e) { /* storage blocked: it works without saving */ }
}

const extractPrefs = loadExtractPrefs();

function currentFormatSettings() {
  return extractPrefs.formats[extractPrefs.format];
}

// ---------- copy / download ----------

// source: the full text (string). fallbackArea: a textarea used only to select
// the text when the clipboard API is blocked.
// Old way, still used by my-list.js: copyText(textarea) copies textarea.value.
async function copyText(source, fallbackArea) {
  const isText = typeof source === 'string';
  const text = isText ? source : source.value;
  const area = isText ? fallbackArea : source;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall back below */ }

  if (!area) return false;
  try {
    if (area.value !== text) area.value = text;   // a cut preview must not limit the copy
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    if (document.execCommand('copy')) return true;
  } catch (e) { /* ignore */ }

  area.focus();
  area.select();   // leave the text selected so Ctrl+C works
  return false;
}

function downloadExport(exp) {
  const blob = new Blob([exp.bom + exp.text], { type: `${exp.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName(exp.ext);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
}

// ---------- Extract window ----------

// Which games does a scope mean?
function resolveScopeGames(scope) {
  if (scope === 'selected') {
    const byId = new Map(allGames.map(g => [String(g.id), g]));
    const games = [];
    editState.selected.forEach(id => {
      const game = byId.get(String(id));
      if (game) games.push(game);
    });
    return games;
  }
  return filteredGames;
}

// 'auto': the selection if there is one, otherwise the filtered games
function pickInitialScope(requested, selectedCount) {
  if (requested === 'selected' && selectedCount > 0) return 'selected';
  if (requested === 'auto' && selectedCount > 0) return 'selected';
  return 'filtered';
}

// A group of buttons where exactly one is on (role=radiogroup, arrow keys move)
function buildSegmented({ labelledBy, options, getValue, onSelect }) {
  const group = editEl('div', 'extract-seg');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', labelledBy);

  const buttons = options.map(opt => {
    const b = editEl('button', 'extract-seg-btn', opt.label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = opt.value;
    b.addEventListener('click', () => { if (!b.disabled) onSelect(opt.value); });
    group.appendChild(b);
    return b;
  });

  group.addEventListener('keydown', e => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    const from = buttons.indexOf(document.activeElement);
    if (from < 0) return;
    for (let i = 1; i <= buttons.length; i++) {
      const next = buttons[(from + step * i + buttons.length * i) % buttons.length];
      if (!next.disabled) {
        e.preventDefault();
        onSelect(next.dataset.value);
        next.focus();
        return;
      }
    }
  });

  function refresh() {
    const value = getValue();
    buttons.forEach(b => {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('active', on);
      b.tabIndex = on ? 0 : -1;
    });
  }

  return {
    el: group,
    refresh,
    button: value => buttons.find(b => b.dataset.value === value)
  };
}

// One line of the window: a label on the left, the control on the right
function buildExtractRow(id, labelText, control) {
  const row = editEl('div', 'extract-row');
  const label = editEl('span', 'extract-label', labelText);
  label.id = `extract-label-${id}`;
  row.append(label, control);
  return row;
}

// Called by the "Extract" button, the bottom bar of Select mode, or by tests
// options.scope: 'auto' (default) | 'selected' | 'filtered'
function openExtractModal(options) {
  const selectedCount = editState.selected.size;
  const state = {
    scope: pickInitialScope((options && options.scope) || 'auto', selectedCount),
    instruction: '',
    legend: true
  };
  let games = resolveScopeGames(state.scope);
  let current = null;
  let refreshTimer = null;
  let copyResetTimer = null;

  openModal(modal => {
    modal.classList.add('edit-modal-wide', 'extract-modal');
    modal.id = 'extract-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-labelledby', 'extract-title');
    const title = editEl('h2', 'edit-modal-title', 'Extract');
    title.id = 'extract-title';
    modal.appendChild(title);

    // --- Games (scope) ---
    const scopeSeg = buildSegmented({
      labelledBy: 'extract-label-scope',
      options: [
        { value: 'selected', label: `Selected (${selectedCount})` },
        { value: 'filtered', label: `Filtered (${filteredGames.length})` }
      ],
      getValue: () => state.scope,
      onSelect: value => {
        state.scope = value;
        games = resolveScopeGames(value);
        scopeSeg.refresh();
        scheduleRefresh();
      }
    });
    scopeSeg.button('selected').disabled = selectedCount === 0;
    modal.appendChild(buildExtractRow('scope', 'Games', scopeSeg.el));

    // --- Format ---
    const formatSeg = buildSegmented({
      labelledBy: 'extract-label-format',
      options: EXTRACT_FORMATS.map(f => ({ value: f.key, label: f.label })),
      getValue: () => extractPrefs.format,
      onSelect: value => {
        extractPrefs.format = value;
        saveExtractPrefs();
        syncControls();
        scheduleRefresh();
      }
    });
    modal.appendChild(buildExtractRow('format', 'Format', formatSeg.el));

    // --- Fields (chips) ---
    const chips = new Map();
    const fieldsBox = editEl('div', 'extract-chips');
    fieldsBox.setAttribute('role', 'group');
    fieldsBox.setAttribute('aria-labelledby', 'extract-label-fields');
    let lastGroup = null;
    let groupBox = null;
    EXTRACT_FIELDS.forEach(field => {
      if (field.group !== lastGroup) {
        groupBox = editEl('div', 'extract-chip-group');
        fieldsBox.appendChild(groupBox);
        lastGroup = field.group;
      }
      const chip = editEl('button', 'extract-chip');
      chip.type = 'button';
      const check = editEl('span', 'extract-chip-check', '✓');
      check.setAttribute('aria-hidden', 'true');
      chip.append(check, editEl('span', 'extract-chip-text', field.label));
      chip.addEventListener('click', () => {
        const s = currentFormatSettings();
        const at = s.fields.indexOf(field.key);
        if (at >= 0) s.fields.splice(at, 1);
        else s.fields.push(field.key);
        saveExtractPrefs();
        syncControls();
        scheduleRefresh();
      });
      groupBox.appendChild(chip);
      chips.set(field.key, chip);
    });
    const fieldsRow = buildExtractRow('fields', 'Fields', fieldsBox);
    modal.appendChild(fieldsRow);

    // --- Description + Sort ---
    const descSeg = buildSegmented({
      labelledBy: 'extract-label-desc',
      options: EXTRACT_DESC_LEVELS,
      getValue: () => currentFormatSettings().desc,
      onSelect: value => {
        currentFormatSettings().desc = value;
        saveExtractPrefs();
        syncControls();
        scheduleRefresh();
      }
    });
    const descRow = buildExtractRow('desc', 'Description', descSeg.el);

    const sortSelect = editEl('select', 'extract-select');
    sortSelect.id = 'extract-sort';
    EXTRACT_SORTS.forEach(s => {
      const o = editEl('option', '', s.label);
      o.value = s.value;
      sortSelect.appendChild(o);
    });
    sortSelect.addEventListener('change', () => {
      currentFormatSettings().sort = sortSelect.value;
      saveExtractPrefs();
      scheduleRefresh();
    });
    const sortLabel = editEl('label', 'extract-label', 'Sort');
    sortLabel.htmlFor = 'extract-sort';
    const sortBox = editEl('div', 'extract-sort-box');
    sortBox.append(sortLabel, sortSelect);

    const descSortRow = editEl('div', 'extract-desc-sort');
    descSortRow.append(descRow, sortBox);
    modal.appendChild(descSortRow);

    // --- For AI only: instruction + legend ---
    const instruction = editEl('textarea', 'extract-instruction');
    instruction.rows = 2;
    instruction.spellcheck = false;
    instruction.setAttribute('aria-label', 'Instruction placed above the list');
    instruction.placeholder = 'Optional instruction placed above the list, e.g. "Suggest a game for 3 players"';
    instruction.addEventListener('input', () => {
      state.instruction = instruction.value;
      scheduleRefresh();
    });

    const legendLabel = editEl('label', 'extract-check');
    const legendBox = document.createElement('input');
    legendBox.type = 'checkbox';
    legendBox.checked = state.legend;
    legendBox.addEventListener('change', () => {
      state.legend = legendBox.checked;
      scheduleRefresh();
    });
    legendLabel.append(legendBox, document.createTextNode(' Field legend'));

    const aiRow = editEl('div', 'extract-row extract-ai-row');
    const aiLabel = editEl('span', 'extract-label', 'AI only');
    const aiBody = editEl('div', 'extract-ai-body');
    aiBody.append(instruction, legendLabel);
    aiRow.append(aiLabel, aiBody);
    modal.appendChild(aiRow);

    // --- preview + counter ---
    const preview = editEl('textarea', 'extract-textarea extract-preview');
    preview.readOnly = true;
    preview.spellcheck = false;
    preview.dir = 'ltr';
    preview.setAttribute('aria-label', 'Preview of the output');
    modal.appendChild(preview);

    const note = editEl('p', 'extract-note');
    note.hidden = true;
    modal.appendChild(note);

    const counter = editEl('p', 'extract-count');
    counter.setAttribute('role', 'status');
    modal.appendChild(counter);

    // --- buttons ---
    const actions = editEl('div', 'edit-modal-actions extract-actions');
    const reset = editEl('button', 'edit-btn edit-btn-ghost extract-reset', 'Reset');
    reset.type = 'button';
    reset.title = 'Back to the default fields of this format';
    reset.addEventListener('click', () => {
      extractPrefs.formats[extractPrefs.format] = defaultFormatSettings(extractPrefs.format);
      saveExtractPrefs();
      syncControls();
      scheduleRefresh();
    });
    const download = editEl('button', 'edit-btn');
    download.type = 'button';
    download.addEventListener('click', () => {
      flushRefresh();
      if (current && current.count) downloadExport(current);
    });
    const copy = editEl('button', 'edit-btn edit-btn-primary', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', doCopy);
    const close = editEl('button', 'edit-btn', 'Close');
    close.type = 'button';
    close.addEventListener('click', closeModal);
    actions.append(reset, download, copy, close);
    modal.appendChild(actions);

    extractCopyHandler = doCopy;

    // ----- inner functions -----

    async function doCopy() {
      flushRefresh();
      if (!current || !current.count) return;
      const ok = await copyText(current.text, preview);
      if (ok) {
        copy.textContent = 'Copied ✓';
        editToast(`Copied ${exPlural(current.count, 'game')}`);
        clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
      } else {
        editToast('Could not copy automatically. The text is selected: press Ctrl+C.', true);
      }
    }

    // Controls follow the settings of the current format (the window is not rebuilt)
    function syncControls() {
      const format = extractFormat(extractPrefs.format);
      const s = currentFormatSettings();
      scopeSeg.refresh();
      formatSeg.refresh();
      descSeg.refresh();
      chips.forEach((chip, key) => {
        const on = s.fields.includes(key);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      sortSelect.value = s.sort;
      fieldsRow.hidden = !format.hasFields;
      descRow.hidden = !format.hasDesc;
      aiRow.hidden = format.key !== 'ai';
      download.textContent = `Download .${format.ext}`;
    }

    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshPreview, PREVIEW_DEBOUNCE_MS);
    }

    // Copy / Download call this first, so a change made a moment ago is included
    function flushRefresh() {
      if (refreshTimer) refreshPreview();
    }

    // Only the preview, the note and the counter change here
    function refreshPreview() {
      clearTimeout(refreshTimer);
      refreshTimer = null;
      const s = currentFormatSettings();
      current = buildExport(games, {
        format: extractPrefs.format,
        fields: s.fields,
        desc: s.desc,
        sort: s.sort,
        instruction: state.instruction,
        legend: state.legend
      });

      const cut = current.text.length > PREVIEW_MAX_CHARS;
      preview.value = cut ? exSafeSlice(current.text, PREVIEW_MAX_CHARS) : current.text;
      preview.placeholder = state.scope === 'selected' ? 'No games selected.' : 'No games match the current filters.';
      note.hidden = !cut;
      note.textContent = `Preview shows the first ${PREVIEW_MAX_CHARS.toLocaleString('en-US')} characters; Copy and Download use the full text.`;

      const big = current.chars > COUNT_WARN_CHARS;
      counter.textContent = `${exPlural(current.count, 'game')} · ${current.chars.toLocaleString('en-US')} chars (~${formatTokens(estimateTokens(current.chars))} tokens)` +
        (big ? ` · ⚠ Large output. ${s.desc === 'full' ? 'Try a shorter description' : 'Try fewer fields'}` : '');
      counter.classList.toggle('extract-count-warn', big);
      copy.disabled = download.disabled = current.count === 0;
    }

    syncControls();
    refreshPreview();
    scopeSeg.button(state.scope).focus();
  });
}

// ---------- the button in the top bar ----------

// Ctrl/Cmd + Enter copies (only while the Extract window is open)
let extractCopyHandler = null;
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && extractCopyHandler && document.getElementById('extract-modal')) {
    e.preventDefault();
    extractCopyHandler();
  }
});

function setupExtractButton() {
  const box = getHeaderActions();
  if (!box || document.getElementById('extract-toggle')) return;
  const btn = editEl('button', 'edit-toggle', 'Extract');
  btn.id = 'extract-toggle';
  btn.type = 'button';
  btn.disabled = true;   // until the games are loaded (enableExtractButton)
  btn.title = 'Export the games as text, Markdown or CSV';
  btn.addEventListener('click', () => openExtractModal({ scope: 'auto' }));
  // order in the top bar: Edit, Select, List, Extract, Update
  const update = document.getElementById('sync-btn');
  if (update && update.parentNode === box) box.insertBefore(btn, update);
  else box.appendChild(btn);
}

// Called by initializeUI() in app-sqlite.js once allGames is ready
function enableExtractButton() {
  const btn = document.getElementById('extract-toggle');
  if (btn) btn.disabled = false;
}

setupExtractButton();
