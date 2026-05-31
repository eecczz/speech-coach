import { createAvatarStage } from './avatar/stage';
import {
  applyFaceToVRM,
  applyPoseToVRM,
  applyHandsToVRM,
  applyFaceToFallback,
} from './avatar/retarget';
import { resolveAvatarUrl } from './avatar/registry';
import { createLandmarkers, detect } from './mediapipe/landmarkers';
import { AvatarRecorder } from './recorder/canvas-record';
import { computeVisionFrame, resetSignalState, type VisionFrame } from './signals/compute';
import { SilenceDetector } from './signals/silence';
import { createAggregatorClient, createHudClient, type LiveHudResponse } from './ws/client';
import { savePendingMedia, setPendingAnalysis } from './session-store';
import { getActiveUser, listAgentMessages, listRemoteSessions, saveAgentMessage } from './app-api';

type SpeechRecognitionAlternativeLike = {
  transcript: string;
  confidence: number;
};

type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
};

type SpeechRecognitionEventLike = Event & {
  resultIndex: number;
  results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
};

type SpeechRecognitionErrorEventLike = Event & {
  error: string;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const status = document.getElementById('status') as HTMLDivElement;
const video = document.getElementById('cam') as HTMLVideoElement;
const canvas = document.getElementById('avatar') as HTMLCanvasElement;
const debug = document.getElementById('debug') as HTMLPreElement;
const camSelect = document.getElementById('cam-select') as HTMLSelectElement;
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const recorded = document.getElementById('recorded') as HTMLVideoElement | null;
const timerEl = document.querySelector('.timer') as HTMLDivElement | null;
const recordBadge = document.querySelector('.record-badge') as HTMLDivElement | null;
const agentFeed = document.getElementById('agent-chat-feed') as HTMLElement | null;
const agentForm = document.getElementById('agent-chat-form') as HTMLFormElement | null;
const agentInput = document.getElementById('agent-chat-input') as HTMLInputElement | null;
const agentState = document.getElementById('agent-state') as HTMLElement | null;
const agentSessionList = document.getElementById('agent-session-list') as HTMLElement | null;
const agentVoiceToggle = document.getElementById('agent-voice-toggle') as HTMLButtonElement | null;
const liveCoachToast = document.getElementById('live-coach-toast') as HTMLElement | null;
const liveCoachTime = document.getElementById('live-coach-time') as HTMLElement | null;
const liveCoachMessage = document.getElementById('live-coach-message') as HTMLElement | null;
const hudCards = {
  wpm: document.querySelector<HTMLElement>('[data-hud-card="wpm"]'),
  filler: document.querySelector<HTMLElement>('[data-hud-card="filler"]'),
  silence: document.querySelector<HTMLElement>('[data-hud-card="silence"]'),
};
const focusAxes = {
  verbal: document.querySelector<HTMLElement>('[data-live-axis="verbal"]'),
  prosody: document.querySelector<HTMLElement>('[data-live-axis="prosody"]'),
  nonverbal: document.querySelector<HTMLElement>('[data-live-axis="nonverbal"]'),
};

const params = new URLSearchParams(location.search);
const projectName = params.get('project') || '오늘의 말하기 연습';
const typeName = params.get('type') || 'free';
const remoteSessionId = params.get('sessionId') || '';
const goals = (params.get('goal') || '말 속도')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const focusSet = new Set(goals);

const SCENARIO_MAP: Record<string, string> = {
  presentation: 'presentation',
  interview: 'interview',
  negotiation: 'presentation',
  persuasion: 'presentation',
  daily: 'casual',
  phone: 'customer_service',
  online: 'presentation',
  free: 'presentation',
};

const FOCUS_LABELS = {
  wpm: ['말 속도', '전달력', '목소리 톤'],
  filler: ['필러 표현', '논리 흐름', '전달력'],
  silence: ['침묵 구간', '말 속도', '목소리 톤'],
  verbal: ['논리 흐름', '필러 표현', '전달력'],
  prosody: ['말 속도', '침묵 구간', '목소리 톤'],
  nonverbal: ['시선 처리', '자세', '표정', '제스처', '자신감'],
  gaze: ['시선 처리', '자신감'],
  posture: ['자세', '자신감'],
  expression: ['표정', '자신감'],
  gesture: ['제스처', '자신감'],
} as const;
const AGENT_STT_CHUNK_MS = 4500;

const agentNudgeAt = new Map<string, number>();
let currentSessionSeconds = 0;
let liveCoachToastTimer = 0;
let agentVoiceEnabled = localStorage.getItem('speakup-agent-voice') === 'true';
let speechRecognition: SpeechRecognitionLike | null = null;
let speechAgentListening = false;
let speechChunkRecorder: MediaRecorder | null = null;
let speechChunkTimer = 0;
let speechChunkSource: MediaStream | null = null;
let speechChunkIndex = 0;
let lastSpokenTranscriptKey = '';
let lastSpeechAgentReplyAt = -Infinity;
let spokenUtteranceCount = 0;

function focusEnabled(key: keyof typeof FOCUS_LABELS): boolean {
  if (focusSet.size === 0) return true;
  return FOCUS_LABELS[key].some((label) => focusSet.has(label));
}

function resolveFocusGoals(): string[] {
  const params = new URLSearchParams(location.search);
  const goal = params.get('goal') || '';
  return goal
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function applyFocusVisibility(): void {
  const hudMap: Record<keyof typeof hudCards, keyof typeof FOCUS_LABELS> = {
    wpm: 'wpm',
    filler: 'filler',
    silence: 'silence',
  };
  Object.entries(hudMap).forEach(([cardKey, focusKey]) => {
    const card = hudCards[cardKey as keyof typeof hudCards];
    if (card) card.hidden = !focusEnabled(focusKey);
  });
  const axisMap: Record<keyof typeof focusAxes, keyof typeof FOCUS_LABELS> = {
    verbal: 'verbal',
    prosody: 'prosody',
    nonverbal: 'nonverbal',
  };
  Object.entries(axisMap).forEach(([axisKey, focusKey]) => {
    const row = focusAxes[axisKey as keyof typeof focusAxes];
    if (row) row.hidden = !focusEnabled(focusKey);
  });
}

function setAgentState(label: string): void {
  if (agentState) agentState.textContent = label;
}

function syncAgentVoiceToggle(): void {
  if (!agentVoiceToggle) return;
  agentVoiceToggle.setAttribute('aria-pressed', String(agentVoiceEnabled));
  const icon = agentVoiceToggle.querySelector('i');
  const label = agentVoiceToggle.querySelector('span');
  if (icon) icon.className = agentVoiceEnabled ? 'ti ti-volume' : 'ti ti-volume-off';
  if (label) label.textContent = agentVoiceEnabled ? '음성 켜짐' : '음성 꺼짐';
}

function speakAgentReply(content: string): void {
  if (!agentVoiceEnabled || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(content);
  utterance.lang = 'ko-KR';
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function showLiveCoachToast(content: string, sessionT: number): void {
  if (!liveCoachToast || !liveCoachMessage || !liveCoachTime) return;
  liveCoachTime.textContent = formatClock(sessionT);
  liveCoachMessage.textContent = content;
  liveCoachToast.hidden = false;
  liveCoachToast.classList.add('is-visible');
  window.clearTimeout(liveCoachToastTimer);
  liveCoachToastTimer = window.setTimeout(() => {
    liveCoachToast.classList.remove('is-visible');
    window.setTimeout(() => {
      if (!liveCoachToast.classList.contains('is-visible')) liveCoachToast.hidden = true;
    }, 180);
  }, 2800);
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function appendAgentMessage(
  role: 'agent' | 'user' | 'system',
  content: string,
  t: number | null = null,
  metadata: Record<string, unknown> = {},
  persist = true,
): void {
  if (!agentFeed) return;
  const bubble = document.createElement('div');
  bubble.className = `agent-bubble is-${role}`;
  if (typeof t === 'number') {
    const time = document.createElement('span');
    time.textContent = formatClock(t);
    bubble.appendChild(time);
  }
  const paragraph = document.createElement('p');
  paragraph.textContent = content;
  bubble.appendChild(paragraph);
  agentFeed.appendChild(bubble);
  agentFeed.scrollTop = agentFeed.scrollHeight;
  if (remoteSessionId && persist) {
    void saveAgentMessage({ session_id: remoteSessionId, role, content, t, metadata }).catch((err) => {
      console.warn('[agent] message save failed', err);
    });
  }
}

function buildAgentAnswer(text: string, source: 'manual' | 'speech'): string {
  const trimmed = text.trim();
  const isQuestion = /[?？]|(어때|뭐가|어떻게|왜|괜찮|좋아|문제|고칠|될까|될까요|할까|할까요|맞아|맞나요|맞을까|괜찮을까|좋을까|봐줘|알려줘)/.test(trimmed);
  const focusText = goals.length ? goals.join(', ') : '전체 흐름';
  if (/안녕|반갑|소개|박진수/.test(trimmed)) {
    return `들었습니다. 도입 인사는 자연스럽게 시작됐어요. 지금은 ${focusText} 중심으로 보고 있으니, 다음 문장은 카메라를 보면서 한 문장씩 끊어 말해보세요.`;
  }
  if (source === 'manual' || isQuestion) {
    return `지금 세션에서는 ${focusText}를 기준으로 보고 있습니다. 녹화 중 잡히는 문제는 중앙 상단에 바로 띄우고, 질문에 대한 답변은 여기 대화창에 남겨둘게요.`;
  }
  return `방금 발화를 들었습니다. 계속 말해보세요. ${focusText} 기준으로 문제가 잡히면 중앙 상단에 짧게 코칭하겠습니다.`;
}

function shouldAnswerSpokenText(text: string, sessionT: number): boolean {
  spokenUtteranceCount += 1;
  if (spokenUtteranceCount === 1) return true;
  if (/[?？]|(어때|뭐가|어떻게|왜|괜찮|좋아|문제|고칠|될까|될까요|할까|할까요|맞아|맞나요|맞을까|괜찮을까|좋을까|봐줘|알려줘)/.test(text)) return true;
  if (sessionT - lastSpeechAgentReplyAt >= 10) return true;
  return false;
}

function handleSpokenText(text: string, confidence: number | null): void {
  const transcript = text.replace(/\s+/g, ' ').trim();
  if (transcript.length < 2) return;
  const transcriptKey = transcript.replace(/[\s.,!?！？。]/g, '').toLowerCase();
  if (!transcriptKey || transcriptKey === lastSpokenTranscriptKey) return;
  lastSpokenTranscriptKey = transcriptKey;
  const sessionT = currentSessionSeconds || 0;
  appendAgentMessage('user', transcript, sessionT, {
    kind: 'spoken_transcript',
    confidence,
  });
  if (!shouldAnswerSpokenText(transcript, sessionT)) return;
  const answer = buildAgentAnswer(transcript, 'speech');
  lastSpeechAgentReplyAt = sessionT;
  appendAgentMessage('agent', answer, sessionT, { kind: 'spoken_answer' });
  speakAgentReply(answer);
}

function chooseAgentAudioMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

async function transcribeAgentAudioChunk(blob: Blob): Promise<void> {
  if (blob.size < 1000) return;
  const form = new FormData();
  form.append('audio', blob, `agent-speech-${speechChunkIndex}.webm`);
  form.append('language', 'ko');
  const response = await fetch('/transcribe', {
    method: 'POST',
    body: form,
  });
  if (!response.ok) {
    console.warn('[agent] speech chunk transcribe failed', response.status);
    return;
  }
  const payload = await response.json().catch(() => ({})) as { full_text?: string; text?: string };
  const transcript = String(payload.full_text || payload.text || '').trim();
  if (transcript) handleSpokenText(transcript, null);
}

function scheduleAgentAudioChunk(): void {
  if (!speechAgentListening || !speechChunkSource) return;
  const chunks: Blob[] = [];
  const mimeType = chooseAgentAudioMimeType();
  const recorder = new MediaRecorder(speechChunkSource, mimeType ? { mimeType } : undefined);
  speechChunkRecorder = recorder;
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => {
    speechChunkRecorder = null;
    const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
    speechChunkIndex += 1;
    void transcribeAgentAudioChunk(blob)
      .catch((err) => console.warn('[agent] speech chunk handling failed', err))
      .finally(() => {
        if (speechAgentListening) {
          window.setTimeout(scheduleAgentAudioChunk, 250);
        }
      });
  };
  try {
    recorder.start();
    speechChunkTimer = window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, AGENT_STT_CHUNK_MS);
  } catch (err) {
    console.warn('[agent] speech chunk recorder start failed', err);
    setAgentState('텍스트 질문 대기');
  }
}

function startBackendSpeechAgentListening(stream: MediaStream): void {
  const audioTracks = stream.getAudioTracks().filter((track) => track.readyState === 'live');
  if (audioTracks.length === 0 || typeof MediaRecorder === 'undefined') {
    setAgentState('텍스트 질문 대기');
    return;
  }
  speechAgentListening = true;
  speechChunkIndex = 0;
  speechChunkSource = new MediaStream(audioTracks);
  setAgentState('듣는 중');
  scheduleAgentAudioChunk();
}

function startSpeechAgentListening(stream: MediaStream): void {
  const Recognition = getSpeechRecognitionConstructor();
  if (!Recognition) {
    startBackendSpeechAgentListening(stream);
    return;
  }

  speechAgentListening = true;
  speechRecognition?.abort();
  const recognition = new Recognition();
  speechRecognition = recognition;
  recognition.lang = 'ko-KR';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => setAgentState('듣는 중');
  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (!result.isFinal || result.length === 0) continue;
      const best = result[0];
      handleSpokenText(best.transcript, Number.isFinite(best.confidence) ? best.confidence : null);
    }
  };
  recognition.onerror = (event) => {
    if (event.error === 'no-speech') return;
    console.warn('[agent] speech recognition error', event.error);
    setAgentState('텍스트 질문 대기');
  };
  recognition.onend = () => {
    if (!speechAgentListening) return;
    window.setTimeout(() => {
      if (speechAgentListening) startSpeechAgentListening(stream);
    }, 350);
  };

  try {
    recognition.start();
  } catch (err) {
    console.warn('[agent] speech recognition start failed', err);
    setAgentState('텍스트 질문 대기');
  }
}

function stopSpeechAgentListening(): void {
  speechAgentListening = false;
  window.clearTimeout(speechChunkTimer);
  speechChunkTimer = 0;
  if (speechChunkRecorder && speechChunkRecorder.state !== 'inactive') {
    try {
      speechChunkRecorder.stop();
    } catch (err) {
      console.warn('[agent] speech chunk recorder stop failed', err);
    }
  }
  speechChunkRecorder = null;
  speechChunkSource = null;
  if (!speechRecognition) return;
  const recognition = speechRecognition;
  speechRecognition = null;
  recognition.onend = null;
  try {
    recognition.stop();
  } catch (err) {
    console.warn('[agent] speech recognition stop failed', err);
  }
}

function nudgeAgent(key: string, content: string, sessionT: number, metadata: Record<string, unknown> = {}): void {
  const last = agentNudgeAt.get(key) ?? -Infinity;
  if (sessionT - last < 8) return;
  agentNudgeAt.set(key, sessionT);
  void metadata;
  showLiveCoachToast(content, sessionT);
}

async function hydrateAgentPanel(): Promise<void> {
  const focusText = goals.length ? goals.join(', ') : '전체';
  if (remoteSessionId) {
    try {
      const messages = await listAgentMessages(remoteSessionId);
      if (messages.length > 0 && agentFeed) {
        const chatMessages = messages.filter((message) => {
          const kind = (message.metadata as { kind?: string } | undefined)?.kind;
          return (
            !kind ||
            kind === 'manual_question' ||
            kind === 'manual_answer' ||
            kind === 'session_ready' ||
            kind === 'spoken_transcript' ||
            kind === 'spoken_answer'
          );
        });
        if (chatMessages.length > 0) {
          agentFeed.innerHTML = '';
          chatMessages.slice(-30).forEach((message) => {
            appendAgentMessage(message.role, message.content, message.t, message.metadata, false);
          });
          return;
        }
      }
    } catch (err) {
      console.warn('[agent] messages load failed', err);
    }
  }
  appendAgentMessage(
    'agent',
    `세션을 준비했습니다. ${focusText}에 대해 궁금한 점을 물어보면 바로 답할게요.`,
    null,
    { kind: 'session_ready' },
  );
}

async function hydrateSessionList(): Promise<void> {
  if (!agentSessionList) return;
  const user = getActiveUser();
  if (!user) {
    agentSessionList.innerHTML = '<p>로그인 후 세션 목록을 볼 수 있습니다.</p>';
    return;
  }
  try {
    const sessions = await listRemoteSessions(user.id);
    agentSessionList.textContent = '';
    if (sessions.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = '저장된 세션이 없습니다.';
      agentSessionList.appendChild(empty);
      return;
    }
    sessions.forEach((session) => {
      const url = new URL('practice.html', location.href);
      url.searchParams.set('sessionId', session.id);
      url.searchParams.set('project', session.title);
      url.searchParams.set('type', session.scenario);
      url.searchParams.set('scenario', SCENARIO_MAP[session.scenario] || 'presentation');
      url.searchParams.set('goal', session.focus_goals.join(', '));
      const item = document.createElement('a');
      item.className = `agent-session-item${session.id === remoteSessionId ? ' is-current' : ''}`;
      item.href = url.toString();
      const title = document.createElement('strong');
      title.textContent = session.title;
      const focus = document.createElement('span');
      focus.textContent = session.focus_goals.join(', ') || '포커스 없음';
      item.append(title, focus);
      agentSessionList.appendChild(item);
    });
  } catch (err) {
    console.warn('[agent] sessions load failed', err);
    agentSessionList.innerHTML = '<p>세션 목록을 불러오지 못했습니다.</p>';
  }
}

agentForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = agentInput?.value.trim();
  if (!text) return;
  appendAgentMessage('user', text, null, { kind: 'manual_question' });
  if (agentInput) agentInput.value = '';
  const answer = buildAgentAnswer(text, 'manual');
  appendAgentMessage('agent', answer, null, { kind: 'manual_answer' });
  speakAgentReply(answer);
});

