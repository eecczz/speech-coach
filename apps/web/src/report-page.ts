import { deriveNextTarget, findPreviousSession, formatTimeShort, getDisplayAxisScores, getTopMoments } from './report-utils';
import type { AnnotatedMoment } from './review/types';
import type { CompletedSession } from './session-store';
import { getCompletedSession, getCompletedSessions, loadPendingMedia } from './session-store';

declare const Chart: any;

const themeToggle = document.querySelector('[data-theme-toggle]') as HTMLButtonElement | null;
const retryLink = document.getElementById('retry-link') as HTMLAnchorElement | null;
const reportHeading = document.getElementById('report-heading') as HTMLElement | null;
const reportSubtitle = document.getElementById('report-subtitle') as HTMLElement | null;
const focusLine = document.getElementById('report-focus-line') as HTMLElement | null;
const currentScoreEl = document.getElementById('current-score') as HTMLElement | null;
const targetScoreEl = document.getElementById('target-score') as HTMLElement | null;
const deltaScoreEl = document.getElementById('delta-score') as HTMLElement | null;
const summaryEl = document.getElementById('ai-summary') as HTMLElement | null;
const nextGoalsList = document.getElementById('next-goals-list') as HTMLOListElement | null;
const downloadVideoButton = document.getElementById('download-video-link') as HTMLButtonElement | null;
const downloadMp4Button = document.getElementById('download-mp4-link') as HTMLButtonElement | null;
const modalVideo = document.getElementById('modal-video') as HTMLVideoElement | null;
const modalVideoEmpty = document.getElementById('modal-video-empty') as HTMLElement | null;
const modalMomentMeta = document.getElementById('modal-moment-meta') as HTMLElement | null;
const modalFeedback = document.getElementById('modal-feedback') as HTMLElement | null;
const modalBack = document.getElementById('modal-back') as HTMLButtonElement | null;
const modalPlay = document.getElementById('modal-play') as HTMLButtonElement | null;
const modalForward = document.getElementById('modal-forward') as HTMLButtonElement | null;

let modalVideoUrl: string | null = null;
let reportMediaBlob: Blob | null = null;
let reportMediaFilename = 'speakup-video.webm';
let reportMediaMimeType = 'video/webm';
let activeMomentTime = 0;

