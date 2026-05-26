// Chess-style review dashboard for a completed session.
//
// Self-contained: builds its own markup inside the passed container (defaults to
// #review) on every call. The host page only needs an empty container to exist —
// makes the dashboard robust to host-page rewrites and lets us add the new mistake-
// marker overlay over the video without changing practice.html.

import type {
  ComprehensiveReport,
  AnnotatedMoment,
  TimelineSample,
  AxisAccuracy,
  SubtitleSegment,
} from './types';
import { getLandmarksAtTime, type LandmarkSnapshot } from '../signals/compute';

// Korean filler dictionary — mirrors services/audio-pipeline/app/prosody.py so
// the subtitle can highlight the same words that triggered FILLER_BURST events.
const KOREAN_FILLERS = new Set([
  '음', '어', '그', '그니까', '그러니까', '이제',
  '뭐', '약간', '막', '근데',
  '음...', '어...', '에...',
]);

function normalizeWord(w: string): string {
  return w.trim().replace(/^[.,!?…"'()[\]{}]+|[.,!?…"'()[\]{}]+$/g, '').trim();
}

// Pulls filler terms out of a moment's title — events.py formats filler bursts
// as e.g. "filler 폭주: 5개 (음, 어, 그)". Returns an empty set for non-filler
// verbal moments, which still get the segment-level "subtitle-active" outline.
function extractFillerTerms(m: AnnotatedMoment): Set<string> {
  if (!/filler|필러|폭주/i.test(m.title)) return new Set();
  const match = m.title.match(/\(([^)]+)\)/);
  if (!match) return new Set();
  return new Set(match[1].split(',').map((s) => normalizeWord(s)));
}

const QUALITY_META: Record<string, { icon: string; color: string; label: string }> = {
  brilliant:  { icon: '★',  color: '#5dd5a2', label: '탁월' },
  excellent:  { icon: '!!', color: '#5dd5a2', label: '우수' },
  good:       { icon: '★',  color: '#9bb',    label: '무난' },
  inaccuracy: { icon: '!',  color: '#4aa3ff', label: '주의' },
  mistake:    { icon: '?',  color: '#f0a040', label: '실수' },
  blunder:    { icon: '✕',  color: '#e04848', label: '심각' },
};

const AXIS_LABEL: Record<string, string> = {
  gaze: '시선', posture: '자세', expression: '표정',
  gesture: '제스처', delivery: '전달력', logic: '논리', overall: '종합',
};

// ── Visual mistake marker mapping ──
//
// Per-moment landmark positions aren't (yet) carried in the SessionBundle, so V1
// maps each moment's AXIS to a generic region of the video frame and renders a
// "?"/"??"/"?!" glyph there. Body-axis moments get an overlay on the relevant
// body region; verbal-axis moments get a caption-strip overlay near the bottom
// (which will sit over real subtitles once STT lands). To make this per-arm or
// per-word precise in V2, the aggregator would need to capture and forward the
// triggering landmark/word index — for now the axis→region map is sufficient
// to demo the visual concept.
const AXIS_REGION: Record<string, [number, number]> = {
  gaze:       [50, 22],   // head/eye area
  expression: [50, 27],   // face
  gesture:    [50, 52],   // body center (no per-side hint in current signals)
  posture:    [50, 62],   // torso
  delivery:   [50, 78],   // caption strip (above standard <video controls>)
  logic:      [50, 78],
  overall:    [50, 50],
};

const QUALITY_MARK: Record<string, string> = {
  brilliant:  '★',
  excellent:  '★',
  good:       '·',
  inaccuracy: '?',
  mistake:    '??',
  blunder:    '?!',
};

// Two moments are "concurrent" if their time spans overlap (with a small fuzz pad
// so near-adjacent point events still cluster). A long-pause silence and a sudden
// raised arm during that silence must show up together — the user explicitly does
// not want one to mask the other.
const CONCURRENT_FUZZ_S = 0.8;

function findConcurrent(moments: AnnotatedMoment[], i: number): number[] {
  const m = moments[i];
  const aStart = m.t - CONCURRENT_FUZZ_S;
  const aEnd = m.t + (m.duration_s ?? 0) + CONCURRENT_FUZZ_S;
  const out: number[] = [i];
  for (let j = 0; j < moments.length; j++) {
    if (j === i) continue;
    const o = moments[j];
    const bStart = o.t - CONCURRENT_FUZZ_S;
    const bEnd = o.t + (o.duration_s ?? 0) + CONCURRENT_FUZZ_S;
    if (aStart < bEnd && bStart < aEnd) out.push(j);
  }
  return out.sort((x, y) => moments[x].t - moments[y].t);
}

// Renders the coach bubble for the active (primary) moment plus a clickable list
// of any concurrent moments below. Clicking a concurrent item promotes it to
// primary via the supplied callback (re-runs selectIndex on that moment's index).
function renderCoachBubble(
  bubble: HTMLDivElement,
  primary: AnnotatedMoment,
  others: AnnotatedMoment[],
  otherIndices: number[],
  onClickOther: (idx: number) => void,
): void {
  const meta = QUALITY_META[primary.quality];
  let html = `
    <div class="bubble-head">
      <span class="bubble-icon" style="color:${meta.color}">${meta.icon}</span>
      <span class="bubble-time">${formatTime(primary.t)}</span>
      <span class="bubble-quality">${meta.label}</span>
      <span class="bubble-axis">${AXIS_LABEL[primary.axis] ?? primary.axis}</span>
    </div>
    <div class="bubble-title">${escapeHtml(primary.title)}</div>
    <div class="bubble-comment">${escapeHtml(primary.coach_comment ?? '(코멘트 없음)')}</div>
  `;
  if (others.length > 0) {
    html += `
      <div class="bubble-concurrent">
        <div class="bubble-concurrent-label">동시 발생 (${others.length})</div>
        <ul class="bubble-concurrent-list" data-el="concurrent-list">
          ${others
            .map((c, k) => {
              const cMeta = QUALITY_META[c.quality];
              return `
                <li class="bubble-concurrent-item moment-${c.quality}" data-other-index="${otherIndices[k]}">
                  <span class="bubble-concurrent-icon" style="color:${cMeta.color}">${cMeta.icon}</span>
                  <span class="bubble-concurrent-axis">${AXIS_LABEL[c.axis] ?? c.axis}</span>
                  <span class="bubble-concurrent-title">${escapeHtml(c.title)}</span>
                  ${c.coach_comment ? `<div class="bubble-concurrent-comment">${escapeHtml(c.coach_comment)}</div>` : ''}
                </li>
              `;
            })
            .join('')}
        </ul>
      </div>
    `;
  }
  bubble.innerHTML = html;
  bubble
    .querySelectorAll<HTMLLIElement>('[data-other-index]')
    .forEach((li) => {
      const idx = Number(li.dataset.otherIndex);
      li.addEventListener('click', () => onClickOther(idx));
    });
}

const REVIEW_TEMPLATE = `
  <header class="review-header">
    <div class="overall-card">
      <div class="overall-label">종합 정확성</div>
      <div data-el="overall" class="overall-value">—</div>
    </div>
    <div data-el="coach-bubble" class="coach-bubble">선택된 순간이 없습니다.</div>
    <div data-el="coach-impact" class="impact-pill">±0</div>
  </header>

  <div class="review-controls">
    <button data-el="prev">← 이전</button>
    <button data-el="next">다음 →</button>
    <span class="kbd-hint">키보드 ← / → 로도 이동</span>
  </div>

  <div class="review-grid">
    <div class="review-left">
      <div class="video-overlay-wrap">
        <video data-el="video" controls playsinline></video>
        <div data-el="overlay" class="video-mistake-overlay"></div>
        <div data-el="subtitle" class="video-subtitle"></div>
      </div>
      <svg data-el="timeline" viewBox="0 0 800 120" preserveAspectRatio="none"></svg>
    </div>
    <div class="review-right">
      <h3 class="panel-h">축별 정확성</h3>
      <div data-el="axes" class="axes"></div>
      <h3 class="panel-h">품질 분포</h3>
      <div data-el="buckets" class="buckets"></div>
    </div>
  </div>

  <h3 class="panel-h">순간 (Moments)</h3>
  <ol data-el="moments-list" class="moments"></ol>
  <h3 class="panel-h">총평</h3>
  <p data-el="summary" class="summary"></p>
`;

export interface ReviewController {
  selectIndex(i: number): void;
  next(): void;
  prev(): void;
}

export function renderReview(
  report: ComprehensiveReport,
  videoEl: HTMLVideoElement,
  container?: HTMLElement,
): ReviewController {
  const root = container ?? (document.getElementById('review') as HTMLElement | null);
  if (!root) {
    throw new Error('renderReview: no container — pass one or ensure #review exists');
  }
  root.innerHTML = REVIEW_TEMPLATE;

  const $ = <T extends Element>(name: string): T =>
    root.querySelector(`[data-el="${name}"]`) as T;

  const $overall  = $<HTMLDivElement>('overall');
  const $bubble   = $<HTMLDivElement>('coach-bubble');
  const $impact   = $<HTMLDivElement>('coach-impact');
  const $prev     = $<HTMLButtonElement>('prev');
  const $next     = $<HTMLButtonElement>('next');
  const $video    = $<HTMLVideoElement>('video');
  const $overlay  = $<HTMLDivElement>('overlay');
  const $subtitle = $<HTMLDivElement>('subtitle');
  const $svg      = $<SVGSVGElement>('timeline');
  const $axes     = $<HTMLDivElement>('axes');
  const $buckets  = $<HTMLDivElement>('buckets');
  const $list     = $<HTMLOListElement>('moments-list');
  const $summary  = $<HTMLParagraphElement>('summary');

  // ── Subtitle state ──
  // segs: STT segments shipped with the report (from /analyze). May be empty
  // when STT didn't run for this session — in that case subtitle stays hidden.
  // activeHighlightT / activeFillers: set when a verbal moment is selected so
  // the matching subtitle segment + filler words get highlighted under the marker.
  const subtitleSegs: SubtitleSegment[] = report.subtitle_segments ?? [];
  let activeHighlightT: number | null = null;
  let activeFillerWords = new Set<string>();

  // Mirror the recorded blob into our self-built video element. Blob URLs can be
  // shared across multiple <video> elements safely.
  if (videoEl.src) $video.src = videoEl.src;

  const moments = report.annotated_moments ?? [];
  const timeline = report.score_timeline ?? [];
  let current = 0;

  $overall.textContent = `${report.accuracy_overall.toFixed(1)}%`;
  $summary.textContent = report.overall_summary ?? '';

  renderAxes($axes, report.accuracy_per_axis ?? []);
  renderBuckets($buckets, report.quality_buckets);

  // ── moments list
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
    $list.appendChild(li);
  });

  renderTimeline($svg, timeline, moments, (i) => selectIndex(i));

  // Subtitle sync — updates on every video.timeupdate (~4Hz in most browsers,
  // which is fine for human reading speed). Also explicitly call after seek.
  function updateSubtitle(): void {
    if (subtitleSegs.length === 0) {
      $subtitle.classList.remove('subtitle-visible');
      return;
    }
    const t = $video.currentTime;
    const seg = subtitleSegs.find((s) => s.t_start <= t && t <= s.t_end + 0.4);
    if (!seg) {
      $subtitle.classList.remove('subtitle-visible');
      $subtitle.innerHTML = '';
      return;
    }
    // Render per-word spans so we can highlight individual words (filler etc.).
    const html = seg.words.length > 0
      ? seg.words.map((w) => {
          const norm = normalizeWord(w.word);
          const isFiller = activeFillerWords.has(norm) ||
            (activeHighlightT !== null && KOREAN_FILLERS.has(norm));
          // Always highlight fillers when their segment is the active verbal moment;
          // otherwise just plain word.
          const filler = activeFillerWords.has(norm) ? ' subtitle-filler' : '';
          // Visually mark the currently spoken word (where playback is).
          const current = t >= w.t_start && t <= w.t_end + 0.1 ? ' subtitle-current' : '';
          void isFiller; // unused if no active highlight, kept for future per-word marker positioning
          return `<span class="subtitle-word${filler}${current}">${escapeHtml(w.word)}</span>`;
        }).join(' ')
      : `<span>${escapeHtml(seg.text)}</span>`;
    const activeOnThis =
      activeHighlightT !== null && seg.t_start <= activeHighlightT && activeHighlightT <= seg.t_end + 0.5;
    $subtitle.className = `video-subtitle subtitle-visible${activeOnThis ? ' subtitle-active' : ''}`;
    $subtitle.innerHTML = html;
  }
  $video.addEventListener('timeupdate', updateSubtitle);
  $video.addEventListener('seeked', updateSubtitle);
  $video.addEventListener('loadedmetadata', updateSubtitle);

  $prev.addEventListener('click', () => selectIndex(current - 1));
  $next.addEventListener('click', () => selectIndex(current + 1));
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
    const concurrentIdx = findConcurrent(moments, clamped);
    const otherIdx = concurrentIdx.filter((j) => j !== clamped);
    const others = otherIdx.map((j) => moments[j]);

    // Coach bubble — primary moment plus a clickable list of all concurrent ones.
    // Clicking a concurrent item re-runs selectIndex on it (promotes to primary).
    renderCoachBubble($bubble, m, others, otherIdx, (idx) => selectIndex(idx));
    $impact.textContent = `${m.impact >= 0 ? '+' : ''}${m.impact}`;

    // Moments list — active for the clicked one, "concurrent" for its siblings.
    $list.querySelectorAll('li').forEach((el) => el.classList.remove('active', 'concurrent'));
    const activeLi = $list.querySelector(`li[data-index="${clamped}"]`);
    if (activeLi) {
      activeLi.classList.add('active');
      (activeLi as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    for (const j of otherIdx) {
      const li = $list.querySelector(`li[data-index="${j}"]`);
      if (li) li.classList.add('concurrent');
    }

    // Timeline dots — same active / concurrent dual highlight.
    $svg.querySelectorAll('.timeline-dot').forEach((el) => el.classList.remove('active', 'concurrent'));
    const activeDot = $svg.querySelector(`.timeline-dot[data-index="${clamped}"]`);
    if (activeDot) activeDot.classList.add('active');
    for (const j of otherIdx) {
      const dot = $svg.querySelector(`.timeline-dot[data-index="${j}"]`);
      if (dot) dot.classList.add('concurrent');
    }

    // Seek video and PAUSE — user explicitly asked for this; auto-play scrubs past
    // the mistake before they can inspect it.
    try {
      $video.pause();
      $video.currentTime = m.t;
    } catch { /* video not ready */ }
    if (videoEl !== $video) {
      try { videoEl.pause(); videoEl.currentTime = m.t; } catch { /* ignore */ }
    }

    // Render markers for ALL concurrent moments — multiple icons at different
    // positions so simultaneous mistakes (silence + raised arm + …) all show at once.
    renderMistakeMarkers($overlay, concurrentIdx.map((j) => moments[j]));

    // Subtitle highlight — if any concurrent moment is verbal (delivery/logic),
    // mark its segment as active and extract filler words for stronger highlight.
    const verbal = concurrentIdx.map((j) => moments[j]).find(
      (mm) => mm.axis === 'delivery' || mm.axis === 'logic',
    );
    if (verbal) {
      activeHighlightT = verbal.t;
      activeFillerWords = extractFillerTerms(verbal);
    } else {
      activeHighlightT = null;
      activeFillerWords = new Set();
    }
    updateSubtitle();

    $prev.disabled = clamped === 0;
    $next.disabled = clamped === moments.length - 1;
  }

  if (moments.length > 0) selectIndex(0);

  return {
    selectIndex,
    next: () => selectIndex(current + 1),
    prev: () => selectIndex(current - 1),
  };
}

