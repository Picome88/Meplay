// =====================================================================
// my-edit.js  -  Edit mode for my tags (Type / Production / Status)
//
// HOW IT WORKS
//  * "Edit" button (top bar) turns edit mode on/off.
//  * In edit mode, clicking a game card selects it (red border + check).
//    The small "Tags" button on a card edits only that one game.
//  * The bottom bar lets you select all filtered games, tag the selection,
//    and Save. Save writes my_tags.json to GitHub using your token.
//  * Your token is stored only in this browser (localStorage), never in code.
//  * "Update" button (top bar, always visible): starts the GitHub Action that
//    refreshes the game list from BGG now, and tells you when it is finished.
//    It uses the same token (needs "Actions: Read and write" too).
//  * Select mode (my-select.js) shares the selection system of this file.
//
// Needs from my-tags.js: TAG_GROUPS, myTagData, applyMyTags, labelForTag, renderMyTagsRows,
//                        MYTAGS_REPO, MYTAGS_FILE, MYTAGS_TOKEN_KEY
// Needs from app-sqlite.js: allGames, filteredGames, onFilterChange
// =====================================================================

const editState = {
  on: false,
  selected: new Set(),   // game ids (strings) currently selected
  pending: new Set(),    // game ids changed but not saved yet
  saving: false
};

// ---------- token ----------

function getEditToken() {
  try { return localStorage.getItem(MYTAGS_TOKEN_KEY) || ''; } catch (e) { return ''; }
}
function setEditToken(value) {
  try {
    if (value) localStorage.setItem(MYTAGS_TOKEN_KEY, value);
    else localStorage.removeItem(MYTAGS_TOKEN_KEY);
  } catch (e) { /* ignore */ }
}

// ---------- small helpers ----------

function editEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function gameById(id) {
  return allGames.find(g => String(g.id) === String(id));
}

let editToastTimer = null;
function editToast(message, isError = false) {
  let t = document.getElementById('edit-toast');
  if (!t) {
    t = editEl('div', 'edit-toast');
    t.id = 'edit-toast';
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.classList.toggle('edit-toast-error', isError);
  t.classList.add('show');
  clearTimeout(editToastTimer);
  editToastTimer = setTimeout(() => t.classList.remove('show'), isError ? 8000 : 3500);
}

// ---------- cards ----------

// Called by renderGameCard() for every card.
// True when clicking a card must select it (Edit mode or Select mode)
function isSelecting() {
  return editState.on || (typeof isSelectModeOn === 'function' && isSelectModeOn());
}

// One hook for every change of the selection: refreshes both toolbars
function onSelectionChanged() {
  refreshToolbar();
  if (typeof refreshSelectToolbar === 'function') refreshSelectToolbar();
}

function selectAllFiltered() {
  filteredGames.forEach(g => editState.selected.add(String(g.id)));
  document.querySelectorAll('.game-card[data-game-id]').forEach(c => {
    c.classList.toggle('edit-selected', editState.selected.has(c.dataset.gameId));
  });
  onSelectionChanged();
}

function clearSelection() {
  editState.selected.clear();
  document.querySelectorAll('.game-card.edit-selected').forEach(c => c.classList.remove('edit-selected'));
  onSelectionChanged();
}

function decorateCardForEdit(fragment, game) {
  const card = fragment.querySelector('.game-card');
  const summary = card && card.querySelector('.game-summary');
  if (!card || !summary) return;

  const id = String(game.id);
  card.dataset.gameId = id;
  if (editState.selected.has(id)) card.classList.add('edit-selected');

  const check = editEl('span', 'edit-check', '✓');
  const tagBtn = editEl('button', 'edit-tag-btn', 'Tags');
  tagBtn.type = 'button';
  tagBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    openTagModal([id]);
  });

  const overlay = editEl('div', 'edit-overlay');
  overlay.append(check, tagBtn);
  summary.appendChild(overlay);

  summary.addEventListener('click', e => {
    if (!isSelecting()) return;
    e.preventDefault();           // do not open the details card in edit / select mode
    toggleSelected(id);
  });
}

