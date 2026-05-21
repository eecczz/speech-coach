"""L2 — semantic event derivation from raw session signals.

Run once at session end. Output is a short list of timestamped events (~50-100) that
the LLM can cite directly. Goal: replace the LLM's need to interpret raw numbers.

Heuristics here are intentionally simple and inspectable. Tune thresholds per coaching
domain (presentation vs dating vs interview).
"""

from __future__ import annotations

from typing import List

from packages.schema import (
    SemanticEvent,
    EventKind,
    SessionBundle,
)
from packages.schema.event import SessionAggregates, WordSpan
from .session import Session

WPM_SPIKE_MULTIPLIER = 1.4
LONG_PAUSE_S = 3.0
FILLER_BURST_PER_MIN = 10
GAZE_LAPSE_RATIO = 0.3
GAZE_LAPSE_MIN_S = 5.0
POSTURE_SWAY_THRESHOLD = 0.08
EXPRESSION_FLAT_THRESHOLD = 0.4
HAND_FREEZE_THRESHOLD = 0.05
HAND_FREEZE_MIN_S = 8.0

# Head pose thresholds
HEAD_TILT_DEG = 15.0            # absolute roll > 15° = noticeable tilt
HEAD_TILT_MIN_S = 4.0           # sustained ≥ 4 seconds
HEAD_PITCH_DOWN_DEG = 15.0      # pitch > 15° = looking distinctly down
GAZE_DOWN_MIN_S = 4.0           # downward gaze sustained ≥ 4s = script-reading habit
CHIN_ON_HAND_MIN_S = 3.0
NOD_OSC_PER_S = 1.5             # ≥ 1.5 pitch-direction reversals/sec
NOD_MIN_S = 3.0
NOD_PITCH_AMPLITUDE_DEG = 6.0   # min amplitude to count as a nod

# Audio silence
SILENCE_LONG_S = 4.0            # silence_seconds ≥ 4 in a window = long pause


