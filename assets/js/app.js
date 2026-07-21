import { api, ApiError, getToken, setToken, getDisplayName, setDisplayName, getCurrentUser } from './api.js';
import { Grid, FONT_FAMILIES, FONT_SIZES } from './grid.js';
import { TabSocket } from './ws.js';

const root = document.getElementById('app');
let currentTeardown = null;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function mount(node) {
  if (currentTeardown) {
    currentTeardown();
    currentTeardown = null;
  }
  root.textContent = '';
  root.appendChild(node);
}

function isLoggedIn() {
  return !!getToken();
}

function formatRelativeTime(date) {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// --- Router -----------------------------------------------------------

function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return hash.split('/').filter(Boolean);
}

async function route() {
  const parts = parseHash();
  try {
    if (parts[0] === 'login' || (parts.length === 0 && !isLoggedIn())) {
      return renderLogin();
    }
    // Canonical, shareable form: #/s/<guid> (tabs list) or
    // #/s/<guid>/t/<tabId> (a specific tab) -- the URL you're looking at
    // IS the share link. The numeric-id forms below still work (existing
    // links/bookmarks keep resolving) but rewrite the address bar to this
    // form once resolved, via history.replaceState inside
    // renderSheetTabs/renderSheet -- see there for why.
    if (parts[0] === 's' && parts[1] && parts[2] === 't' && parts[3]) {
      const spreadsheet = await api.getSpreadsheetByGuid(parts[1]);
      return renderSheet(spreadsheet.id, parseInt(parts[3], 10));
    }
    if (parts[0] === 's' && parts[1]) {
      const spreadsheet = await api.getSpreadsheetByGuid(parts[1]);
      return renderSheetTabs(spreadsheet.id);
    }
    if (parts[0] === 'sheets' && parts[1] && parts[2] === 'tabs' && parts[3]) {
      return renderSheet(parseInt(parts[1], 10), parseInt(parts[3], 10));
    }
    if (parts[0] === 'sheets' && parts[1]) {
      return renderSheetTabs(parseInt(parts[1], 10));
    }
    return renderSheetsList();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setToken(null);
      window.location.hash = '#/login';
      return;
    }
    renderError(e);
  }
}

window.addEventListener('hashchange', route);

// --- Views --------------------------------------------------------------

function renderLogin() {
  const error = el('p', { class: 'error hidden' });
  const username = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username' });
  const password = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });

  const form = el('form', {
    class: 'login-form',
    onsubmit: async (e) => {
      e.preventDefault();
      error.classList.add('hidden');
      try {
        const res = await api.login(username.value, password.value);
        setToken(res.token);
        window.location.hash = '#/sheets';
      } catch {
        error.textContent = 'Invalid username or password.';
        error.classList.remove('hidden');
      }
    },
  }, [
    el('h1', {}, 'Blanket'),
    username,
    password,
    el('button', { class: 'btn btn-block', type: 'submit' }, 'Log in'),
    error,
    el('p', { class: 'muted' }, 'Have a link to a shared spreadsheet? Just open it — no login needed if the owner allowed anonymous access.'),
  ]);

  mount(el('div', { class: 'centered' }, form));
}

async function renderSheetsList() {
  if (!isLoggedIn()) return (window.location.hash = '#/login');

  const list = el('ul', { class: 'sheet-list' });
  const newTitle = el('input', { type: 'text', placeholder: 'New spreadsheet title' });

  async function refresh() {
    list.textContent = '';
    const { spreadsheets } = await api.listSpreadsheets();
    for (const s of spreadsheets) {
      const link = el('a', { href: s.guid ? `#/s/${s.guid}` : `#/sheets/${s.id}` }, s.title);
      list.appendChild(el('li', {}, link));
    }
  }

  const form = el('form', {
    class: 'inline-form',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!newTitle.value.trim()) return;
      await api.createSpreadsheet(newTitle.value.trim());
      newTitle.value = '';
      await refresh();
    },
  }, [newTitle, el('button', { class: 'btn', type: 'submit' }, 'Create')]);

  mount(el('div', { class: 'page' }, [
    el('header', { class: 'topbar' }, [
      el('h1', {}, 'Your spreadsheets'),
      el('button', { class: 'link', onclick: () => { setToken(null); window.location.hash = '#/login'; } }, 'Log out'),
    ]),
    form,
    list,
  ]));

  await refresh();
}

