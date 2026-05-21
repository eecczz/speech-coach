"""In-memory single-session store for raw 5fps vision frames + STT segments + prosody.

V1: single active session per process (overwritten on new /session/start). Redis/DB later.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import List, Optional

from packages.schema import VisionFrame, SttSegment, ProsodyFrame


@dataclass
class Session:
    session_id: str
    started_at: float  # wall-clock seconds (server-side)
    vision_frames: List[VisionFrame] = field(default_factory=list)
    stt_segments: List[SttSegment] = field(default_factory=list)
    prosody_frames: List[ProsodyFrame] = field(default_factory=list)

    @property
    def duration_s(self) -> float:
        if not self.vision_frames and not self.stt_segments:
            return 0.0
        ends = []
        if self.vision_frames:
            ends.append(self.vision_frames[-1].t)
        if self.stt_segments:
            ends.append(self.stt_segments[-1].t_end)
        return max(ends) if ends else 0.0


_active: Optional[Session] = None


def start_session(session_id: str) -> Session:
    global _active
    _active = Session(session_id=session_id, started_at=time.time())
    return _active


def get_session() -> Optional[Session]:
    return _active


def end_session() -> Optional[Session]:
    global _active
    s = _active
    _active = None
    return s


def add_vision_frame(frame: VisionFrame) -> None:
    if _active is not None:
        _active.vision_frames.append(frame)


def add_stt_segment(seg: SttSegment) -> None:
    if _active is not None:
        _active.stt_segments.append(seg)


def add_prosody_frame(frame: ProsodyFrame) -> None:
    if _active is not None:
        _active.prosody_frames.append(frame)
