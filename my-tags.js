// =====================================================================
// my-tags.js  -  My personal tag filters (Type + Production + Status)
//
// HOW IT WORKS
//  * my_tags.json holds, for every game I tagged, its "type" and "status".
//  * Inside one group (e.g. Type) the selected options combine with OR.
//  * Different groups (Type, Status, players, time, ...) combine with AND.
//
// TO ADD A NEW FRIEND: add one line to the "Physical" options below, e.g.
//   { key: 'sara', label: 'Sara' },
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
          { key: 'other', label: 'Other' }
        ]
      },
      {
        key: 'digital',
        label: 'Digital (any)',
        options: [
          { key: 'bga_ready', label: 'BGA - ready to play' },
          { key: 'bga_beta', label: 'BGA - alpha / beta' },
          { key: 'other_site', label: 'Other site' }
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
          { key: 'produced_iran', label: 'Produced (Iran)' },
          { key: 'produced_original', label: 'Produced (Original)' }
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
          { key: 'interested', label: "I'm interested in" },
          { key: 'learned', label: 'I just learned it' },
          { key: 'played', label: 'I have played' },
          { key: 'replay', label: 'Wanna replay' }
        ]
      }
    ]
  }
];

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

// ---------- filter state ----------

function emptyMyTagSelection() {
  const sel = {};
  TAG_GROUPS.forEach(g => { sel[g.id] = []; });
  return sel;
}

function getMyTagFiltersFromURL(params) {
  const sel = emptyMyTagSelection();
  TAG_GROUPS.forEach(g => {
    sel[g.id] = params.get(g.id)?.split(',').filter(Boolean) || [];
  });
  return sel;
}

function getMyTagFiltersFromUI() {
  const sel = emptyMyTagSelection();
  TAG_GROUPS.forEach(g => {
    sel[g.id] = Array.from(
      document.querySelectorAll(`input[type="checkbox"][name="my_${g.id}"]:checked`)
    ).map(cb => cb.value);
  });
  return sel;
}

function setMyTagURLParams(params, filters) {
  const sel = filters.selectedMyTags || {};
  TAG_GROUPS.forEach(g => {
    if (sel[g.id]?.length) params.set(g.id, sel[g.id].join(','));
  });
}

function restoreMyTagUI(state) {
  const sel = state.selectedMyTags || {};
  TAG_GROUPS.forEach(g => {
    (sel[g.id] || []).forEach(value => {
      const cb = document.querySelector(
        `input[type="checkbox"][name="my_${g.id}"][value="${CSS.escape(value)}"]`
      );
      if (cb) cb.checked = true;
    });
  });
}

function myTagsActive(filters) {
  const sel = filters.selectedMyTags || {};
  return TAG_GROUPS.some(g => (sel[g.id] || []).length > 0);
}

function updateMyTagActiveStates(filters) {
  const sel = filters.selectedMyTags || {};
  TAG_GROUPS.forEach(g => {
    const el = document.getElementById(`facet-my-${g.id}`);
    if (!el) return;
    el.classList.toggle('filter-active', (sel[g.id] || []).length > 0);
  });
}

// The heart of the system:
//  inside a group -> OR, between groups -> AND
function gameMatchesMyTags(game, selectedMyTags) {
  if (!selectedMyTags) return true;
  for (const g of TAG_GROUPS) {
    const wanted = selectedMyTags[g.id] || [];
    if (wanted.length === 0) continue;
    const have = game.my_tags ? game.my_tags[g.id] : null;
    if (!have || !wanted.some(k => have.has(k))) return false;
  }
  return true;
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

function updateMyTagCounts(filters) {
  TAG_GROUPS.forEach(group => {
    const without = {
      ...filters,
      selectedMyTags: { ...(filters.selectedMyTags || emptyMyTagSelection()), [group.id]: [] }
    };
    const games = filterGames(allGames, without);
    const counts = {};
    games.forEach(game => {
      game.my_tags[group.id].forEach(k => {
        counts[k] = (counts[k] || 0) + 1;
      });
    });
    updateCountsInDOM(`facet-my-${group.id}`, counts, true);
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

// ---------- show the chosen options in the filter button ----------

// Radio filters use these values for "no filter"
const FILTER_NEUTRAL_VALUES = ['any', '0-100', '0-9999'];

// "Production" -> "Production: PnP, Produced (Iran)"
function updateFilterSummaries() {
  document.querySelectorAll('details.filter-dropdown').forEach(details => {
    const titleEl = details.querySelector('summary .filter-title');
    if (!titleEl) return;
    if (!details.dataset.baseTitle) details.dataset.baseTitle = titleEl.textContent;

    const checked = Array.from(details.querySelectorAll('input:checked'))
      .filter(input => !FILTER_NEUTRAL_VALUES.includes(input.value));

    // My tag groups: hide a parent heading (e.g. "Physical") when one of its
    // own options is ticked, since the option already says it.
    const group = TAG_GROUPS.find(g => details.id === `facet-my-${g.id}`);
    const hiddenValues = new Set();
    if (group) {
      const values = new Set(checked.map(i => i.value));
      group.sections.forEach(sec => {
        if (sec.key && sec.options.some(o => values.has(o.key))) hiddenValues.add(sec.key);
      });
    }

    const labels = checked
      .filter(input => !hiddenValues.has(input.value))
      .map(input => {
        const el = input.closest('label')?.querySelector('.filter-label');
        return (el ? el.textContent : input.value).replace(/\s*\(any\)\s*$/i, '').trim();
      })
      .filter(Boolean);

    const text = labels.length ? `${details.dataset.baseTitle}: ${labels.join(', ')}` : details.dataset.baseTitle;
    titleEl.textContent = text;
    titleEl.title = text;
  });
}