function syncThemeToggle() {
  if (!themeToggle) return;
  const theme = document.documentElement.dataset.theme || 'light';
  themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
  themeToggle.setAttribute('aria-label', theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
}

themeToggle?.addEventListener('click', () => {
  const nextTheme = (document.documentElement.dataset.theme || 'light') === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem('speakup-theme', nextTheme);
  syncThemeToggle();
});

document.getElementById('print-link')?.addEventListener('click', () => {
  window.print();
});

downloadVideoButton?.addEventListener('click', () => {
  downloadReportVideo();
});

downloadMp4Button?.addEventListener('click', () => {
  void downloadReportVideoAsMp4();
});

document.querySelector('[data-close-modal]')?.addEventListener('click', () => {
  (document.getElementById('video-modal') as HTMLDialogElement | null)?.close();
});

modalBack?.addEventListener('click', () => seekModalVideo(activeMomentTime - 10));
modalForward?.addEventListener('click', () => seekModalVideo(activeMomentTime + 10));
modalPlay?.addEventListener('click', () => {
  seekModalVideo(activeMomentTime);
  void modalVideo?.play().catch(() => {});
});

function seekModalVideo(time: number) {
  if (!modalVideo || !modalVideo.src) return;
  const duration = Number.isFinite(modalVideo.duration) ? modalVideo.duration : Number.POSITIVE_INFINITY;
  modalVideo.currentTime = Math.max(0, Math.min(time, duration));
}

function sanitizeDownloadFilename(filename: string): string {
  return filename
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    || 'speakup-video.webm';
}

function extensionFromMime(mimeType: string): string {
  if (mimeType.includes('mp4')) return '.mp4';
  if (mimeType.includes('quicktime')) return '.mov';
  if (mimeType.includes('webm')) return '.webm';
  return '.webm';
}

function getMediaExtension(filename: string, mimeType: string): string {
  return filename.match(/\.[A-Za-z0-9]{2,5}$/)?.[0] ?? extensionFromMime(mimeType);
}

function formatDownloadTimestamp(createdAt: string): string {
  const created = new Date(createdAt);
  const date = Number.isNaN(created.getTime()) ? new Date() : created;
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function getReportVideoFilename(session: CompletedSession, mediaFilename: string, mimeType: string): string {
  if (session.source === 'upload' && mediaFilename) {
    return sanitizeDownloadFilename(mediaFilename);
  }
  const ext = getMediaExtension(mediaFilename, mimeType);
  const timestamp = formatDownloadTimestamp(session.createdAt);
  return sanitizeDownloadFilename(`SpeakUp_${session.project}_${timestamp}${ext}`);
}

function getMp4Filename(filename: string): string {
  const withoutExtension = filename.replace(/\.[A-Za-z0-9]{2,5}$/, '');
  return sanitizeDownloadFilename(`${withoutExtension || 'speakup-video'}.mp4`);
}

function setDownloadVideoAvailable(available: boolean) {
  if (downloadVideoButton) {
    downloadVideoButton.disabled = !available;
    downloadVideoButton.textContent = available ? '영상 저장' : '저장할 영상 없음';
    downloadVideoButton.title = available
      ? '분석에 사용한 원본 영상을 별도로 저장합니다. PDF에는 영상이 포함되지 않습니다.'
      : '저장된 영상이 없어 다운로드할 수 없습니다.';
  }
  if (downloadMp4Button) {
    downloadMp4Button.disabled = !available;
    downloadMp4Button.textContent = available ? 'MP4로 저장' : 'MP4 저장 불가';
    downloadMp4Button.title = available
      ? '저장된 영상을 MP4로 변환해서 내려받습니다.'
      : '저장된 영상이 없어 MP4로 변환할 수 없습니다.';
  }
}

function clearReportMedia() {
  reportMediaBlob = null;
  reportMediaFilename = 'speakup-video.webm';
  reportMediaMimeType = 'video/webm';
  setDownloadVideoAvailable(false);
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadReportVideo() {
  if (!reportMediaBlob) return;
  triggerBlobDownload(reportMediaBlob, reportMediaFilename);
}

function isMp4Source(filename: string, mimeType: string): boolean {
  return mimeType.includes('mp4') || filename.toLowerCase().endsWith('.mp4');
}

async function downloadReportVideoAsMp4() {
  if (!reportMediaBlob || !downloadMp4Button) return;
  const previousText = downloadMp4Button.textContent || 'MP4로 저장';
  downloadMp4Button.disabled = true;
  downloadMp4Button.textContent = 'MP4 변환 중...';
  try {
    if (isMp4Source(reportMediaFilename, reportMediaMimeType)) {
      triggerBlobDownload(reportMediaBlob, getMp4Filename(reportMediaFilename));
      return;
    }
    const form = new FormData();
    const file = new File([reportMediaBlob], reportMediaFilename, {
      type: reportMediaMimeType || reportMediaBlob.type || 'video/webm',
    });
    form.append('video', file, file.name);
    const response = await fetch('/convert/mp4', {
      method: 'POST',
      body: form,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error || `MP4 변환 실패 (${response.status})`);
    }
    const mp4Blob = await response.blob();
    triggerBlobDownload(mp4Blob, getMp4Filename(reportMediaFilename));
  } catch (error) {
    console.error('[report] mp4 download failed', error);
    alert('MP4 변환에 실패했습니다. 원본 영상 저장을 먼저 사용해 주세요.');
  } finally {
    downloadMp4Button.disabled = false;
    downloadMp4Button.textContent = previousText;
  }
}

function formatMomentRange(moment: Pick<AnnotatedMoment, 't' | 'duration_s'>): string {
  const start = formatTimeShort(moment.t);
  const duration = typeof moment.duration_s === 'number' && Number.isFinite(moment.duration_s)
    ? Math.max(0, moment.duration_s)
    : 0;
  if (duration <= 0) return start;
  return `${start}-${formatTimeShort(moment.t + duration)}`;
}

function openMoment(moment: AnnotatedMoment): void {
  activeMomentTime = moment.t;
  seekModalVideo(activeMomentTime);
  if (modalMomentMeta) {
    modalMomentMeta.textContent = `${formatMomentRange(moment)} · ${moment.title}`;
  }
  if (modalFeedback) modalFeedback.textContent = moment.coach_comment || '이 구간의 코칭 코멘트가 여기에 표시됩니다.';
  (document.getElementById('video-modal') as HTMLDialogElement | null)?.showModal();
}

function setAxisCard(key: 'verbal' | 'prosody' | 'nonverbal', score: number | null, note: string) {
  const card = document.querySelector<HTMLElement>(`[data-axis-card="${key}"]`);
  if (!card) return;
  const valueEl = card.querySelector<HTMLElement>('[data-axis-value]');
  const noteEl = card.querySelector<HTMLElement>('[data-axis-note]');
  const meter = card.querySelector<HTMLElement>('.meter i');
  if (valueEl) valueEl.textContent = typeof score === 'number' ? `${Math.round(score)}` : '—';
  if (noteEl) noteEl.textContent = note;
  if (meter) meter.style.width = `${Math.max(0, Math.min(100, score ?? 0))}%`;
}

async function attachModalVideo(session: ReturnType<typeof getCompletedSession>) {
  if (!modalVideo || !modalVideoEmpty || !session?.mediaId) {
    clearReportMedia();
    setModalVideoAvailable(false);
    return;
  }
  const media = await loadPendingMedia(session.mediaId);
  if (!media) {
    clearReportMedia();
    setModalVideoAvailable(false);
    return;
  }
  reportMediaBlob = media.blob;
  reportMediaFilename = getReportVideoFilename(
    session,
    media.filename || session.filename || '',
    media.mimeType || session.mimeType || media.blob.type || 'video/webm',
  );
  reportMediaMimeType = media.mimeType || session.mimeType || media.blob.type || 'video/webm';
  setDownloadVideoAvailable(true);
  if (modalVideoUrl) URL.revokeObjectURL(modalVideoUrl);
  modalVideoUrl = URL.createObjectURL(media.blob);
  modalVideo.src = modalVideoUrl;
  modalVideo.load();
  setModalVideoAvailable(true);
}

function setModalVideoAvailable(available: boolean) {
  if (modalVideo) modalVideo.hidden = !available;
  if (modalVideoEmpty) modalVideoEmpty.hidden = available;
  if (modalBack) modalBack.disabled = !available;
  if (modalPlay) modalPlay.disabled = !available;
  if (modalForward) modalForward.disabled = !available;
}

function renderNextGoals(session: ReturnType<typeof getCompletedSession>) {
  if (!nextGoalsList || !session) return;
  const drills = session.report.training_prescriptions.slice(0, 3);
  const improvements = session.report.improvements.slice(0, 3);
  const rows = drills.length > 0
    ? drills.map((drill) => `${drill.title}: ${drill.steps[0] ?? drill.addresses}`)
    : improvements.map((item) => item.suggestion || item.text);
  nextGoalsList.innerHTML = rows.length
    ? rows.map((row) => `<li>${row}</li>`).join('')
    : '<li>다음 연습에서 다시 확인할 포인트를 곧 보여드릴게요.</li>';
}

function renderChart(session: ReturnType<typeof getCompletedSession>) {
  const canvas = document.getElementById('score-chart') as HTMLCanvasElement | null;
  if (!canvas || !session) return;
  const labels = session.report.score_timeline.map((sample) => formatTimeShort(sample.t));
  const data = session.report.score_timeline.map((sample) => Number(sample.score.toFixed(1)));
  const topMoments = getTopMoments(session.report, 8);
  const momentsByIndex = new Map<number, AnnotatedMoment>();
  const momentData = labels.map(() => null as number | null);
  topMoments.forEach((moment) => {
    const nearestIndex = session.report.score_timeline.reduce((bestIndex, sample, index, samples) => {
      const bestDelta = Math.abs(samples[bestIndex].t - moment.t);
      const nextDelta = Math.abs(sample.t - moment.t);
      return nextDelta < bestDelta ? index : bestIndex;
    }, 0);
    momentsByIndex.set(nearestIndex, moment);
    momentData[nearestIndex] = data[nearestIndex] ?? Math.max(40, 100 + Math.min(0, moment.impact));
  });
  new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '발화 흐름',
          data,
          borderColor: '#AFCBFF',
          backgroundColor: '#AFCBFF',
          pointBackgroundColor: '#AFCBFF',
          pointRadius: 3,
          borderWidth: 2,
          tension: 0.28,
        },
        {
          label: '주의 구간',
          data: momentData,
          borderColor: 'transparent',
          backgroundColor: '#2e2c3a',
          pointBackgroundColor: '#2e2c3a',
          pointBorderColor: '#CDEEE7',
          pointBorderWidth: 3,
          pointRadius: 7,
          pointHoverRadius: 9,
          showLine: false,
        },
      ],
    },
    options: {
      responsive: true,
      onClick: (_event: unknown, elements: Array<{ datasetIndex: number; index: number }>) => {
        const hit = elements.find((element) => element.datasetIndex === 1);
        if (!hit) return;
        const moment = momentsByIndex.get(hit.index);
        if (moment) openMoment(moment);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items: Array<{ dataIndex: number }>) => {
              const moment = momentsByIndex.get(items[0]?.dataIndex ?? -1);
              return moment ? formatMomentRange(moment) : '';
            },
            label: (item: { datasetIndex: number; dataIndex: number; formattedValue: string }) => {
              const moment = momentsByIndex.get(item.dataIndex);
              if (item.datasetIndex === 1 && moment) return `${moment.title} · 클릭해서 복기`;
              return `점수: ${item.formattedValue}`;
            },
          },
        },
      },
      scales: {
        y: { min: 0, max: 100, grid: { color: 'rgba(151, 165, 188, 0.18)' } },
        x: { grid: { display: false } },
      },
    },
  });
}

