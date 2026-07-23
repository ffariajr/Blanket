import { api, ApiError, setToken, getDisplayName, setDisplayName, isSessionValid, APP_BASE } from './api.js?v=__DEPLOY_VERSION__';
import { Grid, FONT_FAMILIES, FONT_SIZES, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, FORMAT_MIXED } from './grid.js?v=__DEPLOY_VERSION__';
import { TabSocket } from './ws.js?v=__DEPLOY_VERSION__';

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
  return isSessionValid();
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

// 2-minute grace period, per Fernando's precise clarification: "green
// means the website is active, or it is not active but 2 minutes since
// it was active. Yellow means the user has not closed the web page but
// they are more than 2 minutes since the page was active." Also used
// locally (renderSheet's markLocalActive/idleTimer) for when THIS client
// itself reports going idle to the server -- one constant, one meaning,
// both directions. Exported (module-level, not buried in renderSheet's
// closure) so this correctness-critical rule is directly unit-testable
// rather than only exercisable through a full rendered page.
export const IDLE_GRACE_MS = 2 * 60 * 1000;

// Active (green) if the server says so, OR if it doesn't but less than
// IDLE_GRACE_MS has elapsed since last_active_at -- a pure function of
// elapsed time, not just the raw flag from the last presence broadcast,
// since a viewer can silently cross from green to yellow with no new
// message at all (renderSheet's presenceTick re-renders on a timer for
// exactly this). No elapsed-time text is shown anywhere, per Fernando:
// "don't report last active time, just show the yellow dot."
export function viewerIsActive(viewer) {
  if (viewer.active) return true;
  return (Date.now() - viewer.last_active_at * 1000) < IDLE_GRACE_MS;
}

// --- Router -----------------------------------------------------------
//
// Canonical, shareable URL for viewing a spreadsheet+tab is a REAL path +
// query string: `${APP_BASE}<guid>?tab=<ordinal>` (e.g.
// /blanket/7dcc.../?tab=0) -- Fernando's explicit ask, not a #/s/... hash
// fragment. `ordinal` is a 0-indexed position into the tabs list sorted
// by `position` (robust to gaps from deletion/reordering -- NOT a literal
// match against a tab's stored position column value, which could point
// at nothing or the wrong tab after edits). Landing on `${APP_BASE}<guid>`
// with no `?tab=` (e.g. straight off the books-menu list) opens tab 0 --
// there's no separate "list of tabs" page anymore (removed per Fernando:
// "remove that tabs list view. it should be books menu > tab 0 open").
//
// Hash-based routes (`#/sheets/{id}/tabs/{id}` from the original
// numeric-id routing, `#/s/<guid>/t/<tabId>` from an earlier fork) still
// resolve for backward compatibility, then get canonicalized to the real
// path+query form via history.replaceState inside renderSheet -- see
// there. Internal navigation links still just use `#/s/<guid>/t/<id>`
// href's (simplest, and hash-navigation is path-preserving so it doesn't
// disturb any real path already in the address bar); renderSheet cleans
// up the address bar to the canonical form immediately after resolving,
// regardless of which route got it there.

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Single source of truth for "what's the canonical shareable URL for this
// guid+tab" -- used both to canonicalize the address bar (renderSheet)
// and to build the Share dialog's "Copy link" button, so the two can
// never drift apart. `ordinal` matches the resolution rule route() uses
// to go the other direction (ordinal -> tab): 0-indexed position in the
// tabs list sorted by `position`, not a literal match against the
// position column (which has gaps after deletion/reordering).
function shareUrlForTab(guid, tabs, tabId) {
  const sorted = tabs.slice().sort((a, b) => a.position - b.position);
  const ordinal = sorted.findIndex((t) => t.id === tabId);
  const qs = ordinal >= 0 ? `?tab=${ordinal}` : '';
  return `${APP_BASE}${guid}${qs}`;
}

function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return hash.split('/').filter(Boolean);
}

// The guid segment currently sitting in the real path, if any (relative
// to APP_BASE, e.g. pathname `/blanket/7dcc.../` -> `7dcc...`).
function currentPathGuid() {
  let rel = window.location.pathname;
  if (rel.startsWith(APP_BASE)) rel = rel.slice(APP_BASE.length);
  const seg = rel.replace(/^\/+/, '').split('/')[0];
  return seg && GUID_RE.test(seg) ? seg : null;
}

