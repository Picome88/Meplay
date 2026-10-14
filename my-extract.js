// =====================================================================
// my-extract.js  -  "Extract" window: export games as text, Markdown or CSV
//
// HOW IT WORKS
//  * "Extract" button (top bar, after List) opens the window. It can also be
//    opened from the bottom bar of Select mode ("Extract…").
//  * Games: the selected games, or all games that pass the filters.
//  * Preset: Names / Compact / Detailed / Custom. A preset only chooses the
//    fields. Change a field by hand and the preset becomes Custom (or the
//    matching preset, if you land exactly on one).
//  * Fields are chips (same names and colors as the filters on the main page).
//    The output always keeps one fixed order:
//      name, rank + rating, players + time + complexity, description,
//      mechanics, categories, expansions, Type, Production, Status, link, image.
//  * Number: puts 1, 2, 3 ... in front of the games.  Title: first line of the
//    text and the name of the downloaded file.
//  * The preview can be Styled (bold, headings) or Plain text. The numbers
//    under it are the size of the plain text.
//  * Output buttons: Copy (plain text), .txt (plain text), .md (Markdown),
//    .csv (a table for Excel). Copy and the files always use the FULL text.
//  * Read-only: nothing is saved to GitHub, no token, no network.
//
// The part up to "Extract window" does not touch the page (except
// decodeHtmlEntities), so buildExportModel() / modelToText() can be tested alone.
//
// TO ADD A NEW FIELD: add one row to EXTRACT_FIELDS below (kind: stat, list...).
// TO HIDE A FIELD (without deleting it): put  hidden: true  in its row.
// (Min age and My plays are hidden for now.)
//
// Needs from my-edit.js: editState, editEl, editToast, openModal, closeModal,
//   getHeaderActions
// Needs from my-tags.js: TAG_GROUPS, colorForTag, TAG_TEXT_COLOR
// Needs from app-sqlite.js: allGames, filteredGames, parsePlayerCount,
//   getComplexityName
// =====================================================================

// ---------- settings (change the numbers here) ----------

const EXTRACT_PREFS_KEY = 'meplay_extract_prefs';
const EXTRACT_PREFS_VERSION = 2;
const DESC_SHORT_CHARS = 300;          // length of a "Short" description
const DESC_SHORT_MIN_RATIO = 0.6;      // a sentence end is used only after this part of the length
const PREVIEW_MAX_CHARS = 50000;       // the preview shows no more than this
const PREVIEW_DEBOUNCE_MS = 150;       // wait after a change before rebuilding the preview
const WARN_BYTES = 100000;             // warn when the plain text is bigger than this
const DOWNLOAD_REVOKE_DELAY_MS = 1000; // keep the download link alive a little
const FILE_NAME_MAX = 80;              // longest file name (without the extension)
const CSV_BOM = '\uFEFF';              // makes Excel read UTF-8 correctly
const BGG_GAME_URL = 'https://boardgamegeek.com/boardgame/';

const EXTRACT_DESC_LEVELS = [
  { value: 'short', label: 'Short' },
  { value: 'full', label: 'Full' }
];

const EXTRACT_SORTS = [
  { value: 'name', label: 'A–Z' },
  { value: 'rating', label: 'Rating (high to low)' },
  { value: 'rank', label: 'Rank (best first)' }
];

// What each personal tag means (for the "Field legend").
// Key = "group/option", the same keys as TAG_COLORS in my-tags.js.
const TAG_DEFINITIONS = {
  'type/physical': 'I have a physical copy (mine, a friend\'s or someone else\'s).',
  'type/digital': 'There is a digital version.',
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
const exOneLine = text => String(text).replace(/\s+/g, ' ').trim();

// Cut a string without splitting a surrogate pair (emoji and so on)
function exSafeSlice(text, end) {
  if (text.length <= end) return text;
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xD800 && code <= 0xDBFF ? end - 1 : end);
}

function exList(value) {
  return Array.isArray(value) ? value.map(v => String(v).trim()).filter(Boolean) : [];
}

function exByteLength(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch (e) {
    return text.length;
  }
}

// 950 -> "950 B", 131072 -> "128 KB", 2621440 -> "2.5 MB"
function exFormatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

// ---------- the fields ----------
//
// key:    id (saved in the settings)    label: chip text and CSV header
//         (the name of the filter on the main page)
// line:   name of the value in the text output
// kind:   name | stat | desc | list      (stat = part of a short line, list = a line of its own)
// row:    which line the chips / the stat values share
// block:  true = this field needs a block per game (not one line per game)
// text(game, opts): the value ('' = empty, left out).  short: for the one-line style.
// csv: the value in CSV.   opts = { best, rec, desc }
// hidden: true = not shown as a chip and never in the output (code is kept).

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

// Best / Recommended are added only when their sub chips are on
function playersText(game, opts) {
  const info = playersInfo(game);
  if (!info) return '';
  const extra = [];
  if (opts.best && info.best.length) extra.push(`best: ${info.best.join(', ')}`);
  if (opts.rec && info.recommended.length) extra.push(`recommended: ${info.recommended.join(', ')}`);
  return extra.length ? `${info.range} (${extra.join('; ')})` : info.range;
}

function playersShort(game, opts) {
  const info = playersInfo(game);
  if (!info) return '';
  const extra = [];
  if (opts.best && info.best.length) extra.push(`best ${info.best.join(', ')}`);
  if (opts.rec && info.recommended.length) extra.push(`rec. ${info.recommended.join(', ')}`);
  return `${info.range}p` + (extra.length ? ` (${extra.join('; ')})` : '');
}

function expansionNames(game) {
  return exList((Array.isArray(game.expansions) ? game.expansions : []).map(e => e && decodeHtmlEntities(e.name || '')));
}