agentVoiceToggle?.addEventListener('click', () => {
  agentVoiceEnabled = !agentVoiceEnabled;
  localStorage.setItem('speakup-agent-voice', String(agentVoiceEnabled));
  if (!agentVoiceEnabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  syncAgentVoiceToggle();
});

const VIRTUAL_HINTS = ['virtual', 'mirametrix', 'obs', 'snap', 'nvidia broadcast', 'xsplit', 'manycam'];

function isLikelyVirtual(label: string): boolean {
  const l = label.toLowerCase();
  return VIRTUAL_HINTS.some((h) => l.includes(h));
}

async function acquireStream(preferredDeviceId?: string): Promise<MediaStream> {
  if (!preferredDeviceId) {
    let scratch: MediaStream | null = null;
    try {
      scratch = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      throw e;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    console.log('[practice] cameras:', cams.map((c) => `${c.label}${isLikelyVirtual(c.label) ? ' [VIRTUAL]' : ''}`));
    populateCamSelect(cams);

    const currentLabel = scratch.getVideoTracks()[0]?.label ?? '';
    if (isLikelyVirtual(currentLabel)) {
      const real = cams.find((c) => c.label && !isLikelyVirtual(c.label));
      if (real) {
        console.warn(`[practice] swapping virtual cam "${currentLabel}" → "${real.label}"`);
        scratch.getTracks().forEach((t) => t.stop());
        camSelect.value = real.deviceId;
        return acquireStream(real.deviceId);
      }
      console.warn('[practice] only virtual cameras found — proceeding with virtual; preview will likely be blank');
    } else {
      camSelect.value = cams.find((c) => c.label === currentLabel)?.deviceId ?? '';
    }
    return scratch;
  }

  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: preferredDeviceId }, width: 640, height: 480 },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
}

