"""발표 코칭 STT 프로토타입 서버 — 녹음 업로드 → faster-whisper 전사."""

import os
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from stt import STT

app = FastAPI(title="Presentation Coach STT Proto")

stt = STT(
    model_name=os.environ.get("WHISPER_MODEL", "large-v3"),
    device=os.environ.get("WHISPER_DEVICE", "auto"),
    compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "auto"),
)


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = "ko"):
    suffix = Path(audio.filename or "rec.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        path = tmp.name
    try:
        t0 = time.perf_counter()
        result = stt.transcribe(path, language=language)
        result["server_elapsed_s"] = time.perf_counter() - t0
        return JSONResponse(result)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


# 정적 HTML은 라우트 등록 이후 mount — /transcribe가 가려지지 않게
app.mount("/", StaticFiles(directory="static", html=True), name="static")
