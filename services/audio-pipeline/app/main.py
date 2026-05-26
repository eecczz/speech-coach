"""Audio analysis server — STT (faster-whisper) + prosody (librosa).

Endpoints:
  POST /transcribe — legacy PoC, raw STT result (kept for ad-hoc testing).
  POST /analyze    — full pipeline: webm → ffmpeg → wav → STT + prosody per segment.
                     Returns SessionBundle-compatible payload for the aggregator.

The avatar/practice flow uses /analyze at session end and forwards the result into
aggregator /session/end body.
"""

import os
import subprocess
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from prosody import analyze_prosody
from stt import STT

app = FastAPI(title="Presentation Coach Audio Pipeline")

stt = STT(
    model_name=os.environ.get("WHISPER_MODEL", "large-v3"),
    device=os.environ.get("WHISPER_DEVICE", "auto"),
    compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "auto"),
)


def _webm_to_wav(src: str, dst: str) -> None:
    """16kHz mono WAV — what both faster-whisper and librosa want. ffmpeg is
    already in the container (Dockerfile installs ffmpeg + libsndfile1)."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-ar", "16000", "-ac", "1", dst],
        check=True, capture_output=True,
    )


def _to_stt_segments(whisper_segments: list) -> list[dict]:
    """Convert stt.transcribe() segments → packages.schema.SttSegment shape.
    Maps Whisper's {start,end,text,words:[{start,end,word,prob}]} →
    SttSegment {t_start,t_end,text,words:[{t_start,t_end,word,prob}],is_final}."""
    out = []
    for seg in whisper_segments:
        words = [
            {
                "t_start": float(w.get("start", 0.0)),
                "t_end": float(w.get("end", 0.0)),
                "word": str(w.get("word", "")).strip(),
                "prob": float(w.get("prob")) if w.get("prob") is not None else None,
            }
            for w in seg.get("words", [])
        ]
        out.append({
            "t_start": float(seg.get("start", 0.0)),
            "t_end": float(seg.get("end", 0.0)),
            "text": str(seg.get("text", "")).strip(),
            "words": words,
            "is_final": True,
        })
    return out


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = "ko"):
    """Legacy PoC — raw STT result. Kept for ad-hoc verification."""
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


@app.post("/analyze")
async def analyze(
    audio: UploadFile = File(...),
    session_id: str = Form("default"),
    language: str = Form("ko"),
):
    """Full audio analysis — STT + per-segment prosody. Returns a payload that
    the aggregator /session/end can merge into the SessionBundle.

    Schema:
      {
        session_id: str,
        full_transcript: str,
        stt_segments: SttSegment[],
        prosody_frames: ProsodyFrame[],   # one per STT segment
        elapsed_s: float,
        whisper_elapsed_s: float,
      }
    """
    suffix = Path(audio.filename or "rec.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as src_tmp:
        src_tmp.write(await audio.read())
        src_path = src_tmp.name
    wav_path = src_path + ".wav"

    try:
        t_total = time.perf_counter()

        # 1) ffmpeg → 16kHz mono WAV
        _webm_to_wav(src_path, wav_path)

        # 2) faster-whisper transcribe (word timestamps + VAD already on inside STT)
        t_w = time.perf_counter()
        result = stt.transcribe(wav_path, language=language)
        whisper_elapsed = time.perf_counter() - t_w

        stt_segments = _to_stt_segments(result.get("segments", []))

        # 3) Prosody per STT segment (F0, intensity, end-energy, fillers, WPM)
        prosody_frames = analyze_prosody(wav_path, result.get("segments", []))

        return JSONResponse({
            "session_id": session_id,
            "full_transcript": result.get("full_text", ""),
            "stt_segments": stt_segments,
            "prosody_frames": prosody_frames,
            "elapsed_s": time.perf_counter() - t_total,
            "whisper_elapsed_s": whisper_elapsed,
        })
    except subprocess.CalledProcessError as e:
        return JSONResponse(
            {"error": f"ffmpeg failed: {e.stderr.decode(errors='ignore')[:500]}"},
            status_code=400,
        )
    except Exception as e:
        return JSONResponse(
            {"error": f"{type(e).__name__}: {e}"},
            status_code=500,
        )
    finally:
        for p in (src_path, wav_path):
            try:
                os.unlink(p)
            except OSError:
                pass


# 정적 HTML은 라우트 등록 이후 mount — /transcribe, /analyze가 가려지지 않게
app.mount("/", StaticFiles(directory="static", html=True), name="static")
