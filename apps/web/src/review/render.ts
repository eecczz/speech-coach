// Chess-style review dashboard for a completed session.
//
// Renders into a container element with these children (looked up by id):
//   #review-coach-bubble        : current moment's title + coach_comment
//   #review-coach-impact        : impact pill (e.g., -20)
//   #review-prev / #review-next : navigation buttons
//   #review-moments-list        : <ol> populated with moments
//   #review-timeline            : <svg> graph
//   #review-axes                : per-axis accuracy bars
//   #review-buckets             : quality count grid
//   #review-overall             : overall accuracy %
//   #review-summary             : LLM overall_summary
//   #review-video               : <video> with the avatar webm

import type {
  ComprehensiveReport,
  AnnotatedMoment,
  TimelineSample,
  AxisAccuracy,
} from './types';

const QUALITY_META: Record<string, { icon: string; color: string; label: string }> = {
  brilliant:  { icon: '★',  color: '#5dd5a2', label: '탁월' },
  excellent:  { icon: '!!', color: '#5dd5a2', label: '우수' },
  good:       { icon: '★',  color: '#9bb',    label: '무난' },
  inaccuracy: { icon: '!',  color: '#4aa3ff', label: '주의' },
  mistake:    { icon: '?',  color: '#f0a040', label: '실수' },
  blunder:    { icon: '✕',  color: '#e04848', label: '심각' },
};

const AXIS_LABEL: Record<string, string> = {
  gaze: '시선',
  posture: '자세',
  expression: '표정',
  gesture: '제스처',
  delivery: '전달력',
  logic: '논리',
  overall: '종합',
};

export interface ReviewController {
  selectIndex(i: number): void;
  next(): void;
  prev(): void;
}

