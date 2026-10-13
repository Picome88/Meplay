// =====================================================================
// my-tags.js  -  My personal tag filters (Type + Production + Status)
//
// HOW IT WORKS
//  * my_tags.json holds, for every game I tagged, its "type" and "status".
//  * Every option is a 4-state checkbox (Off / OR / AND / Exclude). The
//    matching rule is the shared matchesTri() in app-sqlite.js.
//  * Different filters (Type, Status, players, time, ...) combine with AND.
//  * The colors of the tags are all in ONE table: TAG_COLORS (below).
//
// TO ADD A NEW FRIEND: add one line to the "Physical" options below, e.g.
//   { key: 'sara', label: 'Sara' },
// (it gets the brown "Physical" color by itself; to give it its own color,
//  add one line to TAG_COLORS, e.g.  'type/sara': '#336699',)
// =====================================================================

// Where my_tags.json lives (used by edit mode, see my-edit.js)
const MYTAGS_REPO = 'Picome88/Meplay';
const MYTAGS_FILE = 'my_tags.json';
const MYTAGS_TOKEN_KEY = 'meplay_gh_token';

const TAG_GROUPS = [
  {
    id: 'type',
    title: 'Type',
    sections: [
      {
        key: 'physical',
        label: 'Physical (any)',
        options: [
          { key: 'mine', label: 'Mine' },
          { key: 'mohsen', label: 'Mohsen' },
          { key: 'amirali', label: 'Amirali' },
          { key: 'other', label: 'Others' }
        ]
      },
      {
        key: 'digital',
        label: 'Digital (any)',
        options: [
          { key: 'bga_ready', label: 'BGA (Normal)' },
          { key: 'bga_beta', label: 'BGA (Alfa/Beta)' },
          { key: 'other_site', label: 'Elsewhere' }
        ]
      }
    ]
  },
  {
    id: 'production',
    title: 'Production',
    sections: [
      {
        key: null, // no parent heading: plain list
        options: [
          { key: 'pnp', label: 'PnP' },
          { key: 'produced_iran', label: 'Iranian' },
          { key: 'produced_original', label: 'Original' }
        ]
      }
    ]
  },
  {
    id: 'status',
    title: 'Status',
    sections: [
      {
        key: null, // no parent heading: plain list
        options: [
          { key: 'interested', label: 'Wanted' },
          { key: 'learned', label: 'Known' },
          { key: 'played', label: 'Played' },
          { key: 'replay', label: 'Revisit' }
        ]
      }
    ]
  }
];

// ---------------------------------------------------------------------
// TAG COLORS - the one and only place where tag colors are defined.
// Key = "group/option" (the same keys as in TAG_GROUPS above).
// Text on every tag is white. All colors keep a contrast of at least 4.5:1.
// An option without its own row uses the row of its parent heading
// (e.g. a new friend under Physical -> 'type/physical'), then grey.
// ---------------------------------------------------------------------
const TAG_TEXT_COLOR = '#ffffff';
const TAG_DEFAULT_COLOR = '#555555';
const TAG_COLORS = {
  // Type > Physical (brown family)
  'type/physical': '#9C6040',   // default for any new friend under Physical
  'type/mine': '#9C6040',
  'type/mohsen': '#9C6040',
  'type/amirali': '#9C6040',
  'type/other': '#7A6A60',

  // Type > Digital
  'type/bga_ready': '#4169E1',  // BGA (Normal)
  'type/bga_beta': '#A044D0',   // BGA (Alfa/Beta)
  'type/other_site': '#0B7FA8', // Elsewhere

  // Production (all the same)
  'production/pnp': '#587890',
  'production/produced_iran': '#587890',
  'production/produced_original': '#587890',

  // Status
  'status/interested': '#E0147A', // Wanted
  'status/learned': '#0B7F3C',    // Known
  'status/played': '#7D7269',     // Played
  'status/replay': '#C44409'      // Revisit
};

function colorForTag(groupId, optionKey) {
  const exact = TAG_COLORS[`${groupId}/${optionKey}`];
  if (exact) return exact;
  const group = TAG_GROUPS.find(g => g.id === groupId);
  const parent = group ? sectionKeyOf(group, optionKey) : null;
  return (parent && TAG_COLORS[`${groupId}/${parent}`]) || TAG_DEFAULT_COLOR;
}

// myTagData = { "173346": { type: ["mine"], production: ["pnp"], status: ["played"] }, ... }
let myTagData = {};

function myTagKey(x) {
  return String(x).trim().toLowerCase();
}

