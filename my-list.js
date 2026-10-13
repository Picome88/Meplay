// =====================================================================
// my-list.js  -  "List" button: find a whole list of game names at once
//
// HOW IT WORKS
//  * "List" button (top bar, between Select and Update) opens a window.
//    Paste one game name per line, press "Find".
//  * Every line is matched against the names of all my games:
//      Certain  = the name is exactly one game (after cleaning)
//      Not sure = similar games exist (subtitle, typo, other word order):
//                 you accept the right one by hand, nothing is automatic
//      Not found
//  * "Show N games" keeps only those games on the page (a filter, combined
//    with all the other filters by AND). A chip "List: N" shows it; clicking
//    the chip, or "Clear filters", turns the list filter off.
//  * "Tag all (N)..." (next to the chip) turns Edit mode on, selects every
//    game that is shown and opens the normal tag window.
//  * The text, the review and the filter live only in memory: nothing goes
//    to the URL or to localStorage, and a page reload clears them.
//
// The matching functions (cleanLine ... listResultIds) do not touch the page,
// so they can be tested alone.
//
// Needs from my-edit.js: editState, editEl, editToast, openModal, closeModal,
//   clearSelection, selectAllFiltered, openTagModal, setEditMode, getHeaderActions
// Needs from my-select.js: decodeHtmlEntities, copyText, isSelectModeOn, setSelectMode
// Needs from my-tags.js: buildFilterChip
// Needs from app-sqlite.js: allGames, filteredGames, onFilterChange
// =====================================================================

// ---------- settings of the matching (change the numbers here) ----------

const LIST_MIN_LINE_LENGTH = 2;       // shorter lines are ignored
const LIST_MAX_CANDIDATES = 5;        // "not sure" candidates shown per line
const LIST_FUZZY_MIN_LENGTH = 4;      // typo matching only for names at least this long
const LIST_PREFIX_MIN_LENGTH = 3;     // subtitle matching only if the shorter name has this many letters
const LIST_LONG_NAME_LENGTH = 6;      // names longer than this may have more typos
const LIST_MAX_EDITS_LONG = 2;        // typos allowed in long names
const LIST_MAX_EDITS_SHORT = 1;       // typos allowed in short names
const LIST_MIN_SIMILARITY = 0.85;     // or: 1 - edits / length at least this
const LIST_MIN_WORD_OVERLAP = 0.8;    // shared words / words of the longer name, any order
const LIST_PREFIX_BASE_SCORE = 0.85;  // score of a subtitle match = base + (1 - base) * length ratio

// ---------- cleaning and normalizing ----------

// One pasted line -> the bare name: no bullet / number at the start, no (year) at the end
function cleanLine(line) {
  return String(line)
    .trim()
    .replace(/^(?:\d+\s*[.)]\s*|[-*\u2022\u00B7\u2013\u2014]\s+)+/, '')   // "12." "12)" "-" "*" bullet
    .replace(/\s*\(\s*\d{4}\s*\)\s*$/, '')                                // "(1995)"
    .trim();
}

