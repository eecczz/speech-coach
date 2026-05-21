# Presentation Coach AI (발표 코칭 AI)

한국어 발표(3~10분)를 연습하면 **VRM 아바타로 치환된 영상**으로 녹화하고, 비언어 신호(시선·자세·표정·제스처)와 발화를 분석해 **체스닷컴 스타일 리뷰 대시보드**로 코칭을 제공하는 웹 서비스.

---

## 1. 프로젝트 소개

발표자가 카메라 앞에서 연습하면, 시스템은 발표 습관(시선 이탈, 자세 흔들림, 턱 괴기, 침묵, 말 속도 등)을 분석해 발표 종료 후 종합 리포트를 생성한다. 핵심 설계 결정 3가지:

- **아바타 치환 녹화** — 사용자의 raw 카메라 영상은 저장·전송하지 않는다. 저장되는 영상은 MediaPipe 트래킹으로 움직이는 **VRM 아바타 webm**뿐. 발표 녹화에 대한 심리적 부담을 없애고 SNS 공유·수직 확장(면접/소개팅 코칭)을 가능하게 한다.
- **브라우저 내 신호 추출** — 카메라 프레임은 브라우저 안에서 MediaPipe(WASM)로 신호만 뽑고 폐기한다. 서버로는 5fps JSON 신호만 전송 → 영상 처리 부담·프라이버시 문제 동시 해결.
- **3층 평가 (L1/L2/L3)** — 라이브 룰 엔진 → 의미 이벤트 변환 → LLM 종합. LLM에 raw 수치 대신 의미가 부여된 이벤트를 주어 환각을 억제한다.

---

## 2. 구현된 기능

| 기능 | 설명 | 핵심 코드 |
|---|---|---|
| VRM 아바타 실시간 트래킹 | 얼굴 블렌드셰이프·머리 자세·상체·손가락을 MediaPipe → VRM 본/블렌드셰이프로 리타깃 | `apps/web/src/avatar/` |
| 아바타 캔버스 녹화 | `canvas.captureStream()` + 마이크 트랙 합성 → `MediaRecorder`로 webm 저장 | `apps/web/src/recorder/canvas-record.ts` |
| 비전 신호 추출 (5fps) | 시선 고정률·자세 흔들림·어깨 기울기·표정 다양성·제스처 빈도·머리 자세(pitch/yaw/roll)·턱 괴기 | `apps/web/src/signals/compute.ts` |
| L1 라이브 룰 | 5초 윈도우마다 임계 규칙 평가 → HUD 신호 (LLM 호출 없음) | `services/coach` `/live` |
| L2 의미 이벤트 변환 | 세션 종료 시 raw 신호를 ~50개 타임스탬프 이벤트로 압축 | `services/aggregator/app/events.py` |
| L3 LLM 종합 평가 | 이벤트 + transcript + 집계를 받아 구조화 JSON 리포트 생성 (Gemini/Claude 전환) | `services/coach` `/comprehensive` |
| 리뷰 대시보드 | 축별 정확성·품질 분포·점수 타임라인(SVG)·순간 리스트, 타임라인↔리스트↔말풍선↔영상 4방향 동기화 | `apps/web/src/review/` |