// ── Mistake markers over the video ──
// Each moment gets a circle drawn on the *actual body part* causing the issue
// (looked up from the per-frame LandmarkSnapshot buffer that compute.ts kept
// during the session), plus a "?"/"??"/"?!" glyph above it. Verbal axes use the
// caption-strip fallback until Phase C wires word-level subtitle highlighting.
//
// Falls back to AXIS_REGION (generic body area) when no landmark snapshot
// exists for the moment's time — e.g. the user was off-camera in that window.

interface CircleTarget {
  x: number;          // image-normalized [0..1] — same coord space as MediaPipe
  y: number;
  sizePx: number;     // CSS px diameter
}

const SIZE_FACE_PX = 70;
const SIZE_HAND_PX = 90;
const SIZE_HEAD_PX = 120;

function pickMarkerTargets(m: AnnotatedMoment): CircleTarget[] {
  const snap = getLandmarksAtTime(m.t, 1.5);
  if (snap) {
    const t = targetsForAxis(m, snap);
    if (t.length > 0) return t;
  }
  // No landmark coverage for this t → fall back to the generic axis region.
  const [px, py] = AXIS_REGION[m.axis] ?? AXIS_REGION.gesture;
  return [{ x: px / 100, y: py / 100, sizePx: SIZE_HAND_PX }];
}

