"""Aggregator service entrypoint.

Responsibilities:
- Accept 5fps vision-signal frames from browser via WebSocket /ws/signals
- Accept STT segments + prosody from the audio-pipeline (TBD wiring)
- Sliding 5-second windowing → forward window to coach /live for L1 HUD
- On session end: derive L2 semantic events + bundle, send to coach /comprehensive
"""

from __future__ import annotations

import asyncio
import os
from typing import Optional

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from packages.schema import VisionFrame, SttSegment, ProsodyFrame
from .session import (
    Session,
    start_session,
    end_session,
    get_session,
    add_vision_frame,
    add_stt_segment,
    add_prosody_frame,
)
from .windowing import WindowingState, close_window
from .events import build_bundle

COACH_URL = os.environ.get("COACH_URL", "http://coach:8002")

app = FastAPI(title="Presentation Coach Aggregator")
windowing = WindowingState()
_hud_broadcasts: list[WebSocket] = []  # clients listening for live HUD pushback


@app.post("/session/start")
async def session_start(payload: dict):
    sid = payload.get("session_id") or "default"
    start_session(sid)
    windowing.flush()
    return {"session_id": sid, "ok": True}


@app.post("/session/end")
async def session_end():
    s = get_session()
    if not s:
        return JSONResponse({"error": "no active session"}, status_code=404)

    # Flush any open window first.
    last = windowing.flush()
    if last:
        await _forward_window_to_coach(close_window(last, s.session_id))

    bundle = build_bundle(s)
    end_session()
    # Forward to coach for L3 comprehensive evaluation.
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{COACH_URL}/comprehensive",
                json=bundle.model_dump(mode="json"),
            )
    except httpx.HTTPError as e:
        return JSONResponse({"error": f"coach unreachable: {e}"}, status_code=502)

    try:
        report = r.json()
    except Exception as e:
        return JSONResponse(
            {
                "error": f"coach returned non-JSON (status {r.status_code}): {type(e).__name__}",
                "body_preview": r.text[:500],
            },
            status_code=502,
        )

    if r.status_code >= 400:
        return JSONResponse(
            {"coach_status": r.status_code, "coach_response": report},
            status_code=502,
        )

    return {"bundle_event_count": len(bundle.events), "report": report}


@app.websocket("/ws/signals")
async def ws_signals(ws: WebSocket):
    """Browser pushes VisionFrame JSON messages here at ~5fps."""
    await ws.accept()
    try:
        while True:
            msg = await ws.receive_json()
            kind = msg.get("kind", "vision")
            if kind == "vision":
                frame = VisionFrame(**msg["data"])
                add_vision_frame(frame)
                windowing.add_vision(frame)
            elif kind == "stt":
                seg = SttSegment(**msg["data"])
                add_stt_segment(seg)
                windowing.add_stt(seg)
            elif kind == "prosody":
                frame = ProsodyFrame(**msg["data"])
                add_prosody_frame(frame)
                windowing.add_prosody(frame)
            else:
                continue

            now_t = _latest_t()
            closed = windowing.maybe_close(now_t)
            if closed is not None:
                s = get_session()
                if s:
                    await _forward_window_to_coach(close_window(closed, s.session_id))
    except WebSocketDisconnect:
        return


@app.websocket("/ws/hud")
async def ws_hud(ws: WebSocket):
    """Browser opens this to receive HUD signal pushbacks from coach /live."""
    await ws.accept()
    _hud_broadcasts.append(ws)
    try:
        while True:
            await ws.receive_text()  # keepalive
    except WebSocketDisconnect:
        if ws in _hud_broadcasts:
            _hud_broadcasts.remove(ws)


async def _forward_window_to_coach(window) -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(f"{COACH_URL}/live", json=window.model_dump(mode="json"))
            hud = r.json()
    except httpx.HTTPError:
        return
    # Fan out to any connected HUD listeners.
    dead = []
    for ws in _hud_broadcasts:
        try:
            await ws.send_json(hud)
        except Exception:
            dead.append(ws)
    for d in dead:
        if d in _hud_broadcasts:
            _hud_broadcasts.remove(d)


def _latest_t() -> float:
    s = get_session()
    if not s:
        return 0.0
    t = 0.0
    if s.vision_frames:
        t = max(t, s.vision_frames[-1].t)
    if s.stt_segments:
        t = max(t, s.stt_segments[-1].t_end)
    if s.prosody_frames:
        t = max(t, s.prosody_frames[-1].t_end)
    return t


@app.get("/healthz")
async def healthz():
    return {"ok": True}