function refreshCardChips(id) {
  const body = document.querySelector(`.game-card[data-game-id="${CSS.escape(id)}"] .my-tags-body`);
  if (body) renderMyTagsRows(body, id);
}

function toggleSelected(id) {
  if (editState.selected.has(id)) editState.selected.delete(id);
  else editState.selected.add(id);
  const card = document.querySelector(`.game-card[data-game-id="${CSS.escape(id)}"]`);
  if (card) card.classList.toggle('edit-selected', editState.selected.has(id));
  onSelectionChanged();
}

// ---------- toolbar ----------

let editToolbar = null;

function buildToolbar() {
  editToolbar = editEl('div', 'edit-toolbar');
  editToolbar.id = 'edit-toolbar';

  const info = editEl('span', 'edit-info');
  info.id = 'edit-info';

  const selectAll = editEl('button', 'edit-btn', 'Select all filtered');
  selectAll.id = 'edit-select-all';
  selectAll.type = 'button';
  selectAll.addEventListener('click', selectAllFiltered);

  const clearSel = editEl('button', 'edit-btn', 'Clear selection');
  clearSel.id = 'edit-clear-sel';
  clearSel.type = 'button';
  clearSel.addEventListener('click', clearSelection);

  const tagSel = editEl('button', 'edit-btn edit-btn-primary', 'Tag selected…');
  tagSel.id = 'edit-tag-selected';
  tagSel.type = 'button';
  tagSel.addEventListener('click', () => openTagModal([...editState.selected]));

  const save = editEl('button', 'edit-btn edit-btn-save', 'Save');
  save.id = 'edit-save';
  save.type = 'button';
  save.addEventListener('click', saveTags);

  const token = editEl('button', 'edit-btn edit-btn-ghost', 'Token');
  token.id = 'edit-token';
  token.type = 'button';
  token.addEventListener('click', () => openTokenModal());

  editToolbar.append(info, selectAll, clearSel, tagSel, save, token);
  document.body.appendChild(editToolbar);
}

function refreshToolbar() {
  if (!editToolbar) return;
  const n = editState.selected.size;
  const p = editState.pending.size;
  document.getElementById('edit-info').textContent = `${n} selected`;
  document.getElementById('edit-tag-selected').disabled = n === 0;
  document.getElementById('edit-clear-sel').disabled = n === 0;
  const save = document.getElementById('edit-save');
  save.disabled = p === 0 || editState.saving;
  save.textContent = editState.saving ? 'Saving…' : (p ? `Save (${p})` : 'Save');
}

// ---------- modal helpers ----------

function openModal(contentBuilder) {
  closeModal();
  const backdrop = editEl('div', 'edit-modal-backdrop');
  backdrop.id = 'edit-modal-backdrop';
  const modal = editEl('div', 'edit-modal');
  backdrop.appendChild(modal);
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);
  contentBuilder(modal);
}