// The same text for pasted names and for names of the site:
// no entities, no capitals, no accents, "&" = "and", no signs, no leading "the"
function normalizeName(text) {
  let t = decodeHtmlEntities(text).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // e with accent -> e
    .replace(/&/g, ' and ')
    .replace(/['\u2019`]/g, '')                          // don't -> dont
    .replace(/[^\p{L}\p{N}]+/gu, ' ')                    // every other sign -> space
    .replace(/\s+/g, ' ')
    .trim();
  if (t.startsWith('the ') && t.length > 4) t = t.slice(4);
  return t;
}

// The pasted text -> unique lines [{ raw, name, key }] (key = normalized name)
function parseListText(text) {
  const seen = new Set();
  const lines = [];
  String(text).split(/\r\n|\r|\n/).forEach(rawLine => {
    const raw = rawLine.trim();
    const name = cleanLine(raw);
    if (name.length < LIST_MIN_LINE_LENGTH) return;
    const key = normalizeName(name);
    if (!key || seen.has(key)) return;   // the same name twice counts once
    seen.add(key);
    lines.push({ raw, name, key });
  });
  return lines;
}

// ---------- the index of the site names (built once) ----------

// How many of each letter / digit a name has (37 slots). Two names that are
// few edits apart have almost the same counts: a cheap test before the slow one.
const LIST_HIST_SIZE = 37;
function charHistogram(norm) {
  const hist = new Uint8Array(LIST_HIST_SIZE);
  for (let i = 0; i < norm.length; i++) {
    const c = norm.charCodeAt(i);
    let slot = LIST_HIST_SIZE - 1;                       // other letters
    if (c >= 97 && c <= 122) slot = c - 97;              // a-z
    else if (c >= 48 && c <= 57) slot = 26 + (c - 48);   // 0-9
    else if (c === 32) continue;                         // spaces do not count
    hist[slot] = Math.min(255, hist[slot] + 1);
  }
  return hist;
}

// Everything the matching needs to know about one normalized name
function describeName(norm) {
  const words = norm.split(' ');
  return { norm, words, wordSet: new Set(words), hist: charHistogram(norm) };
}

function buildNameIndex(games) {
  const entries = [];
  const exact = new Map();   // normalized name -> [entry, ...]
  games.forEach(game => {
    const norm = normalizeName(game.name);
    if (!norm) return;
    const entry = { id: String(game.id), name: decodeHtmlEntities(game.name), ...describeName(norm) };
    entries.push(entry);
    if (!exact.has(norm)) exact.set(norm, []);
    exact.get(norm).push(entry);
  });
  return { entries, exact };
}

// ---------- similarity ----------

// Number of edits between a and b, or limit + 1 when it is more than limit
function boundedEditDistance(a, b, limit) {
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > limit) return limit + 1;
  let prev = new Array(bl + 1), cur = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return limit + 1;
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[bl] > limit ? limit + 1 : prev[bl];
}

// "catan" is a word-prefix of "catan seafarers" (only the subtitle differs)
function isWordPrefix(shorter, longer) {
  return longer === shorter || longer.startsWith(shorter + ' ');
}

// How similar are the line and one site name? 0 = not similar at all.
// The best of: subtitle difference, typos, same words in another order.
// line and entry both come from describeName().
function similarityScore(line, entry) {
  let best = 0;
  const a = line.norm, b = entry.norm;

  // 1. one name is the other plus a subtitle
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= LIST_PREFIX_MIN_LENGTH && isWordPrefix(shorter, longer)) {
    best = Math.max(best, LIST_PREFIX_BASE_SCORE + (1 - LIST_PREFIX_BASE_SCORE) * (shorter.length / longer.length));
  }

  // 2. typos (the slow test runs only when the cheap ones say it is possible)
  if (a.length >= LIST_FUZZY_MIN_LENGTH && b.length >= LIST_FUZZY_MIN_LENGTH) {
    const maxLen = Math.max(a.length, b.length);
    const allowed = maxLen > LIST_LONG_NAME_LENGTH ? LIST_MAX_EDITS_LONG : LIST_MAX_EDITS_SHORT;
    const limit = Math.max(allowed, Math.floor((1 - LIST_MIN_SIMILARITY) * maxLen));
    if (Math.abs(a.length - b.length) <= limit && histogramDistance(line.hist, entry.hist) <= 2 * limit) {
      const dist = boundedEditDistance(a, b, limit);
      if (dist <= limit) best = Math.max(best, 1 - dist / maxLen);
    }
  }

  // 3. the same words in another order
  const bigger = Math.max(line.words.length, entry.words.length);
  if (bigger > 1) {
    let shared = 0;
    for (const w of line.words) if (entry.wordSet.has(w)) shared++;
    if (shared / bigger >= LIST_MIN_WORD_OVERLAP) best = Math.max(best, shared / bigger);
  }
  return best;
}

