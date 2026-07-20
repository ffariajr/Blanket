// Real-time collaboration client. Matches the wire protocol documented at
// the top of ws-server/server.py exactly. Deliberately fails soft: if the
// socket never connects (e.g. before the Apache proxy for it is wired up)
// or drops, the app keeps working via the plain REST API -- this class
// just stops emitting events, it never throws into the UI.
import { getToken, getDisplayName } from './api.js';

const KEYSTROKE_THROTTLE_MS = 150;
const EDIT_DEBOUNCE_MS = 400;

export class TabSocket {
  constructor(tabId, { onState, onRemoteEdit, onRemoteKeystroke, onSaved, onStatus }) {
    this.tabId = tabId;
    this.onState = onState || (() => {});
    this.onRemoteEdit = onRemoteEdit || (() => {});
    this.onRemoteKeystroke = onRemoteKeystroke || (() => {});
    this.onSaved = onSaved || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.connected = false;
    this._pendingPatch = null;
    this._editTimer = null;
    this._lastKeystrokeSent = 0;
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

  close() {
    this.flushEditNow();
    if (this.ws) this.ws.close();
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