function closeModal() {
  const m = document.getElementById('edit-modal-backdrop');
  if (m) m.remove();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

// ---------- tag modal ----------

function openTagModal(ids) {
  if (!ids.length) return;
  const n = ids.length;

  openModal(modal => {
    const g1 = n === 1 ? gameById(ids[0]) : null;
    modal.appendChild(editEl('h2', 'edit-modal-title', n === 1 ? (g1 ? g1.name : `Game ${ids[0]}`) : `${n} games selected`));
    modal.appendChild(editEl('p', 'edit-modal-sub',
      n === 1 ? 'Tick the tags this game should have.'
              : 'Ticked = add to all. Unticked = remove from all. Dash = mixed, left untouched unless you change it.'));

    const boxes = [];
    TAG_GROUPS.forEach(group => {
      modal.appendChild(editEl('h3', 'edit-group-title', group.title));
      group.sections.forEach(section => {
        if (section.key && section.label) {
          modal.appendChild(editEl('div', 'edit-section-title', section.label.replace(/\s*\(any\)\s*$/i, '')));
        }
        const wrap = editEl('div', 'edit-options' + (section.key ? ' edit-indent' : ''));
        section.options.forEach(opt => {
          const have = ids.filter(id => ((myTagData[id] || {})[group.id] || []).includes(opt.key)).length;
          const label = editEl('label', 'edit-option');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = have === n;
          cb.indeterminate = have > 0 && have < n;
          label.append(cb, editEl('span', '', opt.label));
          wrap.appendChild(label);
          boxes.push({ cb, gid: group.id, key: opt.key });
        });
        modal.appendChild(wrap);
      });
    });

    const actions = editEl('div', 'edit-modal-actions');
    const cancel = editEl('button', 'edit-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', closeModal);
    const apply = editEl('button', 'edit-btn edit-btn-primary', 'Apply');
    apply.type = 'button';
    apply.addEventListener('click', () => {
      const changes = boxes
        .filter(b => !b.cb.indeterminate)
        .map(b => ({ gid: b.gid, key: b.key, add: b.cb.checked }));
      applyTagChanges(ids, changes);
      closeModal();
    });
    actions.append(cancel, apply);
    modal.appendChild(actions);
  });
}

function applyTagChanges(ids, changes) {
  let touched = 0;
  ids.forEach(id => {
    const entry = Object.assign({}, myTagData[id] || {});
    let changed = false;
    changes.forEach(({ gid, key, add }) => {
      const set = new Set(entry[gid] || []);
      const had = set.has(key);
      if (add && !had) { set.add(key); changed = true; }
      if (!add && had) { set.delete(key); changed = true; }
      entry[gid] = [...set];
    });
    if (!changed) return;

    TAG_GROUPS.forEach(g => { if (entry[g.id] && entry[g.id].length === 0) delete entry[g.id]; });
    if (Object.keys(entry).length === 0) delete myTagData[id];
    else myTagData[id] = entry;

    const game = gameById(id);
    if (game) applyMyTags(game);
    editState.pending.add(id);
    touched++;
  });

  refreshToolbar();
  if (touched === 0) { editToast('No changes'); return; }

  // Re-run the current filters so lists and counters stay correct
  ids.forEach(refreshCardChips);
  if (typeof onFilterChange === 'function') onFilterChange(false);
  editToast(`${touched} game${touched === 1 ? '' : 's'} changed - press Save to keep them`);
}

// ---------- token modal ----------

function openTokenModal(afterSave) {
  openModal(modal => {
    modal.appendChild(editEl('h2', 'edit-modal-title', 'GitHub token'));
    const p = editEl('p', 'edit-modal-sub');
    p.append('Saving tags and the Update button need a token that can write to this repository only. ');
    const a = editEl('a', '', 'Create one here');
    a.href = 'https://github.com/settings/personal-access-tokens/new';
    a.target = '_blank';
    a.rel = 'noopener';
    p.append(a, '.');
    modal.appendChild(p);

    const steps = editEl('ol', 'edit-steps');
    [
      'Token name: anything (e.g. "Meplay tags"). Expiration: your choice.',
      `Repository access: "Only select repositories" → ${MYTAGS_REPO}.`,
      'Permissions → Repository permissions → Contents: "Read and write".',
      'Permissions → Repository permissions → Actions: "Read and write" (needed for the Update button).',
      'Generate token, copy it, paste it below.'
    ].forEach(t => steps.appendChild(editEl('li', '', t)));
    modal.appendChild(steps);

    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'edit-token-input';
    input.placeholder = 'github_pat_...';
    input.autocomplete = 'off';
    input.value = getEditToken();
    modal.appendChild(input);

    const actions = editEl('div', 'edit-modal-actions');
    const remove = editEl('button', 'edit-btn edit-btn-ghost', 'Remove token');
    remove.type = 'button';
    remove.addEventListener('click', () => { setEditToken(''); closeModal(); editToast('Token removed'); });
    const cancel = editEl('button', 'edit-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', closeModal);
    const ok = editEl('button', 'edit-btn edit-btn-primary', 'Save token');
    ok.type = 'button';
    ok.addEventListener('click', () => {
      const v = input.value.trim();
      if (!v) { editToast('Paste a token first', true); return; }
      setEditToken(v);
      closeModal();
      editToast('Token saved in this browser');
      if (afterSave) afterSave();
    });
    actions.append(remove, cancel, ok);
    modal.appendChild(actions);
    input.focus();
  });
}

// ---------- GitHub API ----------

const GH_API = () => `https://api.github.com/repos/${MYTAGS_REPO}/contents/${MYTAGS_FILE}`;

function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function utf8ToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

async function ghGetFile(token) {
  const res = await fetch(GH_API() + '?t=' + Date.now(), { headers: ghHeaders(token), cache: 'no-store' });
  if (res.status === 404) return { sha: undefined, data: { games: {} } };
  if (!res.ok) throw new GhError(res.status);
  const json = await res.json();
  return { sha: json.sha, data: JSON.parse(b64ToUtf8(json.content)) };
}

async function ghPutFile(token, text, sha) {
  const body = { message: 'Update game tags (edit mode)', content: utf8ToB64(text) };
  if (sha) body.sha = sha;
  const res = await fetch(GH_API(), {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(token)),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new GhError(res.status);
  return res.json();
}

class GhError extends Error {
  constructor(status) { super('GitHub ' + status); this.status = status; }
}

// One game per line, sorted by id: easy to read and to diff on GitHub.
function serializeTags(data) {
  const games = data.games || {};
  const ids = Object.keys(games).sort((a, b) => Number(a) - Number(b));
  // keep a fixed key order (type, production, status, ...) so diffs stay small
  const ordered = entry => {
    const out = {};
    TAG_GROUPS.forEach(g => { if (entry[g.id] && entry[g.id].length) out[g.id] = entry[g.id]; });
    Object.keys(entry).forEach(k => { if (!(k in out) && !TAG_GROUPS.some(g => g.id === k)) out[k] = entry[k]; });
    return out;
  };
  const lines = ids.map(id => `    ${JSON.stringify(id)}: ${JSON.stringify(ordered(games[id]))}`);
  const help = data._help || 'Each game id lists its tags. Edit mode updates this file for you.';
  return `{\n  "_help": ${JSON.stringify(help)},\n  "games": {\n${lines.join(',\n')}\n  }\n}\n`;
}

function describeGhError(e) {
  if (e instanceof GhError) {
    if (e.status === 401) return 'GitHub rejected the token (expired or wrong). Open "Token" and paste a new one.';
    if (e.status === 403) return 'The token has no permission to write. It needs Contents: Read and write on this repo.';
    if (e.status === 404) return `Repository ${MYTAGS_REPO} not found for this token. Check the repository access of the token.`;
    if (e.status === 409 || e.status === 422) return 'The file changed on GitHub while saving. Press Save again.';
    return `GitHub error ${e.status}.`;
  }
  return 'Network problem. Check your connection and try again.';
}

async function saveTags() {
  if (editState.saving || editState.pending.size === 0) return;
  const token = getEditToken();
  if (!token) { openTokenModal(saveTags); return; }

  editState.saving = true;
  refreshToolbar();
  try {
    const ids = [...editState.pending];
    // Up to 2 tries: if someone changed the file meanwhile, re-read and re-apply
    for (let attempt = 0; attempt < 2; attempt++) {
      const { sha, data } = await ghGetFile(token);
      data.games = data.games || {};
      ids.forEach(id => {
        if (myTagData[id]) data.games[id] = myTagData[id];
        else delete data.games[id];
      });
      try {
        await ghPutFile(token, serializeTags(data), sha);
        break;
      } catch (e) {
        if (attempt === 0 && e instanceof GhError && (e.status === 409 || e.status === 422)) continue;
        throw e;
      }
    }
    editState.pending.clear();
    editToast('Saved ✓  (the public site updates in 1-2 minutes)');
  } catch (e) {
    editToast(describeGhError(e), true);
  } finally {
    editState.saving = false;
    refreshToolbar();
  }
}

// ---------- on / off ----------

function setEditMode(on) {
  if (on && typeof isSelectModeOn === 'function' && isSelectModeOn()) setSelectMode(false);   // only one mode at a time
  editState.on = on;
  document.body.classList.toggle('edit-mode', on);
  const btn = document.getElementById('edit-toggle');
  if (btn) {
    btn.classList.toggle('active', on);
    btn.textContent = on ? 'Done' : 'Edit';
  }
  if (!editToolbar) buildToolbar();
  editToolbar.classList.toggle('show', on);
  refreshToolbar();
}

// One box in the top bar that holds the buttons (Edit, Select, Update)
function getHeaderActions() {
  const header = document.querySelector('header.search');
  if (!header) return null;
  let box = document.getElementById('header-actions');
  if (!box) {
    box = editEl('div', 'header-actions');
    box.id = 'header-actions';
    header.appendChild(box);
  }
  return box;
}

function setupEditButton() {
  const box = getHeaderActions();
  if (!box || document.getElementById('edit-toggle')) return;
  const btn = editEl('button', 'edit-toggle', 'Edit');
  btn.id = 'edit-toggle';
  btn.type = 'button';
  btn.addEventListener('click', () => {
    if (editState.on && editState.pending.size &&
        !confirm('You have unsaved changes. Leave edit mode anyway? (they stay until you reload)')) return;
    setEditMode(!editState.on);
  });
  box.appendChild(btn);
}

// ---------- Update button (runs the GitHub Action that reads BGG) ----------

const WORKFLOW_FILE = 'index.yml';
const syncState = { busy: false, ready: false };

const GH_REPO_API = () => `https://api.github.com/repos/${MYTAGS_REPO}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function setSyncButton(text, opts = {}) {
  const btn = document.getElementById('sync-btn');
  if (!btn) return;
  btn.textContent = text;
  btn.disabled = !!opts.disabled;
  btn.classList.toggle('ready', !!opts.ready);
}

async function ghListRuns(token) {
  const res = await fetch(
    `${GH_REPO_API()}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=5&t=${Date.now()}`,
    { headers: ghHeaders(token), cache: 'no-store' }
  );
  if (!res.ok) throw new GhError(res.status);
  const json = await res.json();
  return json.workflow_runs || [];
}

async function ghDefaultBranch(token) {
  try {
    const res = await fetch(GH_REPO_API(), { headers: ghHeaders(token), cache: 'no-store' });
    if (!res.ok) throw new GhError(res.status);
    const json = await res.json();
    return json.default_branch || 'master';
  } catch (e) {
    if (e instanceof GhError && (e.status === 401 || e.status === 403 || e.status === 404)) throw e;
    return 'master';
  }
}

async function ghDispatchWorkflow(token, branch) {
  const res = await fetch(`${GH_REPO_API()}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(token)),
    body: JSON.stringify({ ref: branch })
  });
  if (!res.ok) throw new GhError(res.status);   // success is 204 without a body
}