function populateCamSelect(cams: MediaDeviceInfo[]): void {
  camSelect.innerHTML = '';
  for (const c of cams) {
    const opt = document.createElement('option');
    opt.value = c.deviceId;
    opt.textContent = `${c.label || c.deviceId.slice(0, 8)}${isLikelyVirtual(c.label) ? ' (가상)' : ''}`;
    camSelect.appendChild(opt);
  }
}

function setStatus(msg: string) {
  status.textContent = msg;
  console.log('[practice]', msg);
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function setTimer(seconds: number): void {
  if (timerEl) timerEl.textContent = formatClock(seconds);
}

function setRecordBadge(label: string, state: 'idle' | 'recording' | 'done' = 'idle'): void {
  if (!recordBadge) return;
  recordBadge.dataset.state = state;
  const dot = recordBadge.querySelector('span');
  recordBadge.textContent = '';
  if (dot) recordBadge.appendChild(dot);
  recordBadge.append(label);
}

function setHudCard(
  key: keyof typeof hudCards,
  value: string,
  meterPct: number,
  tone: 'idle' | 'ok' | 'warn' | 'critical' = 'idle',
): void {
  const card = hudCards[key];
  if (!card) return;
  const valueEl = card.querySelector<HTMLElement>('[data-hud-value]');
  const meterEl = card.querySelector<HTMLElement>('.meter i');
  card.classList.remove('is-muted', 'is-ok', 'is-warn', 'is-critical');
  card.classList.add(
    tone === 'ok' ? 'is-ok' : tone === 'warn' ? 'is-warn' : tone === 'critical' ? 'is-critical' : 'is-muted',
  );
  if (valueEl) valueEl.textContent = value;
  if (meterEl) meterEl.style.width = `${Math.max(0, Math.min(100, meterPct))}%`;
}

function resetHudCards(): void {
  setHudCard('wpm', '—', 0, 'idle');
  setHudCard('filler', '—', 0, 'idle');
  setHudCard('silence', '—', 0, 'idle');
}

function setFocusAxis(key: keyof typeof focusAxes, score: number | null): void {
  const row = focusAxes[key];
  if (!row) return;
  const fill = row.querySelector<HTMLElement>('.axis-fill');
  const scoreEl = row.querySelector<HTMLElement>('.axis-score');
  if (score == null) {
    if (fill) fill.style.width = '0%';
    if (scoreEl) scoreEl.textContent = '—';
    return;
  }
  const clamped = Math.round(Math.max(0, Math.min(100, score)));
  if (fill) fill.style.width = `${clamped}%`;
  if (scoreEl) scoreEl.textContent = `${clamped}`;
}

function resetFocusAxes(): void {
  setFocusAxis('verbal', null);
  setFocusAxis('prosody', null);
  setFocusAxis('nonverbal', null);
}

function parseHudNumber(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function syncHudFromResponse(payload: LiveHudResponse, recording: boolean): void {
  if (!recording) return;
  const byKind = new Map(payload.signals.map((signal) => [signal.kind, signal]));
  const wpmSignal = byKind.get('wpm_very_high') ?? byKind.get('wpm_high');
  let verbalScore = 86;
  if (wpmSignal) {
    const wpm = parseHudNumber(wpmSignal.text) ?? 0;
    const tone = wpmSignal.level === 'critical' ? 'critical' : 'warn';
    if (focusEnabled('wpm')) {
      setHudCard('wpm', `${Math.round(wpm)} WPM`, Math.min(100, (wpm / 240) * 100), tone);
      nudgeAgent(
        'wpm',
        wpm > 180 ? '말 속도가 빨라지고 있어요. 한 문장 끝에서 반 박자 쉬고 이어가세요.' : '말 속도가 조금 빠릅니다. 핵심 단어 앞에서 속도를 낮춰보세요.',
        currentSessionSeconds,
        { wpm },
      );
    }
    verbalScore -= wpmSignal.level === 'critical' ? 34 : 18;
  } else {
    if (focusEnabled('wpm')) setHudCard('wpm', '안정적', 42, 'ok');
  }

  const fillerSignal = byKind.get('filler_burst');
  if (fillerSignal) {
    const count = parseHudNumber(fillerSignal.text) ?? 0;
    const tone = fillerSignal.level === 'critical' ? 'critical' : 'warn';
    if (focusEnabled('filler')) {
      setHudCard('filler', `${Math.round(count)}회`, Math.min(100, count * 20), tone);
      nudgeAgent('filler', '필러 표현이 반복됩니다. 다음 문장은 바로 말하지 말고 짧게 숨을 고른 뒤 시작하세요.', currentSessionSeconds, {
        filler_count: count,
      });
    }
    verbalScore -= fillerSignal.level === 'critical' ? 28 : 14;
  } else {
    if (focusEnabled('filler')) setHudCard('filler', '낮음', 18, 'ok');
  }
  if (focusEnabled('verbal')) setFocusAxis('verbal', verbalScore);
}

function scoreNonverbalFrame(frame: VisionFrame): number {
  const gaze = Math.max(0, Math.min(1, frame.gaze_fixation_ratio)) * 100;
  const posture = Math.max(0, 100 - frame.posture_sway * 1200 - Math.abs(frame.shoulder_tilt) * 80);
  const gesture = Math.max(0, 100 - frame.hand_gesture_freq * 80 - frame.hand_velocity_max * 24);
  return gaze * 0.45 + posture * 0.35 + gesture * 0.2;
}

async function bootstrap() {
  setStatus('카메라/마이크 권한 요청 중…');
  let stream = await acquireStream();
  const vTracks = stream.getVideoTracks();
  const aTracks = stream.getAudioTracks();
  const summarize = (t: MediaStreamTrack) =>
    `label="${t.label}" enabled=${t.enabled} muted=${t.muted} state=${t.readyState}`;
  console.log('[practice] video track:', vTracks.map(summarize).join(' | '));
  console.log('[practice] audio track:', aTracks.map(summarize).join(' | '));
  vTracks[0]?.addEventListener('mute', () => console.warn('[practice] video track went MUTED — camera stopped delivering frames'));
  vTracks[0]?.addEventListener('unmute', () => console.log('[practice] video track UNMUTED — frames flowing again'));
  if (vTracks.length === 0) {
    throw new Error('카메라 트랙이 0개 — 권한은 통과했지만 비디오 장치가 활성화되지 않았습니다.');
  }

  video.srcObject = stream;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('비디오 메타데이터 타임아웃(10s)')), 10000);
    video.onloadedmetadata = async () => {
      clearTimeout(timeout);
      try {
        await video.play();
        console.log('[practice] video playing', video.videoWidth, 'x', video.videoHeight);
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    video.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('video element error'));
    };
  });

  setStatus('실시간 코칭 화면 준비 중…');
  const style = new URLSearchParams(location.search).get('style');
  const vrmUrl = resolveAvatarUrl(style);
  const stage = await createAvatarStage(canvas, vrmUrl);

  setStatus('MediaPipe 모델 로딩 중… (CDN 첫 다운로드 시 ~5-10s)');
  const landmarkers = await createLandmarkers();

  setStatus('준비됨 — 녹화를 시작하면 실시간 코칭과 세션 영상 저장이 함께 진행됩니다.');
  setAgentState('질문 대기');
  btnStart.disabled = false;
  btnStart.textContent = '녹화 시작';
  setTimer(0);
  setRecordBadge('대기 중');
  resetHudCards();
  resetFocusAxes();

  const recorder = new AvatarRecorder();
  const aggregator = createAggregatorClient();
  const hudClient = createHudClient();
  let recording = false;
  let recordingStartTSec = 0;
  let lastSignalSendT = 0;
  let lastProsodySendT = 0;
  let silenceDetector: SilenceDetector | null = null;
  let sessionId = remoteSessionId;
  const scenario = SCENARIO_MAP[typeName] || 'presentation';

  await hudClient.connect((payload) => {
    syncHudFromResponse(payload, recording);
  });

  btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;
    btnStart.textContent = '녹화 중';
    setAgentState('코칭 중');
    setTimer(0);
    setRecordBadge('녹화 중', 'recording');
    setStatus('세션 시작 중…');
    sessionId = remoteSessionId || `sess_${Date.now()}`;
    const focusGoals = resolveFocusGoals();
    resetSignalState();
    await aggregator.start(sessionId, scenario, focusGoals);
    recorder.start(stream);
    silenceDetector = new SilenceDetector(stream);
    silenceDetector.start();
    recording = true;
    spokenUtteranceCount = 0;
    lastSpeechAgentReplyAt = -Infinity;
    lastSpokenTranscriptKey = '';
    recordingStartTSec = performance.now() / 1000;
    lastSignalSendT = 0;
    lastProsodySendT = 0;
    btnStop.disabled = false;
    resetHudCards();
    resetFocusAxes();
    startSpeechAgentListening(stream);
    setStatus(`녹화 중… (세션 ${sessionId})`);
  });

  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    recording = false;
    stopSpeechAgentListening();
    if (silenceDetector) {
      silenceDetector.stop();
      silenceDetector = null;
    }
    const rec = await recorder.stop();
    if (recorded) recorded.src = rec.url;
    setTimer(rec.durationMs / 1000);
    setRecordBadge('녹화 완료', 'done');
    setAgentState('리포트 생성');

    try {
      setStatus('코칭 화면으로 이동 중…');
      const mediaId = await savePendingMedia(rec.blob, `${sessionId}.webm`, rec.blob.type || 'video/webm');
      setPendingAnalysis({
        sessionId,
        project: projectName,
        goal: goals,
        type: typeName,
        source: 'live',
        createdAt: new Date().toISOString(),
        mediaId,
        filename: `${sessionId}.webm`,
        mimeType: rec.blob.type || 'video/webm',
        scenario,
      });
      const next = new URL('loading.html', location.href);
      next.searchParams.set('session', sessionId);
      next.searchParams.set('source', 'live');
      next.searchParams.set('project', projectName);
      next.searchParams.set('goal', goals.join(', '));
      next.searchParams.set('type', typeName);
      location.href = next.toString();
    } catch (e) {
      console.error('[practice] failed to hand off live analysis', e);
      btnStart.disabled = false;
      btnStart.textContent = '다시 녹화';
      btnStop.disabled = false;
      setStatus('분석 준비에 실패했어요. 다시 시도해주세요.');
    }
  });

  let lastT = performance.now();
  let frames = 0;
  let lastFpsT = performance.now();
  let fps = 0;
  let faceCount = 0;
  let poseCount = 0;
  let handCount = 0;
  let detectError: string | null = null;
  let lastTs = -1;
  let pixelMean = -1;

  const probe = document.createElement('canvas');
  probe.width = 64;
  probe.height = 48;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true })!;
  let probeFrame = 0;

  const tick = () => {
    const now = performance.now();
    const delta = (now - lastT) / 1000;
    lastT = now;
    frames++;
    if (now - lastFpsT >= 1000) {
      fps = (frames * 1000) / (now - lastFpsT);
      frames = 0;
      lastFpsT = now;
    }

    const ready = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (ready && vw > 0 && vh > 0) {
      if (probeFrame++ % 10 === 0) {
        probeCtx.drawImage(video, 0, 0, probe.width, probe.height);
        const data = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum += data[i] + data[i + 1] + data[i + 2];
        }
        pixelMean = sum / (data.length / 4) / 3;
      }

      const ts = Math.max(Math.floor(now), lastTs + 1);
      lastTs = ts;
      try {
        const { face, pose, hand } = detect(landmarkers, video, ts);
        faceCount = face.faceLandmarks?.length ?? 0;
        poseCount = pose.landmarks?.length ?? 0;
        handCount = hand.landmarks?.length ?? 0;
        if (stage.vrm) {
          applyFaceToVRM(stage.vrm, face);
          applyPoseToVRM(stage.vrm, pose);
          applyHandsToVRM(stage.vrm, hand);
        } else if (stage.fallback) {
          applyFaceToFallback(stage.fallback, face);
        }

        if (recording) {
          const sessionT = now / 1000 - recordingStartTSec;
          currentSessionSeconds = sessionT;
          setTimer(sessionT);
          if (sessionT - lastSignalSendT >= 0.2) {
            const frame = computeVisionFrame(sessionT, face, pose, hand);
            aggregator.sendVision(frame);
            const nonverbalScore = scoreNonverbalFrame(frame);
            if (focusEnabled('nonverbal')) setFocusAxis('nonverbal', nonverbalScore);
            if (focusEnabled('gaze') && frame.gaze_fixation_ratio < 0.42) {
              nudgeAgent('gaze', '시선이 정면에서 벗어나고 있어요. 다음 문장은 카메라 렌즈나 청중 중앙을 보고 말해보세요.', sessionT, {
                gaze_fixation_ratio: frame.gaze_fixation_ratio,
              });
            }
            if (focusEnabled('posture') && (frame.posture_sway > 0.08 || Math.abs(frame.head_roll_deg) > 10)) {
              nudgeAgent('posture', '자세가 기울어졌습니다. 목을 살짝 세우고 어깨 선을 수평으로 맞춰보세요.', sessionT, {
                posture_sway: frame.posture_sway,
                head_roll_deg: frame.head_roll_deg,
              });
            }
            if (focusEnabled('expression') && frame.expression_diversity < 0.08 && sessionT > 4) {
              nudgeAgent('expression', '표정 변화가 적습니다. 핵심 문장을 말할 때 눈썹과 입꼬리를 조금 더 살려보세요.', sessionT, {
                expression_diversity: frame.expression_diversity,
              });
            }
            if (focusEnabled('gesture') && frame.hand_gesture_freq < 0.02 && sessionT > 6) {
              nudgeAgent('gesture', '손동작이 거의 없습니다. 중요한 단어 하나에만 작게 손짓을 붙여보세요.', sessionT, {
                hand_gesture_freq: frame.hand_gesture_freq,
              });
            }
            lastSignalSendT = sessionT;
          }
          if (silenceDetector && sessionT - lastProsodySendT >= 1.0) {
            const { silenceSeconds, rmsMean } = silenceDetector.snapshot();
            aggregator.sendProsody({
              t_start: lastProsodySendT,
              t_end: sessionT,
              silence_seconds: silenceSeconds,
              rms_mean: rmsMean,
            });
            const tone = silenceSeconds >= 4 ? 'warn' : silenceSeconds >= 2 ? 'ok' : 'idle';
            if (focusEnabled('silence')) {
              setHudCard(
                'silence',
                silenceSeconds > 0.1 ? `${silenceSeconds.toFixed(1)}초` : '짧음',
                Math.min(100, (silenceSeconds / 4) * 100),
                tone,
              );
            }
            if (focusEnabled('prosody')) setFocusAxis('prosody', silenceSeconds >= 4 ? 48 : silenceSeconds >= 2 ? 72 : 86);
            if (focusEnabled('silence') && silenceSeconds >= 4) {
              nudgeAgent('silence', '침묵이 길어졌어요. 다음 문장은 짧은 연결어로 다시 시작해보세요.', sessionT, {
                silence_seconds: silenceSeconds,
              });
            }
            silenceDetector.resetWindow();
            lastProsodySendT = sessionT;
          }
        }
      } catch (e) {
        detectError = e instanceof Error ? e.message : String(e);
      }
    }

    const debugLine =
      `fps ${fps.toFixed(0)}  video ${vw}x${vh} ready=${video.readyState} pix=${pixelMean.toFixed(0)}\n` +
      `face=${faceCount} pose=${poseCount} hands=${handCount} vrm=${stage.vrm ? 'yes' : 'no(fallback)'}` +
      (detectError ? `\nERR ${detectError}` : '');
    debug.textContent = debugLine;
    if (now - lastFpsT < 50) {
      console.log('[debug]', debugLine.replace(/\n/g, ' | '));
    }

    stage.render(delta);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.addEventListener('beforeunload', (e) => {
    if (recording) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('pagehide', () => {
    hudClient.close();
    aggregator.close();
  });
}

applyFocusVisibility();
syncAgentVoiceToggle();
void hydrateAgentPanel();
void hydrateSessionList();

bootstrap().catch((err) => {
  console.error(err);
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    setStatus(
      '카메라/마이크 권한이 거부됐어요. 주소창 자물쇠 → 사이트 설정에서 허용 후 새로고침하세요.',
    );
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    setStatus('카메라 또는 마이크 장치를 찾을 수 없어요. 연결 상태를 확인해주세요.');
  } else if (name === 'NotReadableError') {
    setStatus('다른 앱이 카메라를 사용 중인 것 같아요. 해당 앱을 닫고 새로고침하세요.');
  } else {
    setStatus(`초기화 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
});
