"""L3 LLM dispatcher — swap providers via LLM_PROVIDER env var.

Both providers receive the same SessionBundle and return a ComprehensiveReport.
Keeps Claude and Gemini behind a single contract so the API surface in main.py
doesn't care which one is active.
"""

from __future__ import annotations

import json
import os
from typing import Optional

from packages.schema import SessionBundle, ComprehensiveReport
from .prompts import SYSTEM_PROMPT_BASE, OUTPUT_INSTRUCTION
from .rubric import compose_scenario_block


def _compose_system_prompt(scenario: str) -> str:
    """Stitches the universal SYSTEM_PROMPT_BASE, the scenario-specific rubric block
    (loaded from YAML), and the universal OUTPUT_INSTRUCTION into one system text.
    Result is byte-stable per scenario → safe for prompt caching."""
    return f"{SYSTEM_PROMPT_BASE}\n\n{compose_scenario_block(scenario)}\n{OUTPUT_INSTRUCTION}"


def _backfill_from_bundle(report: ComprehensiveReport, bundle: SessionBundle) -> ComprehensiveReport:
    """LLM is told to pass rule-derived dashboard fields through verbatim. We enforce
    that here so a sloppy LLM can't break the dashboard."""
    report.accuracy_overall = bundle.accuracy_overall
    report.accuracy_per_axis = bundle.accuracy_per_axis
    report.quality_buckets = bundle.quality_buckets
    report.score_timeline = bundle.score_timeline

    # For annotated_moments: keep LLM's coach_comment but force-override the rule-derived
    # fields. If LLM omitted moments entirely, fall back to bundle moments (no comments).
    if not report.annotated_moments:
        report.annotated_moments = list(bundle.annotated_moments)
    else:
        # Match by t (timestamp); if LLM dropped any, re-add from bundle.
        by_t = {round(m.t, 2): m for m in report.annotated_moments}
        merged = []
        for src in bundle.annotated_moments:
            key = round(src.t, 2)
            llm_m = by_t.get(key)
            if llm_m:
                # Trust src for the rule fields, keep LLM coach_comment.
                src.coach_comment = llm_m.coach_comment
                merged.append(src)
            else:
                merged.append(src)
        report.annotated_moments = merged

    # Subtitle segments — built from the bundle's STT segments so the review UI
    # can draw word-timed subtitles over the video. LLM never authors these.
    from packages.schema.report import SubtitleSegment, SubtitleWord
    report.subtitle_segments = [
        SubtitleSegment(
            t_start=seg.t_start,
            t_end=seg.t_end,
            text=seg.text,
            words=[SubtitleWord(t_start=w.t_start, t_end=w.t_end, word=w.word) for w in seg.words],
        )
        for seg in bundle.stt_segments
    ]
    return report


def _user_payload(bundle: SessionBundle) -> str:
    inner = json.dumps(bundle.model_dump(mode="json"), ensure_ascii=False, indent=2)
    return (
        f"세션 ID: {bundle.session_id}\n"
        f"길이: {bundle.duration_s:.1f}s\n\n"
        f"## SessionBundle (구조화 신호)\n```json\n{inner}\n```"
    )


# --------- Gemini (default) ----------

_gemini_client = None


def _get_gemini():
    global _gemini_client
    if _gemini_client is None:
        from google import genai  # lazy so the SDK isn't required if user runs Claude

        _gemini_client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
    return _gemini_client


GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")


def generate_with_gemini(bundle: SessionBundle) -> ComprehensiveReport:
    if not os.environ.get("GOOGLE_API_KEY"):
        raise RuntimeError("GOOGLE_API_KEY not set")

    from google.genai import types

    client = _get_gemini()
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=_user_payload(bundle),
        config=types.GenerateContentConfig(
            system_instruction=_compose_system_prompt(bundle.scenario),
            response_mime_type="application/json",
            response_schema=ComprehensiveReport,
        ),
    )
    parsed: Optional[ComprehensiveReport] = response.parsed
    if parsed is None:
        parsed = ComprehensiveReport.model_validate_json(response.text)
    if not parsed.session_id:
        parsed.session_id = bundle.session_id
    return _backfill_from_bundle(parsed, bundle)


# --------- Claude (alternate) ----------

_claude_client = None


def _get_claude():
    global _claude_client
    if _claude_client is None:
        import anthropic

        _claude_client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
    return _claude_client


CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")


def generate_with_claude(bundle: SessionBundle) -> ComprehensiveReport:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    client = _get_claude()
    # System split into two blocks for caching: universal base (highly cacheable across
    # any scenario) + scenario-specific rubric + output rules (cacheable per scenario).
    response = client.messages.parse(
        model=CLAUDE_MODEL,
        max_tokens=8000,
        system=[
            {"type": "text", "text": SYSTEM_PROMPT_BASE},
            {
                "type": "text",
                "text": compose_scenario_block(bundle.scenario) + "\n" + OUTPUT_INSTRUCTION,
                "cache_control": {"type": "ephemeral"},
            },
        ],
        messages=[{"role": "user", "content": _user_payload(bundle)}],
        output_format=ComprehensiveReport,
    )
    parsed: Optional[ComprehensiveReport] = response.parsed_output
    if parsed is None:
        raise RuntimeError(f"Claude returned unparseable output (stop_reason={response.stop_reason})")
    if not parsed.session_id:
        parsed.session_id = bundle.session_id
    return _backfill_from_bundle(parsed, bundle)


# --------- Dispatcher ----------

PROVIDER = os.environ.get("LLM_PROVIDER", "gemini").lower()


def generate(bundle: SessionBundle) -> ComprehensiveReport:
    if PROVIDER == "claude":
        return generate_with_claude(bundle)
    if PROVIDER == "gemini":
        return generate_with_gemini(bundle)
    raise RuntimeError(f"unknown LLM_PROVIDER: {PROVIDER!r}")


def provider_info() -> dict:
    if PROVIDER == "claude":
        return {"provider": "claude", "model": CLAUDE_MODEL}
    return {"provider": "gemini", "model": GEMINI_MODEL}