const EXTRACT_FIELDS = [
  { key: 'name', label: 'Name', kind: 'name', row: 'name' },

  { key: 'rank', label: 'Rank', line: 'Rank', kind: 'stat', row: 'rank',
    text: g => {
      const r = exNum(g.rank);
      return r ? String(Math.round(r)) : '';
    },
    short: g => {
      const r = exNum(g.rank);
      return r ? `#${Math.round(r)}` : '';
    } },
  { key: 'rating', label: 'Rating', line: 'Rating', kind: 'stat', row: 'rank',
    text: g => {
      const r = exNum(g.rating);
      return r ? r.toFixed(1) : '';
    },
    short: g => {
      const r = exNum(g.rating);
      return r ? `★${r.toFixed(1)}` : '';
    } },

  { key: 'players', label: 'Number of players', line: 'Players', kind: 'stat', row: 'play',
    text: playersText, short: playersShort },
  { key: 'time', label: 'Playing time', line: 'Time', kind: 'stat', row: 'play',
    text: g => (g.playing_time ? String(g.playing_time) : '') },
  { key: 'weight', label: 'Complexity', line: 'Complexity', kind: 'stat', row: 'play',
    text: g => {
      const w = exNum(g.weight);
      return w ? `${w.toFixed(1)}/5 (${getComplexityName(w)})` : '';
    },
    short: g => {
      const w = exNum(g.weight);
      return w ? `complexity ${w.toFixed(1)}` : '';
    } },
  { key: 'age', label: 'Min age', line: 'Min age', kind: 'stat', row: 'play', hidden: true,
    text: g => {
      const a = exNum(g.min_age);
      return a ? `${a}+` : '';
    } },

  { key: 'description', label: 'Description', kind: 'desc', row: 'desc', block: true },

  { key: 'mechanics', label: 'Mechanics', line: 'Mechanics', kind: 'list', row: 'lists', block: true,
    text: g => exList(g.mechanics).join(', '),
    csv: g => exList(g.mechanics).join('; ') },
  { key: 'categories', label: 'Categories', line: 'Categories', kind: 'list', row: 'lists', block: true,
    text: g => exList(g.categories).join(', '),
    csv: g => exList(g.categories).join('; ') },
  { key: 'expansions', label: 'Expansions', line: 'Expansions', kind: 'list', row: 'lists', block: true,
    text: g => {
      const names = expansionNames(g);
      return names.length ? `${names.join(', ')} (${names.length})` : '';
    },
    csv: g => expansionNames(g).join('; ') },

  // the tag groups (Type, Production, Status) are built from TAG_GROUPS and go here
  { key: '@tags', kind: 'tags-slot' },

  { key: 'link', label: 'Link', line: 'Link', kind: 'list', row: 'links',
    text: g => `${BGG_GAME_URL}${g.id}` },
  { key: 'image', label: 'Image', line: 'Image', kind: 'list', row: 'links',
    text: g => (g.image ? String(g.image) : '') },

  { key: 'plays', label: 'My plays', line: 'My plays', kind: 'stat', row: 'play', hidden: true,
    text: g => {
      const n = exNum(g.numplays);
      return n ? String(n) : '';
    },
    short: g => {
      const n = exNum(g.numplays);
      return n ? exPlural(n, 'play') : '';
    } }
];

// Small chips that belong to a field: they are only used while the parent is on
const EXTRACT_SUBFIELDS = [
  { key: 'players_best', parent: 'players', label: 'Best' },
  { key: 'players_rec', parent: 'players', label: 'Recommended' }
];

// ---------- tag chips (built from TAG_GROUPS: a new tag or friend gets its chip by itself) ----------

const EX_TAG_PREFIX = 'tag:';

// One entry per chip, in the same order as the filters on the main page.
// isParent: the heading chip ("Physical (any)"), true when the game has any of its tags.
function exTagChips() {
  const chips = [];
  TAG_GROUPS.forEach(group => group.sections.forEach(section => {
    if (section.key) {
      chips.push({ key: `${EX_TAG_PREFIX}${group.id}/${section.key}`, groupId: group.id, groupTitle: group.title,
        optionKey: section.key, label: section.label, outLabel: section.label.replace(/\s*\(any\)\s*$/i, ''), isParent: true });
    }
    section.options.forEach(opt => chips.push({
      key: `${EX_TAG_PREFIX}${group.id}/${opt.key}`, groupId: group.id, groupTitle: group.title,
      optionKey: opt.key, label: opt.label, outLabel: opt.label, isParent: false
    }));
  }));
  return chips;
}

// The tag chips that are on in "Select all" and "Detailed": every tag, but not the "(any)" headings
const exDefaultTagKeys = () => exTagChips().filter(c => !c.isParent).map(c => c.key);

// One output field per tag group (Type / Production / Status) that has chips on.
// It shows only the chosen tags that the game really has.
function exTagGroupField(group, keys) {
  const picked = exTagChips().filter(c => c.groupId === group.id && keys.includes(c.key));
  if (!picked.length) return null;
  const tagsOf = game => {
    const set = game.my_tags && game.my_tags[group.id];
    return set && typeof set.has === 'function' ? picked.filter(c => set.has(c.optionKey)) : [];
  };
  return {
    key: `tags:${group.id}`, label: group.title, line: group.title, kind: 'list', row: 'tags',
    text: g => tagsOf(g).map(c => c.outLabel).join(', '),
    csv: g => tagsOf(g).map(c => c.outLabel).join('; '),
    tagsOf
  };
}

// The fields in use (the hidden ones are left out everywhere)
const exActiveFields = () => EXTRACT_FIELDS.filter(f => !f.hidden && f.kind !== 'tags-slot');

