import { deriveNextTarget, findPreviousSession, formatTimeShort, getDisplayAxisScores, getTopMoments } from './report-utils';
import type { AnnotatedMoment } from './review/types';
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
const momentsList = document.getElementById('moments-list') as HTMLElement | null;
const nextGoalsList = document.getElementById('next-goals-list') as HTMLOListElement | null;
const modalVideo = document.getElementById('modal-video') as HTMLVideoElement | null;
const modalVideoEmpty = document.getElementById('modal-video-empty') as HTMLElement | null;
const modalMomentMeta = document.getElementById('modal-moment-meta') as HTMLElement | null;
const modalFeedback = document.getElementById('modal-feedback') as HTMLElement | null;
const modalBack = document.getElementById('modal-back') as HTMLButtonElement | null;
const modalPlay = document.getElementById('modal-play') as HTMLButtonElement | null;
const modalForward = document.getElementById('modal-forward') as HTMLButtonElement | null;

let modalVideoUrl: string | null = null;
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

function formatMomentRange(moment: Pick<AnnotatedMoment, 't' | 'duration_s'>): string {
  const start = formatTimeShort(moment.t);
  const duration = typeof moment.duration_s === 'number' && Number.isFinite(moment.duration_s)
    ? Math.max(0, moment.duration_s)
    : 0;
  if (duration <= 0) return start;
  return `${start}-${formatTimeShort(moment.t + duration)}`;
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

function renderMoments(session: ReturnType<typeof getCompletedSession>) {
  if (!momentsList || !session) return;
  const topMoments = getTopMoments(session.report, 3);
  if (topMoments.length === 0) {
    momentsList.innerHTML = '<p>표시할 분석 구간이 아직 없습니다.</p>';
    return;
  }
  momentsList.innerHTML = topMoments
    .map(
      (moment) => {
        const range = formatMomentRange(moment);
        return `
        <button type="button" class="moment-card" data-moment-title="${moment.title}" data-moment-comment="${moment.coach_comment ?? ''}" data-moment-time="${moment.t}" data-moment-range="${range}">
          <span class="moment-time-range">${range}</span>
          <p>${moment.title}</p>
          <em>${moment.axis}</em>
        </button>
      `;
      },
    )
    .join('');

  momentsList.querySelectorAll<HTMLButtonElement>('[data-moment-title]').forEach((button) => {
    button.addEventListener('click', () => {
      activeMomentTime = Number(button.dataset.momentTime || 0);
      seekModalVideo(activeMomentTime);
      if (modalMomentMeta) {
        const range = button.dataset.momentRange || formatTimeShort(activeMomentTime);
        modalMomentMeta.textContent = `${range} · ${button.dataset.momentTitle || '주의 구간'}`;
      }
      if (modalFeedback) modalFeedback.textContent = button.dataset.momentComment || '이 구간의 코칭 코멘트가 여기에 표시됩니다.';
      (document.getElementById('video-modal') as HTMLDialogElement | null)?.showModal();
    });
  });
}

async function attachModalVideo(session: ReturnType<typeof getCompletedSession>) {
  if (!modalVideo || !modalVideoEmpty || !session?.mediaId) {
    setModalVideoAvailable(false);
    return;
  }
  const media = await loadPendingMedia(session.mediaId);
  if (!media) {
    setModalVideoAvailable(false);
    return;
  }
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
  new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '점수', data, borderColor: '#AFCBFF', backgroundColor: '#AFCBFF', pointBackgroundColor: ['#AFCBFF', '#CDEEE7', '#F3C9D0', '#F6E6A8'], pointRadius: 3, borderWidth: 2, tension: 0.28 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0, max: 100, grid: { color: 'rgba(151, 165, 188, 0.18)' } },
        x: { grid: { display: false } },
      },
    },
  });
}

async function render() {
  syncThemeToggle();
  const params = new URLSearchParams(location.search);
  const sessions = getCompletedSessions();
  const session = params.get('session')
    ? getCompletedSession(params.get('session')!)
    : sessions[0] ?? null;

  if (!session) {
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
    retryLink.href = `practice.html?project=${encodeURIComponent(session.project)}&goal=${encodeURIComponent(goalText)}&type=${encodeURIComponent(session.type)}`;
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

  renderMoments(session);
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
