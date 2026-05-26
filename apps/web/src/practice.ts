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
import { createAggregatorClient } from './ws/client';
import { renderReview } from './review/render';
import type { ComprehensiveReport } from './review/types';
import { uploadForAnalysis } from './audio-upload';
import { analyzeUploadedVideo } from './upload-analyze';

const status = document.getElementById('status') as HTMLDivElement;
const video = document.getElementById('cam') as HTMLVideoElement;
const canvas = document.getElementById('avatar') as HTMLCanvasElement;
const debug = document.getElementById('debug') as HTMLPreElement;
const camSelect = document.getElementById('cam-select') as HTMLSelectElement;
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const recorded = document.getElementById('recorded') as HTMLVideoElement;
const reviewSection = document.getElementById('review') as HTMLElement;

// Common virtual-camera label fragments. We avoid these on first try because
// they often output a privacy filter or static image, not the actual user.
const VIRTUAL_HINTS = ['virtual', 'mirametrix', 'obs', 'snap', 'nvidia broadcast', 'xsplit', 'manycam'];

function isLikelyVirtual(label: string): boolean {
  const l = label.toLowerCase();
  return VIRTUAL_HINTS.some((h) => l.includes(h));
}

async function acquireStream(preferredDeviceId?: string): Promise<MediaStream> {
  // First call: ask for permission with default device so labels become readable.
  if (!preferredDeviceId) {
    let scratch: MediaStream | null = null;
    try {
      scratch = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      throw e;
    }
    // Enumerate to pick a non-virtual camera if the default is virtual.
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
      } else {
        console.warn('[practice] only virtual cameras found — proceeding with virtual; preview will likely be blank');
      }
    } else {
      camSelect.value = cams.find((c) => c.label === currentLabel)?.deviceId ?? '';
    }
    return scratch;
  }

  // Targeted re-acquire with a specific device.
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

  const recorder = new AvatarRecorder();
  const aggregator = createAggregatorClient();
  let recording = false;
  let recordingStartTSec = 0;
  let lastSignalSendT = 0;
  let lastProsodySendT = 0;
  let silenceDetector: SilenceDetector | null = null;
  // Outer scope so btnStop can pass it into /analyze (associates the audio
  // analysis with the recording session).
  let sessionId = '';
  // Pauses the live tick's MediaPipe + avatar pipeline while the uploaded-video
  // flow drives the same landmarkers on its hidden probe video. Two sources
  // calling detectForVideo with interleaved timestamps would break MP's
  // monotonicity guard. Set false to suspend live detect, true to resume.
  let liveDetect = true;

  btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;
    setStatus('세션 시작 중…');
    sessionId = `sess_${Date.now()}`;
    // Scenario picks the coach rubric: presentation | interview | vocal | ...
    // (see services/coach/rubrics/*.yaml). Default 'presentation' if no URL param.
    const scenario = new URLSearchParams(location.search).get('scenario') || 'presentation';
    resetSignalState();
    await aggregator.start(sessionId, scenario);
    recorder.start(stream); // record the user's video+audio directly (avatar canvas is hidden)
    silenceDetector = new SilenceDetector(stream);
    silenceDetector.start();
    recording = true;
    recordingStartTSec = performance.now() / 1000;
    lastSignalSendT = 0;
    lastProsodySendT = 0;
    btnStop.disabled = false;
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

    // Phase 2 audio pipeline — upload webm to /analyze (STT + prosody), merge
    // result into the bundle via aggregator /session/end. faster-whisper +
    // librosa on a 1-2 min clip on CPU usually 30-90s, hence the status update.
    setStatus(`음성 분석 중… (Whisper + 운율, 최대 ~1분)`);
    let audioResult: Awaited<ReturnType<typeof uploadForAnalysis>> | null = null;
    try {
      audioResult = await uploadForAnalysis(rec.blob, sessionId);
      console.log('[audio] analyze result', audioResult);
    } catch (e) {
      console.warn('[audio] /analyze failed — bundling without server-side audio', e);
    }

    setStatus(`평가 생성 중…`);
    const result = await aggregator.end(audioResult);
    aggregator.close();
    if (result && (result as { report?: ComprehensiveReport }).report) {
      const report = (result as { report: ComprehensiveReport }).report;
      console.log('[coach] result', result);
      reviewSection.hidden = false;
      renderReview(report, recorded);
      setStatus(
        `평가 완료 — 종합 ${report.accuracy_overall?.toFixed(1) ?? '?'}점, 순간 ${report.annotated_moments?.length ?? 0}개`,
      );
      reviewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      console.warn('[coach] result missing or malformed', result);
      setStatus('녹화 완료 — 평가 서버 응답 없음 (콘솔 확인)');
    }
    btnStart.disabled = false;
  });

  // Animation loop with diagnostics
  let lastT = performance.now();
  let frames = 0;
  let lastFpsT = performance.now();
  let fps = 0;
  let faceCount = 0;
  let poseCount = 0;
  let handCount = 0;
  let detectError: string | null = null;
  let lastTs = -1;
  let pixelMean = -1; // sampled brightness of current camera frame, 0..255

  // Off-screen canvas for sampling video pixel content (verifies frames are non-black).
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

    if (ready && vw > 0 && vh > 0 && liveDetect) {
      // Sample frame brightness every ~10 frames to verify camera isn't black.
      if (probeFrame++ % 10 === 0) {
        probeCtx.drawImage(video, 0, 0, probe.width, probe.height);
        const data = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum += data[i] + data[i + 1] + data[i + 2];
        }
        pixelMean = sum / (data.length / 4) / 3;
      }

      // MediaPipe requires strictly monotonic timestamps. Skipped entirely when
      // liveDetect=false (upload-analyze takes over the landmarker).
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

        // Push 5fps vision signals to aggregator while recording.
        if (recording) {
          const sessionT = now / 1000 - recordingStartTSec;
          if (sessionT - lastSignalSendT >= 0.2) {
            const frame = computeVisionFrame(sessionT, face, pose, hand);
            aggregator.sendVision(frame);
            lastSignalSendT = sessionT;
          }
          // Push prosody (silence) frame every ~1s.
          if (silenceDetector && sessionT - lastProsodySendT >= 1.0) {
            const { silenceSeconds, rmsMean } = silenceDetector.snapshot();
            aggregator.sendProsody({
              t_start: lastProsodySendT,
              t_end: sessionT,
              silence_seconds: silenceSeconds,
              rms_mean: rmsMean,
            });
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
      // ~once per second, dump to console too
      console.log('[debug]', debugLine.replace(/\n/g, ' | '));
    }

    stage.render(delta);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Beforeunload guard: prevent accidental nav while recording
  window.addEventListener('beforeunload', (e) => {
    if (recording) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ── Uploaded-video flow ──
  // Wires #btn-analyze (in the upload section above the recording stage) to the
  // upload-analyze pipeline. Re-uses the same landmarkers + aggregator + review
  // section the live flow uses, so evaluation depth is identical.
  const btnAnalyze = document.getElementById('btn-analyze') as HTMLButtonElement | null;
  const uploadInput = document.getElementById('upload-file') as HTMLInputElement | null;
  if (btnAnalyze && uploadInput) {
    btnAnalyze.addEventListener('click', async (ev) => {
      // The inline JS in practice.html still navigates to loading.html — prevent
      // that so our handler can run instead. (We also clear that handler in the
      // HTML, but defense-in-depth is fine.)
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const file = uploadInput.files?.[0];
      if (!file) {
        setStatus('영상 파일을 먼저 선택해 주세요');
        return;
      }
      btnAnalyze.disabled = true;
      btnStart.disabled = true;
      liveDetect = false; // suspend live tick — upload flow drives the landmarker
      const scenario =
        new URLSearchParams(location.search).get('scenario') || 'presentation';
      try {
        await analyzeUploadedVideo(file, {
          scenario,
          landmarkers,
          aggregator,
          setStatus,
          reviewSection,
          reviewVideo: recorded,
        });
      } catch (e) {
        console.error('[upload] flow failed', e);
        setStatus(`업로드 분석 실패: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        btnAnalyze.disabled = false;
        // Leave btnStart disabled — user is reviewing the upload result, and the
        // aggregator session was closed by analyzeUploadedVideo. A fresh page
        // load is the cleanest path back to a live recording.
        // liveDetect stays false so the live camera doesn't keep firing MP detect
        // on top of the review playback.
      }
    });
  }
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

// (uploadForAnalysis moved to ./audio-upload.ts — shared with upload-analyze flow.)