// Every chip key that exists now, in output order
const exAllKeys = () => {
  const keys = [];
  exActiveFields().forEach(f => {
    keys.push(f.key);
    EXTRACT_SUBFIELDS.filter(s => s.parent === f.key).forEach(s => keys.push(s.key));
  });
  const tags = exTagChips().map(c => c.key);
  const at = keys.indexOf('link');
  keys.splice(at < 0 ? keys.length : at, 0, ...tags);
  return keys;
};

// Everything on (but no "(any)" headings)
const exSelectAllKeys = () => {
  const parents = new Set(exTagChips().filter(c => c.isParent).map(c => c.key));
  return exAllKeys().filter(k => !parents.has(k));
};

// The fields to write, in the fixed output order, for the chips that are on.
// opts: what the sub chips and the description level say.
function exResolveFields(keys, desc) {
  const opts = { best: keys.includes('players_best'), rec: keys.includes('players_rec'), desc: desc === 'full' ? 'full' : 'short' };
  const fields = [];
  EXTRACT_FIELDS.forEach(f => {
    if (f.kind === 'tags-slot') {
      TAG_GROUPS.forEach(g => {
        const t = exTagGroupField(g, keys);
        if (t) fields.push(t);
      });
      return;
    }
    if (!f.hidden && keys.includes(f.key)) fields.push(f);
  });
  return { fields, opts };
}

function exFieldValue(field, game, opts, mode) {
  const fn = mode === 'short' ? (field.short || field.text)
    : mode === 'csv' ? (field.csv || field.text)
    : field.text;
  return String(fn(game, opts) || '');
}

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
  return level === 'full' ? cleanDescription(game.description, oneLine) : shortDescription(game.description);
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

// ---------- the model ----------
//
// buildExportModel() reads the games ONCE and makes a plain object. Every output
// (plain text, Markdown, CSV, the styled preview) is made from that object.
//
// options: { fields: [keys], desc: 'short'|'full', sort, number, title,
//            instruction, legend }
// model:   { empty, count, fields, opts, blockMode, number, title, instruction,
//            legend: [{text, sub}] | null,
//            games: [{ game, number, name, rawName, lines | inline }] }
//   lines  (block style): [{type:'stats', parts:[{label,text}]}, {type:'desc', lines:[..]},
//                          {type:'field', label, text}]
//   inline (one-line style): "#25 · ★8.1 · 1-5p (best 3)"

function buildLegendLines(fields, items, opts) {
  const on = new Set(fields.map(f => f.key));
  const lines = [];
  if (on.has('rank')) lines.push({ text: 'Rank: overall BGG rank (a lower number is better).' });
  if (on.has('rating')) lines.push({ text: 'Rating: average rating of BGG users, out of 10.' });
  if (on.has('players') && (opts.best || opts.rec)) lines.push({ text: 'Players: "best" and "recommended" are opinions of the BGG community.' });
  if (on.has('time')) lines.push({ text: 'Time: play-time range.' });
  if (on.has('weight')) lines.push({ text: 'Complexity: BGG complexity (weight) scale, 1 (light) to 5 (heavy).' });

  const tagFields = fields.filter(f => f.tagsOf);
  if (tagFields.length) {
    const used = new Set();
    items.forEach(({ game }) => tagFields.forEach(f => f.tagsOf(game).forEach(c => used.add(c.key))));
    const defs = [];
    exTagChips().forEach(c => {
      const id = c.key.slice(EX_TAG_PREFIX.length);
      if (used.has(c.key) && TAG_DEFINITIONS[id]) defs.push({ text: `${c.outLabel}: ${TAG_DEFINITIONS[id]}`, sub: true });
    });
    if (defs.length) lines.push({ text: `${tagFields.map(f => f.label).join(' / ')}: my personal tags on each game:` }, ...defs);
  }
  return lines;
}

function exGameRecord(item, index, model) {
  const { game, name } = item;
  const { fields, opts } = model;
  const rec = { game, number: index + 1, rawName: name, name: null, lines: null, inline: null };
  if (fields.some(f => f.kind === 'name')) rec.name = exOneLine(name);
  const rest = fields.filter(f => f.kind !== 'name');

  if (!model.blockMode) {
    rec.inline = rest.map(f => exFieldValue(f, game, opts, 'short')).filter(Boolean).join(' · ');
    return rec;
  }

  const lines = [];
  rest.forEach(f => {
    if (f.kind === 'stat') {
      const text = exFieldValue(f, game, opts, 'text');
      if (!text) return;
      const last = lines[lines.length - 1];
      if (last && last.type === 'stats' && last.row === f.row) last.parts.push({ label: f.line, text });
      else lines.push({ type: 'stats', row: f.row, parts: [{ label: f.line, text }] });
    } else if (f.kind === 'desc') {
      const text = exDescription(game, opts.desc, false);
      if (text) lines.push({ type: 'desc', lines: text.split('\n') });
    } else {
      const text = exFieldValue(f, game, opts, 'text');
      if (text) lines.push({ type: 'field', label: f.line, text });
    }
  });
  rec.lines = lines;
  return rec;
}

function buildExportModel(games, options) {
  const o = options || {};
  const { fields, opts } = exResolveFields(Array.isArray(o.fields) ? o.fields : [], o.desc);
  const items = games.length ? sortGames(games, o.sort) : [];
  const model = {
    empty: !items.length || !fields.length,
    count: items.length,
    fields, opts,
    blockMode: fields.some(f => f.kind !== 'name' && (f.block || f.kind === 'desc')),
    number: !!o.number,
    title: String(o.title || '').trim(),
    instruction: String(o.instruction || '').trim(),
    legend: null,
    games: []
  };
  if (model.empty) return model;
  if (o.legend) {
    const legend = buildLegendLines(fields, items, opts);
    if (legend.length) model.legend = legend;
  }
  model.games = items.map((item, i) => exGameRecord(item, i, model));
  return model;
}