function describeUpdateError(e) {
  if (e instanceof GhError) {
    if (e.status === 401) return 'GitHub rejected the token (expired or wrong). Open edit mode → "Token" and paste a new one.';
    if (e.status === 403) return 'The token cannot run workflows. It needs Actions: Read and write on this repo (edit the token on GitHub or create a new one).';
    if (e.status === 404) return `Workflow or repository ${MYTAGS_REPO} not found for this token. Check its repository access and that it has the Actions permission.`;
    if (e.status === 422) return 'GitHub refused to start the workflow. Check that it has "workflow_dispatch" and the branch exists.';
    if (e.status === 'run-not-found') return 'Update was requested, but its run did not show up yet. Check the Actions tab on GitHub.';
    if (e.status === 'watch-timeout') return 'The update is taking very long. Check the Actions tab on GitHub.';
    return `GitHub error ${e.status}.`;
  }
  return 'Network problem. Check your connection and try again.';
}

// Follows one run until it is completed (every 8 s, at most 15 minutes)
async function watchRun(token, runId) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const runs = await ghListRuns(token);
    let run = runs.find(r => r.id === runId);
    if (!run) {   // pushed out of the short list by newer runs: ask for it directly
      const res = await fetch(`${GH_REPO_API()}/actions/runs/${runId}?t=${Date.now()}`, { headers: ghHeaders(token), cache: 'no-store' });
      if (!res.ok) throw new GhError(res.status);
      run = await res.json();
    }
    if (run.status === 'completed') return run;
    setSyncButton(run.status === 'queued' ? 'Queued…' : 'Updating…', { disabled: true });
    await wait(8000);
  }
  throw new GhError('watch-timeout');
}

