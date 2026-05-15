"""faster-whisper 래퍼 — 모델 1회 로드, transcribe()만 노출."""

import time

from faster_whisper import WhisperModel


class STT:
    def __init__(self, model_name: str = "large-v3", device: str = "auto",
                 compute_type: str = "auto"):
        if device == "auto":
            try:
                import torch
                device = "cuda" if torch.cuda.is_available() else "cpu"
            except ImportError:
                device = "cpu"
        if compute_type == "auto":
            compute_type = "float16" if device == "cuda" else "int8"

        print(f"[STT] loading {model_name} device={device} compute_type={compute_type}", flush=True)
        t0 = time.perf_counter()
        self.model = WhisperModel(model_name, device=device, compute_type=compute_type)
        print(f"[STT] loaded in {time.perf_counter() - t0:.1f}s", flush=True)

    def transcribe(self, path: str, language: str = "ko") -> dict:
        segments_iter, info = self.model.transcribe(
            path,
            language=language,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        segments = []
        for seg in segments_iter:
            words = [
                {"start": w.start, "end": w.end, "word": w.word, "prob": w.probability}
                for w in (seg.words or [])
            ]
            segments.append({
                "start": seg.start,
                "end": seg.end,
                "text": seg.text,
                "no_speech_prob": seg.no_speech_prob,
                "words": words,
            })
        full_text = " ".join(s["text"].strip() for s in segments).strip()
        word_count = sum(len(s["words"]) for s in segments)
        wpm = (word_count / info.duration * 60) if info.duration else 0.0
        return {
            "language": info.language,
            "language_probability": info.language_probability,
            "duration_s": info.duration,
            "wpm": wpm,
            "word_count": word_count,
            "full_text": full_text,
            "segments": segments,
        }