async function loadMyTags() {
  let data = null;

  // If a token is saved (edit mode), read straight from GitHub: always the
  // newest version, even before GitHub Pages has finished rebuilding.
  let token = '';
  try { token = localStorage.getItem(MYTAGS_TOKEN_KEY) || ''; } catch (e) { /* ignore */ }
  if (token) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${MYTAGS_REPO}/contents/${MYTAGS_FILE}?t=${Date.now()}`,
        { cache: 'no-store', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.raw+json' } }
      );
      if (res.ok) data = await res.json();
    } catch (e) {
      console.warn('Could not read tags from GitHub API, using the published file instead:', e);
    }
  }

  if (!data) {
    try {
      const response = await fetch('./my_tags.json?v=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status);
      data = await response.json();
    } catch (e) {
      console.warn('Could not load my_tags.json (tag filters will be empty):', e);
    }
  }

  myTagData = (data && data.games) || {};
  console.log('Loaded my_tags.json:', Object.keys(myTagData).length, 'games tagged');
}

// Which parent-heading key does an option belong to? (e.g. mine -> physical)
function sectionKeyOf(group, optionKey) {
  for (const s of group.sections) {
    if (s.key && s.options.some(o => o.key === optionKey)) return s.key;
  }
  return null;
}

// Puts row.my_tags = { type: Set, status: Set } on a game.
// Parent headings (physical/digital) are added automatically.
function applyMyTags(game) {
  const entry = myTagData[String(game.id)] || {};
  const result = {};
  TAG_GROUPS.forEach(group => {
    const keys = new Set();
    (entry[group.id] || []).forEach(k => {
      keys.add(k);
      const parent = sectionKeyOf(group, k);
      if (parent) keys.add(parent);
    });
    result[group.id] = keys;
  });
  game.my_tags = result;
}

// ---------- building the sidebar dropdowns ----------

function setupMyTagFilters() {
  TAG_GROUPS.forEach(group => {
    const items = [];
    group.sections.forEach(section => {
      if (section.key) {
        items.push({ label: section.label, value: section.key, count: 0, indent: false });
      }
      section.options.forEach(opt => {
        items.push({ label: opt.label, value: opt.key, count: 0, indent: !!section.key });
      });
    });

    createRefinementFilter(`facet-my-${group.id}`, group.title, items, `my_${group.id}`);

    // Indent the options that sit under a heading
    const indented = new Set(items.filter(i => i.indent).map(i => i.value));
    document.querySelectorAll(`#facet-my-${group.id} input`).forEach(input => {
      if (indented.has(input.value)) {
        const label = input.closest('label.filter-item');
        if (label) label.style.paddingLeft = '20px';
      }
    });
  });
}

// ---------- tag text for a game (shown in the game panel, see renderMyTagsSection) ----------

function labelForTag(groupId, key) {
  const group = TAG_GROUPS.find(g => g.id === groupId);
  if (!group) return key;
  for (const s of group.sections) {
    const opt = s.options.find(o => o.key === key);
    if (opt) return opt.label;
  }
  return key;
}

// One row per group that has tags: "Type  [Mine] [BGA - ready to play]"
function renderMyTagsRows(container, id) {
  container.textContent = '';
  const entry = myTagData[String(id)] || {};
  let total = 0;
  TAG_GROUPS.forEach(g => {
    const keys = entry[g.id] || [];
    if (!keys.length) return;
    const row = document.createElement('div');
    row.className = 'my-tags-row';
    const name = document.createElement('span');
    name.className = 'my-tags-group';
    name.textContent = g.title;
    row.appendChild(name);
    keys.forEach(key => {
      const chip = document.createElement('span');
      chip.className = `my-chip my-chip-${g.id}`;
      chip.textContent = labelForTag(g.id, key);
      chip.style.background = colorForTag(g.id, key);
      chip.style.color = TAG_TEXT_COLOR;
      row.appendChild(chip);
      total++;
    });
    container.appendChild(row);
  });
  if (!total) {
    const empty = document.createElement('span');
    empty.className = 'my-tags-empty';
    empty.textContent = 'Not tagged yet';
    container.appendChild(empty);
  }
}

// Adds a "My tags" block at the bottom of the opened game panel.
function renderMyTagsSection(fragment, game) {
  const panel = fragment.querySelector('.game-details');
  if (!panel) return;
  const section = document.createElement('div');
  section.className = 'my-tags-section';
  const heading = document.createElement('h2');
  heading.textContent = 'My tags';
  const body = document.createElement('div');
  body.className = 'my-tags-body';
  renderMyTagsRows(body, game.id);
  section.append(heading, body);
  panel.appendChild(section);
}