def _avg(xs: List[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def derive_events(session: Session) -> List[SemanticEvent]:
    events: List[SemanticEvent] = []

    # --- Prosody-driven events ---
    if session.prosody_frames:
        wpms = [p.wpm for p in session.prosody_frames if p.wpm > 0]
        mean_wpm = _avg(wpms)
        for p in session.prosody_frames:
            if mean_wpm > 0 and p.wpm > mean_wpm * WPM_SPIKE_MULTIPLIER:
                events.append(
                    SemanticEvent(
                        kind=EventKind.WPM_SPIKE,
                        t_start=p.t_start,
                        t_end=p.t_end,
                        text=f"말 속도 spike: WPM {p.wpm:.0f} (세션 평균 {mean_wpm:.0f}, +{(p.wpm/mean_wpm - 1)*100:.0f}%)",
                        metrics={"wpm": p.wpm, "session_mean_wpm": mean_wpm},
                    )
                )
            if p.pause_seconds >= LONG_PAUSE_S:
                snippet = _transcript_around(session, p.t_start)
                events.append(
                    SemanticEvent(
                        kind=EventKind.LONG_PAUSE,
                        t_start=p.t_start,
                        t_end=p.t_end,
                        text=f"{p.pause_seconds:.1f}초 침묵",
                        transcript_snippet=snippet,
                        metrics={"pause_s": p.pause_seconds},
                    )
                )
            window_minutes = max(0.001, (p.t_end - p.t_start) / 60.0)
            if (p.filler_count / window_minutes) >= FILLER_BURST_PER_MIN:
                events.append(
                    SemanticEvent(
                        kind=EventKind.FILLER_BURST,
                        t_start=p.t_start,
                        t_end=p.t_end,
                        text=f"filler 폭주: {p.filler_count}개 ({', '.join(p.filler_terms)})",
                        metrics={"filler_count": float(p.filler_count)},
                    )
                )

    # --- Vision-driven events ---
    events.extend(_gaze_lapses(session))
    events.extend(_gaze_downward_events(session))
    events.extend(_posture_sway_events(session))
    events.extend(_head_tilt_events(session))
    events.extend(_head_nodding_events(session))
    events.extend(_chin_on_hand_events(session))
    events.extend(_expression_flat_events(session))
    events.extend(_hand_freeze_events(session))

    # --- Audio silence (from browser RMS detector OR Phase 2 prosody) ---
    events.extend(_silence_long_events(session))

    # --- Session-wide aggregate event ---
    aggs = compute_aggregates(session)
    events.append(
        SemanticEvent(
            kind=EventKind.AGGREGATE,
            t_start=0.0,
            t_end=session.duration_s,
            text=(
                f"세션 평균 WPM {aggs.avg_wpm:.0f}, "
                f"filler {aggs.filler_per_minute:.1f}회/분, "
                f"시선 중앙 유지율 {aggs.gaze_central_fraction*100:.0f}%, "
                f"표정 다양성 {aggs.expression_diversity_mean:.2f}"
            ),
            metrics={
                "avg_wpm": aggs.avg_wpm,
                "filler_per_min": aggs.filler_per_minute,
                "gaze_central_frac": aggs.gaze_central_fraction,
                "posture_sway_mean": aggs.posture_sway_mean,
                "expression_diversity_mean": aggs.expression_diversity_mean,
            },
        )
    )

    return events


def _transcript_around(session: Session, t: float, span_s: float = 4.0) -> str:
    """Return last few words spoken just before time t."""
    snippets = []
    for seg in session.stt_segments:
        if seg.t_end <= t and seg.t_end >= t - span_s:
            snippets.append(seg.text.strip())
    return " ".join(snippets).strip()


def _gaze_lapses(session: Session) -> List[SemanticEvent]:
    """Find continuous spans where gaze_fixation_ratio stays below threshold."""
    out: List[SemanticEvent] = []
    if not session.vision_frames:
        return out
    span_start = None
    last_t = None
    for f in session.vision_frames:
        if f.gaze_fixation_ratio < GAZE_LAPSE_RATIO:
            if span_start is None:
                span_start = f.t
            last_t = f.t
        else:
            if span_start is not None and last_t is not None and (last_t - span_start) >= GAZE_LAPSE_MIN_S:
                out.append(
                    SemanticEvent(
                        kind=EventKind.GAZE_LAPSE,
                        t_start=span_start,
                        t_end=last_t,
                        text=f"시선 이탈 {last_t - span_start:.1f}초",
                        metrics={"duration_s": last_t - span_start},
                    )
                )
            span_start = None
            last_t = None
    # Trailing span at session end
    if span_start is not None and last_t is not None and (last_t - span_start) >= GAZE_LAPSE_MIN_S:
        out.append(
            SemanticEvent(
                kind=EventKind.GAZE_LAPSE,
                t_start=span_start,
                t_end=last_t,
                text=f"시선 이탈 {last_t - span_start:.1f}초",
                metrics={"duration_s": last_t - span_start},
            )
        )
    return out


def _posture_sway_events(session: Session) -> List[SemanticEvent]:
    out: List[SemanticEvent] = []
    span_start, last_t = None, None
    for f in session.vision_frames:
        if f.posture_sway > POSTURE_SWAY_THRESHOLD:
            if span_start is None:
                span_start = f.t
            last_t = f.t
        else:
            if span_start is not None and last_t is not None and (last_t - span_start) >= 5.0:
                out.append(
                    SemanticEvent(
                        kind=EventKind.POSTURE_SWAY,
                        t_start=span_start,
                        t_end=last_t,
                        text=f"어깨 흔들림 지속 {last_t - span_start:.1f}초",
                        metrics={"duration_s": last_t - span_start},
                    )
                )
            span_start, last_t = None, None
    return out


def _expression_flat_events(session: Session) -> List[SemanticEvent]:
    out: List[SemanticEvent] = []
    span_start, last_t = None, None
    for f in session.vision_frames:
        if f.expression_diversity < EXPRESSION_FLAT_THRESHOLD:
            if span_start is None:
                span_start = f.t
            last_t = f.t
        else:
            if span_start is not None and last_t is not None and (last_t - span_start) >= 15.0:
                out.append(
                    SemanticEvent(
                        kind=EventKind.EXPRESSION_FLAT,
                        t_start=span_start,
                        t_end=last_t,
                        text=f"표정 단조 {last_t - span_start:.0f}초",
                    )
                )
            span_start, last_t = None, None
    return out


def _hand_freeze_events(session: Session) -> List[SemanticEvent]:
    out: List[SemanticEvent] = []
    span_start, last_t = None, None
    for f in session.vision_frames:
        if f.hand_gesture_freq < HAND_FREEZE_THRESHOLD:
            if span_start is None:
                span_start = f.t
            last_t = f.t
        else:
            if span_start is not None and last_t is not None and (last_t - span_start) >= HAND_FREEZE_MIN_S:
                out.append(
                    SemanticEvent(
                        kind=EventKind.HAND_FREEZE,
                        t_start=span_start,
                        t_end=last_t,
                        text=f"제스처 정지 {last_t - span_start:.0f}초",
                    )
                )
            span_start, last_t = None, None
    return out


def _head_tilt_events(session: Session) -> List[SemanticEvent]:
    """Detect spans where the head is tilted sideways (|roll| > threshold) for ≥ N seconds."""
    out: List[SemanticEvent] = []
    span_start, last_t, peak_deg = None, None, 0.0
    for f in session.vision_frames:
        deg = abs(f.head_roll_deg)
        if deg > HEAD_TILT_DEG:
            if span_start is None:
                span_start = f.t
            last_t = f.t
            peak_deg = max(peak_deg, deg)
        else:
            if span_start is not None and last_t is not None and (last_t - span_start) >= HEAD_TILT_MIN_S:
                direction = "오른쪽" if peak_deg > 0 else "왼쪽"
                out.append(
                    SemanticEvent(
                        kind=EventKind.HEAD_TILT_SUSTAINED,
                        t_start=span_start,
                        t_end=last_t,
                        text=f"머리 {direction}으로 기울임 {last_t - span_start:.1f}초 (최대 {peak_deg:.0f}°)",
                        metrics={"duration_s": last_t - span_start, "peak_deg": peak_deg},
                    )
                )
            span_start, last_t, peak_deg = None, None, 0.0
    return out


def _gaze_downward_events(session: Session) -> List[SemanticEvent]:
    """Detect spans where head pitch is sustained downward — proxy for reading from
    notes / desk."""
    out: List[SemanticEvent] = []
    span_start, last_t = None, None
    for f in session.vision_frames:
        if f.head_pitch_deg > HEAD_PITCH_DOWN_DEG:
            if span_start is None:
                span_start = f.t
            last_t = f.t
        else:
            if span_start is not None and last_t is not None and (last_t - span_start) >= GAZE_DOWN_MIN_S:
                out.append(
                    SemanticEvent(
                        kind=EventKind.GAZE_DOWNWARD,
                        t_start=span_start,
                        t_end=last_t,
                        text=f"시선이 아래로 향함 {last_t - span_start:.1f}초 (원고/책상 응시 가능성)",
                        metrics={"duration_s": last_t - span_start},
                    )
                )
            span_start, last_t = None, None
    return out


def _chin_on_hand_events(session: Session) -> List[SemanticEvent]:
    """Detect spans where a hand is propping the face."""
    out: List[SemanticEvent] = []
    span_start, last_t = None, None
    for f in session.vision_frames:
        if f.chin_on_hand:
            if span_start is None:
                span_start = f.t
            last_t = f.t
        else:
            if span_start is not None and last_t is not None and (last_t - span_start) >= CHIN_ON_HAND_MIN_S:
                out.append(
                    SemanticEvent(
                        kind=EventKind.CHIN_ON_HAND,
                        t_start=span_start,
                        t_end=last_t,
                        text=f"턱 괴기 자세 유지 {last_t - span_start:.1f}초",
                        metrics={"duration_s": last_t - span_start},
                    )
                )
            span_start, last_t = None, None
    if span_start is not None and last_t is not None and (last_t - span_start) >= CHIN_ON_HAND_MIN_S:
        out.append(
            SemanticEvent(
                kind=EventKind.CHIN_ON_HAND,
                t_start=span_start,
                t_end=last_t,
                text=f"턱 괴기 자세 유지 {last_t - span_start:.1f}초",
                metrics={"duration_s": last_t - span_start},
            )
        )
    return out


def _head_nodding_events(session: Session) -> List[SemanticEvent]:
    """Detect rapid head pitch oscillation (긴장성 끄덕임 패턴) — sustained span of
    pitch reversals exceeding NOD_OSC_PER_S frequency."""
    out: List[SemanticEvent] = []
    vfs = session.vision_frames
    if len(vfs) < 4:
        return out

    span_start, span_count, last_t, last_dir = None, 0, None, 0
    last_pitch = vfs[0].head_pitch_deg
    prev_t = vfs[0].t
    direction_changes_window: List[float] = []
    AMPL_OK = NOD_PITCH_AMPLITUDE_DEG

    for f in vfs[1:]:
        dpitch = f.head_pitch_deg - last_pitch
        cur_dir = 1 if dpitch > 0 else (-1 if dpitch < 0 else last_dir)
        if last_dir != 0 and cur_dir != 0 and cur_dir != last_dir and abs(dpitch) > AMPL_OK / 2:
            direction_changes_window.append(f.t)
        last_dir = cur_dir
        last_pitch = f.head_pitch_deg

        # Drop changes older than 2s window
        while direction_changes_window and direction_changes_window[0] < f.t - 2.0:
            direction_changes_window.pop(0)

        rate = len(direction_changes_window) / 2.0
        if rate >= NOD_OSC_PER_S:
            if span_start is None:
                span_start = f.t
                span_count = 0
            span_count += 1
            last_t = f.t
        else:
            if span_start is not None and last_t is not None and (last_t - span_start) >= NOD_MIN_S:
                out.append(
                    SemanticEvent(
                        kind=EventKind.HEAD_NODDING,
                        t_start=span_start,
                        t_end=last_t,
                        text=f"고개 끄덕임 반복 {last_t - span_start:.1f}초",
                        metrics={"duration_s": last_t - span_start},
                    )
                )
            span_start, last_t = None, None

        prev_t = f.t

    if span_start is not None and last_t is not None and (last_t - span_start) >= NOD_MIN_S:
        out.append(
            SemanticEvent(
                kind=EventKind.HEAD_NODDING,
                t_start=span_start,
                t_end=last_t,
                text=f"고개 끄덕임 반복 {last_t - span_start:.1f}초",
                metrics={"duration_s": last_t - span_start},
            )
        )
    return out


def _silence_long_events(session: Session) -> List[SemanticEvent]:
    """Browser pushes silence_seconds per ~1s prosody frame. A value ≥ SILENCE_LONG_S
    means the user just completed a long silence — emit once per peak."""
    out: List[SemanticEvent] = []
    last_emitted_peak = -1.0
    for p in session.prosody_frames:
        if p.silence_seconds >= SILENCE_LONG_S and p.silence_seconds > last_emitted_peak + 0.5:
            snippet = _transcript_around(session, p.t_start)
            out.append(
                SemanticEvent(
                    kind=EventKind.SILENCE_LONG,
                    t_start=max(0.0, p.t_end - p.silence_seconds),
                    t_end=p.t_end,
                    text=f"{p.silence_seconds:.1f}초 침묵",
                    transcript_snippet=snippet,
                    metrics={"silence_s": p.silence_seconds},
                )
            )
            last_emitted_peak = p.silence_seconds
        elif p.silence_seconds < SILENCE_LONG_S - 1.0:
            last_emitted_peak = -1.0
    return out


def compute_aggregates(session: Session) -> SessionAggregates:
    vfs = session.vision_frames
    pfs = session.prosody_frames
    duration_min = max(0.001, session.duration_s / 60.0)
    return SessionAggregates(
        avg_wpm=_avg([p.wpm for p in pfs if p.wpm > 0]),
        filler_per_minute=sum(p.filler_count for p in pfs) / duration_min,
        gaze_central_fraction=_avg([f.gaze_fixation_ratio for f in vfs]),
        posture_sway_mean=_avg([f.posture_sway for f in vfs]),
        expression_diversity_mean=_avg([f.expression_diversity for f in vfs]),
    )


def build_bundle(session: Session) -> SessionBundle:
    from .dashboard import (
        compute_axis_accuracies,
        compute_overall_accuracy,
        annotate_moments,
        compute_quality_buckets,
        compute_score_timeline,
    )

    words: List[WordSpan] = []
    for seg in session.stt_segments:
        for w in seg.words:
            words.append(WordSpan(t_start=w.t_start, t_end=w.t_end, word=w.word))
    full_transcript = " ".join(seg.text.strip() for seg in session.stt_segments if seg.is_final).strip()

    axes = compute_axis_accuracies(session)
    moments = annotate_moments(session)
    buckets = compute_quality_buckets(moments)
    timeline = compute_score_timeline(session, moments)

    return SessionBundle(
        session_id=session.session_id,
        duration_s=session.duration_s,
        full_transcript=full_transcript,
        words=words,
        events=derive_events(session),
        aggregates=compute_aggregates(session),
        accuracy_overall=compute_overall_accuracy(axes),
        accuracy_per_axis=axes,
        quality_buckets=buckets,
        annotated_moments=moments,
        score_timeline=timeline,
    )