// `?tab=` from the query string -- a non-negative integer ordinal, or
// null if absent/malformed (treated as "no tab specified" -> tab 0).
function tabOrdinalFromQuery() {
  const raw = new URLSearchParams(window.location.search).get('tab');
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Resolves a 0-indexed ordinal (position in a position-sorted tabs list)
// to that tab, or null if the spreadsheet has no tabs / the ordinal is
// out of range. Defaults to ordinal 0 when none is given.
async function resolveTabByOrdinal(spreadsheetId, ordinal) {
  const { tabs } = await api.listTabs(spreadsheetId);
  const sorted = tabs.slice().sort((a, b) => a.position - b.position);
  return sorted[ordinal ?? 0] || null;
}

async function route() {
  const parts = parseHash();

  // A hash-based navigation (an internal link click, or the numeric/old
  // guid-hash forms below) takes priority over -- and clears -- any real
  // guid path left over in the address bar from a previously-canonicalized
  // view, so e.g. clicking "Exit" (#/sheets) from
  // /blanket/<guid>?tab=0#/sheets doesn't get stuck re-resolving the old
  // guid on this or the next route() call.
  if (parts.length > 0 && currentPathGuid()) {
    history.replaceState(null, '', APP_BASE + window.location.hash);
  }

  try {
    if (parts.length === 0) {
      const pathGuid = currentPathGuid();
      if (pathGuid) {
        const spreadsheet = await api.getSpreadsheetByGuid(pathGuid);
        const tab = await resolveTabByOrdinal(spreadsheet.id, tabOrdinalFromQuery());
        return tab ? renderSheet(spreadsheet.id, tab.id) : renderNoTabs(spreadsheet.id, spreadsheet);
      }
      if (!isLoggedIn()) return renderLogin();
      return renderSheetsList();
    }
    if (parts[0] === 'login') {
      return renderLogin();
    }
    // Legacy hash forms -- still resolve, then renderSheet canonicalizes
    // the address bar to the real path+query form.
    if (parts[0] === 's' && parts[1] && parts[2] === 't' && parts[3]) {
      const spreadsheet = await api.getSpreadsheetByGuid(parts[1]);
      return renderSheet(spreadsheet.id, parseInt(parts[3], 10));
    }
    if (parts[0] === 's' && parts[1]) {
      const spreadsheet = await api.getSpreadsheetByGuid(parts[1]);
      const tab = await resolveTabByOrdinal(spreadsheet.id, null);
      return tab ? renderSheet(spreadsheet.id, tab.id) : renderNoTabs(spreadsheet.id, spreadsheet);
    }
    if (parts[0] === 'sheets' && parts[1] && parts[2] === 'tabs' && parts[3]) {
      return renderSheet(parseInt(parts[1], 10), parseInt(parts[3], 10));
    }
    if (parts[0] === 'sheets' && parts[1]) {
      const spreadsheetId = parseInt(parts[1], 10);
      const tab = await resolveTabByOrdinal(spreadsheetId, null);
      return tab ? renderSheet(spreadsheetId, tab.id) : renderNoTabs(spreadsheetId, null);
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
window.addEventListener('popstate', route);

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
      const li = el('li', {}, [link]);

      // Owner gets "Duplicate" (asks about sharing settings first); a
      // logged-in editor/viewer gets "Make a copy" (no dialog -- always
      // private, since they can't see the sharing list to begin with,
      // per Permissions::canManage()). Anonymous/no-access: no button --
      // there's no account to own the resulting copy under.
      if (s.my_access === 'owner') {
        li.appendChild(el('button', {
          class: 'btn btn-small',
          onclick: async () => {
            const shareToo = window.confirm("Also duplicate this spreadsheet's sharing settings?");
            await api.duplicateSpreadsheet(s.id, shareToo);
            await refresh();
          },
        }, 'Duplicate'));
      } else if (s.my_access === 'edit' || s.my_access === 'view') {
        li.appendChild(el('button', {
          class: 'btn btn-small',
          onclick: async () => {
            await api.duplicateSpreadsheet(s.id, false);
            await refresh();
          },
        }, 'Make a copy'));
      }

      list.appendChild(li);
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

// No standalone "list of tabs" page anymore (removed per Fernando:
// "remove that tabs list view. it should be books menu > tab 0 open") --
// route() always resolves straight to a specific tab's grid. This is
// only reached for the edge case a spreadsheet has zero tabs yet (e.g.
// just created from the books menu), where there's no tab 0 to jump to.
// Reuses the existing "Manage tabs" dialog to create the first one rather
// than duplicating tab-creation UI here.
async function renderNoTabs(spreadsheetId, spreadsheet) {
  if (!spreadsheet) {
    spreadsheet = await api.getSpreadsheet(spreadsheetId).catch(() => null);
  }

  function openManageTabs() {
    showManageTabs(spreadsheetId, null, () => route());
  }

  // Creating a tab is a tab-structure write, owner-only (TabController::
  // create() gates on canManage -- see the comment there). This is a rare
  // edge case in practice (every new spreadsheet auto-creates "tab-0"
  // now), but a non-owner somehow landing here shouldn't see a button
  // that would just be rejected by the server.
  const canManage = !!spreadsheet && spreadsheet.my_access === 'owner';

  mount(el('div', { class: 'page' }, [
    el('header', { class: 'topbar' }, [
      el('a', { href: '#/sheets', class: 'link' }, '← All spreadsheets'),
      el('h1', {}, spreadsheet ? spreadsheet.title : 'Spreadsheet'),
    ]),
    el('div', { class: 'centered' }, [
      el('p', { class: 'muted' }, "This spreadsheet doesn't have any tabs yet."),
      canManage
        ? el('button', { class: 'btn', onclick: openManageTabs }, 'Add a tab')
        : el('p', { class: 'muted' }, 'Ask the owner to add one.'),
    ]),
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

  // Canonical, shareable URL for this view: real path + query, per
  // Fernando's request -- `${APP_BASE}<guid>?tab=<ordinal>`, not a
  // #/s/<guid>/t/<id> hash. Rewritten here regardless of which route (the
  // real path itself, or a legacy hash form) actually got us here, so
  // whatever's in the address bar right now always converges to the
  // shareable form. spreadsheet can be null here (existing defensive
  // handling above, e.g. a permission edge case where /tabs still loads
  // but /spreadsheets/{id} doesn't) -- only rewrite if we actually have a
  // guid to rewrite to. `ordinal` is this tab's 0-indexed position in the
  // position-sorted tabs list -- matches the resolution rule route() uses
  // to go the other direction (ordinal -> tab).
  const shareUrl = (spreadsheet && spreadsheet.guid)
    ? shareUrlForTab(spreadsheet.guid, tabsRes.tabs, tabId)
    : null;
  if (shareUrl) {
    history.replaceState(null, '', shareUrl);
  }
  const sheetUrl = (tid) => (spreadsheet && spreadsheet.guid)
    ? `#/s/${spreadsheet.guid}/t/${tid}`
    : `#/sheets/${spreadsheetId}/tabs/${tid}`;

  // Was hardcoded `false` -- the UI optimistically allowed editing
  // regardless of actual access and just relied on the server silently
  // rejecting writes it shouldn't allow, which produces "looks editable,
  // edits silently have no effect" (Fernando: "if a user is view only,
  // they should not be able to make edits in their browser"). `my_access`
  // is server-computed (Blanket\Auth\Permissions::levelFor(), the same
  // check every write endpoint already enforces) -- fail closed (readOnly)
  // if it's missing/anything other than owner/edit, including the
  // `spreadsheet` fetch itself having failed (the pre-existing
  // permission-edge-case handling above where /tabs loads but
  // /spreadsheets/{id} doesn't -- safer to assume no edit access than to
  // assume yes).
  const readOnly = !spreadsheet || !['owner', 'edit'].includes(spreadsheet.my_access);
  const docData = current.data || { cells: {} };
  const currentTab = tabsRes.tabs.find((t) => t.id === tabId) || null;
  const reload = () => renderSheet(spreadsheetId, tabId);

  // Also server-authoritative now (was re-derived from the client-decoded
  // JWT, `me.isAdmin || spreadsheet.owner_id === me.id` -- same class of
  // bug as readOnly above: client-side inference instead of asking the
  // server what it actually decided).
  const canManageAccess = !!spreadsheet && spreadsheet.my_access === 'owner';

  // --- Status area: connection state and last-saved time are two
  // separate small facts, not one ambiguous word ("what is the
  // disconnected word top right?"). Both auto-save paths (WS server-side
  // debounce, and the REST fallback below) already save without a manual
  // trigger -- this just surfaces when that last happened.
  // title = a tooltip explaining what the word means -- Fernando asked
  // "what is the offline indicator?" even after an earlier pass relabeled
  // it from a bare ambiguous word ("disconnected") to Live/Connecting/
  // Offline; the label alone still isn't self-explanatory without this.
  const STATUS_TOOLTIPS = {
    live: 'Real-time collaboration is connected -- other people editing this tab see your changes immediately.',
    connecting: 'Connecting to real-time collaboration...',
    offline: "Real-time collaboration isn't connected right now, but your changes are still being saved automatically -- you're just not seeing other editors live.",
  };
  const connectionEl = el('span', { class: 'status-dot status-connecting', title: STATUS_TOOLTIPS.connecting }, 'Connecting…');
  // Moved next to the spreadsheet name (Fernando: "the thing about how
  // long ago the last save was to be next to the spreadsheet name") --
  // was in .status-row below the topbar, see the mount() call further
  // down for where it actually sits now.
  const savedEl = el('span', { class: 'saved-indicator' }, '');
  let lastSavedAt = current.created_at ? new Date(current.created_at.replace(' ', 'T') + 'Z') : null;
  function renderSavedLabel() {
    savedEl.textContent = lastSavedAt ? `Saved ${formatRelativeTime(lastSavedAt)}` : '';
  }
  renderSavedLabel();
  const savedTick = setInterval(renderSavedLabel, 20000);

  // --- Presence: who's viewing this spreadsheet (any tab), their cell
  // selection, and active/idle state. Fed by the WS server's spreadsheet-
  // wide presence broadcasts (ws-server/presence.py) -- see renderPresence
  // below for how a roster entry becomes UI (viewer chip, grid highlight,
  // tab-bar dot).
  const presenceListEl = el('div', { class: 'presence-list' });
  let presenceViewers = [];

  // ref -> true for every cell currently carrying a remote-selection
  // highlight, so renderPresence can clear stale ones before reapplying
  // (a viewer's selection can move, another viewer's selection can appear
  // on a cell that used to be highlighted for someone else, etc.) without
  // walking the whole grid every time.
  const remoteHighlightedRefs = new Set();

  function renderRemoteSelections() {
    for (const ref of remoteHighlightedRefs) {
      const cellEl = grid._cellEl(ref);
      if (cellEl) {
        cellEl.classList.remove('remote-selected');
        cellEl.style.removeProperty('--remote-color');
      }
    }
    remoteHighlightedRefs.clear();
    for (const viewer of presenceViewers) {
      // Only viewers on the tab currently displayed have a selection
      // meaningful to highlight in THIS grid instance -- someone on
      // another tab still shows up in the viewer list and the tab-bar
      // dots below, just not as a cell highlight here.
      if (viewer.tab_id !== tabId || !viewer.selection) continue;
      // grid._rangeRefs expands an {anchor,selected} rectangle into every
      // ref in it (same helper Grid uses internally for its own
      // selection) -- safe to reuse since this is the same grid instance/
      // coordinate system the viewer's selection was made in. A ref that
      // falls on a merge-covered cell has no element (_cellEl returns
      // null) and is silently skipped, same as everywhere else that walks
      // a range.
      for (const ref of grid._rangeRefs(viewer.selection.anchor, viewer.selection.selected)) {
        const cellEl = grid._cellEl(ref);
        if (!cellEl) continue;
        cellEl.classList.add('remote-selected');
        cellEl.style.setProperty('--remote-color', viewer.color);
        remoteHighlightedRefs.add(ref);
      }
    }
  }

  function renderPresence() {
    presenceListEl.textContent = '';
    for (const viewer of presenceViewers) {
      const active = viewerIsActive(viewer);
      presenceListEl.appendChild(el('span', {
        class: 'presence-viewer' + (viewer.is_anonymous ? ' is-anonymous' : ''),
      }, [
        el('span', { class: 'presence-activity-dot ' + (active ? 'is-active' : 'is-idle') }),
        el('span', { class: 'presence-name', style: `color: ${viewer.color}` }, viewer.name || 'Anonymous'),
      ]));
    }
    for (const [tid, dotsEl] of tabPresenceDotEls) {
      dotsEl.textContent = '';
      for (const viewer of presenceViewers) {
        if (viewer.tab_id === tid) {
          dotsEl.appendChild(el('span', { class: 'tab-presence-dot', style: `background: ${viewer.color}` }));
        }
      }
    }
    renderRemoteSelections();
  }

  // Recomputes active->idle dot color transitions that happen purely from
  // elapsed time (no new presence broadcast triggers them) -- e.g. a
  // viewer who went inactive 90s ago is green now, yellow once 2 minutes
  // have actually passed, with nothing else changing in the meantime.
  const presenceTick = setInterval(renderPresence, 15000);

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
    disabled: readOnly || null,
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); formulaInput.blur(); }
      else if (e.key === 'Escape') { formulaBar.onSelect(grid.selected); formulaInput.blur(); }
    },
    onblur: () => {
      if (grid.selected && !readOnly) grid.setCellValue(grid.selected, formulaInput.value);
    },
  });
  const formulaHelpBtn = el('button', {
    class: 'btn btn-secondary btn-icon', type: 'button', title: 'Formula help',
    onclick: () => showFormulaHelp(),
  }, '?');
  const formulaBar = {
    el: el('div', { class: 'formula-bar' }, [formulaRefLabel, formulaInput, formulaHelpBtn]),
    onSelect: (ref) => {
      formulaRefLabel.textContent = ref || '';
      if (document.activeElement !== formulaInput) {
        formulaInput.value = ref && grid.cells[ref] ? (grid.cells[ref].value || '') : '';
      }
    },
  };
  // Reflects the current selection's actual rendered font in the toolbar's
  // font pickers. DEFAULT_FONT_FAMILY ('sans') and DEFAULT_FONT_SIZE (11)
  // are themselves real entries in FONT_FAMILIES/FONT_SIZES, so "no
  // explicit override" selects that real option directly (in its normal
  // sorted list position) instead of a separate injected "Effective font:
  // sans" placeholder duplicating it -- Fernando: showing both was
  // redundant, and the injected option always appearing first broke the
  // sorted ordering regardless of where its value actually sorts. The
  // blank placeholder option now exists only for the one case a real list
  // entry genuinely can't represent: a mixed-format selection. Referenced
  // here before fontFamilySelect/fontSizeSelect are declared below (a
  // function declaration is hoisted) -- safe because it's only ever
  // invoked later, from onSelectionChange or the one-time call right
  // after the toolbar is built, by which point those consts already
  // exist.
  function updateEffectiveFontOptions() {
    const fmt = grid.getSelectionFormat();
    const familyMixed = fmt.fontFamily === FORMAT_MIXED;
    fontFamilyDefaultOption.textContent = familyMixed ? 'Mixed' : 'Default';
    fontFamilySelect.value = familyMixed ? '' : (fmt.fontFamily || DEFAULT_FONT_FAMILY);
    const sizeMixed = fmt.fontSize === FORMAT_MIXED;
    fontSizeDefaultOption.textContent = sizeMixed ? 'Mixed' : 'Default';
    fontSizeSelect.value = sizeMixed ? '' : String(fmt.fontSize || DEFAULT_FONT_SIZE);
  }
  grid.onSelectionChange = (ref) => {
    formulaBar.onSelect(ref);
    updateEffectiveFontOptions();
    // `socket` (a `const` further down, after Grid's construction) is
    // only ever actually assigned-to during renderSheet's own synchronous
    // execution, which completes before any user interaction could
    // trigger this callback -- Grid's constructor itself never selects
    // anything, so this never fires until well after `socket` exists.
    // (A `typeof socket` guard here would be actively wrong, not just
    // unnecessary: `const`/`let` are in the temporal dead zone until their
    // declaration line runs, so `typeof` on one throws instead of safely
    // returning 'undefined' the way it would for a truly undeclared name.)
    socket.sendSelection(ref ? { anchor: grid.anchor, selected: grid.selected } : null);
  };
  // Reapply remote-viewer selection highlights after any structural
  // rebuild (merge/unmerge, a remote merge-patch, resize) -- _build()
  // replaces the whole <table>, which would otherwise silently drop the
  // DOM-level highlighting renderRemoteSelections() applies directly to
  // cells (see Grid.onRebuild's doc comment in grid.js).
  grid.onRebuild = () => renderRemoteSelections();

  // tab_id -> its .tab-presence-dots element, so renderPresence() can
  // refill each tab's dots without rebuilding the whole nav on every
  // presence broadcast (a presence update is far more frequent than a
  // tab list change).
  const tabPresenceDotEls = new Map();
  const tabNav = el('nav', { class: 'tab-nav' });
  tabsRes.tabs.forEach((t) => {
    const isActive = t.id === tabId;
    const dotsEl = el('span', { class: 'tab-presence-dots' });
    tabPresenceDotEls.set(t.id, dotsEl);
    tabNav.appendChild(el('a', {
      href: sheetUrl(t.id),
      class: isActive ? 'active' : '',
    }, [t.name, dotsEl]));
  });

  const tabMenuBtn = el('button', { class: 'btn btn-secondary btn-icon', title: 'Tab options' }, '⋮');
  tabMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showTabMenu(tabMenuBtn, {
      tabId,
      tabName: currentTab ? currentTab.name : 'Tab',
      grid,
      canManage: canManageAccess,
      onRenamed: reload,
    });
  });

  // Bold/italic/underline/wrap are real TOGGLES now (read the current
  // selection's format and flip it) -- the old version just always forced
  // the value on, so there was no way to turn formatting back off from the
  // toolbar. Every write control here gets `disabled: readOnly || null` --
  // Grid already blocks the underlying calls internally when readOnly,
  // but a fully clickable-looking toolbar that silently does nothing on
  // click is exactly the "looks editable, isn't" gap this pass fixes.
  const fontFamilyDefaultOption = el('option', { value: '' }, 'Default');
  const fontFamilySelect = el('select', {
    class: 'toolbar-select', title: 'Font', disabled: readOnly || null,
    onchange: (e) => grid.applyFormatToSelection({ fontFamily: e.target.value || undefined }),
  }, [
    fontFamilyDefaultOption,
    ...Object.keys(FONT_FAMILIES).map((k) => el('option', { value: k }, k)),
  ]);
  const fontSizeDefaultOption = el('option', { value: '' }, 'Default');
  const fontSizeSelect = el('select', {
    class: 'toolbar-select', title: 'Font size', disabled: readOnly || null,
    onchange: (e) => grid.applyFormatToSelection({ fontSize: e.target.value ? Number(e.target.value) : undefined }),
  }, [
    fontSizeDefaultOption,
    ...FONT_SIZES.map((size) => el('option', { value: String(size) }, String(size))),
  ]);
  const toolbar = el('div', { class: 'toolbar' }, [
    el('button', { class: 'btn btn-secondary btn-icon', title: 'Bold', disabled: readOnly || null, onclick: () => grid.toggleFormatOnSelection('bold') }, 'B'),
    el('button', { class: 'btn btn-secondary btn-icon', title: 'Italic', disabled: readOnly || null, onclick: () => grid.toggleFormatOnSelection('italic') }, 'I'),
    el('button', { class: 'btn btn-secondary btn-icon', title: 'Underline', disabled: readOnly || null, onclick: () => grid.toggleFormatOnSelection('underline') }, 'U'),
    el('input', {
      class: 'btn-color', type: 'color', title: 'Text color', disabled: readOnly || null,
      onchange: (e) => grid.applyFormatToSelection({ color: e.target.value }),
    }),
    el('input', {
      class: 'btn-color', type: 'color', title: 'Background', value: '#ffffff', disabled: readOnly || null,
      onchange: (e) => grid.applyFormatToSelection({ bg: e.target.value }),
    }),
    fontFamilySelect,
    fontSizeSelect,
    el('button', { class: 'btn btn-secondary btn-small', title: 'Wrap text', disabled: readOnly || null, onclick: () => grid.toggleFormatOnSelection('wrap') }, 'Wrap'),
    el('button', {
      class: 'btn btn-secondary btn-small', title: 'Merge selected cells', disabled: readOnly || null,
      onclick: () => {
        const result = grid.mergeSelection();
        if (!result.ok) alert(result.error);
      },
    }, 'Merge'),
    el('button', {
      class: 'btn btn-secondary btn-small', title: 'Unmerge', disabled: readOnly || null,
      onclick: () => {
        const result = grid.unmergeSelection();
        if (!result.ok) alert(result.error);
      },
    }, 'Unmerge'),
    el('div', { class: 'toolbar-spacer' }),
    tabMenuBtn,
  ]);
  updateEffectiveFontOptions();

  // Rename (spreadsheet title), Manage tabs, and Share are all owner-only
  // (TabController's create/rename/reorder/delete now gate on canManage,
  // not canEdit, per Fernando: "only the spreadsheet owner can manage
  // tabs" -- an editor can change cell content but not tab structure).
  // canManageAccess already covers admins too (Permissions::levelFor()
  // treats an admin as 'owner').
  const actions = el('div', { class: 'sheet-actions' }, [
    canManageAccess ? el('button', { class: 'btn btn-secondary btn-small', onclick: () => showRenameSpreadsheet(spreadsheet, reload) }, 'Rename') : null,
    canManageAccess ? el('button', { class: 'btn btn-secondary btn-small', onclick: () => showManageTabs(spreadsheetId, tabId, reload) }, 'Manage tabs') : null,
    canManageAccess ? el('button', { class: 'btn btn-secondary btn-small', onclick: () => showShare(spreadsheetId, shareUrl) }, 'Share') : null,
    el('a', { href: '#/sheets', class: 'btn btn-secondary btn-small' }, 'Exit'),
  ]);

  mount(el('div', { class: 'page sheet-page' }, [
    el('header', { class: 'topbar' }, [
      el('div', { class: 'topbar-title' }, [
        el('h1', {}, (spreadsheet && spreadsheet.title) || 'Spreadsheet'),
        savedEl,
      ]),
      actions,
    ]),
    el('div', { class: 'status-row' }, [connectionEl, presenceListEl]),
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
    // The connection can be fully "Live" while still rejecting a specific
    // edit (e.g. anonymous view-only access) -- that used to only reach
    // the console, so an edit could silently have no effect with nothing
    // in the UI explaining why. Reuses the same transient-toast pattern
    // as the context-menu hints, anchored near the status row since
    // there's no cursor position to anchor to here.
    onServerError: (message) => {
      const rect = connectionEl.getBoundingClientRect();
      showTransientHint(message, rect.left, rect.bottom);
    },
    onStatus: (status) => {
      // "unavailable" and "disconnected" both mean the REST fallback is
      // doing the saving instead -- editing still works either way, so
      // this is never "saving disabled", just "not live right now".
      const live = status === 'connected';
      const state = live ? 'live' : status === 'connecting' ? 'connecting' : 'offline';
      connectionEl.className = 'status-dot status-' + state;
      connectionEl.textContent = live ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline';
      connectionEl.title = STATUS_TOOLTIPS[state];
      // A fresh connection has no idea what this client's active/idle
      // state is until told -- (re)send it once the socket is actually up
      // (ws.js's own dedupe on the last value it sent is per-connection,
      // so a reconnect needs this resent even if the local state itself
      // hasn't changed since before the drop).
      if (live) socket.sendPresenceActive(localActive);
    },
    onPresence: (viewers) => {
      presenceViewers = viewers;
      renderPresence();
    },
  });
  socket.connect();

  gridContainer.addEventListener('mousemove', () => {
    socket.sendKeystroke({ at: Date.now() });
  });

  // --- Active/idle detection for THIS client, reported to the server via
  // presence_active so other viewers see it. Two inputs, per Fernando's
  // precise clarification: (1) an interaction timer -- 2+ minutes with no
  // mousemove/keydown/click anywhere on the page means idle; (2) the Page
  // Visibility API -- the tab being hidden (switched away from/minimized)
  // means idle immediately, not after the 2-minute grace period, since
  // there's no ambiguity there the way "hasn't moved the mouse in a
  // while but the tab IS still focused" has.
  let localActive = true;
  let idleTimer = null;
  function markLocalActive() {
    localActive = true;
    socket.sendPresenceActive(true);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      localActive = false;
      socket.sendPresenceActive(false);
    }, IDLE_GRACE_MS);
  }
  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      localActive = false;
      socket.sendPresenceActive(false);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    } else {
      markLocalActive();
    }
  }
  document.addEventListener('mousemove', markLocalActive);
  document.addEventListener('keydown', markLocalActive);
  document.addEventListener('click', markLocalActive);
  document.addEventListener('visibilitychange', onVisibilityChange);
  markLocalActive(); // starts the idle timer immediately, and gives onStatus's first 'connected' something to resend

  // grid.js suppresses the native browser context menu and dispatches this
  // instead (see Grid._onContextMenu) -- it does the data-layer work
  // (which cell/row/column, adjusting the selection), app.js owns the
  // actual menu UI, consistent with mergeSelection() etc. returning
  // {ok,error} for app.js to surface rather than grid.js having any
  // dialog/menu machinery of its own.
  gridContainer.addEventListener('gridcontextmenu', (e) => {
    const { kind, x, y, rowIndex, colIndex } = e.detail;
    if (kind === 'cell') showCellContextMenu(x, y, grid);
    else if (kind === 'row-header') showHeaderContextMenu(x, y, grid, 'row', rowIndex);
    else if (kind === 'col-header') showHeaderContextMenu(x, y, grid, 'col', colIndex);
  });

  currentTeardown = () => {
    clearInterval(savedTick);
    clearInterval(presenceTick);
    if (idleTimer) clearTimeout(idleTimer);
    document.removeEventListener('mousemove', markLocalActive);
    document.removeEventListener('keydown', markLocalActive);
    document.removeEventListener('click', markLocalActive);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    socket.close();
  };
}