function targetsForAxis(m: AnnotatedMoment, snap: LandmarkSnapshot): CircleTarget[] {
  const titleHas = (s: string) => m.title.includes(s);

  switch (m.axis) {
    case 'gaze':
      if (snap.face) {
        return [{
          x: (snap.face.leftEye.x + snap.face.rightEye.x) / 2,
          y: (snap.face.leftEye.y + snap.face.rightEye.y) / 2,
          sizePx: SIZE_FACE_PX,
        }];
      }
      break;

    case 'expression':
      if (snap.face) {
        return [{
          x: snap.face.mouth.x,
          y: snap.face.mouth.y,
          sizePx: SIZE_FACE_PX,
        }];
      }
      break;

    case 'gesture':
      if (snap.pose) {
        // For gesture issues we don't know which hand — circle both.
        return [
          { x: snap.pose.leftWrist.x, y: snap.pose.leftWrist.y, sizePx: SIZE_HAND_PX },
          { x: snap.pose.rightWrist.x, y: snap.pose.rightWrist.y, sizePx: SIZE_HAND_PX },
        ];
      }
      break;

    case 'posture': {
      // Hand-touching-face events: circle the wrist nearest the face center.
      const wristToFace = (titleHas('턱 괴기') || titleHas('얼굴') || titleHas('만지')) && snap.face && snap.pose;
      if (wristToFace && snap.face && snap.pose) {
        const fcx = (snap.face.bbox.minX + snap.face.bbox.maxX) / 2;
        const fcy = (snap.face.bbox.minY + snap.face.bbox.maxY) / 2;
        const lwd = Math.hypot(snap.pose.leftWrist.x - fcx, snap.pose.leftWrist.y - fcy);
        const rwd = Math.hypot(snap.pose.rightWrist.x - fcx, snap.pose.rightWrist.y - fcy);
        const w = lwd < rwd ? snap.pose.leftWrist : snap.pose.rightWrist;
        return [{ x: w.x, y: w.y, sizePx: SIZE_HAND_PX }];
      }
      // Fidget — both wrists.
      if (titleHas('만지작') && snap.pose) {
        return [
          { x: snap.pose.leftWrist.x, y: snap.pose.leftWrist.y, sizePx: SIZE_HAND_PX },
          { x: snap.pose.rightWrist.x, y: snap.pose.rightWrist.y, sizePx: SIZE_HAND_PX },
        ];
      }
      // Generic posture / head tilt / sway / nodding — circle the head/upper torso.
      if (snap.pose) {
        const cx = (snap.pose.leftShoulder.x + snap.pose.rightShoulder.x) / 2;
        const cy = (snap.pose.head.y + (snap.pose.leftShoulder.y + snap.pose.rightShoulder.y) / 2) / 2;
        return [{ x: cx, y: cy, sizePx: SIZE_HEAD_PX }];
      }
      break;
    }

    case 'overall':
      // Positive "all axes good" moments — soft glow at face center.
      if (snap.face) {
        return [{
          x: (snap.face.bbox.minX + snap.face.bbox.maxX) / 2,
          y: (snap.face.bbox.minY + snap.face.bbox.maxY) / 2,
          sizePx: SIZE_HEAD_PX,
        }];
      }
      break;

    // Verbal axes (delivery, logic) — leave to caption-strip fallback for now;
    // Phase C will render subtitles with word-level highlighting underneath.
    default:
      break;
  }
  return [];
}

