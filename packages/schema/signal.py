"""Python mirror of signal.ts — Pydantic models for vision/audio frames + windowed bundle."""

from __future__ import annotations

from typing import Optional, List

from pydantic import BaseModel, Field


class VisionFrame(BaseModel):
    t: float = Field(ge=0)
    gaze_fixation_ratio: float = Field(ge=0, le=1)
    posture_sway: float = Field(ge=0)
    shoulder_tilt: float
    expression_diversity: float = Field(ge=0)
    hand_gesture_freq: float = Field(ge=0)
    # Head pose decomposed from MediaPipe face transformation matrix (Euler angles, degrees).
    # +pitch = looking down (chin to chest), +yaw = head turned to subject's left,
    # +roll = head tilted toward subject's right shoulder.
    head_pitch_deg: float = 0.0
    head_yaw_deg: float = 0.0
    head_roll_deg: float = 0.0
    # True when the user is propping head on hand (wrist landmark close to face bounds).
    chin_on_hand: bool = False
    # Mouth-open ratio (jawOpen blendshape, 0..1). Proxy for whether user is speaking
    # at this instant; combined with audio RMS it lets us distinguish silent-mouth-open
    # vs. talking.
    mouth_open: float = Field(default=0.0, ge=0, le=1)


class SttWord(BaseModel):
    t_start: float
    t_end: float
    word: str
    prob: Optional[float] = None


class SttSegment(BaseModel):
    t_start: float = Field(ge=0)
    t_end: float = Field(ge=0)
    text: str
    words: List[SttWord] = Field(default_factory=list)
    is_final: bool = True


class ProsodyFrame(BaseModel):
    t_start: float = Field(ge=0)
    t_end: float = Field(ge=0)
    wpm: float = Field(default=0.0, ge=0)
    filler_count: int = Field(default=0, ge=0)
    filler_terms: List[str] = Field(default_factory=list)
    pause_seconds: float = Field(default=0.0, ge=0)
    # Continuous silence duration ending in this window. Browser-side RMS detector
    # populates this even when STT is not yet running.
    silence_seconds: float = Field(default=0.0, ge=0)
    f0_variance: Optional[float] = Field(default=None, ge=0)
    rms_mean: Optional[float] = Field(default=None, ge=0)


class SignalWindow(BaseModel):
    session_id: str
    t_start: float = Field(ge=0)
    t_end: float = Field(ge=0)
    vision: Optional[VisionFrame] = None  # mean of frames in window
    prosody: Optional[ProsodyFrame] = None
    transcript: str = ""