async function startUpdate() {
  const btn = document.getElementById('sync-btn');
  if (!btn || syncState.busy) return;                       // no double clicks
  if (syncState.ready) { location.reload(); return; }       // finished: this click reloads

  const token = getEditToken();
  if (!token) { openTokenModal(startUpdate); return; }      // after saving the token, run again

  syncState.busy = true;
  setSyncButton('Starting…', { disabled: true });
  try {
    const runs = await ghListRuns(token);
    const active = runs.find(r => r.status !== 'completed');
    let runId;

    if (active) {
      // an update (for example the hourly one) is already running: just follow it
      editToast('Update already started - it is still running');
      runId = active.id;
    } else {
      const baseline = runs.reduce((max, r) => Math.max(max, r.id), 0);
      const branch = await ghDefaultBranch(token);
      await ghDispatchWorkflow(token, branch);
      editToast('Update started - this can take a few minutes');

      for (let i = 0; i < 20 && !runId; i++) {
        await wait(3000);
        const now = await ghListRuns(token);
        const mine = now.find(r => r.id > baseline && r.event === 'workflow_dispatch');
        if (mine) runId = mine.id;
      }
      if (!runId) throw new GhError('run-not-found');
    }

    const run = await watchRun(token, runId);
    if (run.conclusion === 'success') {
      syncState.ready = true;
      setSyncButton('Reload ✓', { ready: true });
      editToast('Update finished ✓  Press "Reload ✓" to see the new games');
    } else {
      setSyncButton('Update');
      editToast(`The update ended with "${run.conclusion}". Check the Actions tab on GitHub.`, true);
    }
  } catch (e) {
    setSyncButton('Update');
    editToast(describeUpdateError(e), true);
  } finally {
    syncState.busy = false;
    const b = document.getElementById('sync-btn');
    if (b && !syncState.ready && b.textContent === 'Update') b.disabled = false;
  }
}

function setupUpdateButton() {
  const box = getHeaderActions();
  if (!box || document.getElementById('sync-btn')) return;
  const btn = editEl('button', 'edit-toggle sync-btn', 'Update');
  btn.id = 'sync-btn';
  btn.type = 'button';
  btn.title = 'Update the game list from BGG now (instead of waiting for the hourly update)';
  btn.addEventListener('click', startUpdate);
  box.appendChild(btn);
}

window.addEventListener('beforeunload', e => {
  if (editState.pending.size) { e.preventDefault(); e.returnValue = ''; }
});

setupEditButton();
setupUpdateButton();
