// REST API client. Base path is derived at runtime from where this
// document actually lives (mirrors Request::stripBasePath() on the PHP
// side) so the same code works at https://church.dogmanjr.net/blanket/ and
// at the webroot under local `php -S` dev, with no hardcoded prefix.
export const APP_BASE = new URL('.', window.location.href).pathname;
export const API_BASE = APP_BASE.replace(/\/$/, '') + '/api';

const TOKEN_KEY = 'blanket_token';
const NAME_KEY = 'blanket_display_name';

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

/**
 * Decodes (does not verify -- the server verifies on every request; this
 * is purely for UI decisions like "is this user the owner, show the Share
 * button") the JWT payload so the client knows who's logged in without an
 * extra round-trip. Mirrors the claim shape Blanket\Auth\Jwt::issue()
 * puts in the token: sub (as a string, see src/Auth/Jwt.php), username,
 * display_name, is_admin.
 */
export function getCurrentUser() {
  const token = getToken();
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return {
      id: parseInt(payload.sub, 10),
      username: payload.username,
      displayName: payload.display_name,
      isAdmin: !!payload.is_admin,
    };
  } catch {
    return null;
  }
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

  listSpreadsheets: () => request('GET', '/spreadsheets'),
  createSpreadsheet: (title) => request('POST', '/spreadsheets', { title }),
  getSpreadsheet: (id) => request('GET', `/spreadsheets/${id}`),
  renameSpreadsheet: (id, title) => request('PATCH', `/spreadsheets/${id}`, { title }),
  deleteSpreadsheet: (id) => request('DELETE', `/spreadsheets/${id}`),
  purgeSpreadsheet: (id) => request('DELETE', `/spreadsheets/${id}/purge`),

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