// ---------- show the chosen options as chips under each filter button ----------

// Radio filters use these values for "no filter"
const FILTER_NEUTRAL_VALUES = ['0-100', '0-9999'];

// Colors of the chips come from the CSS variables --state-or / --state-and / --state-not
// (the same ones that color the checkboxes).

// ONE builder for every chip (filter chips here, the "List" chip in my-list.js):
//   [ x ] [ label ] [ mark ]   - clicking anywhere on the chip removes it.
//   stateClass: "or" / "and" / "not" (state colors) or "neutral" (no state, e.g. List)
//   mark:       small extra sign after the label (the "&" of AND), optional
//   strike:     draw the label with a line through it (Exclude), optional
//   title / ariaLabel: tooltip and screen reader text
//   onRemove(event): called on click / Enter / Space
function buildFilterChip({ stateClass, label, mark, strike, title, ariaLabel, onRemove }) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `filter-chip filter-chip-${stateClass}`;
  if (title) chip.title = title;
  chip.setAttribute('aria-label', ariaLabel || label);

  const x = document.createElement('span');
  x.className = 'filter-chip-x';
  x.setAttribute('aria-hidden', 'true');
  x.textContent = '\u00D7';

  const text = document.createElement('span');
  text.className = strike ? 'filter-chip-label filter-chip-strike' : 'filter-chip-label';
  text.textContent = label;
  chip.append(x, text);

  if (mark) {
    const markEl = document.createElement('span');
    markEl.className = 'filter-chip-mark';
    markEl.setAttribute('aria-hidden', 'true');
    markEl.textContent = mark;
    chip.appendChild(markEl);
  }

  if (onRemove) chip.addEventListener('click', onRemove);
  return chip;
}

// Takes one option out of its filter (the chip was clicked)
function removeFilterOption(input) {
  if (input.type === 'radio') {
    // Min age / Num plays: back to the neutral option
    const neutral = Array.from(document.querySelectorAll(`input[type="radio"][name="${input.name}"]`))
      .find(r => FILTER_NEUTRAL_VALUES.includes(r.value));
    if (neutral) neutral.checked = true;
  } else {
    setTriState(input, 0);
  }
  onFilterChange();
}

// After a chip is removed with the keyboard the chips are rebuilt: put the focus
// on the chip that took its place, or on the filter button when none is left
function refocusAfterChipRemoval(groupIndex, chipIndex) {
  const group = document.querySelectorAll('.filter-group')[groupIndex];
  if (!group) return;
  const next = group.querySelectorAll('.filter-chip')[chipIndex];
  const target = next || group.querySelector('details.filter-dropdown > summary');
  if (target) target.focus();
}

// Builds the chips of every filter from the current state of its options.
function updateFilterChips() {
  document.querySelectorAll('.filter-group').forEach(group => {
    const details = group.querySelector('details.filter-dropdown');
    const chips = group.querySelector('.filter-chips');
    if (!details || !chips) return;
    chips.textContent = '';

    const labelOf = input => {
      const el = input.closest('label')?.querySelector('.filter-label');
      return (el ? el.textContent : input.value).replace(/\s*\(any\)\s*$/i, '').trim();
    };

    const addChip = (input, state) => {
      const st = TRI_STATES[state];
      const name = labelOf(input);
      const chip = buildFilterChip({
        stateClass: st.set,
        label: name,
        mark: state === 2 ? '&' : '',
        strike: state === 3,
        title: `Click to remove: ${name} (${st.label})`,
        ariaLabel: `Remove ${name} (${st.label})`,
        onRemove: event => {
          const groups = Array.from(document.querySelectorAll('.filter-group'));
          const groupIndex = groups.indexOf(group);
          const chipIndex = Array.from(chips.children).indexOf(chip);
          removeFilterOption(input);
          if (event.detail === 0) refocusAfterChipRemoval(groupIndex, chipIndex);   // keyboard
        }
      });
      chips.appendChild(chip);
    };

    details.querySelectorAll('input').forEach(input => {
      if (input.type === 'radio') {
        if (input.checked && !FILTER_NEUTRAL_VALUES.includes(input.value)) addChip(input, 1);
        return;
      }
      const state = Number(input.dataset.state) || 0;
      if (state > 0 && labelOf(input)) addChip(input, state);
    });
  });
}
