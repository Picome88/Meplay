// =====================================================================
// my-select.js  -  "Select" mode + "Extract names" window
//
// HOW IT WORKS
//  * "Select" button (top bar, next to Edit) turns select mode on/off.
//  * In select mode, clicking a game card selects it (red border + check).
//    It uses the SAME selection as Edit mode (editState.selected in my-edit.js),
//    so there is only one selection engine.
//  * The bottom bar shows "N selected", "Select all filtered", "Clear selection"
//    and "Extract…". Extract opens a window with the names of the selected
//    games (one per line, A to Z) and a Copy button.
//  * Read-only: nothing is saved, no token, no network, nothing in the URL.
//
// Needs from my-edit.js: editState, editEl, editToast, openModal, closeModal,
//   gameById, selectAllFiltered, clearSelection, getHeaderActions,
//   setEditMode
// =====================================================================

const selectState = { on: false };

function isSelectModeOn() {
  return selectState.on;
}

// ---------- names list ----------

// "Tom &amp; Jerry" -> "Tom & Jerry" (a textarea never runs scripts)
function decodeHtmlEntities(text) {
  const t = document.createElement('textarea');
  t.innerHTML = String(text);
  return t.value;
}

// The text shown in the Extract window: one name per line, A to Z, no numbering
function buildNamesText() {
  const names = [];
  editState.selected.forEach(id => {
    const game = gameById(id);
    if (game) names.push(decodeHtmlEntities(game.name));
  });
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return { names, text: names.join('\n') };
}

// ---------- copy ----------

async function copyText(textarea) {
  const text = textarea.value;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall back below */ }

  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (document.execCommand('copy')) return true;
  } catch (e) { /* ignore */ }

  textarea.focus();
  textarea.select();   // leave the text selected so Ctrl+C works
  return false;
}

// ---------- Extract window ----------

function openExtractModal() {
  const { names, text } = buildNamesText();
  if (!names.length) return;

  openModal(modal => {
    modal.appendChild(editEl('h2', 'edit-modal-title', 'Extract names'));
    modal.appendChild(editEl('p', 'edit-modal-sub', `${names.length} game${names.length === 1 ? '' : 's'}`));

    const area = document.createElement('textarea');
    area.className = 'extract-textarea';
    area.readOnly = true;
    area.rows = 12;
    area.spellcheck = false;
    area.value = text;
    modal.appendChild(area);

    const actions = editEl('div', 'edit-modal-actions');
    const close = editEl('button', 'edit-btn', 'Close');
    close.type = 'button';
    close.addEventListener('click', closeModal);

    const copy = editEl('button', 'edit-btn edit-btn-primary', 'Copy');
    copy.type = 'button';
    let resetTimer = null;
    copy.addEventListener('click', async () => {
      const ok = await copyText(area);
      if (ok) {
        copy.textContent = 'Copied ✓';
        editToast(`Copied ${names.length} name${names.length === 1 ? '' : 's'}`);
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
      } else {
        editToast('Could not copy automatically. The text is selected: press Ctrl+C.', true);
      }
    });

    actions.append(close, copy);
    modal.appendChild(actions);
  });
}

// ---------- bottom bar ----------

let selectToolbar = null;

function buildSelectToolbar() {
  selectToolbar = editEl('div', 'edit-toolbar select-toolbar');
  selectToolbar.id = 'select-toolbar';

  const info = editEl('span', 'edit-info');
  info.id = 'select-info';

  const selectAll = editEl('button', 'edit-btn', 'Select all filtered');
  selectAll.type = 'button';
  selectAll.addEventListener('click', selectAllFiltered);

  const clearSel = editEl('button', 'edit-btn', 'Clear selection');
  clearSel.id = 'select-clear-sel';
  clearSel.type = 'button';
  clearSel.addEventListener('click', clearSelection);

  const extract = editEl('button', 'edit-btn edit-btn-primary', 'Extract…');
  extract.id = 'select-extract';
  extract.type = 'button';
  extract.addEventListener('click', openExtractModal);

  selectToolbar.append(info, selectAll, clearSel, extract);
  document.body.appendChild(selectToolbar);
}

// Called by onSelectionChanged() in my-edit.js
function refreshSelectToolbar() {
  if (!selectToolbar) return;
  const n = editState.selected.size;
  document.getElementById('select-info').textContent = `${n} selected`;
  document.getElementById('select-clear-sel').disabled = n === 0;
  document.getElementById('select-extract').disabled = n === 0;
}

// ---------- on / off ----------

function setSelectMode(on) {
  selectState.on = on;
  document.body.classList.toggle('select-mode', on);
  const btn = document.getElementById('select-toggle');
  if (btn) {
    btn.classList.toggle('active', on);
    btn.textContent = on ? 'Done' : 'Select';
  }
  if (!selectToolbar) buildSelectToolbar();
  selectToolbar.classList.toggle('show', on);
  refreshSelectToolbar();
}

function setupSelectButton() {
  const box = getHeaderActions();
  if (!box || document.getElementById('select-toggle')) return;
  const btn = editEl('button', 'edit-toggle', 'Select');
  btn.id = 'select-toggle';
  btn.type = 'button';
  btn.addEventListener('click', () => {
    if (selectState.on) { setSelectMode(false); return; }

    // Edit mode and Select mode are never on together
    if (editState.on) {
      if (editState.pending.size &&
          !confirm('You have unsaved changes. Leave edit mode anyway? (they stay until you reload)')) return;
      setEditMode(false);
    }
    setSelectMode(true);
  });
  // order in the top bar: Edit, Select, Update
  const update = document.getElementById('sync-btn');
  if (update && update.parentNode === box) box.insertBefore(btn, update);
  else box.appendChild(btn);
}

setupSelectButton();