async function showHistory(tabId, grid) {
  const { history } = await api.listHistory(tabId, 50);
  const list = el('ul', { class: 'history-list' });
  for (const h of history) {
    const label = `#${h.sequence} — ${h.saved_by_name || 'Anonymous'} — ${h.created_at}`;
    const btn = el('button', {
      class: 'btn btn-secondary btn-small',
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

// Clipboard write for the "Copy link" button. Clipboard-API-first, same
// pattern as grid.js's _copySelectionToClipboard -- but unlike that one
// (which has an in-app clipboard variable to fall back to, since there's
// something to paste into within the app), the meaningful fallback for a
// URL is a document.execCommand('copy') off the already-visible,
// already-selected link input, not an in-app-only construct.
function copyShareLink(text, inputEl, buttonEl) {
  const original = buttonEl.textContent;
  function showCopied() {
    buttonEl.textContent = 'Copied!';
    setTimeout(() => { buttonEl.textContent = original; }, 1500);
  }
  function selectAndExecCopy() {
    inputEl.select();
    inputEl.setSelectionRange(0, inputEl.value.length);
    try {
      if (document.execCommand('copy')) showCopied();
    } catch {
      /* Nothing more we can do here -- the value is visible and selected
         for a manual Ctrl+C. */
    }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(showCopied, selectAndExecCopy);
  } else {
    selectAndExecCopy();
  }
}

function buildShareLinkSection(shareUrl) {
  const fullUrl = window.location.origin + shareUrl;
  const linkInput = el('input', {
    type: 'text', readonly: true, value: fullUrl, class: 'share-link-input',
    onclick: (e) => e.target.select(),
  });
  const copyBtn = el('button', { class: 'btn btn-small', type: 'button' }, 'Copy link');
  copyBtn.addEventListener('click', () => copyShareLink(fullUrl, linkInput, copyBtn));
  return el('div', { class: 'share-section' }, [
    el('h3', {}, 'Share this link'),
    el('div', { class: 'share-link-row' }, [linkInput, copyBtn]),
  ]);
}

// Documents exactly what's implemented in formulas.js -- kept next to it
// deliberately isn't possible (different file/language layer: this is UI,
// formulas.js is the engine), so this list is manually kept in sync. Every
// example here is cross-checked against the real evaluator in
// test-refs.mjs; if you add/change a function, update both.
const FORMULA_HELP = [
  { name: 'SUM(range)', desc: 'Adds the numeric values in a range.', example: '=SUM(A1:A5)' },
  { name: 'AVG(range)', desc: 'Average of the numeric values in a range.', example: '=AVG(A1:A5)' },
  { name: 'MIN(range)', desc: 'Smallest numeric value in a range.', example: '=MIN(A1:A5)' },
  { name: 'MAX(range)', desc: 'Largest numeric value in a range.', example: '=MAX(A1:A5)' },
  { name: 'COUNT(range)', desc: 'Count of numeric values in a range.', example: '=COUNT(A1:A5)' },
  { name: 'COUNTA(range)', desc: 'Count of non-empty cells in a range (numbers or text).', example: '=COUNTA(A1:A5)' },
  { name: 'ROUND(value, digits)', desc: 'Rounds a value to the given number of decimal digits.', example: '=ROUND(3.14159, 2)' },
  { name: 'ABS(value)', desc: 'Absolute value.', example: '=ABS(-5)' },
  { name: 'IF(condition, then, else)', desc: 'condition uses =, <>, <, >, <=, >= (or any nonzero number counts as true). "else" is optional.', example: '=IF(A1>10, "big", "small")' },
  { name: 'CONCAT(...) / CONCATENATE(...)', desc: 'Joins any number of values into one piece of text.', example: '=CONCAT(A1, " ", B1)' },
  { name: 'ACTIONGROUP(buttonText, hideOnClick, action1, ...)', desc: 'Not a computed function -- renders a button; clicking it runs each action in order. hideOnClick=TRUE disables the button (for everyone, permanently) after it’s clicked once. The only action today is USERINFO(...).', example: '=ACTIONGROUP("Sign me up", TRUE, USERINFO(B2, "name"), USERINFO(C2, "email"))' },
  { name: 'USERINFO(cell, infoType[, saveOnEdit=false])', desc: 'An action for use inside ACTIONGROUP(...), not a standalone formula. Fills `cell` with the clicker’s saved info (from a cookie, or their account if logged in) for infoType: "name" or "email". saveOnEdit=TRUE also saves whatever anyone later types into `cell` by hand, independent of the button.', example: '=ACTIONGROUP("Fill in", FALSE, USERINFO(B2, "name", TRUE))' },
];

function showFormulaHelp() {
  const dialog = el('div', {
    class: 'modal',
    // Backdrop-click-to-close: only when the click lands on the backdrop
    // itself, not bubbled up from a click inside .modal-content. No
    // explicit close button (removed below) -- this is the only way out,
    // matching how a native <dialog> or most modal libraries behave by
    // default. Reusable pattern for future dialogs; only wired into this
    // one for now.
    onclick: (e) => { if (e.target === dialog) dialog.remove(); },
  }, [
    el('div', { class: 'modal-content modal-content-wide' }, [
      el('h2', {}, 'Formulas'),
      el('p', { class: 'muted' }, 'Start a cell with = to enter a formula. Basic arithmetic (+ - * /) and comparisons (= <> < > <= >=) work directly on cell references and numbers, e.g. =A1+B1*2.'),
      el('div', { class: 'formula-help-list' }, FORMULA_HELP.map((f) => el('div', { class: 'formula-help-item' }, [
        el('code', {}, f.name),
        el('p', {}, f.desc),
        el('code', { class: 'formula-help-example' }, f.example),
      ]))),
      el('h3', {}, 'Cell references'),
      el('p', {}, [
        'A plain reference like ', el('code', {}, 'A1'), ' shifts when a formula is copied to a new cell, just like Excel/Sheets. Lock a column and/or row with ',
        el('code', {}, '$'), ' so it stays fixed instead: ', el('code', {}, '$A1'), ' (column locked), ',
        el('code', {}, 'A$1'), ' (row locked), ', el('code', {}, '$A$1'), ' (both locked).',
      ]),
      el('p', { class: 'muted' }, 'Example: copying =CONCAT($A1, A$3, B4) from C5 to D6 becomes =CONCAT($A2, B$3, C5) — the $-locked parts stay put, everything else shifts by the same +1 column, +1 row the cell itself moved.'),
    ]),
  ]);
  document.body.appendChild(dialog);
}

async function showShare(spreadsheetId, shareUrl) {
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
      shareUrl ? buildShareLinkSection(shareUrl) : null,
      error,
      body,
      el('button', { class: 'btn btn-secondary', onclick: () => dialog.remove() }, 'Close'),
    ]),
  ]);
  document.body.appendChild(dialog);
  await refresh();
}