function renderMistakeMarkers(overlay: HTMLDivElement, moments: AnnotatedMoment[]): void {
  overlay.innerHTML = '';
  if (moments.length === 0) return;

  for (const m of moments) {
    const mark = QUALITY_MARK[m.quality];
    if (!mark) continue;
    const meta = QUALITY_META[m.quality];
    const isCaption = m.axis === 'delivery' || m.axis === 'logic';
    const targets = pickMarkerTargets(m);

    for (const t of targets) {
      // Body-part axes draw a circle around the actual landmark; caption-strip
      // axes (verbal) skip the circle and just place the glyph at the caption row.
      if (!isCaption) {
        const circle = document.createElement('div');
        circle.className = `mistake-circle mistake-${m.quality}`;
        circle.style.left = `${t.x * 100}%`;
        circle.style.top = `${t.y * 100}%`;
        circle.style.width = `${t.sizePx}px`;
        circle.style.height = `${t.sizePx}px`;
        circle.style.borderColor = meta.color;
        overlay.appendChild(circle);
      }
      // Glyph: above the circle for body parts, sitting in the caption strip otherwise.
      const el = document.createElement('div');
      el.className = `mistake-marker mistake-${m.quality}${isCaption ? ' mistake-marker-caption' : ''}`;
      el.textContent = mark;
      el.style.color = meta.color;
      el.style.left = `${t.x * 100}%`;
      // Position glyph just above the circle (or at the point itself for caption).
      const yOffsetPx = isCaption ? 0 : (t.sizePx / 2 + 14);
      el.style.top = isCaption ? `${t.y * 100}%` : `calc(${t.y * 100}% - ${yOffsetPx}px)`;
      overlay.appendChild(el);
    }
  }
}

function renderAxes(el: HTMLElement, axes: AxisAccuracy[]): void {
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

function renderBuckets(el: HTMLElement, b: ComprehensiveReport['quality_buckets']): void {
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
  svg: SVGSVGElement,
  samples: TimelineSample[],
  moments: AnnotatedMoment[],
  onDot: (i: number) => void,
): void {
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

  for (const score of [25, 50, 75]) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(PAD));
    line.setAttribute('x2', String(W - PAD));
    line.setAttribute('y1', String(yOf(score)));
    line.setAttribute('y2', String(yOf(score)));
    line.setAttribute('class', 'timeline-grid');
    svg.appendChild(line);
  }

  moments.forEach((m, i) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(xOf(m.t)));
    const nearby = samples.reduce(
      (acc, s) => (Math.abs(s.t - m.t) < Math.abs(acc.t - m.t) ? s : acc),
      samples[0] ?? { t: m.t, score: 75 },
    );
    c.setAttribute('cy', String(yOf(nearby?.score ?? 75)));
    c.setAttribute('r', '5');
    c.setAttribute('class', `timeline-dot quality-${m.quality}`);
    c.setAttribute('data-index', String(i));
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