// Sum of the differences of two histograms (a lower bound of 2 x the edits)
function histogramDistance(h1, h2) {
  let sum = 0;
  for (let i = 0; i < LIST_HIST_SIZE; i++) sum += Math.abs(h1[i] - h2[i]);
  return sum;
}

// One cleaned line -> { status: 'certain' | 'uncertain' | 'notfound', candidates: [{ id, name, score }] }
function matchLine(line, index) {
  const norm = normalizeName(line);
  const toCandidate = (entry, score) => ({ id: entry.id, name: entry.name, score });

  const same = index.exact.get(norm);
  if (same && same.length === 1) {
    return { status: 'certain', candidates: [toCandidate(same[0], 1)] };
  }
  if (same && same.length > 1) {   // several games with this exact name: you decide
    return { status: 'uncertain', candidates: same.slice(0, LIST_MAX_CANDIDATES).map(e => toCandidate(e, 1)) };
  }

  const lineInfo = describeName(norm);
  const found = [];
  index.entries.forEach(entry => {
    const score = similarityScore(lineInfo, entry);
    if (score > 0) found.push(toCandidate(entry, score));
  });
  found.sort((x, y) => y.score - x.score || x.name.length - y.name.length || x.name.localeCompare(y.name));
  const candidates = found.slice(0, LIST_MAX_CANDIDATES);
  return { status: candidates.length ? 'uncertain' : 'notfound', candidates };
}

// All the lines -> [{ raw, name, key, status, candidates }]
function matchAllLines(lines, index) {
  return lines.map(line => ({ ...line, ...matchLine(line.name, index) }));
}

// The games of the list: every certain one + the accepted candidates.
// accepted = Map(line key -> Set of game ids). Each game is counted once.
function listResultIds(results, accepted) {
  const ids = new Set();
  results.forEach(r => {
    if (r.status === 'certain') ids.add(r.candidates[0].id);
    else if (r.status === 'uncertain') {
      const chosen = accepted.get(r.key);
      if (chosen) r.candidates.forEach(c => { if (chosen.has(c.id)) ids.add(c.id); });
    }
  });
  return ids;
}

// ---------- state (memory only) ----------

const listState = {
  text: '',               // the pasted text
  results: null,          // result of the last Find
  accepted: new Map(),    // line key -> Set of accepted game ids
  ids: null,              // Set of game ids while the filter is on, otherwise null
  index: null             // the name index, built on the first Find
};

// Used by filterGames() in app-sqlite.js: null = no list filter
function getListFilterIds() {
  return listState.ids;
}

// Turns the filter off (the text and the review stay in memory)
function clearListFilter() {
  listState.ids = null;
}

// ---------- the window ----------

const pluralGames = n => `${n} game${n === 1 ? '' : 's'}`;

function openListModal() {
  if (!allGames.length) return;
  openModal(modal => {
    modal.classList.add('list-modal');
    if (listState.results) renderListReview(modal);
    else renderListInput(modal);
  });
}

// View 1: the text box
function renderListInput(modal) {
  modal.textContent = '';
  modal.appendChild(editEl('h2', 'edit-modal-title', 'Find a list of games'));
  modal.appendChild(editEl('p', 'edit-modal-sub', 'One game name per line. Numbers, bullets and (years) are ignored.'));

  const area = document.createElement('textarea');
  area.className = 'extract-textarea list-textarea';
  area.rows = 10;
  area.dir = 'ltr';
  area.spellcheck = false;
  area.setAttribute('aria-label', 'Game names, one per line');
  area.value = listState.text;
  modal.appendChild(area);

  const count = editEl('p', 'edit-modal-sub list-count');
  modal.appendChild(count);

  const actions = editEl('div', 'edit-modal-actions');
  const cancel = editEl('button', 'edit-btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', closeModal);
  const find = editEl('button', 'edit-btn edit-btn-primary', 'Find');
  find.type = 'button';
  actions.append(cancel, find);
  modal.appendChild(actions);

  const refresh = () => {
    listState.text = area.value;
    const n = parseListText(area.value).length;
    count.textContent = `${n} name${n === 1 ? '' : 's'}`;
    find.disabled = n === 0;
  };
  area.addEventListener('input', refresh);
  refresh();

  find.addEventListener('click', () => {
    const lines = parseListText(area.value);
    if (!lines.length) return;
    if (!listState.index) listState.index = buildNameIndex(allGames);
    listState.results = matchAllLines(lines, listState.index);
    renderListReview(modal);
  });
  area.focus();
}