// Shared floating-menu positioning/dismiss logic for both context menus
// below (and reusable for anything else that wants a menu at the cursor
// rather than anchored to a button, unlike showTabMenu's anchorEl variant).
// Reuses the .tab-menu/.tab-menu-item CSS classes -- same floating-card
// look, just positioned differently.
function showContextMenuAt(x, y, items) {
  document.querySelectorAll('.tab-menu').forEach((n) => n.remove());
  const menu = el('div', { class: 'tab-menu' }, items.map(([label, onclick]) =>
    el('button', { class: 'tab-menu-item', type: 'button', onclick: () => { close(); onclick(); } }, label)));
  document.body.appendChild(menu);
  // Clamp so the menu doesn't render off the right/bottom edge of the viewport.
  menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8) + window.scrollX}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8) + window.scrollY}px`;

  function close() {
    menu.remove();
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('contextmenu', close);
  }
  function onDocClick(e) {
    if (!menu.contains(e.target)) close();
  }
  setTimeout(() => {
    document.addEventListener('click', onDocClick);
    document.addEventListener('contextmenu', close); // right-clicking elsewhere closes this one instead of stacking
  }, 0);
}

/**
 * Brief toast near (x,y), auto-removing -- same lightweight
 * transient-feedback idea as the Copy Link button's "Copied!" text swap,
 * but as a standalone element rather than reverting an existing button's
 * text, since there's no persistent button here to revert.
 */
function showTransientHint(text, x, y) {
  const hint = el('div', { class: 'context-hint' }, text);
  document.body.appendChild(hint);
  hint.style.left = `${Math.min(x, window.innerWidth - hint.offsetWidth - 8) + window.scrollX}px`;
  hint.style.top = `${Math.min(y + 8, window.innerHeight - hint.offsetHeight - 8) + window.scrollY}px`;
  setTimeout(() => hint.remove(), 2500);
}

/**
 * "Show browser menu" escape hatch appended to both context menus below
 * (Fernando: "show an option to show the normal browser right click
 * menu"). Arms Grid's one-shot native-menu pass-through and hints that a
 * second right-click is what actually triggers it -- there's no way to
 * summon the native menu immediately on click (browsers don't allow
 * scripts to trigger it on demand, and preventDefault() on the original
 * right-click can't be undone after the fact).
 */
function nativeMenuEscapeItem(grid, x, y) {
  return ['Show browser menu', () => {
    grid.allowNativeContextMenuOnce();
    showTransientHint('Right-click again for the browser menu', x, y);
  }];
}

/** Right-click on a cell/selection: Cut, Copy, Paste, Clear contents -- the "common menu options" Fernando asked for. Reuses the exact same Ctrl+C/V/Delete logic, not a parallel implementation. */
function showCellContextMenu(x, y, grid) {
  // Copy is the only one of these that's actually read-only-safe -- Cut
  // internally copies THEN clears (_cutSelectionToClipboard calls
  // _clearSelection, which Grid itself blocks when readOnly), so offering
  // it unconditionally used to mean clicking it in read-only mode copied
  // fine but silently failed to clear -- the exact "looks available, half
  // silently does nothing" bug this pass is fixing elsewhere.
  const items = [['Copy', () => grid._copySelectionToClipboard()]];
  if (!grid.readOnly) {
    items.push(
      ['Cut', () => grid._cutSelectionToClipboard()],
      ['Paste', () => grid._pasteClipboardAtSelection()],
      ['Clear contents', () => grid._clearSelection()],
    );
  }
  items.push(nativeMenuEscapeItem(grid, x, y));
  showContextMenuAt(x, y, items);
}

/**
 * Right-click on a row/column header: Insert above/below (rows) or
 * left/right (columns), Delete -- distinct from showCellContextMenu above
 * per Fernando's own framing (insert/delete is a header-specific action).
 *
 * Count and boundary come from the grid's current whole-row/column
 * selection if the right-clicked header is part of one (see
 * Grid._selectedWholeRowRange/_selectedWholeColRange) -- "selecting 10
 * rows and doing insert below inserts 10 rows below," not just 1.
 */
function showHeaderContextMenu(x, y, grid, kind, index) {
  if (grid.readOnly) return;
  const range = kind === 'row' ? grid._selectedWholeRowRange() : grid._selectedWholeColRange();
  const inRange = range && index >= range.start && index <= range.end;
  const start = inRange ? range.start : index;
  const end = inRange ? range.end : index;
  const count = end - start + 1;

  const items = kind === 'row' ? [
    [`Insert ${count} row${count > 1 ? 's' : ''} above`, () => grid.insertRowsAt(start, count)],
    [`Insert ${count} row${count > 1 ? 's' : ''} below`, () => grid.insertRowsAt(end + 1, count)],
    [`Delete row${count > 1 ? 's' : ''}`, () => grid.deleteRowsAt(start, count)],
  ] : [
    [`Insert ${count} column${count > 1 ? 's' : ''} left`, () => grid.insertColumnsAt(start, count)],
    [`Insert ${count} column${count > 1 ? 's' : ''} right`, () => grid.insertColumnsAt(end + 1, count)],
    [`Delete column${count > 1 ? 's' : ''}`, () => grid.deleteColumnsAt(start, count)],
  ];
  items.push(nativeMenuEscapeItem(grid, x, y));
  showContextMenuAt(x, y, items);
}

// Small floating dropdown for the currently-viewed tab's quick actions.
// Deliberately separate from showManageTabs below: this is "things you do
// to the tab you're looking at" (Fernando: "in the tab menu, I want import
// and export buttons, history, rename tab"), that's "manage every tab in
// this spreadsheet" (create/reorder/delete any of them).
function showTabMenu(anchorEl, { tabId, tabName, grid, canManage, onRenamed }) {
  document.querySelectorAll('.tab-menu').forEach((n) => n.remove());

  // Export/History are read-only-safe (both just read data). Import CSV
  // is a content write, gated the same as cell edits (!grid.readOnly --
  // edit or owner). Rename is a tab-STRUCTURE write, gated on `canManage`
  // instead (owner only, matching TabController's canManage check --
  // Fernando: "only the spreadsheet owner can manage tabs") -- an editor
  // can write cell content but not rename/reorder/create/delete tabs.
  const items = [
    el('button', { class: 'tab-menu-item', type: 'button', onclick: () => { close(); exportCsv(tabId); } }, 'Export CSV'),
  ];
  if (!grid.readOnly) {
    items.push(el('label', { class: 'tab-menu-item file-btn' }, [
      'Import CSV',
      el('input', {
        type: 'file', accept: '.csv',
        onchange: (e) => { close(); importCsv(tabId, e, grid); },
      }),
    ]));
  }
  items.push(el('button', { class: 'tab-menu-item', type: 'button', onclick: () => { close(); showHistory(tabId, grid); } }, 'History'));
  if (canManage) {
    items.push(el('button', {
      class: 'tab-menu-item', type: 'button',
      onclick: async () => {
        close();
        const name = window.prompt('Rename tab', tabName);
        if (name && name.trim() && name.trim() !== tabName) {
          // Was a bare unhandled `await api.renameTab(...)` with no
          // try/catch -- since close() already ran, any failure (network
          // blip, a permission edge case, anything) surfaced as nothing
          // happening at all, no error, no feedback. Renaming looking
          // like it silently "doesn't work" is exactly what that
          // produces. Matches the try/catch + inline alert pattern
          // already used elsewhere in this file (e.g. showManageTabs'
          // create-tab handler) rather than inventing a new one.
          try {
            await api.renameTab(tabId, name.trim());
            onRenamed();
          } catch {
            window.alert('Could not rename tab (you may not have permission, or the request failed).');
          }
        }
      },
    }, 'Rename tab'));
  }
  const menu = el('div', { class: 'tab-menu' }, items);

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

// Full tab management: create, reorder (a single move-to-position call --
// TabRepository::reorder() shifts every tab between the old and new spot
// server-side inside one transaction, so there's no separate "swap" call
// needed and no window where two tabs can end up sharing a position),
// rename, delete. Reachable via the "Manage tabs" button next to the
// spreadsheet title, not just the per-tab quick menu above.
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
              // Was a bare unhandled await with no try/catch, inconsistent
              // with Delete below in this same function -- a failure
              // surfaced as nothing happening, no error shown, reordering
              // looking like it silently "doesn't work".
              try {
                await api.reorderTab(t.id, prev.position);
                await refresh();
                onChanged();
              } catch {
                error.textContent = 'Could not reorder tabs (you may not have permission).';
                error.classList.remove('hidden');
              }
            },
          }, '←'),
          el('button', {
            class: 'btn btn-small btn-secondary', title: 'Move right',
            disabled: !next || null,
            onclick: async () => {
              if (!next) return;
              try {
                await api.reorderTab(t.id, next.position);
                await refresh();
                onChanged();
              } catch {
                error.textContent = 'Could not reorder tabs (you may not have permission).';
                error.classList.remove('hidden');
              }
            },
          }, '→'),
          el('button', {
            class: 'btn btn-small btn-secondary',
            onclick: async () => {
              const name = window.prompt('Rename tab', t.name);
              if (name && name.trim() && name.trim() !== t.name) {
                try {
                  await api.renameTab(t.id, name.trim());
                  await refresh();
                  onChanged();
                } catch {
                  error.textContent = 'Could not rename tab (you may not have permission).';
                  error.classList.remove('hidden');
                }
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

// "Remember indefinitely" (Fernando) is sliding renewal, not one huge
// token: every boot with a still-valid stored token silently trades it in
// for a fresh one (POST /api/session/renew, fresh TTL_SECONDS from src/
// Auth/Jwt.php) before anything else runs. A visitor who opens the app at
// least once within that window never sees a login screen; one who
// doesn't return in time still expires on schedule, same as before.
// Renewing unconditionally on every boot rather than tracking "was my
// token issued more than N days ago" -- this app isn't opened often
// enough per visitor for the extra request to matter, and unconditional
// is simpler than adding iat-tracking state for no real benefit here.
// A 401 here means the token died (revoked/disabled/expired right at the
// boundary) -- clear it, same as route()'s own 401 handling, so
// promptForNameIfNeeded()/route() right after see the true state instead
// of a token that LOOKED valid to isLoggedIn() a moment ago but isn't
// anymore. Any OTHER failure (network hiccup, etc.) intentionally leaves
// the existing token alone -- don't log someone out over a blip; route()'s
// own requests will surface a real problem if there is one.
async function boot() {
  if (isLoggedIn()) {
    try {
      const res = await api.renewSession();
      setToken(res.token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setToken(null);
    }
  }
  promptForNameIfNeeded();
  route();
}

boot();
