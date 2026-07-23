// REST API client. Base path is derived at runtime from where this
// document actually lives (mirrors Request::stripBasePath() on the PHP
// side) so the same code works at https://church.dogmanjr.net/blanket/ and
// at the webroot under local `php -S` dev, with no hardcoded prefix.
export const APP_BASE = new URL('.', window.location.href).pathname;
export const API_BASE = APP_BASE.replace(/\/$/, '') + '/api';

const TOKEN_KEY = 'blanket_token';
const NAME_KEY = 'blanket_display_name';

// encodeURIComponent, not the raw field name -- a cookie NAME can't contain
// ';'/'='/whitespace/control characters (RFC 6265), and infoType is
// whatever string a cell's USERINFO(...) formula happens to contain, not a
// fixed set this code controls. encodeURIComponent escapes exactly the
// characters that would otherwise corrupt the cookie header (';', '=',
// space, etc.); 'email' round-trips unchanged, so this doesn't break any
// cookie a visitor already has from before this field became generic.
function userInfoStorageKey(field) {
  return `blanket_userinfo_${encodeURIComponent(field)}`;
}

// document.cookie has no per-name lookup API -- reading it with a RegExp
// built from a dynamic name (as getDisplayName()/the old email-only getter
// did with their fixed literal names) would need the name regex-escaped
// too, since a field like "a.b" would otherwise match "aXb" as well. A
// plain split-and-startsWith avoids that class of bug entirely.
function readCookie(name) {
  const prefix = name + '=';
  const hit = (document.cookie ? document.cookie.split('; ') : []).find((p) => p.startsWith(prefix));
  return hit ? decodeURIComponent(hit.slice(prefix.length)) : null;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getDisplayName() {
  const m = document.cookie.match(/(?:^|; )blanket_name=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : localStorage.getItem(NAME_KEY) || '';
}

export function setDisplayName(name) {
  localStorage.setItem(NAME_KEY, name);
  const oneYear = 365 * 24 * 60 * 60;
  document.cookie = `blanket_name=${encodeURIComponent(name)}; path=${APP_BASE}; max-age=${oneYear}; samesite=lax`;
}

/** Forgets the display name entirely (cookie + localStorage) -- distinct from setDisplayName('') , which would still leave a real (empty-string) cookie behind for getDisplayName()'s cookie-read branch to find. */
export function clearDisplayName() {
  localStorage.removeItem(NAME_KEY);
  document.cookie = `blanket_name=; path=${APP_BASE}; max-age=0; samesite=lax`;
}

/**
 * Decodes (does not verify -- the server verifies on every request) a JWT
 * payload, returning null if it's malformed OR expired. Checking `exp`
 * here is the fix for a real bug: this used to just parse the payload
 * with no expiry check at all, so once a token passed its 12h TTL
 * (src/Auth/Jwt.php's TTL_SECONDS), the client could keep showing
 * "logged in as X" indefinitely while the server silently treated every
 * actual request with that token as anonymous (Authenticator::resolve()
 * intentionally falls back to anonymous on any verification failure,
 * expiry included -- that server-side behavior is correct and untouched
 * here; the bug was the client never learning its belief was wrong).
 * Clears the stored token the moment expiry is detected, rather than
 * just treating it as absent for this one call -- there's no reason to
 * keep a token around once it's provably dead, and leaving it would risk
 * some other future code path checking getToken() truthiness directly
 * instead of going through this/isSessionValid() and reintroducing the
 * same stale-login-state bug.
 */
function decodeValidToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let payload;
  try {
    payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
  if (typeof payload.exp === 'number' && payload.exp <= Date.now() / 1000) {
    setToken(null);
    return null;
  }
  return payload;
}

/** Whether there's a token AND it isn't expired -- the canonical "am I logged in" check; isLoggedIn() in app.js is just this. */
export function isSessionValid() {
  return decodeValidToken(getToken()) !== null;
}

/**
 * UI-facing identity (e.g. "is this user the owner, show the Share
 * button") derived from the same validated payload as isSessionValid()
 * above -- mirrors the claim shape Blanket\Auth\Jwt::issue() puts in the
 * token: sub (as a string, see src/Auth/Jwt.php), username, display_name,
 * is_admin.
 */
export function getCurrentUser() {
  const payload = decodeValidToken(getToken());
  if (!payload) return null;
  return {
    id: parseInt(payload.sub, 10),
    username: payload.username,
    displayName: payload.display_name,
    isAdmin: !!payload.is_admin,
  };
}

/**
 * Resolves the viewer's own value for a USERINFO() field (see
 * CELL_SCHEMA.md). "name" is just getDisplayName() -- the same cookie used
 * for save attribution and the first-visit name prompt, not a second
 * source of truth -- and NOT the logged-in account's displayName: a
 * logged-in user is free to edit this independently of their permanent
 * account identity (Fernando: "a logged in user does not have to be
 * forced to use their display name from their account"). boot()/
 * promptForNameIfNeeded() in app.js seed this cookie from the account
 * once, on a fresh login with no cookie yet -- after that one-time seed,
 * this never looks at the account again. Every OTHER field (infoType is
 * any string a formula author chooses, not a fixed set -- "email" is just
 * the common example, not special-cased beyond it having existed here
 * first) has no account-level source available client-side regardless,
 * so it's cookie-only, mirroring the same cookie+localStorage pattern
 * "email" already used.
 */
export function getUserInfoField(field) {
  if (field === 'name') return getDisplayName();
  const key = userInfoStorageKey(field);
  return readCookie(key) || localStorage.getItem(key) || '';
}

/** Persists a USERINFO field value for reuse elsewhere. "name" writes through setDisplayName (same cookie, one identity). */
export function setUserInfoField(field, value) {
  if (field === 'name') {
    setDisplayName(value);
    return;
  }
  const key = userInfoStorageKey(field);
  localStorage.setItem(key, value);
  const oneYear = 365 * 24 * 60 * 60;
  document.cookie = `${key}=${encodeURIComponent(value)}; path=${APP_BASE}; max-age=${oneYear}; samesite=lax`;
}

/**
 * Forgets a USERINFO field entirely (Fernando: "when I clear a userinfo
 * cells contents, I want the cookie deleted, including name") -- "name"
 * goes through clearDisplayName() (same identity setUserInfoField's "name"
 * branch already writes through), every other field expires its own
 * blanket_userinfo_<field> cookie and drops the localStorage fallback.
 */
export function deleteUserInfoField(field) {
  if (field === 'name') {
    clearDisplayName();
    return;
  }
  const key = userInfoStorageKey(field);
  localStorage.removeItem(key);
  document.cookie = `${key}=; path=${APP_BASE}; max-age=0; samesite=lax`;
}

class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let fetchBody;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }

  const res = await fetch(API_BASE + path, { method, headers, body: fetchBody });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  login: (username, password) => request('POST', '/login', { username, password }),
  renewSession: () => request('POST', '/session/renew'),

  listSpreadsheets: () => request('GET', '/spreadsheets'),
  createSpreadsheet: (title) => request('POST', '/spreadsheets', { title }),
  getSpreadsheet: (id) => request('GET', `/spreadsheets/${id}`),
  getSpreadsheetByGuid: (guid) => request('GET', `/spreadsheets/guid/${encodeURIComponent(guid)}`),
  renameSpreadsheet: (id, title) => request('PATCH', `/spreadsheets/${id}`, { title }),
  deleteSpreadsheet: (id) => request('DELETE', `/spreadsheets/${id}`),
  purgeSpreadsheet: (id) => request('DELETE', `/spreadsheets/${id}/purge`),
  duplicateSpreadsheet: (id, duplicateSharing) =>
    request('POST', `/spreadsheets/${id}/duplicate`, { duplicate_sharing: duplicateSharing }),

  listTabs: (spreadsheetId) => request('GET', `/spreadsheets/${spreadsheetId}/tabs`),
  createTab: (spreadsheetId, name, editorName) =>
    request('POST', `/spreadsheets/${spreadsheetId}/tabs`, { name, editor_name: editorName }),
  renameTab: (tabId, name) => request('PATCH', `/tabs/${tabId}`, { name }),
  reorderTab: (tabId, position) => request('PATCH', `/tabs/${tabId}/position`, { position }),
  deleteTab: (tabId, editorName) => request('DELETE', `/tabs/${tabId}`, { editor_name: editorName }),

  currentTabState: (tabId) => request('GET', `/tabs/${tabId}/current`),
  saveTabState: (tabId, data, editorName) =>
    request('POST', `/tabs/${tabId}/save`, { data, editor_name: editorName }),
  listHistory: (tabId, limit = 50) => request('GET', `/tabs/${tabId}/history?limit=${limit}`),
  restoreVersion: (tabId, sequence, editorName) =>
    request('POST', `/tabs/${tabId}/restore`, { sequence, editor_name: editorName }),

  listAccess: (spreadsheetId) => request('GET', `/spreadsheets/${spreadsheetId}/access`),
  grantAccess: (spreadsheetId, userId, level) =>
    request('PUT', `/spreadsheets/${spreadsheetId}/access/${userId}`, { access_level: level }),
  revokeAccess: (spreadsheetId, userId) =>
    request('DELETE', `/spreadsheets/${spreadsheetId}/access/${userId}`),

  importCsv: (tabId, csv, editorName) =>
    request('POST', `/tabs/${tabId}/import-csv`, { csv, editor_name: editorName }),
  exportCsvUrl: (tabId) => `${API_BASE}/tabs/${tabId}/export-csv`,

  lookupUser: (username) => request('GET', `/users/lookup?username=${encodeURIComponent(username)}`),
};

export { ApiError };