async function render() {
  syncThemeToggle();
  setDownloadVideoAvailable(false);
  const params = new URLSearchParams(location.search);
  const sessions = getCompletedSessions();
  const session = params.get('session')
    ? getCompletedSession(params.get('session')!)
    : sessions[0] ?? null;

  if (!session) {
    clearReportMedia();
    if (summaryEl) summaryEl.textContent = '표시할 분석 결과가 아직 없습니다.';
    return;
  }

  const previous = findPreviousSession(sessions, session);
  const previousScore = previous?.report.accuracy_overall ?? null;
  const targetScore = deriveNextTarget(session.report.accuracy_overall, previousScore);
  const axisScores = getDisplayAxisScores(session.report);
  const goalText = session.goal.length ? session.goal.join(', ') : '말하기 흐름';

  if (reportHeading) reportHeading.textContent = session.project;
  if (reportSubtitle) reportSubtitle.textContent = `${session.project} 리포트`;
  if (focusLine) focusLine.textContent = `이번 연습에서는 ${goalText}를 중심으로 돌아봤어요.`;
  if (currentScoreEl) currentScoreEl.textContent = `${Math.round(session.report.accuracy_overall)}`;
  if (targetScoreEl) targetScoreEl.textContent = `${Math.round(targetScore)}`;
  if (deltaScoreEl) {
    const delta = typeof previousScore === 'number' ? session.report.accuracy_overall - previousScore : session.report.accuracy_overall - targetScore + 5;
    deltaScoreEl.textContent = `${delta >= 0 ? '+' : ''}${Math.round(delta)}`;
  }
  if (summaryEl) {
    summaryEl.textContent = session.report.overall_summary || '이번 연습의 종합 코칭이 여기에 표시됩니다.';
  }
  if (retryLink) {
    const retryUrl = new URL('practice.html', location.href);
    retryUrl.searchParams.set('sessionId', session.sessionId);
    if (session.projectId) retryUrl.searchParams.set('projectId', session.projectId);
    retryUrl.searchParams.set('project', session.project);
    retryUrl.searchParams.set('goal', goalText);
    retryUrl.searchParams.set('type', session.type);
    if (session.situation) retryUrl.searchParams.set('situation', session.situation);
    retryLink.href = retryUrl.toString();
  }

  setAxisCard(
    'verbal',
    axisScores.verbal,
    session.report.strengths[0]?.text || session.report.top_priorities[0]?.text || '핵심 문장 흐름을 기준으로 살펴봤어요.',
  );
  setAxisCard(
    'prosody',
    axisScores.prosody,
    session.report.improvements[0]?.text || '속도와 쉼의 리듬을 함께 정리했어요.',
  );
  setAxisCard(
    'nonverbal',
    axisScores.nonverbal,
    session.report.top_priorities[0]?.suggestion || '시선, 자세, 표정 흐름을 함께 돌아봤어요.',
  );

  renderNextGoals(session);
  renderChart(session);
  await attachModalVideo(session);

  const modalLines = [
    session.report.top_priorities[0]?.text,
    session.report.top_priorities[0]?.suggestion,
  ].filter(Boolean);
  if (modalFeedback) modalFeedback.textContent = modalLines.join(' ') || '세부 코칭이 준비되면 이곳에 표시됩니다.';
}

void render();