// View 2: the review
function renderListReview(modal) {
  modal.textContent = '';
  const results = listState.results;
  const certain = results.filter(r => r.status === 'certain');
  const unsure = results.filter(r => r.status === 'uncertain');
  const missing = results.filter(r => r.status === 'notfound');

  modal.appendChild(editEl('h2', 'edit-modal-title', 'Review'));
  modal.appendChild(editEl('p', 'edit-modal-sub',
    `${certain.length} found \u00B7 ${unsure.length} not sure \u00B7 ${missing.length} not found (of ${results.length})`));

  // Certain: only the count, the names are one click away
  if (certain.length) {
    const details = editEl('details', 'list-section');
    // a click on the page closes every open <details> (closeAll in app-sqlite.js): not this one
    details.addEventListener('click', event => event.stopPropagation());
    details.appendChild(editEl('summary', '', `Certain (${certain.length})`));
    const body = editEl('ul', 'list-names');
    certain.map(r => r.candidates[0].name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .forEach(name => body.appendChild(editEl('li', '', name)));
    details.appendChild(body);
    modal.appendChild(details);
  }

  // Not sure: pick the right game for each line (nothing is picked for you)
  const showBtn = editEl('button', 'edit-btn edit-btn-primary');
  showBtn.type = 'button';
  const refreshShow = () => {
    const n = listResultIds(results, listState.accepted).size;
    showBtn.textContent = `Show ${pluralGames(n)}`;
    showBtn.disabled = n === 0;
  };

  if (unsure.length) {
    const section = editEl('div', 'list-section');
    section.appendChild(editEl('h3', 'list-section-title', `Not sure (${unsure.length})`));
    unsure.forEach(r => {
      const row = editEl('div', 'list-unsure');
      row.appendChild(editEl('div', 'list-line-name', r.name));
      const cands = editEl('div', 'list-cands');
      r.candidates.forEach(c => {
        const btn = editEl('button', 'list-cand');
        btn.type = 'button';
        btn.appendChild(editEl('span', 'list-cand-check'));
        btn.appendChild(editEl('span', 'list-cand-name', c.name));
        btn.appendChild(editEl('span', 'list-cand-id', `#${c.id}`));
        const paint = () => {
          const on = !!listState.accepted.get(r.key)?.has(c.id);
          btn.classList.toggle('accepted', on);
          btn.setAttribute('aria-pressed', String(on));
          btn.firstChild.textContent = on ? '\u2713' : '';
          btn.setAttribute('aria-label', `${on ? 'Accepted' : 'Accept'}: ${c.name} (BGG #${c.id}) for "${r.name}"`);
        };
        btn.addEventListener('click', () => {
          let chosen = listState.accepted.get(r.key);
          if (!chosen) listState.accepted.set(r.key, chosen = new Set());
          if (chosen.has(c.id)) chosen.delete(c.id); else chosen.add(c.id);
          paint();
          refreshShow();
        });
        paint();
        cands.appendChild(btn);
      });
      row.appendChild(cands);
      section.appendChild(row);
    });
    modal.appendChild(section);
  }

  // Not found: the lines, ready to copy
  if (missing.length) {
    const section = editEl('div', 'list-section');
    section.appendChild(editEl('h3', 'list-section-title', `Not found (${missing.length})`));
    const area = document.createElement('textarea');
    area.className = 'extract-textarea';
    area.readOnly = true;
    area.rows = Math.min(missing.length, 6);
    area.dir = 'ltr';
    area.spellcheck = false;
    area.setAttribute('aria-label', 'Names that were not found');
    area.value = missing.map(r => r.raw).join('\n');
    section.appendChild(area);
    const copy = editEl('button', 'edit-btn', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      if (await copyText(area)) editToast(`Copied ${missing.length} name${missing.length === 1 ? '' : 's'}`);
      else editToast('Could not copy automatically. The text is selected: press Ctrl+C.', true);
    });
    section.appendChild(copy);
    modal.appendChild(section);
  }

  const actions = editEl('div', 'edit-modal-actions list-actions');
  const back = editEl('button', 'edit-btn edit-btn-ghost', 'Back');
  back.type = 'button';
  back.addEventListener('click', () => renderListInput(modal));
  const cancel = editEl('button', 'edit-btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', closeModal);
  showBtn.addEventListener('click', () => {
    listState.ids = listResultIds(results, listState.accepted);
    closeModal();
    onFilterChange();
  });
  actions.append(back, cancel, showBtn);
  modal.appendChild(actions);
  refreshShow();
}