async function renderSheetTabs(spreadsheetId) {
  const spreadsheet = await api.getSpreadsheet(spreadsheetId);
  const { tabs } = await api.listTabs(spreadsheetId);

  // Canonical URL for this view is guid-based -- rewrite the address bar
  // in place (no navigation/reload, and no hashchange event, so this
  // can't loop) so that whatever's in the address bar right now is always
  // the shareable link, per Fernando's request.
  if (spreadsheet && spreadsheet.guid) {
    history.replaceState(null, '', `#/s/${spreadsheet.guid}`);
  }

  const list = el('ul', { class: 'tab-list' });
  for (const t of tabs) {
    list.appendChild(el('li', {}, el('a', { href: `#/s/${spreadsheet.guid}/t/${t.id}` }, t.name)));
  }

  const newName = el('input', { type: 'text', placeholder: 'New tab name' });
  const form = el('form', {
    class: 'inline-form',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!newName.value.trim()) return;
      const created = await api.createTab(spreadsheetId, newName.value.trim(), getDisplayName());
      window.location.hash = `#/s/${spreadsheet.guid}/t/${created.id}`;
    },
  }, [newName, el('button', { class: 'btn', type: 'submit' }, 'Add tab')]);

  mount(el('div', { class: 'page' }, [
    el('header', { class: 'topbar' }, [
      el('a', { href: '#/sheets', class: 'link' }, '← All spreadsheets'),
      el('h1', {}, spreadsheet.title),
    ]),
    form,
    list,
  ]));
}

