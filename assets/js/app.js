import { api, ApiError, getToken, setToken, getDisplayName, setDisplayName, getCurrentUser } from './api.js';
import { Grid } from './grid.js';
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
  const tabsListUrl = (spreadsheet && spreadsheet.guid) ? `#/s/${spreadsheet.guid}` : `#/sheets/${spreadsheetId}`;

  const readOnly = false; // grid itself doesn't know permissions; server rejects unauthorized writes either way
  const cells = (current.data && current.data.cells) || {};

  const me = getCurrentUser();
  const canManageAccess = !!spreadsheet && !!me && (me.isAdmin || spreadsheet.owner_id === me.id);

  const statusEl = el('span', { class: 'ws-status' }, 'connecting…');
  const gridContainer = el('div', { class: 'grid-container' });
  const grid = new Grid(gridContainer, {
    cells,
    readOnly,
    onChange: (patch) => {
      socket.queueEdit(patch);
      localSaveFallbackTimer();
    },
  });

  const tabNav = el('nav', { class: 'tab-nav' });
  tabsRes.tabs.forEach((t) => {
    const isActive = t.id === tabId;
    tabNav.appendChild(el('a', {
      href: sheetUrl(t.id),
      class: isActive ? 'active' : '',
    }, t.name));
  });

  const toolbar = el('div', { class: 'toolbar' }, [
    el('button', { class: 'btn btn-icon', onclick: () => grid.applyFormatToSelection({ bold: true }) }, 'B'),
    el('button', { class: 'btn btn-icon', onclick: () => grid.applyFormatToSelection({ italic: true }) }, 'I'),
    el('input', {
      class: 'btn-color', type: 'color', title: 'Text color',
      onchange: (e) => grid.applyFormatToSelection({ color: e.target.value }),
    }),
    el('input', {
      class: 'btn-color', type: 'color', title: 'Background', value: '#ffffff',
      onchange: (e) => grid.applyFormatToSelection({ bg: e.target.value }),
    }),
    el('button', { class: 'btn', onclick: () => socket.requestSave() }, 'Save now'),
    el('button', { class: 'btn', onclick: () => showHistory(tabId, grid) }, 'History'),
    canManageAccess ? el('button', { class: 'btn', onclick: () => showShare(spreadsheetId) }, 'Share') : null,
    el('button', { class: 'btn', onclick: () => exportCsv(tabId) }, 'Export CSV'),
    el('label', { class: 'btn file-btn' }, [
      'Import CSV',
      el('input', { type: 'file', accept: '.csv', onchange: (e) => importCsv(tabId, e, grid) }),
    ]),
  ]);

  mount(el('div', { class: 'page sheet-page' }, [
    el('header', { class: 'topbar' }, [
      el('a', { href: tabsListUrl, class: 'link' }, '← Tabs'),
      el('h1', {}, (spreadsheet && spreadsheet.title) || 'Spreadsheet'),
      statusEl,
    ]),
    tabNav,
    toolbar,
    gridContainer,
  ]));

  // --- REST fallback autosave, so editing still works if the socket
  // never connects (e.g. before the proxy is wired up) or drops. Debounced
  // the same way the WS path is (see EDIT_DEBOUNCE_MS in ws.js), just
  // routed to POST /api/tabs/{id}/save instead of a WS message.
  let saveTimer = null;
  function localSaveFallbackTimer() {
    if (socket.isConnected()) return; // socket path handles persistence
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await api.saveTabState(tabId, { cells: grid.cells }, getDisplayName());
        statusEl.textContent = 'saved (offline mode)';
      } catch {
        /* best-effort; next edit will retry */
      }
    }, 1200);
  }

  const socket = new TabSocket(tabId, {
    onState: (data) => {
      grid.setCells((data && data.cells) || {});
    },
    onRemoteEdit: (patch) => grid.applyRemote(patch),
    onRemoteKeystroke: () => {
      /* could show a "someone is typing" indicator; kept minimal */
    },
    onSaved: () => {
      statusEl.textContent = 'saved';
      setTimeout(() => { statusEl.textContent = socket.isConnected() ? 'live' : 'offline'; }, 1500);
    },
    onStatus: (status) => {
      statusEl.textContent = status === 'connected' ? 'live' : status === 'unavailable' ? 'offline (saving disabled)' : status;
    },
  });
  socket.connect();

  gridContainer.addEventListener('mousemove', () => {
    socket.sendKeystroke({ at: Date.now() });
  });

  currentTeardown = () => socket.close();
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
        grid.setCells((current.data && current.data.cells) || {});
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

function exportCsv(tabId) {
  window.location.href = api.exportCsvUrl(tabId);
}

async function importCsv(tabId, event, grid) {
  const file = event.target.files[0];
  if (!file) return;
  const text = await file.text();
  await api.importCsv(tabId, text, getDisplayName());
  const current = await api.currentTabState(tabId);
  grid.setCells((current.data && current.data.cells) || {});
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