// ---------- chip + "Tag all" under the filters ----------

let listBar = null;

function setupListBar() {
  const clearAll = document.getElementById('clear-all');
  if (!clearAll || listBar) return;
  listBar = editEl('div', 'list-bar');
  listBar.id = 'list-bar';
  listBar.hidden = true;
  clearAll.parentNode.insertBefore(listBar, clearAll);
}

// Called at the end of applyFiltersAndSort(), when filteredGames is up to date
function refreshListBar() {
  if (!listBar) return;
  listBar.textContent = '';
  const ids = listState.ids;
  listBar.hidden = !ids;
  if (!ids) return;

  const shown = filteredGames.length;
  const hidden = ids.size - shown;
  const note = hidden > 0 ? `${hidden} hidden by other filters` : '';

  listBar.appendChild(buildFilterChip({
    stateClass: 'neutral',
    label: `List: ${ids.size}`,
    title: `Click to remove the list filter${note ? ` (${note})` : ''}`,
    ariaLabel: `Remove List filter (${pluralGames(ids.size)})`,
    onRemove: event => {
      clearListFilter();
      onFilterChange();
      if (event.detail === 0) document.getElementById('list-toggle')?.focus();   // keyboard
    }
  }));
  if (note) listBar.appendChild(editEl('span', 'list-hidden-note', `(${note})`));

  const tagAll = editEl('button', 'edit-btn edit-btn-primary', `Tag all (${shown})\u2026`);
  tagAll.type = 'button';
  tagAll.disabled = shown === 0;
  tagAll.addEventListener('click', tagAllShown);
  listBar.appendChild(tagAll);
}

// Opens the normal tag window for every game that is shown (all pages)
function tagAllShown() {
  if (!filteredGames.length) return;
  if (isSelectModeOn()) setSelectMode(false);   // Edit and Select are never on together
  if (!editState.on) setEditMode(true);
  clearSelection();
  selectAllFiltered();
  openTagModal([...editState.selected]);
}

// ---------- the button in the top bar ----------

function setupListButton() {
  const box = getHeaderActions();
  if (!box || document.getElementById('list-toggle')) return;
  const btn = editEl('button', 'edit-toggle', 'List');
  btn.id = 'list-toggle';
  btn.type = 'button';
  btn.disabled = true;   // until the games are loaded (enableListButton)
  btn.title = 'Find a list of games by name';
  btn.addEventListener('click', openListModal);
  // order in the top bar: Edit, Select, List, Update
  const update = document.getElementById('sync-btn');
  if (update && update.parentNode === box) box.insertBefore(btn, update);
  else box.appendChild(btn);
}

// Called by initializeUI() in app-sqlite.js once allGames is ready
function enableListButton() {
  const btn = document.getElementById('list-toggle');
  if (btn) btn.disabled = false;
}

setupListButton();
setupListBar();