async function renderSheet(spreadsheetId, tabId) {
  // Name prompt now happens once at app startup (see promptForNameIfNeeded
  // / bootstrap at the bottom of this file), not here -- Fernando wants it
  // on first visit generally, not just when entering a sheet.

  const [spreadsheet, tabsRes, current] = await Promise.all([
    api.getSpreadsheet(spreadsheetId).catch(() => null),
    api.listTabs(spreadsheetId),
    api.currentTabState(tabId),
  ]);

  // Canonical URL for this view is guid-based -- see the matching comment
  // in renderSheetTabs. spreadsheet can be null here (existing defensive
  // handling above, e.g. a permission edge case where /tabs still loads
  // but /spreadsheets/{id} doesn't) -- only rewrite if we actually have a
  // guid to rewrite to.
  if (spreadsheet && spreadsheet.guid) {
    history.replaceState(null, '', `#/s/${spreadsheet.guid}/t/${tabId}`);
  }
  const sheetUrl = (tid) => (spreadsheet && spreadsheet.guid)
    ? `#/s/${spreadsheet.guid}/t/${tid}`
    : `#/sheets/${spreadsheetId}/tabs/${tid}`;

  const readOnly = false; // grid itself doesn't know permissions; server rejects unauthorized writes either way
  const docData = current.data || { cells: {} };
  const currentTab = tabsRes.tabs.find((t) => t.id === tabId) || null;
  const reload = () => renderSheet(spreadsheetId, tabId);

  const me = getCurrentUser();
  const canManageAccess = !!spreadsheet && !!me && (me.isAdmin || spreadsheet.owner_id === me.id);

  // --- Status area: connection state and last-saved time are two
  // separate small facts, not one ambiguous word ("what is the
  // disconnected word top right?"). Both auto-save paths (WS server-side
  // debounce, and the REST fallback below) already save without a manual
  // trigger -- this just surfaces when that last happened.
  const connectionEl = el('span', { class: 'status-dot status-connecting' }, 'Connecting…');
  const savedEl = el('span', { class: 'status-saved' }, '');
  let lastSavedAt = current.created_at ? new Date(current.created_at.replace(' ', 'T') + 'Z') : null;
  function renderSavedLabel() {
    savedEl.textContent = lastSavedAt ? `Saved ${formatRelativeTime(lastSavedAt)}` : '';
  }
  renderSavedLabel();
  const savedTick = setInterval(renderSavedLabel, 20000);

  const gridContainer = el('div', { class: 'grid-container' });
  const grid = new Grid(gridContainer, {
    document: docData,
    readOnly,
    // grid.js assembles the full-document-shaped patch itself (e.g.
    // {cells: {...}} or {columnWidths: {...}}) -- that's the wire shape
    // ws-server/merge_patch.py expects, since new_edit merge-patches
    // against the WHOLE document, not just the cells dict. Sending a bare
    // {ref: {...}} patch directly (the previous behavior here) was a real,
    // previously-undetected bug: it added each cell ref as a top-level
    // sibling key next to "cells" instead of updating cells[ref], silently
    // orphaning every live edit made over an active WebSocket session
    // (confirmed live: a test edit landed as {"A1": {...}, "cells": {}} --
    // invisible to the app, which only ever reads data.cells). Never
    // caught before because the WS server isn't wired through Apache in
    // production yet.
    onChange: (patch) => {
      socket.queueEdit(patch);
      localSaveFallbackTimer();
    },
  });

  // Formula bar: classic spreadsheet UX -- shows/edits the RAW value
  // (literal or "=formula") of whatever's selected, as an alternative to
  // typing directly into the cell. Reuses grid.setCellValue -- the exact
  // same commit path in-cell editing uses, so there's only one place that
  // decides what "committing a cell edit" means.
  const formulaRefLabel = el('span', { class: 'formula-ref' }, '');
  const formulaInput = el('input', {
    type: 'text', class: 'formula-input', placeholder: 'Select a cell to edit its value or formula',
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); formulaInput.blur(); }
      else if (e.key === 'Escape') { formulaBar.onSelect(grid.selected); formulaInput.blur(); }
    },
    onblur: () => {
      if (grid.selected && !readOnly) grid.setCellValue(grid.selected, formulaInput.value);
    },
  });
  const formulaBar = {
    el: el('div', { class: 'formula-bar' }, [formulaRefLabel, formulaInput]),
    onSelect: (ref) => {
      formulaRefLabel.textContent = ref || '';
      if (document.activeElement !== formulaInput) {
        formulaInput.value = ref && grid.cells[ref] ? (grid.cells[ref].value || '') : '';
      }
    },
  };
  grid.onSelectionChange = (ref) => formulaBar.onSelect(ref);

  const tabNav = el('nav', { class: 'tab-nav' });
  tabsRes.tabs.forEach((t) => {
    const isActive = t.id === tabId;
    tabNav.appendChild(el('a', {
      href: sheetUrl(t.id),
      class: isActive ? 'active' : '',
    }, t.name));
  });

  const tabMenuBtn = el('button', { class: 'btn btn-secondary btn-icon', title: 'Tab options' }, '⋮');
  tabMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showTabMenu(tabMenuBtn, {
      tabId,
      tabName: currentTab ? currentTab.name : 'Tab',
      grid,
      onRenamed: reload,
    });
  });

  // Bold/italic/underline/wrap are real TOGGLES now (read the current
  // selection's format and flip it) -- the old version just always forced
  // the value on, so there was no way to turn formatting back off from the
  // toolbar.
  const toolbar = el('div', { class: 'toolbar' }, [
    el('button', { class: 'btn btn-icon', title: 'Bold', onclick: () => grid.toggleFormatOnSelection('bold') }, 'B'),
    el('button', { class: 'btn btn-icon', title: 'Italic', onclick: () => grid.toggleFormatOnSelection('italic') }, 'I'),
    el('button', { class: 'btn btn-icon', title: 'Underline', onclick: () => grid.toggleFormatOnSelection('underline') }, 'U'),
    el('input', {
      class: 'btn-color', type: 'color', title: 'Text color',
      onchange: (e) => grid.applyFormatToSelection({ color: e.target.value }),
    }),
    el('input', {
      class: 'btn-color', type: 'color', title: 'Background', value: '#ffffff',
      onchange: (e) => grid.applyFormatToSelection({ bg: e.target.value }),
    }),
    el('select', {
      class: 'toolbar-select', title: 'Font',
      onchange: (e) => grid.applyFormatToSelection({ fontFamily: e.target.value || undefined }),
    }, [
      el('option', { value: '' }, 'Default font'),
      ...Object.keys(FONT_FAMILIES).map((k) => el('option', { value: k }, k)),
    ]),
    el('select', {
      class: 'toolbar-select', title: 'Font size',
      onchange: (e) => grid.applyFormatToSelection({ fontSize: e.target.value || undefined }),
    }, [
      el('option', { value: '' }, 'Default size'),
      ...Object.keys(FONT_SIZES).map((k) => el('option', { value: k }, k)),
    ]),
    el('button', { class: 'btn btn-icon', title: 'Wrap text', onclick: () => grid.toggleFormatOnSelection('wrap') }, '⏎'),
    el('button', {
      class: 'btn btn-secondary btn-small', title: 'Merge selected cells',
      onclick: () => {
        const result = grid.mergeSelection();
        if (!result.ok) alert(result.error);
      },
    }, 'Merge'),
    el('button', {
      class: 'btn btn-secondary btn-small', title: 'Unmerge',
      onclick: () => {
        const result = grid.unmergeSelection();
        if (!result.ok) alert(result.error);
      },
    }, 'Unmerge'),
    el('div', { class: 'toolbar-spacer' }),
    tabMenuBtn,
  ]);

  const actions = el('div', { class: 'sheet-actions' }, [
    el('button', { class: 'btn btn-secondary btn-small', onclick: () => showRenameSpreadsheet(spreadsheet, reload) }, 'Rename'),
    el('button', { class: 'btn btn-secondary btn-small', onclick: () => showManageTabs(spreadsheetId, tabId, reload) }, 'Manage tabs'),
    canManageAccess ? el('button', { class: 'btn btn-secondary btn-small', onclick: () => showShare(spreadsheetId) }, 'Share') : null,
    el('a', { href: '#/sheets', class: 'btn btn-secondary btn-small' }, 'Exit'),
  ]);

  mount(el('div', { class: 'page sheet-page' }, [
    el('header', { class: 'topbar' }, [
      el('h1', {}, (spreadsheet && spreadsheet.title) || 'Spreadsheet'),
      actions,
    ]),
    el('div', { class: 'status-row' }, [connectionEl, savedEl]),
    tabNav,
    toolbar,
    formulaBar.el,
    gridContainer,
  ]));

  // --- REST fallback autosave, so editing still works if the socket
  // never connects (e.g. before the proxy is wired up) or drops. Debounced
  // the same way the WS path is (see EDIT_DEBOUNCE_MS in ws.js), just
  // routed to POST /api/tabs/{id}/save instead of a WS message. This was
  // already auto-saving before -- the removed "Save now" button was only
  // ever a manual force-flush, not a requirement to save at all.
  let saveTimer = null;
  function localSaveFallbackTimer() {
    if (socket.isConnected()) return; // socket path handles persistence
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await api.saveTabState(
          tabId,
          { cells: grid.cells, columnWidths: grid.columnWidths, rowHeights: grid.rowHeights },
          getDisplayName(),
        );
        lastSavedAt = new Date();
        renderSavedLabel();
      } catch {
        /* best-effort; next edit will retry */
      }
    }, 1200);
  }

  const socket = new TabSocket(tabId, {
    onState: (data) => {
      grid.setDocument(data || { cells: {} });
    },
    onRemoteEdit: (patch) => grid.applyRemote(patch),
    onRemoteKeystroke: () => {
      /* could show a "someone is typing" indicator; kept minimal */
    },
    onSaved: () => {
      lastSavedAt = new Date();
      renderSavedLabel();
    },
    onStatus: (status) => {
      // "unavailable" and "disconnected" both mean the REST fallback is
      // doing the saving instead -- editing still works either way, so
      // this is never "saving disabled", just "not live right now".
      const live = status === 'connected';
      connectionEl.className = 'status-dot ' + (live ? 'status-live' : status === 'connecting' ? 'status-connecting' : 'status-offline');
      connectionEl.textContent = live ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline';
    },
  });
  socket.connect();

  gridContainer.addEventListener('mousemove', () => {
    socket.sendKeystroke({ at: Date.now() });
  });

  currentTeardown = () => {
    clearInterval(savedTick);
    socket.close();
  };
}