// ---------- the outputs ----------

function exGameHeading(rec, model) {
  const parts = [];
  if (model.number) parts.push(`${rec.number}.`);
  if (rec.name !== null) parts.push(rec.name);
  return parts.join(' ');
}

function exLegendText(model, md) {
  if (!model.legend) return '';
  const rows = model.legend.map(l => `${l.sub ? '  ' : ''}- ${l.text}`);
  return [md ? '**Field legend**' : 'Field legend:', ...rows].join('\n');
}

function exGameBlockText(rec, model, md) {
  const out = [];
  const heading = exGameHeading(rec, model);
  if (heading) out.push(md ? `## ${heading}` : heading);

  rec.lines.forEach(line => {
    if (line.type === 'desc') {
      if (md) out.push('', ...line.lines.map(l => (l ? exEscapeMd(l) : '')), '');
      else out.push(...line.lines);
    } else if (line.type === 'stats') {
      const text = line.parts.map(p => (md ? `**${p.label}** ${p.text}` : `${p.label} ${p.text}`)).join(' · ');
      out.push(md ? `- ${text}` : text);
    } else {
      out.push(md ? `- **${line.label}:** ${line.text}` : `${line.label}: ${line.text}`);
    }
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
}

function exGameLineText(rec, model, md) {
  const text = [rec.name, rec.inline].filter(x => x !== null && x !== '').join(' — ');
  if (model.number) return `${rec.number}. ${text}`;
  return md ? `- ${text}` : text;
}

// kind: 'plain' | 'md'
function modelToText(model, kind) {
  if (model.empty) return '';
  const md = kind === 'md';
  const blocks = [];
  if (model.instruction) blocks.push(model.instruction);
  if (model.title) blocks.push(md ? `# ${model.title}` : model.title);
  const legend = exLegendText(model, md);
  if (legend) blocks.push(legend);

  if (model.blockMode) model.games.forEach(rec => blocks.push(exGameBlockText(rec, model, md)));
  else blocks.push(model.games.map(rec => exGameLineText(rec, model, md)).join('\n'));

  return blocks.join('\n\n') + (md ? '\n' : '');
}

// RFC 4180: a cell with a comma, a quote or a new line goes inside "..."
function csvCell(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A table: one column per field, in the same order. No title / instruction / legend.
function modelToCsv(model) {
  if (model.empty) return '';
  const { fields, opts } = model;
  const header = [...(model.number ? ['#'] : []), ...fields.map(f => (f.kind === 'tags-slot' ? '' : f.label))];
  const rows = [header];
  model.games.forEach(rec => {
    rows.push([
      ...(model.number ? [rec.number] : []),
      ...fields.map(f => {
        if (f.kind === 'name') return rec.rawName;
        if (f.kind === 'desc') return exDescription(rec.game, opts.desc, true);
        return exFieldValue(f, rec.game, opts, 'csv');
      })
    ]);
  });
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// What each output button gives
const EXTRACT_OUTPUTS = {
  copy: { mime: 'text/plain', ext: 'txt' },
  txt: { mime: 'text/plain', ext: 'txt' },
  md: { mime: 'text/markdown', ext: 'md' },
  csv: { mime: 'text/csv', ext: 'csv' }
};

// -> { text, mime, ext, bom }. The BOM is NOT in text: only the downloaded CSV gets it.
function exportAs(model, outputKey) {
  const o = EXTRACT_OUTPUTS[outputKey];
  const text = outputKey === 'csv' ? modelToCsv(model) : modelToText(model, outputKey === 'md' ? 'md' : 'plain');
  return { text, mime: o.mime, ext: o.ext, bom: outputKey === 'csv' ? CSV_BOM : '' };
}

// The file name: the title (made safe) or meplay-extract-DATE
function exportFileName(title, ext, date) {
  let base = String(title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  base = exSafeSlice(base, FILE_NAME_MAX).replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `_${base}`;
  if (!base) {
    const d = date || new Date();
    const two = n => String(n).padStart(2, '0');
    base = `meplay-extract-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  }
  return `${base}.${ext}`;
}

// ---------- presets and settings ----------
//
// A preset only chooses the fields. extractPrefs =
//   { v, preset, fields, desc, sort, number, custom: {fields, desc} | null }
// "custom" remembers your last own choice, so you can come back to it.

const EXTRACT_PRESETS = [
  { key: 'names', label: 'Names', legend: false, desc: 'short', fields: () => ['name'] },
  { key: 'compact', label: 'Compact', legend: false, desc: 'short',
    fields: () => ['name', 'rating', 'players', 'players_best', 'time', 'weight'] },
  { key: 'detailed', label: 'Detailed', legend: true, desc: 'short', fields: () => exSelectAllKeys() }
];

const exInOrder = keys => exAllKeys().filter(k => keys.includes(k));
const exPresetFields = preset => exInOrder(preset.fields());

// Which preset do these fields equal? (null = none, so "Custom")
function exDetectPreset(fields, desc) {
  const have = exInOrder(fields).join('|');
  const hit = EXTRACT_PRESETS.find(p => exPresetFields(p).join('|') === have && (!fields.includes('description') || p.desc === desc));
  return hit ? hit.key : null;
}

function defaultExtractPrefs() {
  const first = EXTRACT_PRESETS[0];
  return { v: EXTRACT_PREFS_VERSION, preset: first.key, fields: exPresetFields(first), desc: first.desc, sort: 'name', number: false, custom: null };
}

// Keeps only what is known; anything else falls back to the default
function sanitizeExtractPrefs(raw) {
  const prefs = defaultExtractPrefs();
  if (!raw || typeof raw !== 'object' || raw.v !== EXTRACT_PREFS_VERSION) return prefs;
  const cleanFields = list => (Array.isArray(list) ? exInOrder(list) : null);
  const cleanDesc = d => (EXTRACT_DESC_LEVELS.some(l => l.value === d) ? d : null);

  const fields = cleanFields(raw.fields);
  if (fields) prefs.fields = fields;
  prefs.desc = cleanDesc(raw.desc) || prefs.desc;
  if (EXTRACT_SORTS.some(o => o.value === raw.sort)) prefs.sort = raw.sort;
  prefs.number = raw.number === true;
  if (raw.custom && typeof raw.custom === 'object' && cleanFields(raw.custom.fields)) {
    prefs.custom = { fields: cleanFields(raw.custom.fields), desc: cleanDesc(raw.custom.desc) || 'short' };
  }
  prefs.preset = raw.preset === 'custom' ? 'custom' : (exDetectPreset(prefs.fields, prefs.desc) || 'custom');
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

// Click on a preset button. "custom" brings back your last own choice.
function applyExtractPreset(key) {
  const preset = EXTRACT_PRESETS.find(p => p.key === key);
  if (preset) {
    extractPrefs.fields = exPresetFields(preset);
    extractPrefs.desc = preset.desc;
    extractPrefs.preset = key;
  } else {
    if (extractPrefs.custom) {
      extractPrefs.fields = extractPrefs.custom.fields.slice();
      extractPrefs.desc = extractPrefs.custom.desc;
    } else {
      extractPrefs.custom = { fields: extractPrefs.fields.slice(), desc: extractPrefs.desc };
    }
    extractPrefs.preset = 'custom';
  }
  saveExtractPrefs();
}

// Call after the fields (or the description level) were changed by hand
function afterExtractFieldsEdited() {
  extractPrefs.fields = exInOrder(extractPrefs.fields);
  const key = exDetectPreset(extractPrefs.fields, extractPrefs.desc);
  extractPrefs.preset = key || 'custom';
  if (!key) extractPrefs.custom = { fields: extractPrefs.fields.slice(), desc: extractPrefs.desc };
  saveExtractPrefs();
}

// ---------- copy / download ----------

// source: the full text (string). fallbackArea: a textarea used only to select
// the text when the clipboard API is blocked.
// Old way, still used by my-list.js: copyText(textarea) copies textarea.value.
async function copyText(source, fallbackArea) {
  const isText = typeof source === 'string';
  const text = isText ? source : source.value;
  let area = isText ? fallbackArea : source;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall back below */ }

  // an area that is not on the screen cannot be selected: use a temporary one
  let temp = null;
  if (!area || !area.offsetParent) {
    temp = document.createElement('textarea');
    temp.value = text;
    temp.readOnly = true;
    temp.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(temp);
    area = temp;
  }
  try {
    if (area.value !== text) area.value = text;   // a cut preview must not limit the copy
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    if (document.execCommand('copy')) return true;
  } catch (e) { /* ignore */ }
  finally {
    if (temp) temp.remove();
  }

  if (!temp) {
    area.focus();
    area.select();   // leave the text selected so Ctrl+C works
  }
  return false;
}

function downloadExport(exp, fileName) {
  const blob = new Blob([exp.bom + exp.text], { type: `${exp.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
}

// ---------- the styled preview ----------

function exEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  el.dir = 'auto';
  return el;
}

function exRecordLength(rec) {
  if (rec.inline !== null) return (rec.name || '').length + rec.inline.length + 4;
  let n = (rec.name || '').length;
  rec.lines.forEach(l => {
    if (l.type === 'stats') l.parts.forEach(p => { n += p.label.length + p.text.length + 3; });
    else if (l.type === 'desc') n += l.lines.join('\n').length;
    else n += l.label.length + l.text.length + 3;
  });
  return n;
}

// Draws the model into `box` (bold labels, headings...). Only the first games are
// drawn when the text is long. Returns how many games were drawn.
// Everything goes in with textContent: a description can never run as HTML.
function renderStyled(model, box) {
  box.textContent = '';
  if (model.empty) return 0;
  if (model.instruction) box.appendChild(exEl('p', 'ex-s-instruction', model.instruction));
  if (model.title) box.appendChild(exEl('h3', 'ex-s-title', model.title));
  if (model.legend) {
    const wrap = exEl('div', 'ex-s-legend');
    wrap.appendChild(exEl('strong', '', 'Field legend'));
    const ul = document.createElement('ul');
    model.legend.forEach(l => {
      const li = exEl('li', l.sub ? 'ex-s-sub' : '', l.text);
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    box.appendChild(wrap);
  }

  const list = model.blockMode ? box : box.appendChild(exEl('div', 'ex-s-oneline-list'));
  let shown = 0;
  let size = 0;
  for (const rec of model.games) {
    if (shown > 0 && size > PREVIEW_MAX_CHARS) break;
    size += exRecordLength(rec);
    shown++;

    if (!model.blockMode) {
      const row = exEl('div', 'ex-s-oneline');
      if (model.number) row.appendChild(exEl('span', 'ex-s-num', `${rec.number}.`));
      if (rec.name !== null) row.appendChild(exEl('strong', '', rec.name));
      if (rec.inline) row.appendChild(exEl('span', '', (rec.name !== null ? ' — ' : '') + rec.inline));
      list.appendChild(row);
      continue;
    }

    const section = exEl('section', 'ex-s-game');
    const heading = exGameHeading(rec, model);
    if (heading) section.appendChild(exEl('h4', 'ex-s-name', heading));
    rec.lines.forEach(line => {
      if (line.type === 'desc') {
        line.lines.join('\n').split(/\n{2,}/).forEach(p => section.appendChild(exEl('p', 'ex-s-desc', p)));
      } else if (line.type === 'stats') {
        const row = exEl('div', 'ex-s-line');
        line.parts.forEach((p, i) => {
          if (i) row.appendChild(document.createTextNode(' · '));
          row.appendChild(exEl('strong', '', p.label));
          row.appendChild(document.createTextNode(` ${p.text}`));
        });
        section.appendChild(row);
      } else {
        const row = exEl('div', 'ex-s-line');
        row.appendChild(exEl('strong', '', `${line.label}:`));
        row.appendChild(document.createTextNode(` ${line.text}`));
        section.appendChild(row);
      }
    });
    list.appendChild(section);
  }
  return shown;
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
    title: '',
    instruction: '',
    legend: extractPrefs.preset === 'detailed',
    view: 'styled'
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
    const heading = editEl('h2', 'edit-modal-title', 'Extract');
    heading.id = 'extract-title';
    modal.appendChild(heading);

    const layout = editEl('div', 'extract-layout');
    const settings = editEl('div', 'extract-settings');
    const previewCol = editEl('div', 'extract-previewcol');
    layout.append(settings, previewCol);
    modal.appendChild(layout);

    // --- Title ---
    const titleInput = editEl('input', 'extract-input');
    titleInput.type = 'text';
    titleInput.id = 'extract-title-input';
    titleInput.maxLength = 120;
    titleInput.dir = 'auto';
    titleInput.autocomplete = 'off';
    titleInput.placeholder = 'Optional, e.g. Games for Friday';
    titleInput.addEventListener('input', () => {
      state.title = titleInput.value;
      scheduleRefresh();
    });
    const titleLabel = editEl('label', 'extract-label', 'Title');
    titleLabel.htmlFor = 'extract-title-input';
    const titleRow = editEl('div', 'extract-row');
    titleRow.append(titleLabel, titleInput);
    settings.appendChild(titleRow);

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
    settings.appendChild(buildExtractRow('scope', 'Games', scopeSeg.el));

    // --- Sort + Number ---
    const sortSelect = editEl('select', 'extract-select');
    sortSelect.id = 'extract-sort';
    EXTRACT_SORTS.forEach(s => {
      const o = editEl('option', '', s.label);
      o.value = s.value;
      sortSelect.appendChild(o);
    });
    sortSelect.addEventListener('change', () => {
      extractPrefs.sort = sortSelect.value;
      saveExtractPrefs();
      scheduleRefresh();
    });
    const numberLabel = editEl('label', 'extract-check');
    const numberBox = document.createElement('input');
    numberBox.type = 'checkbox';
    numberBox.id = 'extract-number';
    numberBox.addEventListener('change', () => {
      extractPrefs.number = numberBox.checked;
      saveExtractPrefs();
      scheduleRefresh();
    });
    numberLabel.append(numberBox, document.createTextNode(' Number'));
    numberLabel.title = 'Put 1, 2, 3 ... in front of the games';
    const sortBox = editEl('div', 'extract-inline');
    sortBox.append(sortSelect, numberLabel);
    const sortLabel = editEl('label', 'extract-label', 'Sort');
    sortLabel.htmlFor = 'extract-sort';
    const sortRow = editEl('div', 'extract-row');
    sortRow.append(sortLabel, sortBox);
    settings.appendChild(sortRow);

    // --- Preset ---
    const presetSeg = buildSegmented({
      labelledBy: 'extract-label-preset',
      options: [...EXTRACT_PRESETS.map(p => ({ value: p.key, label: p.label })), { value: 'custom', label: 'Custom' }],
      getValue: () => extractPrefs.preset,
      onSelect: value => {
        applyExtractPreset(value);
        const p = EXTRACT_PRESETS.find(x => x.key === value);
        if (p) state.legend = p.legend;
        syncControls();
        scheduleRefresh();
      }
    });
    settings.appendChild(buildExtractRow('preset', 'Preset', presetSeg.el));

    // --- stats + Select all / Clear ---
    const fieldBar = editEl('div', 'extract-fieldbar');
    const stat = editEl('span', 'extract-stat');
    stat.setAttribute('role', 'status');
    const allBtn = editEl('button', 'extract-link-btn', 'Select all');
    allBtn.type = 'button';
    allBtn.addEventListener('click', () => {
      extractPrefs.fields = exSelectAllKeys();
      afterExtractFieldsEdited();
      syncControls();
      scheduleRefresh();
    });
    const clearBtn = editEl('button', 'extract-link-btn', 'Clear');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => {
      extractPrefs.fields = [];
      afterExtractFieldsEdited();
      syncControls();
      scheduleRefresh();
    });
    const links = editEl('span', 'extract-links');
    links.append(allBtn, document.createTextNode(' · '), clearBtn);
    fieldBar.append(stat, links);
    settings.appendChild(fieldBar);

    // --- Fields (chips) ---
    // "Game info" is in the same order as the output. Then one block per tag
    // group (Type, Production, Status), then the links.
    const chips = new Map();
    const fieldsBox = editEl('div', 'extract-chips');
    fieldsBox.setAttribute('role', 'group');
    fieldsBox.setAttribute('aria-label', 'Fields');

    // tagColor: a tag chip gets the same color as that tag on the main page
    function addChip(parent, key, label, extraClass, tagColor) {
      const chip = editEl('button', 'extract-chip' + (extraClass ? ` ${extraClass}` : ''));
      chip.type = 'button';
      if (tagColor) {
        chip.classList.add('extract-chip-tag');
        chip.style.setProperty('--chip-color', tagColor);
        chip.style.setProperty('--chip-text', TAG_TEXT_COLOR);
      }
      const check = editEl('span', 'extract-chip-check', '✓');
      check.setAttribute('aria-hidden', 'true');
      const text = editEl('span', 'extract-chip-text', label);
      text.id = `extract-field-${key.replace(/[^a-z0-9_-]/gi, '-')}`;
      chip.append(check, text);
      chip.addEventListener('click', () => {
        const at = extractPrefs.fields.indexOf(key);
        if (at >= 0) extractPrefs.fields.splice(at, 1);
        else extractPrefs.fields.push(key);
        afterExtractFieldsEdited();
        syncControls();
        scheduleRefresh();
      });
      parent.appendChild(chip);
      chips.set(key, chip);
      return chip;
    }

    function addBlock(caption) {
      const block = editEl('div', 'extract-block');
      block.setAttribute('role', 'group');
      block.setAttribute('aria-label', caption);
      block.appendChild(editEl('span', 'extract-block-caption', caption));
      const body = editEl('div', 'extract-block-body');
      block.appendChild(body);
      fieldsBox.appendChild(block);
      return body;
    }

    function addRow(body) {
      const row = editEl('div', 'extract-chip-group');
      body.appendChild(row);
      return row;
    }

    const infoBody = addBlock('Game info');
    let rowName = null;
    let rowBox = null;
    let descSeg = null;
    exActiveFields().filter(f => f.row !== 'links').forEach(field => {
      if (field.row !== rowName) {
        rowBox = addRow(infoBody);
        rowName = field.row;
      }
      addChip(rowBox, field.key, field.label);
      EXTRACT_SUBFIELDS.filter(s => s.parent === field.key).forEach(s => addChip(rowBox, s.key, s.label, 'extract-chip-sub'));
      if (field.key === 'description') {
        descSeg = buildSegmented({
          labelledBy: 'extract-field-description',
          options: EXTRACT_DESC_LEVELS,
          getValue: () => extractPrefs.desc,
          onSelect: value => {
            extractPrefs.desc = value;
            afterExtractFieldsEdited();
            syncControls();
            scheduleRefresh();
          }
        });
        descSeg.el.classList.add('extract-seg-small');
        rowBox.appendChild(descSeg.el);
      }
    });

    TAG_GROUPS.forEach(group => {
      const body = addBlock(group.title);
      let tagRow = null;
      exTagChips().filter(c => c.groupId === group.id).forEach(c => {
        // a "(any)" heading starts a new line of chips, its tags follow it
        if (c.isParent || !tagRow) tagRow = addRow(body);
        addChip(tagRow, c.key, c.label, c.isParent ? 'extract-chip-parent' : '', colorForTag(c.groupId, c.optionKey));
      });
    });

    const linksBody = addBlock('Links');
    const linksRow = addRow(linksBody);
    exActiveFields().filter(f => f.row === 'links').forEach(f => addChip(linksRow, f.key, f.label));

    settings.appendChild(fieldsBox);

    // --- Instruction + legend ---
    const instruction = editEl('textarea', 'extract-instruction');
    instruction.rows = 2;
    instruction.spellcheck = false;
    instruction.dir = 'auto';
    instruction.setAttribute('aria-label', 'Instruction placed above the list');
    instruction.placeholder = 'Optional instruction placed above the list, e.g. "Suggest a game for 3 players"';
    instruction.addEventListener('input', () => {
      state.instruction = instruction.value;
      scheduleRefresh();
    });
    const legendLabel = editEl('label', 'extract-check');
    const legendBox = document.createElement('input');
    legendBox.type = 'checkbox';
    legendBox.addEventListener('change', () => {
      state.legend = legendBox.checked;
      scheduleRefresh();
    });
    legendLabel.append(legendBox, document.createTextNode(' Field legend (explains the fields)'));
    const extras = editEl('div', 'extract-extras');
    extras.append(instruction, legendLabel);
    settings.appendChild(buildExtractRow('extras', 'Extra', extras));

    // --- preview column ---
    const previewHead = editEl('div', 'extract-preview-head');
    const previewLabel = editEl('span', 'extract-label', 'Preview');
    previewLabel.id = 'extract-label-preview';
    const viewSeg = buildSegmented({
      labelledBy: 'extract-label-preview',
      options: [{ value: 'styled', label: 'Styled' }, { value: 'plain', label: 'Plain text' }],
      getValue: () => state.view,
      onSelect: value => {
        state.view = value;
        viewSeg.refresh();
        renderPreview();
      }
    });
    viewSeg.el.classList.add('extract-seg-small');
    previewHead.append(previewLabel, viewSeg.el);

    const warn = editEl('p', 'extract-warn');
    warn.hidden = true;

    const styledBox = editEl('div', 'extract-styled');
    styledBox.tabIndex = 0;
    styledBox.setAttribute('role', 'region');
    styledBox.setAttribute('aria-label', 'Styled preview');

    const plainBox = editEl('textarea', 'extract-textarea extract-preview');
    plainBox.readOnly = true;
    plainBox.spellcheck = false;
    plainBox.dir = 'auto';
    plainBox.setAttribute('aria-label', 'Plain text preview');

    const note = editEl('p', 'extract-note');
    note.hidden = true;
    previewCol.append(previewHead, warn, styledBox, plainBox, note);

    // --- buttons ---
    const actions = editEl('div', 'edit-modal-actions extract-actions');
    const reset = editEl('button', 'edit-btn edit-btn-ghost extract-reset', 'Reset');
    reset.type = 'button';
    reset.title = 'Back to the default settings';
    reset.addEventListener('click', () => {
      const fresh = defaultExtractPrefs();
      Object.assign(extractPrefs, fresh);
      saveExtractPrefs();
      state.title = '';
      state.instruction = '';
      state.legend = false;
      titleInput.value = '';
      instruction.value = '';
      syncControls();
      scheduleRefresh();
    });

    const outputButtons = {};
    function addOutput(key, label, primary, title) {
      const b = editEl('button', 'edit-btn' + (primary ? ' edit-btn-primary' : ''), label);
      b.type = 'button';
      b.dataset.output = key;
      b.title = title;
      outputButtons[key] = b;
      return b;
    }
    const copy = addOutput('copy', 'Copy', true, 'Copy the plain text');
    copy.addEventListener('click', doCopy);
    ['txt', 'md', 'csv'].forEach(key => {
      const b = addOutput(key, `.${key}`, false, {
        txt: 'Download the plain text',
        md: 'Download as Markdown',
        csv: 'Download as a table for Excel'
      }[key]);
      b.addEventListener('click', () => doDownload(key));
    });
    const close = editEl('button', 'edit-btn', 'Close');
    close.type = 'button';
    close.addEventListener('click', closeModal);
    actions.append(reset, copy, outputButtons.txt, outputButtons.md, outputButtons.csv, close);
    modal.appendChild(actions);

    extractCopyHandler = doCopy;

    // ----- inner functions -----

    async function doCopy() {
      flushRefresh();
      if (!current || current.model.empty) return;
      const ok = await copyText(current.plain, plainBox);
      if (ok) {
        copy.textContent = 'Copied ✓';
        editToast(`Copied ${exPlural(current.model.count, 'game')}`);
        clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
      } else {
        // show the plain text, selected, so Ctrl+C works
        state.view = 'plain';
        viewSeg.refresh();
        renderPreview();
        plainBox.value = current.plain;
        plainBox.focus();
        plainBox.select();
        editToast('Could not copy automatically. The text is selected: press Ctrl+C.', true);
      }
    }

    function doDownload(key) {
      flushRefresh();
      if (!current || current.model.empty) return;
      const exp = exportAs(current.model, key);
      downloadExport(exp, exportFileName(current.model.title, exp.ext));
    }

    // Controls follow the settings (the window is not rebuilt)
    function syncControls() {
      scopeSeg.refresh();
      presetSeg.refresh();
      descSeg.refresh();
      viewSeg.refresh();
      chips.forEach((chip, key) => {
        chip.setAttribute('aria-pressed', extractPrefs.fields.includes(key) ? 'true' : 'false');
      });
      const playersOn = extractPrefs.fields.includes('players');
      EXTRACT_SUBFIELDS.forEach(s => { chips.get(s.key).disabled = !playersOn; });
      const descOn = extractPrefs.fields.includes('description');
      EXTRACT_DESC_LEVELS.forEach(l => { descSeg.button(l.value).disabled = !descOn; });
      sortSelect.value = extractPrefs.sort;
      numberBox.checked = extractPrefs.number;
      legendBox.checked = state.legend;
    }

    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshPreview, PREVIEW_DEBOUNCE_MS);
    }

    // Copy / Download call this first, so a change made a moment ago is included
    function flushRefresh() {
      if (refreshTimer) refreshPreview();
    }

    // Builds the model once, then draws the preview, the numbers and the warning
    function refreshPreview() {
      clearTimeout(refreshTimer);
      refreshTimer = null;
      const model = buildExportModel(games, {
        fields: extractPrefs.fields,
        desc: extractPrefs.desc,
        sort: extractPrefs.sort,
        number: extractPrefs.number,
        title: state.title,
        instruction: state.instruction,
        legend: state.legend
      });
      current = { model, plain: modelToText(model, 'plain') };

      const bytes = exByteLength(current.plain);
      stat.textContent = model.empty ? exPlural(model.count, 'game') : `${exPlural(model.count, 'game')} · ${exFormatBytes(bytes)}`;
      Object.values(outputButtons).forEach(b => { b.disabled = model.empty; });

      const big = bytes > WARN_BYTES;
      warn.hidden = !big;
      warn.textContent = big
        ? `⚠ Large output (${exFormatBytes(bytes)}). ${extractPrefs.fields.includes('description') && extractPrefs.desc === 'full' ? 'Try a shorter description' : 'Try fewer fields'}.`
        : '';
      renderPreview();
    }

    // Shows the current model in the chosen view
    function renderPreview() {
      const model = current.model;
      const styled = state.view === 'styled';
      styledBox.hidden = !styled;
      plainBox.hidden = styled;
      note.hidden = true;

      let message = '';
      if (!model.count) message = state.scope === 'selected' ? 'No games selected.' : 'No games match the current filters.';
      else if (!model.fields.length) message = 'Pick at least one field.';

      if (styled) {
        const shown = renderStyled(model, styledBox);
        if (message) styledBox.appendChild(editEl('p', 'extract-empty', message));
        if (shown && shown < model.count) {
          note.hidden = false;
          note.textContent = `Showing the first ${shown.toLocaleString('en-US')} of ${model.count.toLocaleString('en-US')} games. Copy and downloads use everything.`;
        }
      } else {
        const text = current.plain;
        const cut = text.length > PREVIEW_MAX_CHARS;
        plainBox.value = cut ? exSafeSlice(text, PREVIEW_MAX_CHARS) : text;
        plainBox.placeholder = message;
        if (cut) {
          note.hidden = false;
          note.textContent = `Showing the first ${PREVIEW_MAX_CHARS.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters. Copy and downloads use everything.`;
        }
      }
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
