# Presentation Coach AI

발표 코칭 AI — 한국어 비즈니스/학술 발표(3~10분)를 음성·비전 신호로 환원해 LLM이 코칭을 생성하는 실시간 웹 서비스.

## 모노레포 구조 (예정)

- `apps/web/` — Next.js, MediaPipe(WASM) 추론, 라이브 HUD, 리포트
- `services/audio-pipeline/` — Pipecat + STT(faster-whisper) + 운율 분석
- `services/coach/` — Live/Comprehensive coach, LLM 호출, 프롬프트 캐싱
- `services/aggregator/` — 신호 정렬·윈도우링, FastAPI WebSocket 허브
- `packages/schema/` — 신호·리포트 JSON 스키마 (TS/Python 공유)

## 기획 문서

전체 기획·아키텍처: `C:\Users\swh01\.claude\plans\joyful-sparking-hamster.md`

## 빠른 프로토타입 — Docker 한 줄로 띄우기

브라우저에서 마이크 녹음 → 서버 업로드 → faster-whisper(large-v3) 전사. 단일 컨테이너.

```pwsh
docker compose up --build
# 첫 실행 모델 다운로드 ~3-5분 (CPU int8 기준 ~3GB)
# 이후엔 whisper-cache 볼륨으로 즉시 기동
# 브라우저: http://localhost:8000
```

응답 (`POST /transcribe`):
- `full_text` — 전체 transcript
- `segments[*].words[*]` — word-level start/end 타임스탬프 (evidence_clip용)
- `wpm`, `word_count`, `duration_s`, `server_elapsed_s` (RTF 계산용)

**GPU 사용 시**: `docker-compose.yml`의 `deploy.resources.reservations.devices` 블록 주석 해제 + NVIDIA Container Toolkit (Windows는 WSL2 환경에서).

**참고**: `reference/eecczz-2026-capstone` — pipecat + cohere 한국어 음성챗봇. W2 Pipecat 단계에서 Silero VAD 파라미터·Pipeline 구성·Raw PCM serializer 차용 예정.

## CLI PoC — W1 검증용

`services/audio-pipeline/poc/stt_validate.py` — Docker 없이 모델 자체만 빠르게 검증.

```pwsh
cd services\audio-pipeline\poc
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# (GPU 사용 시) torch CUDA 빌드 추가 설치
# pip install torch --index-url https://download.pytorch.org/whl/cu121

# 한국어 발표 wav을 services/audio-pipeline/samples/ 에 배치한 후:
python stt_validate.py --audio ..\samples\sample.wav --ref ..\samples\sample.txt
```

측정 목표:
- 한국어 WER ≤ 15%
- 첫 segment 도착 지연 ≤ 2s (라이브성)
- word 타임스탬프 ±100ms 정합
- CPU(int8) / GPU(float16) RTF 비교

## STT 운용 — 듀얼

- **라이브 트랙**: faster-whisper large-v3 (Pipecat WhisperSTTService) — 스트리밍·word timestamps
- **종합 트랙 (v1.5)**: cohere-transcribe 재전사 — Apache 2.0, RTFx 525, 한국어 포함 14언어. 라이브 transcript와 IoU 매칭으로 종합 리포트 품질 보강
