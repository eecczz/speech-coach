"""Coach service — L1 rule engine + L3 LLM comprehensive evaluation.

LLM provider is selected via LLM_PROVIDER env var (gemini | claude). See llm.py.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from packages.schema import (
    SignalWindow,
    SessionBundle,
    ComprehensiveReport,
    LiveHudResponse,
)
from .rules import evaluate as evaluate_window
from .llm import generate, provider_info

app = FastAPI(title="Presentation Coach")


@app.get("/healthz")
async def healthz():
    return {"ok": True, **provider_info()}


@app.post("/live", response_model=LiveHudResponse)
async def live(window: SignalWindow):
    """L1 — rule-based per-5s-window HUD signals. No LLM."""
    return evaluate_window(window)


@app.post("/comprehensive", response_model=ComprehensiveReport)
async def comprehensive(bundle: SessionBundle):
    """L3 — LLM-based structured evaluation of the entire session."""
    try:
        return generate(bundle)
    except Exception as e:
        return JSONResponse(
            {"error": f"LLM call failed: {type(e).__name__}: {e}"},
            status_code=502,
        )
