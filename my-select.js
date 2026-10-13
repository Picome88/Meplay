// =====================================================================
// my-select.js  -  "Select" mode
//
// HOW IT WORKS
//  * "Select" button (top bar, next to Edit) turns select mode on/off.
//  * In select mode, clicking a game card selects it (red border + check).
//    It uses the SAME selection as Edit mode (editState.selected in my-edit.js),
//    so there is only one selection engine.
//  * The bottom bar shows "N selected", "Select all filtered", "Clear selection"
//    and "Extract…". Extract opens the Extract window (my-extract.js) with
//    the selected games.
//  * Read-only: nothing is saved, no token, no network, nothing in the URL.
//
// Needs from my-edit.js: editState, editEl, editToast, openModal, closeModal,
//   selectAllFiltered, clearSelection, getHeaderActions, setEditMode
// Needs from my-extract.js: openExtractModal (called only on click)
// =====================================================================

const selectState = { on: false };

function isSelectModeOn() {
  return selectState.on;
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
  extract.addEventListener('click', () => openExtractModal({ scope: 'selected' }));

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
