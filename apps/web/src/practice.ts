import { createAvatarStage } from './avatar/stage';
import { applyFaceToVRM, applyPoseToVRM } from './avatar/retarget';
import { resolveAvatarUrl } from './avatar/registry';
import { createLandmarkers, detect } from './mediapipe/landmarkers';
import { AvatarRecorder } from './recorder/canvas-record';

const status = document.getElementById('status') as HTMLDivElement;
const video = document.getElementById('cam') as HTMLVideoElement;
const canvas = document.getElementById('avatar') as HTMLCanvasElement;
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const playback = document.getElementById('playback') as HTMLElement;
const recorded = document.getElementById('recorded') as HTMLVideoElement;

function setStatus(msg: string) {
  status.textContent = msg;
  console.log('[practice]', msg);
}

async function bootstrap() {
  setStatus('카메라/마이크 권한 요청 중…');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  video.srcObject = stream;
  await video.play();

  setStatus('아바타 로딩 중…');
  const style = new URLSearchParams(location.search).get('style');
  const vrmUrl = resolveAvatarUrl(style);
  const stage = await createAvatarStage(canvas, vrmUrl);

  setStatus('MediaPipe 모델 로딩 중… (CDN 첫 다운로드 시 ~5-10s)');
  const landmarkers = await createLandmarkers();

  setStatus('준비됨 — 거울처럼 따라옵니다. 녹화를 시작하면 webm 저장됩니다.');
  btnStart.disabled = false;

  const recorder = new AvatarRecorder();
  let recording = false;

  btnStart.addEventListener('click', () => {
    recorder.start(canvas, stream);
    recording = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    setStatus('녹화 중…');
  });

  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    const rec = await recorder.stop();
    recording = false;
    btnStart.disabled = false;
    setStatus(`녹화 완료 — ${(rec.durationMs / 1000).toFixed(1)}s, ${(rec.blob.size / 1024 / 1024).toFixed(1)}MB`);
    recorded.src = rec.url;
    playback.hidden = false;
  });

  // Animation loop
  let lastT = performance.now();
  const tick = () => {
    const now = performance.now();
    const delta = (now - lastT) / 1000;
    lastT = now;

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const { face, pose } = detect(landmarkers, video, now);
      if (stage.vrm) {
        applyFaceToVRM(stage.vrm, face);
        applyPoseToVRM(stage.vrm, pose);
      } else if (stage.fallback) {
        // No VRM available — rotate primitive head by jawOpen for visible feedback.
        const jaw = face.faceBlendshapes?.[0]?.categories.find((c) => c.categoryName === 'jawOpen')?.score ?? 0;
        const head = stage.fallback.children[0];
        if (head) head.scale.setScalar(1 + jaw * 0.3);
      }
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
}

bootstrap().catch((err) => {
  console.error(err);
  setStatus(`초기화 실패: ${err instanceof Error ? err.message : String(err)}`);
});