async function showHistory(tabId, grid) {
  const { history } = await api.listHistory(tabId, 50);
  const list = el('ul', { class: 'history-list' });
  for (const h of history) {
    const label = `#${h.sequence} — ${h.saved_by_name || 'Anonymous'} — ${h.created_at}`;
    const btn = el('button', {
      class: 'btn btn-small',
      onclick: async () => {
        await api.restoreVersion(tabId, h.sequence, getDisplayName());
        const current = await api.currentTabState(tabId);
        grid.setDocument(current.data || { cells: {} });
        dialog.remove();
      },
    }, 'Restore');
    list.appendChild(el('li', {}, [el('span', {}, label), btn]));
  }
  const dialog = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-content' }, [
      el('h2', {}, 'History'),
      list,
      el('button', { class: 'btn btn-secondary', onclick: () => dialog.remove() }, 'Close'),
    ]),
  ]);
  document.body.appendChild(dialog);
}

const ACCESS_LEVELS = [
  ['none', 'No access'],
  ['view', 'Can view'],
  ['edit', 'Can view and edit'],
];

async function showShare(spreadsheetId) {
  const body = el('div', { class: 'share-body' });
  const error = el('p', { class: 'error hidden' });

  async function refresh() {
    body.textContent = '';
    error.classList.add('hidden');
    const { access } = await api.listAccess(spreadsheetId);
    const anonRow = access.find((a) => a.user_id === 0);
    const userRows = access.filter((a) => a.user_id !== 0);

    const anonSelect = el(
      'select',
      {
        onchange: async (e) => {
          const level = e.target.value;
          if (level === 'none') await api.revokeAccess(spreadsheetId, 0);
          else await api.grantAccess(spreadsheetId, 0, level);
          await refresh();
        },
      },
      ACCESS_LEVELS.map(([value, label]) =>
        el('option', { value, selected: value === (anonRow ? anonRow.access_level : 'none') || null }, label))
    );

    const userList = el('ul', { class: 'access-list' });
    for (const a of userRows) {
      userList.appendChild(el('li', {}, [
        el('span', {}, `${a.display_name || a.username} (${a.username}) — ${a.access_level}`),
        el('button', {
          class: 'btn btn-small btn-danger',
          onclick: async () => { await api.revokeAccess(spreadsheetId, a.user_id); await refresh(); },
        }, 'Revoke'),
      ]));
    }

    const shareUsername = el('input', { type: 'text', placeholder: 'Username' });
    const shareLevel = el('select', {}, [
      el('option', { value: 'view' }, 'Can view'),
      el('option', { value: 'edit' }, 'Can view and edit'),
    ]);
    const shareForm = el('form', {
      class: 'inline-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const username = shareUsername.value.trim();
        if (!username) return;
        try {
          const found = await api.lookupUser(username);
          await api.grantAccess(spreadsheetId, found.id, shareLevel.value);
          shareUsername.value = '';
          await refresh();
        } catch {
          error.textContent = `No user found with username "${username}".`;
          error.classList.remove('hidden');
        }
      },
    }, [shareUsername, shareLevel, el('button', { class: 'btn', type: 'submit' }, 'Share')]);

    body.appendChild(el('div', { class: 'share-section' }, [
      el('h3', {}, 'Anonymous access'),
      el('p', { class: 'muted' }, 'Anyone with the link, without logging in.'),
      anonSelect,
    ]));
    body.appendChild(el('div', { class: 'share-section' }, [
      el('h3', {}, 'People with access'),
      userRows.length ? userList : el('p', { class: 'muted' }, 'Not shared with anyone by username yet.'),
    ]));
    body.appendChild(el('div', { class: 'share-section' }, [
      el('h3', {}, 'Share with someone'),
      shareForm,
    ]));
  }

  const dialog = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-content' }, [
      el('h2', {}, 'Share'),
      error,
      body,
      el('button', { class: 'btn btn-secondary', onclick: () => dialog.remove() }, 'Close'),
    ]),
  ]);
  document.body.appendChild(dialog);
  await refresh();
}

