"""Python mirror of event.ts — semantic events + session bundle for L3 LLM call."""

from __future__ import annotations

from enum import Enum
from typing import Dict, List, Optional

from pydantic import BaseModel, Field

from .report import (
    AxisAccuracy,
    QualityBuckets,
    TimelineSample,
    AnnotatedMoment,
)


class EventKind(str, Enum):
    WPM_SPIKE = "wpm_spike"
    LONG_PAUSE = "long_pause"
    FILLER_BURST = "filler_burst"
    GAZE_LAPSE = "gaze_lapse"
    GAZE_DOWNWARD = "gaze_downward"          # head pitch sustained downward (looking at script)
    POSTURE_SWAY = "posture_sway"
    HEAD_TILT_SUSTAINED = "head_tilt_sustained"  # head roll > threshold for extended period
    HEAD_NODDING = "head_nodding"             # rapid pitch oscillation (긴장성 끄덕임)
    CHIN_ON_HAND = "chin_on_hand"             # hand propping head (slouched / disengaged)
    EXPRESSION_FLAT = "expression_flat"
    HAND_FREEZE = "hand_freeze"
    SILENCE_LONG = "silence_long"             # silent (no speech audio) for extended period
    VOICE_FLAT = "voice_flat"
    AGGREGATE = "aggregate"


class SemanticEvent(BaseModel):
    kind: EventKind
    t_start: float = Field(ge=0)
    t_end: float = Field(ge=0)
    text: str  # Korean human-readable
    transcript_snippet: Optional[str] = None
    metrics: Optional[Dict[str, float]] = None


class WordSpan(BaseModel):
    t_start: float
    t_end: float
    word: str


class SessionAggregates(BaseModel):
    avg_wpm: float
    filler_per_minute: float
    gaze_central_fraction: float
    posture_sway_mean: float
    expression_diversity_mean: float


class SessionBundle(BaseModel):
    session_id: str
    duration_s: float = Field(ge=0)
    full_transcript: str
    words: List[WordSpan]
    events: List[SemanticEvent]
    aggregates: SessionAggregates
    # === Pre-computed dashboard data (rule-engine, no LLM) ===
    # LLM receives these as input and is expected to ground its commentary in them
    # rather than reinvent. annotated_moments will have empty coach_comment;
    # LLM fills it in.
    accuracy_overall: float = Field(default=0.0, ge=0, le=100)
    accuracy_per_axis: List[AxisAccuracy] = Field(default_factory=list)
    quality_buckets: QualityBuckets = Field(default_factory=QualityBuckets)
    annotated_moments: List[AnnotatedMoment] = Field(default_factory=list)
    score_timeline: List[TimelineSample] = Field(default_factory=list)
