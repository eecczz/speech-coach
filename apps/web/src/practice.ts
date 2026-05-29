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
import { computeVisionFrame, resetSignalState } from './signals/compute';
import { SilenceDetector } from './signals/silence';
import { createAggregatorClient, createHudClient, type LiveHudResponse } from './ws/client';
import { savePendingMedia, setPendingAnalysis } from './session-store';

const status = document.getElementById('status') as HTMLDivElement;
const video = document.getElementById('cam') as HTMLVideoElement;
const canvas = document.getElementById('avatar') as HTMLCanvasElement;
const debug = document.getElementById('debug') as HTMLPreElement;
const camSelect = document.getElementById('cam-select') as HTMLSelectElement;
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const btnAnalyze = document.getElementById('btn-analyze') as HTMLButtonElement;
const recorded = document.getElementById('recorded') as HTMLVideoElement;
const timerEl = document.querySelector('.timer') as HTMLDivElement | null;
const recordBadge = document.querySelector('.record-badge') as HTMLDivElement | null;

const params = new URLSearchParams(location.search);
const projectName = params.get('project') || '오늘의 말하기 연습';
const typeName = params.get('type') || 'free';
const goals = (params.get('goal') || '말 속도')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const hudCards = {
  wpm: document.querySelector<HTMLElement>('[data-hud-card="wpm"]'),
  filler: document.querySelector<HTMLElement>('[data-hud-card="filler"]'),
  silence: document.querySelector<HTMLElement>('[data-hud-card="silence"]'),
};

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

function resolveFocusGoals(): string[] {
  const params = new URLSearchParams(location.search);
  const goal = params.get('goal') || '';
  return goal
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

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
) {
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

function resetHudCards() {
  setHudCard('wpm', '—', 0, 'idle');
  setHudCard('filler', '—', 0, 'idle');
  setHudCard('silence', '—', 0, 'idle');
}

function parseHudNumber(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function syncHudFromResponse(payload: LiveHudResponse, recording: boolean) {
  if (!recording) return;
  const byKind = new Map(payload.signals.map((signal) => [signal.kind, signal]));
  const wpmSignal = byKind.get('wpm_very_high') ?? byKind.get('wpm_high');
  if (wpmSignal) {
    const wpm = parseHudNumber(wpmSignal.text) ?? 0;
    const tone = wpmSignal.level === 'critical' ? 'critical' : 'warn';
    setHudCard('wpm', `${Math.round(wpm)} WPM`, Math.min(100, (wpm / 240) * 100), tone);
  } else {
    setHudCard('wpm', '안정적', 42, 'ok');
  }

  const fillerSignal = byKind.get('filler_burst');
  if (fillerSignal) {
    const count = parseHudNumber(fillerSignal.text) ?? 0;
    const tone = fillerSignal.level === 'critical' ? 'critical' : 'warn';
    setHudCard('filler', `${Math.round(count)}회`, Math.min(100, count * 20), tone);
  } else {
    setHudCard('filler', '낮음', 18, 'ok');
  }
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

  setStatus('아바타 로딩 중…');
  const style = new URLSearchParams(location.search).get('style');
  const vrmUrl = resolveAvatarUrl(style);
  const stage = await createAvatarStage(canvas, vrmUrl);

  setStatus('MediaPipe 모델 로딩 중… (CDN 첫 다운로드 시 ~5-10s)');
  const landmarkers = await createLandmarkers();

  setStatus('준비됨 — 거울처럼 따라옵니다. 녹화를 시작하면 webm 저장됩니다.');
  btnStart.disabled = false;
  setTimer(0);
  setRecordBadge('대기 중');
  resetHudCards();

  const recorder = new AvatarRecorder();
  const aggregator = createAggregatorClient();
  const hudClient = createHudClient();
  let recording = false;
  let recordingStartTSec = 0;
  let lastSignalSendT = 0;
  let lastProsodySendT = 0;
  let silenceDetector: SilenceDetector | null = null;
  let sessionId = '';
  const scenario = SCENARIO_MAP[typeName] || 'presentation';

  await hudClient.connect((payload) => {
    syncHudFromResponse(payload, recording);
  });

  btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;
    btnAnalyze.disabled = true;
    setTimer(0);
    setRecordBadge('녹화 중', 'recording');
    setStatus('세션 시작 중…');
    sessionId = `sess_${Date.now()}`;
    const focusGoals = resolveFocusGoals();
    resetSignalState();
    await aggregator.start(sessionId, scenario, focusGoals);
    recorder.start(stream);
    silenceDetector = new SilenceDetector(stream);
    silenceDetector.start();
    recording = true;
    recordingStartTSec = performance.now() / 1000;
    lastSignalSendT = 0;
    lastProsodySendT = 0;
    btnStop.disabled = false;
    resetHudCards();
    setStatus(`녹화 중… (세션 ${sessionId})`);
  });

  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    recording = false;
    if (silenceDetector) {
      silenceDetector.stop();
      silenceDetector = null;
    }
    const rec = await recorder.stop();
    recorded.src = rec.url;
    setTimer(rec.durationMs / 1000);
    setRecordBadge('녹화 완료', 'done');

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
      btnStop.disabled = false;
      setStatus('분석 준비에 실패했어요. 다시 시도해주세요.');
    }
  });

  btnAnalyze.addEventListener('click', async () => {
    const uploadInput = document.getElementById('upload-file') as HTMLInputElement | null;
    const file = uploadInput?.files?.[0];
    if (!file) return;
    btnAnalyze.disabled = true;
    try {
      const sessionKey = `upload_${Date.now()}`;
      const mediaId = await savePendingMedia(file, file.name, file.type || 'video/mp4');
      setPendingAnalysis({
        sessionId: sessionKey,
        project: projectName,
        goal: goals,
        type: typeName,
        source: 'upload',
        createdAt: new Date().toISOString(),
        mediaId,
        filename: file.name,
        mimeType: file.type || 'video/mp4',
        scenario,
      });
      const next = new URL('loading.html', location.href);
      next.searchParams.set('session', sessionKey);
      next.searchParams.set('source', 'upload');
      next.searchParams.set('project', projectName);
      next.searchParams.set('goal', goals.join(', '));
      next.searchParams.set('type', typeName);
      location.href = next.toString();
    } catch (e) {
      console.error('[practice] failed to queue uploaded analysis', e);
      btnAnalyze.disabled = false;
      setStatus('업로드 영상을 준비하지 못했어요. 다시 시도해주세요.');
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
          setTimer(sessionT);
          if (sessionT - lastSignalSendT >= 0.2) {
            const frame = computeVisionFrame(sessionT, face, pose, hand);
            aggregator.sendVision(frame);
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
            setHudCard(
              'silence',
              silenceSeconds > 0.1 ? `${silenceSeconds.toFixed(1)}초` : '짧음',
              Math.min(100, (silenceSeconds / 4) * 100),
              tone,
            );
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