> 음성 STT·운율 분석(`delivery`/`logic` 축)은 현재 미연결 상태 — [9. 알려진 한계](#9-알려진-한계--다음-단계) 참고.

---

## 3. 아키텍처 / 모노레포 구조

```
presentation-coach/
├─ apps/web/                  Vite + Vanilla TypeScript (프레임워크 없음)
│  ├─ practice.html           메인 연습 페이지
│  ├─ report.html             리포트 뷰 페이지
│  └─ src/
│     ├─ avatar/              Three.js + @pixiv/three-vrm 렌더·리타깃
│     ├─ mediapipe/           FaceLandmarker + Pose + Hand 초기화/루프
│     ├─ signals/             5fps 비전 신호 산출 + 침묵 감지
│     ├─ recorder/            canvas.captureStream + MediaRecorder
│     ├─ ws/                  aggregator WebSocket 클라이언트
│     ├─ review/              리뷰 대시보드 렌더링
│     └─ practice.ts          진입 모듈
├─ services/
│  ├─ audio-pipeline/         FastAPI — faster-whisper STT (:8000), 웹 정적 서빙
│  ├─ aggregator/             FastAPI — 신호 윈도우링 + L2 이벤트 (:8001)
│  └─ coach/                  FastAPI — L1 룰 + L3 LLM 평가 (:8002)
├─ packages/schema/           신호·이벤트·리포트 Pydantic 스키마 (서비스 공유)
└─ docker-compose.yml
```

**런타임 흐름**: 브라우저가 비전 신호를 `aggregator`(WS `/ws/signals`)로 5fps 전송 → 5초 윈도우마다 `coach /live` → 세션 종료 시 `aggregator`가 L2 이벤트 번들 생성 → `coach /comprehensive`(LLM) → 리포트 반환 → 리뷰 대시보드 렌더.

데이터 모델(Vite는 빌드 산출물을 `services/audio-pipeline/app/static/`에 떨궈 FastAPI가 그대로 서빙 — 프로덕션에서 별도 웹 컨테이너 불필요).

---

## 4. 사전 요구사항

- **Docker Desktop** (백엔드 3개 서비스 실행)
- **Node.js 20.19+ 또는 22.12+** (Vite 8 요구사항 — 웹 빌드/개발 서버)
- **데스크톱 Chrome** 권장 (MediaPipe + Three.js 부하 — 모바일 미지원)
- **Gemini API 키** (무료, 카드 등록 불필요 — 아래 참고)

---

## 5. 처음 클론 후 로컬 실행

### 5-1. 저장소 클론 + 환경변수 설정

```pwsh
git clone <repo-url> presentation-coach
cd presentation-coach

# .env 생성 (.env 는 git에 올라가지 않음)
Copy-Item .env.example .env
```

`.env` 파일을 열어 `GOOGLE_API_KEY` 를 채운다:

1. https://aistudio.google.com/apikey 접속 → "Create API key" (Google 계정만 있으면 즉시 발급, 결제수단 불필요)
2. 발급된 키를 `.env` 의 `GOOGLE_API_KEY=` 뒤에 붙여넣기

> ⚠️ API 키는 절대 코드·채팅·커밋에 노출하지 말 것. `.env` 파일에만 둔다.

### 5-2. 개발 모드 (권장 — HMR 동작)

**터미널 A — 백엔드 서비스:**
```pwsh
docker compose up -d audio aggregator coach
```
첫 실행은 이미지 빌드 + whisper 모델 다운로드로 수 분 소요된다. 모델은 `whisper-cache` 볼륨에 캐시되어 이후엔 즉시 기동된다.

**터미널 B — 웹 개발 서버:**
```pwsh
cd apps/web
npm install
npm run dev
```

브라우저에서 **http://localhost:5173/practice.html** 접속.

> Windows PowerShell에서 `npm` 실행이 정책 오류로 막히면 `npm.cmd run dev` 처럼 `.cmd` 를 명시한다.

Vite dev 서버가 `/ws/signals`·`/session/*`·`/api/coach` 요청을 백엔드 컨테이너로 프록시한다(`apps/web/vite.config.ts`).

### 5-3. 프로덕션 빌드 (단일 컨테이너 서빙)

웹을 빌드하면 산출물이 `audio` 컨테이너의 정적 디렉터리로 들어가 FastAPI가 직접 서빙한다 (별도 웹 서버 불필요).

```pwsh
cd apps/web
npm install
npm run build          # → services/audio-pipeline/app/static/ 에 산출
cd ..
docker compose up --build
```

브라우저에서 **http://localhost:8000/practice.html** 접속.

---

## 6. 서비스 / 포트

| 서비스 | 포트 | 역할 | 주요 엔드포인트 |
|---|---|---|---|
| web (Vite dev) | 5173 | 개발 모드 웹 서버 (HMR) | `/practice.html` |
| audio | 8000 | faster-whisper STT + 프로덕션 정적 서빙 | `POST /transcribe`, `/` |
| aggregator | 8001 | 비전 신호 윈도우링 + L2 이벤트 번들 | `WS /ws/signals`, `POST /session/start`, `POST /session/end` |
| coach | 8002 | L1 룰 엔진 + L3 LLM 종합 평가 | `POST /live`, `POST /comprehensive`, `GET /healthz` |

**환경변수** (`.env`, `docker-compose.yml`이 읽음):

| 변수 | 기본값 | 설명 |
|---|---|---|
| `LLM_PROVIDER` | `gemini` | L3 평가 LLM 공급자 (`gemini` \| `claude`) |
| `GOOGLE_API_KEY` | — | Gemini API 키 (필수) |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Gemini 모델명 |
| `ANTHROPIC_API_KEY` | — | `LLM_PROVIDER=claude` 일 때만 필요 |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Claude 모델명 |
| `WHISPER_MODEL` | `medium` | faster-whisper 모델 (`tiny`~`large-v3`) |

---

## 7. 사용 흐름

1. `practice.html` 접속 → 카메라/마이크 권한 허용
2. 카메라 드롭다운에서 실제 웹캠 선택 (가상 카메라는 자동 회피)
3. 아바타가 거울처럼 본인을 따라 움직이는지 확인
4. **● 녹화 시작** → 1~2분 발표 (데모는 짧은 발표 권장)
5. **■ 정지** → 비전 신호 번들이 평가 서버로 전송됨
6. 리뷰 대시보드 표시 — 축별 정확성, 점수 타임라인, 순간 리스트. 타임라인 점이나 리스트 항목을 클릭하면 영상·말풍선이 해당 시점으로 동기화

---

## 8. 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| `docker compose` 실행 시 daemon 연결 실패 | Docker Desktop이 꺼져 있음 — 먼저 실행 후 데몬 기동 대기 |
| audio 컨테이너가 exit 137로 죽음 | whisper 모델 메모리 부족(OOM) — `.env`에 `WHISPER_MODEL=small` 또는 `tiny` 설정 후 재시작 |
| `npm` PowerShell 실행 정책 오류 | `npm.cmd run dev` 처럼 `.cmd` 확장자 명시 |
| 평가 응답이 없음 / 502 | `coach` 로그 확인 (`docker compose logs coach`) — `GOOGLE_API_KEY` 누락 또는 Gemini 쿼터 초과 |
| Gemini 모델 쿼터 0 | 일부 모델은 무료 한도가 0 — `gemini-2.5-flash-lite`는 별도 쿼터 풀로 동작 |
| 아바타가 안 움직임 / 얼굴 미검출 | 가상 카메라(Mirametrix 등) 선택됨 — 드롭다운에서 실제 웹캠으로 변경 |
| 첫 실행이 매우 느림 | whisper 모델 최초 다운로드 — `whisper-cache` 볼륨 캐시 후 이후 빠름 |

---

## 9. 알려진 한계 / 다음 단계

- **STT·운율 미연결** — 현재 음성 인식(STT)이 파이프라인에 연결돼 있지 않아 `full_transcript`가 비어 있고 `delivery`(전달력)·`logic`(논리) 축은 placeholder. 다음 작업: 아바타 webm 오디오로 batch STT + 운율(피치 변동성·강세·말끝 흐림) 추출.
- **단일 세션 인메모리** — aggregator는 활성 세션 1개만 메모리에 보관 (멀티 세션/계정/DB 저장은 v2).
- **데스크톱 크롬 타겟** — 모바일 브라우저 미최적화.
- **음성 변조 없음** — 아바타 영상이지만 목소리는 본인 그대로.

전체 기획·아키텍처 문서: `C:\Users\swh01\.claude\plans\joyful-sparking-hamster.md`
