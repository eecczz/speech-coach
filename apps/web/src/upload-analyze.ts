// Uploaded-video analysis flow.
//
// Goal: deliver the SAME evaluation depth as the live-recording flow when the
// user uploads a pre-recorded video instead of recording in the browser.
//
// Approach: replay the uploaded video through the SAME MediaPipe pipeline that
// the live flow uses, then upload the original file to /analyze for STT + prosody.
// The video itself never leaves the browser for vision (only audio is sent to
// the server, same privacy posture as the live flow).
//
// Pump strategy: play the video silently at PLAYBACK_RATE × realtime, sample
// frames at SAMPLE_INTERVAL_MS wall-clock cadence (≈ 5fps in video time at
// PLAYBACK_RATE=1, 10fps coverage at PLAYBACK_RATE=2, etc.). MediaPipe's
// detectForVideo is synchronous (~30-50ms on CPU); the sleep between samples
// gives the event loop air and matches the live tick's 5fps signal cadence.

import { detect, type Landmarkers } from './mediapipe/landmarkers';
import { computeVisionFrame, resetSignalState } from './signals/compute';
import type { AggregatorClient, AudioAnalysisResult } from './ws/client';
import { uploadForAnalysis } from './audio-upload';
import { renderReview } from './review/render';
import type { ComprehensiveReport } from './review/types';

const SAMPLE_INTERVAL_MS = 200; // 5 samples / sec wall-clock
const PLAYBACK_RATE = 2;        // 2× realtime keeps a 5min upload to ~2.5min vision
const META_TIMEOUT_MS = 15000;
const SEEK_FALLBACK_TIMEOUT_MS = 3000;

export interface UploadAnalyzeContext {
  scenario: string;
  landmarkers: Landmarkers;
  aggregator: AggregatorClient;
  setStatus: (msg: string) => void;
  reviewSection?: HTMLElement;
  reviewVideo?: HTMLVideoElement; // visible <video> renderReview hangs its overlay onto
  onPhaseChange?: (phase: 'video' | 'audio' | 'content' | 'done') => void;
}

export async function analyzeUploadedVideo(
  file: File,
  ctx: UploadAnalyzeContext,
): Promise<ComprehensiveReport | null> {
  const url = URL.createObjectURL(file);

  // Hidden video element used for frame sampling. Separate from the visible
  // review video so playback rate / seeking here doesn't disturb the user's view.
  const probe = document.createElement('video');
  probe.src = url;
  probe.muted = true;             // no audio playback during vision sampling
  probe.preload = 'auto';
  probe.playsInline = true;
  probe.crossOrigin = 'anonymous';
  // We need the element rendering for MediaPipe to read frame pixels — hidden
  // via visibility, not display:none (which can stop the rendering pipeline).
  probe.style.position = 'fixed';
  probe.style.left = '-99999px';
  probe.style.top = '0';
  probe.style.width = '320px';
  probe.style.height = '240px';
  document.body.appendChild(probe);

  // Mirror src onto the visible review video so renderReview can scrub it.
  if (ctx.reviewVideo) {
    ctx.reviewVideo.src = url;
  }

  try {
    ctx.onPhaseChange?.('video');
    ctx.setStatus('영상 로딩 중…');
    await waitFor(probe, META_TIMEOUT_MS);
    const duration = isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 0;
    if (duration <= 0) {
      throw new Error('영상 길이를 알 수 없습니다 (재인코딩이 필요할 수 있어요)');
    }

    // Start an aggregator session keyed to this upload, using the chosen scenario.
    const sessionId = `upload_${Date.now()}`;
    resetSignalState();
    await ctx.aggregator.start(sessionId, ctx.scenario);

    // ── Vision: play + sample loop ──
    probe.playbackRate = PLAYBACK_RATE;
    await probe.play();

    let lastTs = -1;
    let lastReportedPct = -1;
    while (!probe.ended && !probe.paused) {
      const t = probe.currentTime;
      // MediaPipe needs MONOTONIC ms timestamps across the WHOLE landmarker
      // lifetime — and the live tick that ran during the camera preview has
      // already fed it ts ≈ performance.now() (millions). Reusing
      // video.currentTime * 1000 here would start at 0, MP would reject every
      // frame as "non-monotonic", try/catch would swallow the error, and
      // aggregator would see "vision_frames=0". Solution: use wall-clock for
      // MP ordering. The VisionFrame's `t` stays as video time so the moments
      // align to playback position.
      const ts = Math.max(Math.floor(performance.now()), lastTs + 1);
      lastTs = ts;
      try {
        const { face, pose, hand } = detect(ctx.landmarkers, probe, ts);
        const frame = computeVisionFrame(t, face, pose, hand);
        ctx.aggregator.sendVision(frame);
      } catch (e) {
        console.warn('[upload] detect error', e);
      }
      const pct = Math.min(99, Math.round((t / duration) * 100));
      if (pct !== lastReportedPct) {
        ctx.setStatus(`비전 분석 중… ${pct}% (${t.toFixed(1)} / ${duration.toFixed(1)}s)`);
        lastReportedPct = pct;
      }
      await sleep(SAMPLE_INTERVAL_MS);
    }

    // ── Audio: ship the original file to /analyze (STT + prosody) ──
    ctx.onPhaseChange?.('audio');
    ctx.setStatus('음성 분석 중… (Whisper + 운율, 최대 ~1분)');
    let audioResult: AudioAnalysisResult | null = null;
    try {
      audioResult = await uploadForAnalysis(file, sessionId, file.name);
      console.log('[upload] audio analyze', audioResult);
    } catch (e) {
      console.warn('[upload] /analyze failed — proceeding without server audio', e);
    }

    // ── Bundle + LLM ──
    ctx.onPhaseChange?.('content');
    ctx.setStatus('평가 생성 중…');
    const result = await ctx.aggregator.end(audioResult);
    ctx.aggregator.close();

    if (result && (result as { report?: ComprehensiveReport }).report) {
      const report = (result as { report: ComprehensiveReport }).report;
      console.log('[upload] coach result', result);
      if (ctx.reviewSection && ctx.reviewVideo) {
        ctx.reviewSection.hidden = false;
        renderReview(report, ctx.reviewVideo);
      }
      ctx.setStatus(
        `평가 완료 — 종합 ${report.accuracy_overall?.toFixed(1) ?? '?'}점, 순간 ${report.annotated_moments?.length ?? 0}개`,
      );
      ctx.reviewSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      ctx.onPhaseChange?.('done');
      return report;
    } else {
      ctx.setStatus('평가 실패 — 콘솔 확인');
      console.warn('[upload] coach result missing or malformed', result);
      return null;
    }
  } finally {
    // Don't revoke `url` — reviewVideo is still using it. The browser will GC
    // the blob after the page reloads / video src changes.
    try { probe.pause(); } catch { /* ignore */ }
    probe.remove();
  }
}

function waitFor(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onMeta = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error('영상 로드 실패'));
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onErr);
      clearTimeout(timer);
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onErr);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('영상 메타데이터 타임아웃'));
    }, timeoutMs);
    if (video.readyState >= 1) onMeta();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Suppress unused-export warning for SEEK_FALLBACK_TIMEOUT_MS if we don't need
// seek-based sampling at all. Kept in source for the alternate-pump strategy.
void SEEK_FALLBACK_TIMEOUT_MS;