// Small floating dropdown for the currently-viewed tab's quick actions.
// Deliberately separate from showManageTabs below: this is "things you do
// to the tab you're looking at" (Fernando: "in the tab menu, I want import
// and export buttons, history, rename tab"), that's "manage every tab in
// this spreadsheet" (create/reorder/delete any of them).
function showTabMenu(anchorEl, { tabId, tabName, grid, onRenamed }) {
  document.querySelectorAll('.tab-menu').forEach((n) => n.remove());

  const menu = el('div', { class: 'tab-menu' }, [
    el('button', { class: 'tab-menu-item', type: 'button', onclick: () => { close(); exportCsv(tabId); } }, 'Export CSV'),
    el('label', { class: 'tab-menu-item file-btn' }, [
      'Import CSV',
      el('input', {
        type: 'file', accept: '.csv',
        onchange: (e) => { close(); importCsv(tabId, e, grid); },
      }),
    ]),
    el('button', { class: 'tab-menu-item', type: 'button', onclick: () => { close(); showHistory(tabId, grid); } }, 'History'),
    el('button', {
      class: 'tab-menu-item', type: 'button',
      onclick: async () => {
        close();
        const name = window.prompt('Rename tab', tabName);
        if (name && name.trim() && name.trim() !== tabName) {
          await api.renameTab(tabId, name.trim());
          onRenamed();
        }
      },
    }, 'Rename tab'),
  ]);

  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.left = `${Math.max(8, rect.right + window.scrollX - menu.offsetWidth)}px`;

  function close() {
    menu.remove();
    document.removeEventListener('click', onDocClick);
  }
  function onDocClick(e) {
    if (!menu.contains(e.target) && e.target !== anchorEl) close();
  }
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
}