export function renderReview(
  report: ComprehensiveReport,
  videoEl: HTMLVideoElement,
): ReviewController {
  const moments = report.annotated_moments ?? [];
  const timeline = report.score_timeline ?? [];
  let current = 0;

  // ── overall + summary
  setText('review-overall', `${report.accuracy_overall.toFixed(1)}%`);
  setText('review-summary', report.overall_summary ?? '');

  // ── axes
  renderAxes(report.accuracy_per_axis ?? []);

  // ── buckets
  renderBuckets(report.quality_buckets);

  // ── moments list
  const list = document.getElementById('review-moments-list') as HTMLOListElement;
  list.innerHTML = '';
  moments.forEach((m, i) => {
    const li = document.createElement('li');
    li.className = `moment moment-${m.quality}`;
    li.dataset.index = String(i);
    const meta = QUALITY_META[m.quality];
    li.innerHTML = `
      <span class="moment-time">${formatTime(m.t)}</span>
      <span class="moment-icon" style="color:${meta.color}">${meta.icon}</span>
      <span class="moment-axis">${AXIS_LABEL[m.axis] ?? m.axis}</span>
      <span class="moment-title">${escapeHtml(m.title)}</span>
      <span class="moment-impact">${m.impact >= 0 ? '+' : ''}${m.impact}</span>
    `;
    li.addEventListener('click', () => selectIndex(i));
    list.appendChild(li);
  });

  // ── timeline svg
  renderTimeline(timeline, moments, (i) => selectIndex(i));

  // ── nav buttons + keyboard
  const btnPrev = document.getElementById('review-prev') as HTMLButtonElement;
  const btnNext = document.getElementById('review-next') as HTMLButtonElement;
  btnPrev.addEventListener('click', () => selectIndex(current - 1));
  btnNext.addEventListener('click', () => selectIndex(current + 1));
  document.addEventListener('keydown', (e) => {
    if (document.activeElement && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') selectIndex(current - 1);
    else if (e.key === 'ArrowRight') selectIndex(current + 1);
  });

  function selectIndex(i: number) {
    if (moments.length === 0) return;
    const clamped = Math.max(0, Math.min(moments.length - 1, i));
    current = clamped;
    const m = moments[clamped];

    // Bubble
    const meta = QUALITY_META[m.quality];
    const bubble = document.getElementById('review-coach-bubble') as HTMLDivElement;
    bubble.innerHTML = `
      <div class="bubble-head">
        <span class="bubble-icon" style="color:${meta.color}">${meta.icon}</span>
        <span class="bubble-time">${formatTime(m.t)}</span>
        <span class="bubble-quality">${meta.label}</span>
        <span class="bubble-axis">${AXIS_LABEL[m.axis] ?? m.axis}</span>
      </div>
      <div class="bubble-title">${escapeHtml(m.title)}</div>
      <div class="bubble-comment">${escapeHtml(m.coach_comment ?? '(코멘트 없음)')}</div>
    `;
    setText('review-coach-impact', `${m.impact >= 0 ? '+' : ''}${m.impact}`);

    // Move list highlight + scroll
    list.querySelectorAll('li').forEach((el) => el.classList.remove('active'));
    const activeLi = list.querySelector(`li[data-index="${clamped}"]`);
    if (activeLi) {
      activeLi.classList.add('active');
      (activeLi as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    // Timeline dot highlight
    document.querySelectorAll('.timeline-dot').forEach((el) => el.classList.remove('active'));
    const activeDot = document.querySelector(`.timeline-dot[data-index="${clamped}"]`);
    if (activeDot) activeDot.classList.add('active');

    // Video jump
    try {
      videoEl.currentTime = m.t;
      videoEl.play().catch(() => {/* autoplay blocked, user can press play */});
    } catch {/* video not ready */}

    btnPrev.disabled = clamped === 0;
    btnNext.disabled = clamped === moments.length - 1;
  }

  if (moments.length > 0) selectIndex(0);

  return {
    selectIndex,
    next: () => selectIndex(current + 1),
    prev: () => selectIndex(current - 1),
  };
}

function renderAxes(axes: AxisAccuracy[]): void {
  const el = document.getElementById('review-axes') as HTMLDivElement;
  el.innerHTML = '';
  for (const a of axes) {
    const row = document.createElement('div');
    row.className = 'axis-row';
    const w = a.available ? Math.max(0, Math.min(100, a.score)) : 0;
    const note = !a.available ? a.note ?? 'N/A' : '';
    row.innerHTML = `
      <span class="axis-label">${AXIS_LABEL[a.axis] ?? a.axis}</span>
      <span class="axis-bar"><span class="axis-fill" style="width:${w}%"></span></span>
      <span class="axis-score">${a.available ? a.score.toFixed(0) : '—'}</span>
      <span class="axis-note">${escapeHtml(note)}</span>
    `;
    el.appendChild(row);
  }
}

function renderBuckets(b: ComprehensiveReport['quality_buckets']): void {
  const el = document.getElementById('review-buckets') as HTMLDivElement;
  el.innerHTML = '';
  const items: Array<[string, number]> = [
    ['brilliant', b?.brilliant ?? 0],
    ['excellent', b?.excellent ?? 0],
    ['good', b?.good ?? 0],
    ['inaccuracy', b?.inaccuracy ?? 0],
    ['mistake', b?.mistake ?? 0],
    ['blunder', b?.blunder ?? 0],
  ];
  for (const [k, n] of items) {
    const meta = QUALITY_META[k];
    const cell = document.createElement('div');
    cell.className = 'bucket-cell';
    cell.innerHTML = `
      <span class="bucket-icon" style="color:${meta.color}">${meta.icon}</span>
      <span class="bucket-label">${meta.label}</span>
      <span class="bucket-count">${n}</span>
    `;
    el.appendChild(cell);
  }
}

function renderTimeline(
  samples: TimelineSample[],
  moments: AnnotatedMoment[],
  onDot: (i: number) => void,
): void {
  const svg = document.getElementById('review-timeline') as unknown as SVGSVGElement;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (samples.length === 0 && moments.length === 0) return;

  const W = svg.viewBox.baseVal?.width || 800;
  const H = svg.viewBox.baseVal?.height || 120;
  const PAD = 8;

  const tMax = Math.max(
    samples.length ? samples[samples.length - 1].t : 0,
    moments.length ? moments[moments.length - 1].t : 0,
    1,
  );

  const xOf = (t: number) => PAD + (t / tMax) * (W - 2 * PAD);
  const yOf = (s: number) => H - PAD - (s / 100) * (H - 2 * PAD);

  // Line through samples
  if (samples.length > 1) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d = `M ${xOf(samples[0].t).toFixed(1)} ${yOf(samples[0].score).toFixed(1)}`;
    for (let i = 1; i < samples.length; i++) {
      d += ` L ${xOf(samples[i].t).toFixed(1)} ${yOf(samples[i].score).toFixed(1)}`;
    }
    path.setAttribute('d', d);
    path.setAttribute('class', 'timeline-line');
    svg.appendChild(path);
  }

  // Baseline grid
  for (const score of [25, 50, 75]) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(PAD));
    line.setAttribute('x2', String(W - PAD));
    line.setAttribute('y1', String(yOf(score)));
    line.setAttribute('y2', String(yOf(score)));
    line.setAttribute('class', 'timeline-grid');
    svg.appendChild(line);
  }

  // Moment dots
  moments.forEach((m, i) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(xOf(m.t)));
    // For dots without a corresponding sample, use baseline 75
    const nearby = samples.reduce((acc, s) => (Math.abs(s.t - m.t) < Math.abs(acc.t - m.t) ? s : acc), samples[0] ?? { t: m.t, score: 75 });
    c.setAttribute('cy', String(yOf(nearby?.score ?? 75)));
    c.setAttribute('r', '5');
    c.setAttribute('class', `timeline-dot quality-${m.quality}`);
    c.dataset.index = String(i);
    c.setAttribute('fill', QUALITY_META[m.quality].color);
    c.addEventListener('click', () => onDot(i));
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${formatTime(m.t)} ${m.title}`;
    c.appendChild(title);
    svg.appendChild(c);
  });
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
