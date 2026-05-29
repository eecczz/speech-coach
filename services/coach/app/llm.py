"""L3 LLM dispatcher — swap providers via LLM_PROVIDER env var.

Both providers receive the same SessionBundle and return a ComprehensiveReport.
Keeps Claude, Gemini, and OpenAI-compatible providers behind a single contract
so the API surface in main.py doesn't care which one is active.
"""

from __future__ import annotations

import json
import os
from typing import Optional

from pydantic import ValidationError

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


def _parse_report_text(text: str) -> ComprehensiveReport:
    """Parse JSON returned by a plain chat-completions endpoint.

    Gemini/Claude paths use SDK-level structured outputs. The Jeonbuk endpoint is
    OpenAI-compatible chat, so we defensively strip common markdown fences before
    validating against the same ComprehensiveReport schema.
    """
    raw = text.strip()
    if raw.startswith("```"):
        lines = raw.splitlines()
        if lines and lines[0].strip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        raw = "\n".join(lines).strip()

    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        raw = raw[start : end + 1]
    return ComprehensiveReport.model_validate_json(raw)


JEONBUK_JSON_CONTRACT = """출력은 JSON 객체 하나여야 합니다. Markdown 금지.

필수 최상위 키:
- session_id: string
- rubric: {logic, delivery, gaze, posture, expression} 각 0~5 숫자
- overall_summary: string
- top_priorities: Finding[]
- strengths: Finding[]
- improvements: Finding[]
- training_prescriptions: TrainingPrescription[]
- evidence_clips: EvidenceClip[]
- accuracy_overall, accuracy_per_axis, quality_buckets, annotated_moments, score_timeline

Finding 형식: {"text": string, "evidence_t": [start, end] 또는 null, "suggestion": string 또는 null}
EvidenceClip 형식: {"t_start": number, "t_end": number, "reason": string}
TrainingPrescription 형식: {"title": string, "addresses": string, "steps": string[]}

입력 데이터가 부족해도 키를 생략하지 말고 빈 배열 또는 데이터 부족 설명을 넣으세요.
"""


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


# --------- Jeonbuk AI student API (OpenAI-compatible) ----------

_jeonbuk_client = None

JEONBUK_BASE_URL = os.environ.get(
    "JEONBUK_BASE_URL",
    "https://ai.jb.go.kr/student-api/v1",
)
JEONBUK_CHAT_MODEL = os.environ.get("JEONBUK_CHAT_MODEL", "gemma-4-31b-turbo")


def _get_jeonbuk():
    global _jeonbuk_client
    if _jeonbuk_client is None:
        from openai import OpenAI

        _jeonbuk_client = OpenAI(
            base_url=JEONBUK_BASE_URL,
            api_key=os.environ["JEONBUK_API_KEY"],
        )
    return _jeonbuk_client


def _jeonbuk_chat(messages: list[dict], *, temperature: float = 0.2):
    client = _get_jeonbuk()
    kwargs = {
        "model": JEONBUK_CHAT_MODEL,
        "messages": messages,
        "max_tokens": 8000,
        "temperature": temperature,
    }
    try:
        return client.chat.completions.create(
            **kwargs,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        # Some OpenAI-compatible gateways expose chat completions but not JSON mode.
        if "response_format" not in str(exc):
            raise
        return client.chat.completions.create(**kwargs)


def _repair_jeonbuk_report(bundle: SessionBundle, raw_text: str, error: ValidationError) -> ComprehensiveReport:
    response = _jeonbuk_chat(
        [
            {
                "role": "system",
                "content": (
                    "당신은 JSON 스키마 수정기입니다. 사용자의 잘못된 평가 JSON을 "
                    "ComprehensiveReport 스키마에 맞는 JSON 객체 하나로만 고치세요."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"{JEONBUK_JSON_CONTRACT}\n\n"
                    f"session_id는 반드시 {bundle.session_id!r} 입니다.\n"
                    "accuracy_overall, accuracy_per_axis, quality_buckets, "
                    "annotated_moments, score_timeline은 아래 SessionBundle의 값을 그대로 사용하세요.\n\n"
                    f"검증 오류:\n{error}\n\n"
                    f"잘못된 JSON 후보:\n{raw_text}\n\n"
                    f"원본 입력:\n{_user_payload(bundle)}"
                ),
            },
        ],
        temperature=0.0,
    )
    return _parse_report_text(response.choices[0].message.content or "")


def generate_with_jeonbuk(bundle: SessionBundle) -> ComprehensiveReport:
    if not os.environ.get("JEONBUK_API_KEY"):
        raise RuntimeError("JEONBUK_API_KEY not set")

    response = _jeonbuk_chat(
        [
            {"role": "system", "content": _compose_system_prompt(bundle.scenario)},
            {
                "role": "user",
                "content": f"{_user_payload(bundle)}\n\n{JEONBUK_JSON_CONTRACT}",
            },
        ],
        temperature=0.2,
    )
    content = response.choices[0].message.content or ""
    try:
        parsed = _parse_report_text(content)
    except ValidationError as exc:
        parsed = _repair_jeonbuk_report(bundle, content, exc)
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
    if PROVIDER == "jeonbuk":
        return generate_with_jeonbuk(bundle)
    raise RuntimeError(f"unknown LLM_PROVIDER: {PROVIDER!r}")


def provider_info() -> dict:
    if PROVIDER == "claude":
        return {"provider": "claude", "model": CLAUDE_MODEL}
    if PROVIDER == "jeonbuk":
        return {"provider": "jeonbuk", "model": JEONBUK_CHAT_MODEL, "base_url": JEONBUK_BASE_URL}
    return {"provider": "gemini", "model": GEMINI_MODEL}