function showRenameSpreadsheet(spreadsheet, onDone) {
  const input = el('input', { type: 'text', value: (spreadsheet && spreadsheet.title) || '' });
  const error = el('p', { class: 'error hidden' });

  const dialog = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-content' }, [
      el('h2', {}, 'Rename spreadsheet'),
      error,
      el('form', {
        class: 'inline-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const title = input.value.trim();
          if (!title || !spreadsheet) return;
          try {
            await api.renameSpreadsheet(spreadsheet.id, title);
            dialog.remove();
            onDone();
          } catch {
            error.textContent = 'Could not rename (you may not have permission).';
            error.classList.remove('hidden');
          }
        },
      }, [input, el('button', { class: 'btn', type: 'submit' }, 'Save')]),
      el('button', { class: 'btn btn-secondary', onclick: () => dialog.remove() }, 'Close'),
    ]),
  ]);
  document.body.appendChild(dialog);
  input.focus();
  input.select();
}

// Full tab management: create, reorder (swaps the two tabs' `position`
// values -- TabRepository.reorder() just sets the raw column, it doesn't
// shift neighbors, so a single-sided update would leave two tabs sharing
// a position), rename, delete. Reachable via the "Manage tabs" button next
// to the spreadsheet title, not just the per-tab quick menu above.
async function showManageTabs(spreadsheetId, currentTabId, onChanged) {
  const body = el('div', {});
  const error = el('p', { class: 'error hidden' });

  async function refresh() {
    body.textContent = '';
    error.classList.add('hidden');
    const { tabs } = await api.listTabs(spreadsheetId);

    const list = el('ul', { class: 'manage-tabs-list' });
    tabs.forEach((t, i) => {
      const prev = tabs[i - 1];
      const next = tabs[i + 1];
      list.appendChild(el('li', {}, [
        el('span', { class: t.id === currentTabId ? 'manage-tabs-current' : '' }, t.name),
        el('span', { class: 'manage-tabs-controls' }, [
          el('button', {
            class: 'btn btn-small btn-secondary', title: 'Move left',
            disabled: !prev || null,
            onclick: async () => {
              if (!prev) return;
              await Promise.all([api.reorderTab(t.id, prev.position), api.reorderTab(prev.id, t.position)]);
              await refresh();
              onChanged();
            },
          }, '←'),
          el('button', {
            class: 'btn btn-small btn-secondary', title: 'Move right',
            disabled: !next || null,
            onclick: async () => {
              if (!next) return;
              await Promise.all([api.reorderTab(t.id, next.position), api.reorderTab(next.id, t.position)]);
              await refresh();
              onChanged();
            },
          }, '→'),
          el('button', {
            class: 'btn btn-small btn-secondary',
            onclick: async () => {
              const name = window.prompt('Rename tab', t.name);
              if (name && name.trim() && name.trim() !== t.name) {
                await api.renameTab(t.id, name.trim());
                await refresh();
                onChanged();
              }
            },
          }, 'Rename'),
          tabs.length > 1 ? el('button', {
            class: 'btn btn-small btn-danger',
            onclick: async () => {
              if (!window.confirm(`Delete tab "${t.name}"? This cannot be undone from here.`)) return;
              try {
                await api.deleteTab(t.id, getDisplayName());
                await refresh();
                onChanged();
              } catch {
                error.textContent = 'Could not delete tab (you may not have permission).';
                error.classList.remove('hidden');
              }
            },
          }, 'Delete') : null,
        ]),
      ]));
    });
    body.appendChild(list);

    const newName = el('input', { type: 'text', placeholder: 'New tab name' });
    body.appendChild(el('form', {
      class: 'inline-form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!newName.value.trim()) return;
        try {
          await api.createTab(spreadsheetId, newName.value.trim(), getDisplayName());
          newName.value = '';
          await refresh();
          onChanged();
        } catch {
          error.textContent = 'Could not create tab (you may not have permission).';
          error.classList.remove('hidden');
        }
      },
    }, [newName, el('button', { class: 'btn', type: 'submit' }, 'Add tab')]));
  }

  const dialog = el('div', { class: 'modal' }, [
    el('div', { class: 'modal-content' }, [
      el('h2', {}, 'Manage tabs'),
      error,
      body,
      el('button', { class: 'btn btn-secondary', onclick: () => dialog.remove() }, 'Close'),
    ]),
  ]);
  document.body.appendChild(dialog);
  await refresh();
}

