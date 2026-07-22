// Real-time collaboration client. Matches the wire protocol documented at
// the top of ws-server/server.py exactly. Deliberately fails soft: if the
// socket never connects (e.g. before the Apache proxy for it is wired up)
// or drops, the app keeps working via the plain REST API -- this class
// just stops emitting events, it never throws into the UI.
import { getToken, getDisplayName } from './api.js?v=__DEPLOY_VERSION__';

const KEYSTROKE_THROTTLE_MS = 150;
const EDIT_DEBOUNCE_MS = 400;
// Selection changes fire on every arrow-key/click/drag-tick -- far more
// often than edits, but each message is tiny and doesn't touch the
// document/DB (see presence.py), so a short debounce (not edit's 400ms)
// is enough to collapse a drag-select's flood of intermediate positions
// into one send, without making a remote viewer's selection highlight
// visibly lag behind a deliberate single click.
const SELECTION_DEBOUNCE_MS = 120;

export class TabSocket {
  constructor(tabId, { onState, onRemoteEdit, onRemoteKeystroke, onSaved, onStatus, onServerError, onPresence }) {
    this.tabId = tabId;
    this.onState = onState || (() => {});
    this.onRemoteEdit = onRemoteEdit || (() => {});
    this.onRemoteKeystroke = onRemoteKeystroke || (() => {});
    this.onSaved = onSaved || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onPresence = onPresence || (() => {});
    // Server-side rejections (e.g. "View-only access" when an edit is
    // attempted without edit rights, "Tab not found") used to only reach
    // console.warn below -- the connection itself stays open and the
    // status indicator correctly keeps showing Live (view access is still
    // valid), so nothing in the UI ever explained why an edit silently had
    // no effect. This surfaces it visibly instead; console.warn stays too,
    // for anyone actually checking devtools.
    this.onServerError = onServerError || (() => {});
    this.ws = null;
    this.connected = false;
    this._pendingPatch = null;
    this._editTimer = null;
    this._lastKeystrokeSent = 0;
    this._lastActiveSent = null; // null until the first send, so the first real state always goes out even if it's `false`
    this._pendingSelection = undefined; // undefined = nothing queued; null is itself a valid "no selection" value to send
    this._selectionTimer = null;
  }

  connect() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = new URL('.', window.location.href);
    const path = (base.pathname.replace(/\/$/, '') || '') + `/ws/tabs/${this.tabId}`;
    const token = getToken();
    const url = `${proto}//${base.host}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.onStatus('unavailable');
      return;
    }

    this.ws.addEventListener('open', () => {
      this._send({ type: 'hello', name: getDisplayName() || 'Anonymous' });
      this.connected = true;
      this.onStatus('connected');
    });

    this.ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'state':
          this.onState(msg.data, msg.sequence);
          break;
        case 'new_edit':
          this.onRemoteEdit(msg.payload, msg.from);
          break;
        case 'keystroke':
          this.onRemoteKeystroke(msg.payload, msg.from);
          break;
        case 'saved':
          this.onSaved(msg.sequence);
          break;
        case 'error':
          console.warn('ws error:', msg.message);
          this.onServerError(msg.message);
          break;
        case 'presence':
          this.onPresence(msg.viewers);
          break;
      }
    });

    this.ws.addEventListener('close', () => {
      this.connected = false;
      this.onStatus('disconnected');
    });

    this.ws.addEventListener('error', () => {
      this.onStatus('unavailable');
    });
  }

  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // Called on every keystroke -- throttled, ephemeral, never touches saved state.
  sendKeystroke(payload) {
    if (!this.isConnected()) return;
    const now = Date.now();
    if (now - this._lastKeystrokeSent < KEYSTROKE_THROTTLE_MS) return;
    this._lastKeystrokeSent = now;
    this._send({ type: 'keystroke', payload });
  }

  // Groups edits client-side before sending, per the earlier design --
  // debounced merge patch, not one message per keystroke.
  queueEdit(patch) {
    this._pendingPatch = mergePatchInto(this._pendingPatch || {}, patch);
    if (this._editTimer) clearTimeout(this._editTimer);
    this._editTimer = setTimeout(() => this._flushEdit(), EDIT_DEBOUNCE_MS);
  }

  flushEditNow() {
    if (this._editTimer) {
      clearTimeout(this._editTimer);
      this._editTimer = null;
    }
    this._flushEdit();
  }

  requestSave() {
    if (!this.isConnected()) return;
    this._send({ type: 'save' });
  }

  // Dedupes on the last value actually sent (not just "did the caller call
  // this again") so a flapping visibility/interaction signal doesn't spam
  // the server with redundant presence_active messages -- only a genuine
  // active<->idle transition sends anything.
  sendPresenceActive(active) {
    if (!this.isConnected()) return;
    if (this._lastActiveSent === active) return;
    this._lastActiveSent = active;
    this._send({ type: 'presence_active', active });
  }

  // Debounced the same shape as queueEdit/_flushEdit above, just a much
  // shorter window (SELECTION_DEBOUNCE_MS) and no merging -- a selection
  // fully replaces the previous one, it doesn't accumulate.
  sendSelection(selection) {
    this._pendingSelection = selection;
    if (this._selectionTimer) clearTimeout(this._selectionTimer);
    this._selectionTimer = setTimeout(() => this._flushSelection(), SELECTION_DEBOUNCE_MS);
  }

  close() {
    this.flushEditNow();
    if (this._selectionTimer) {
      clearTimeout(this._selectionTimer);
      this._flushSelection();
    }
    if (this.ws) this.ws.close();
  }

  _flushSelection() {
    this._selectionTimer = null;
    if (this._pendingSelection === undefined || !this.isConnected()) return;
    this._send({ type: 'selection', selection: this._pendingSelection });
    this._pendingSelection = undefined;
  }

  _flushEdit() {
    this._editTimer = null;
    if (!this._pendingPatch || !this.isConnected()) return;
    this._send({ type: 'new_edit', payload: this._pendingPatch });
    this._pendingPatch = null;
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}

function mergePatchInto(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = mergePatchInto(result[key] || {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
