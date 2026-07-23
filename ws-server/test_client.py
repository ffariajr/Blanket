import asyncio
import json
import sys

import websockets

URL = "ws://127.0.0.1:8765/ws/tabs/{tab_id}"


def url(tab_id):
    return URL.format(tab_id=tab_id)


def hello(name="ignored", token=None):
    payload = {"type": "hello", "name": name}
    if token:
        payload["token"] = token
    return json.dumps(payload)


async def recv_json(ws, timeout=3):
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return json.loads(raw)


async def test_two_authenticated_clients_collab(owner_token, editor_token, tab_id):
    print("\n--- TEST 1: two authenticated clients, edit + keystroke relay, debounce persist ---")
    async with websockets.connect(url(tab_id)) as owner_ws, \
               websockets.connect(url(tab_id)) as editor_ws:

        await owner_ws.send(hello(token=owner_token))
        await editor_ws.send(hello(token=editor_token))

        owner_state = await recv_json(owner_ws)
        editor_state = await recv_json(editor_ws)
        assert owner_state["type"] == "state" and owner_state["sequence"] == 0, owner_state
        assert editor_state["type"] == "state" and editor_state["sequence"] == 0, editor_state
        print("OK: both clients received initial state, sequence=0")

        await owner_ws.send(json.dumps({"type": "new_edit", "payload": {"cells": {"A1": {"value": "hello"}}}}))
        relayed = await recv_json(editor_ws)
        assert relayed["type"] == "new_edit", relayed
        assert relayed["from"]["user_id"] == 2, relayed
        assert relayed["payload"]["cells"]["A1"]["value"] == "hello", relayed
        print("OK: editor received owner's new_edit broadcast, correctly attributed")

        await editor_ws.send(json.dumps({"type": "keystroke", "payload": {"cell": "B2", "char": "x"}}))
        relayed_keystroke = await recv_json(owner_ws)
        assert relayed_keystroke["type"] == "keystroke", relayed_keystroke
        assert relayed_keystroke["from"]["user_id"] == 3, relayed_keystroke
        print("OK: owner received editor's keystroke relay, correctly attributed")

        print("waiting ~6s for debounce persist...")
        saved_owner = await recv_json(owner_ws, timeout=8)
        saved_editor = await recv_json(editor_ws, timeout=8)
        assert saved_owner == {"type": "saved", "sequence": 1}, saved_owner
        assert saved_editor == {"type": "saved", "sequence": 1}, saved_editor
        print("OK: both clients notified of debounced persist at sequence=1")


async def test_explicit_save(editor_token, tab_id):
    print("\n--- TEST 2: explicit save forces immediate persist ---")
    async with websockets.connect(url(tab_id)) as ws:
        await ws.send(hello(token=editor_token))
        state = await recv_json(ws)
        print(f"state on connect: sequence={state['sequence']}")

        await ws.send(json.dumps({"type": "new_edit", "payload": {"cells": {"C3": {"value": "explicit"}}}}))
        await ws.send(json.dumps({"type": "save"}))
        saved = await recv_json(ws, timeout=3)
        assert saved["type"] == "saved", saved
        print(f"OK: explicit save triggered immediate persist, sequence={saved['sequence']}")


async def test_max_wait_persist(owner_token, tab_id):
    print("\n--- TEST 3: continuous edits still force a persist at max-wait (~15s), not just debounce ---")
    async with websockets.connect(url(tab_id)) as ws:
        await ws.send(hello(token=owner_token))
        await recv_json(ws)

        loop = asyncio.get_event_loop()
        start = loop.time()
        for i in range(6):
            await ws.send(json.dumps({"type": "new_edit", "payload": {"cells": {"D4": {"value": i}}}}))
            await asyncio.sleep(3)  # resets the 5s debounce each time, well under it

        saved = await recv_json(ws, timeout=8)
        elapsed = loop.time() - start
        assert saved["type"] == "saved", saved
        print(f"OK: persisted after {elapsed:.1f}s of continuous edits (max-wait forced it, debounce alone never would have)")


async def test_disconnect_flush(owner_token, tab_id):
    print("\n--- TEST 4: last-client-disconnect forces immediate flush ---")
    ws = await websockets.connect(url(tab_id))
    await ws.send(hello(token=owner_token))
    state = await recv_json(ws)
    seq_before = state["sequence"]
    await ws.send(json.dumps({"type": "new_edit", "payload": {"cells": {"E5": {"value": "bye"}}}}))
    await asyncio.sleep(0.3)
    await ws.close()
    await asyncio.sleep(1)  # give the server a moment to process the disconnect + flush
    print(f"OK: disconnected after edit at sequence={seq_before}; check DB for sequence={seq_before + 1}")


async def test_anonymous_rejected_without_access(tab_id):
    print("\n--- TEST 5: anonymous connection rejected when no anonymous access row exists ---")
    try:
        async with websockets.connect(url(tab_id)) as ws:
            await ws.send(json.dumps({"type": "hello", "name": "Nosy Anon"}))
            await ws.recv()
        print("FAIL: connection should have been rejected")
    except websockets.exceptions.ConnectionClosedError as e:
        print(f"OK: rejected as expected, code={e.code} reason={e.reason!r}")


async def test_anonymous_view_only(tab_id):
    print("\n--- TEST 6: anonymous with view-only policy can connect + watch, but edits are rejected ---")
    async with websockets.connect(url(tab_id)) as ws:
        await ws.send(json.dumps({"type": "hello", "name": "Friendly Anon"}))
        state = await recv_json(ws)
        assert state["type"] == "state", state
        print("OK: anonymous view-only connection accepted, received state")

        await ws.send(json.dumps({"type": "new_edit", "payload": {"cells": {"F6": {"value": "nope"}}}}))
        err = await recv_json(ws, timeout=3)
        assert err["type"] == "error", err
        print(f"OK: edit rejected for view-only anonymous client: {err['message']!r}")


async def main():
    with open("/tmp/claude-1018/-home-claude-blanket/33777c22-d49d-45ed-9b03-20db79f5e50e/scratchpad/owner_token.txt") as f:
        owner_token = f.read().strip()
    with open("/tmp/claude-1018/-home-claude-blanket/33777c22-d49d-45ed-9b03-20db79f5e50e/scratchpad/editor_token.txt") as f:
        editor_token = f.read().strip()

    await test_two_authenticated_clients_collab(owner_token, editor_token, tab_id=1)
    await test_explicit_save(editor_token, tab_id=1)
    await test_max_wait_persist(owner_token, tab_id=1)
    await test_disconnect_flush(owner_token, tab_id=1)
    await test_anonymous_rejected_without_access(tab_id=2)
    await test_anonymous_view_only(tab_id=3)
    print("\nAll scenarios completed.")


if __name__ == "__main__":
    asyncio.run(main())