function exportCsv(tabId) {
  window.location.href = api.exportCsvUrl(tabId);
}

async function importCsv(tabId, event, grid) {
  const file = event.target.files[0];
  if (!file) return;
  const text = await file.text();
  await api.importCsv(tabId, text, getDisplayName());
  const current = await api.currentTabState(tabId);
  grid.setDocument(current.data || { cells: {} });
  event.target.value = '';
}

function renderError(e) {
  mount(el('div', { class: 'centered' }, [
    el('h1', {}, 'Something went wrong'),
    el('p', {}, e && e.message ? e.message : String(e)),
    el('a', { href: '#/sheets' }, 'Back to spreadsheets'),
  ]));
}

// Ask an anonymous visitor for a display name once, on first visit to the
// app generally -- not just when they land inside a specific sheet (the
// old behavior). Only fires if they're not logged in and don't already
// have a display-name cookie; never fires again once one's set. Runs
// before the very first route() so it's the first thing a fresh
// anonymous visitor sees, on both mobile and desktop.
function promptForNameIfNeeded() {
  if (!isLoggedIn() && !getDisplayName()) {
    // TODO(next UI pass): replace with a small in-app modal to match the
    // rest of the app's styling -- left as window.prompt() here since a
    // broader menu/UI overhaul is already planned as separate follow-up
    // work and will likely revisit this anyway.
    const name = window.prompt('What name should we show next to your edits?', '');
    if (name && name.trim()) setDisplayName(name.trim());
  }
}

promptForNameIfNeeded();
route();
