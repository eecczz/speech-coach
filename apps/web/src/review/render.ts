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
import { getLandmarksAtTime, type LandmarkSnapshot, type Point2 } from '../signals/compute';

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

  // STT segments shipped with the report (from /analyze). Empty when STT didn't
  // run for this session → subtitle stays hidden. The rAF overlay loop reads
  // these continuously and decides per-frame which segment / words to highlight.
  const subtitleSegs: SubtitleSegment[] = report.subtitle_segments ?? [];

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

  // ── Time-driven overlay loop ──
  // Markers stay pinned to whatever the user clicked (selectIndex sets pinnedMoments),
  // so they remain visible while the video plays. The CIRCLES inside the markers
  // reposition every frame to the body part's current location — so e.g. when
  // the user clicked a "raised arm" moment and presses play, the circle stays on
  // the moving wrist instead of disappearing the instant playback steps past the
  // moment's time range. (The previous "active-moments-at-currentT" approach
  // hid markers anywhere outside the moment span — markers seemed to only appear
  // while paused.)
  //
  // Subtitle text follows currentT separately so the words read correctly with
  // playback; the active-verbal *highlight* keys off pinnedMoments so it agrees
  // with the markers above.
  let pinnedMoments: AnnotatedMoment[] = [];
  function pinnedVerbalMoment(): AnnotatedMoment | undefined {
    return pinnedMoments.find((m) => m.axis === 'delivery' || m.axis === 'logic');
  }

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
    // Subtitle highlight follows the user's clicked context (pinned), not the
    // current playback time. So the filler / segment outline stays consistent
    // with the markers above the video instead of randomly jumping when
    // playback drifts into another verbal mistake the user didn't click.
    const verbal = pinnedVerbalMoment();
    const explicitFillers = verbal ? extractFillerTerms(verbal) : new Set<string>();
    const html = seg.words.length > 0
      ? seg.words.map((w) => {
          const norm = normalizeWord(w.word);
          const isFiller = !!verbal && (explicitFillers.has(norm) || KOREAN_FILLERS.has(norm));
          const filler = isFiller ? ' subtitle-filler' : '';
          const current = t >= w.t_start && t <= w.t_end + 0.1 ? ' subtitle-current' : '';
          return `<span class="subtitle-word${filler}${current}">${escapeHtml(w.word)}</span>`;
        }).join(' ')
      : `<span>${escapeHtml(seg.text)}</span>`;
    const activeOnThis = !!verbal;
    $subtitle.className = `video-subtitle subtitle-visible${activeOnThis ? ' subtitle-active' : ''}`;
    $subtitle.innerHTML = html;
  }

  function renderOverlayAtCurrentTime(): void {
    const t = $video.currentTime;
    // Pinned moments stay on-screen; circles re-pick body coords for THIS instant.
    renderMistakeMarkers($overlay, pinnedMoments, t);
    updateSubtitle();
  }

  // rAF loop runs only while playing — paused video uses one-shot updates so
  // we don't burn cycles forever.
  let rafId = 0;
  function rafLoop(): void {
    renderOverlayAtCurrentTime();
    if (!$video.paused && !$video.ended) {
      rafId = requestAnimationFrame(rafLoop);
    }
  }
  $video.addEventListener('play', () => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(rafLoop);
  });
  $video.addEventListener('pause', () => {
    cancelAnimationFrame(rafId);
    renderOverlayAtCurrentTime();
  });
  $video.addEventListener('ended', () => cancelAnimationFrame(rafId));
  $video.addEventListener('seeked', renderOverlayAtCurrentTime);
  $video.addEventListener('loadedmetadata', renderOverlayAtCurrentTime);

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

    // Pin this moment + its concurrents so the overlay keeps them on-screen
    // while the user plays through the section. The rAF loop will continually
    // refresh circle positions to wherever the body parts are at the current
    // frame, so the marker tracks the speaker instead of staying static.
    pinnedMoments = concurrentIdx.map((j) => moments[j]);

    // Seek video and PAUSE — user explicitly asked for this; auto-play scrubs past
    // the mistake before they can inspect it. The rAF overlay loop picks up the
    // new currentTime via the 'seeked' event and re-renders markers/subtitle.
    try {
      $video.pause();
      $video.currentTime = m.t;
    } catch { /* video not ready */ }
    if (videoEl !== $video) {
      try { videoEl.pause(); videoEl.currentTime = m.t; } catch { /* ignore */ }
    }

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

// ── Bone-based mistake / positive markers over the video ──
//
// Chess.com-style: draw a coloured LINE along the body part causing the moment
// (forearm for gesture, eye-line for gaze, spine for posture, …). The line's
// colour encodes the moment's quality — green for excellent/brilliant, orange
// for mistake, red for blunder, etc. A "?"/"??"/"?!"/"★" glyph sits at the
// midpoint of the (first) bone so the user reads both the *what* and the *where*
// in a single glance.
//
// Verbal axes (delivery / logic) still use the caption-strip fallback below the
// video — subtitle word-highlight handles those.

interface Bone {
  a: Point2;
  b: Point2;
}

function pickBones(m: AnnotatedMoment, snap: LandmarkSnapshot): Bone[] {
  const titleHas = (s: string) => m.title.includes(s);

  switch (m.axis) {
    case 'gaze':
    case 'expression':
      if (snap.face) {
        // Eye-line for both — distinguishable by colour + glyph from the marker.
        return [{ a: snap.face.leftEye, b: snap.face.rightEye }];
      }
      break;

    case 'gesture':
      if (snap.pose) {
        // We don't know which hand was the issue — draw both forearms.
        return [
          { a: snap.pose.leftElbow, b: snap.pose.leftWrist },
          { a: snap.pose.rightElbow, b: snap.pose.rightWrist },
        ];
      }
      break;

    case 'posture': {
      // Hand-touching-face → forearm of the touching hand.
      const wristToFace =
        (titleHas('턱 괴기') || titleHas('얼굴') || titleHas('만지')) && snap.face && snap.pose;
      if (wristToFace && snap.face && snap.pose) {
        const fcx = (snap.face.bbox.minX + snap.face.bbox.maxX) / 2;
        const fcy = (snap.face.bbox.minY + snap.face.bbox.maxY) / 2;
        const lwd = Math.hypot(snap.pose.leftWrist.x - fcx, snap.pose.leftWrist.y - fcy);
        const rwd = Math.hypot(snap.pose.rightWrist.x - fcx, snap.pose.rightWrist.y - fcy);
        return lwd < rwd
          ? [{ a: snap.pose.leftElbow, b: snap.pose.leftWrist }]
          : [{ a: snap.pose.rightElbow, b: snap.pose.rightWrist }];
      }
      // Fidget — both forearms.
      if (titleHas('만지작') && snap.pose) {
        return [
          { a: snap.pose.leftElbow, b: snap.pose.leftWrist },
          { a: snap.pose.rightElbow, b: snap.pose.rightWrist },
        ];
      }
      // Generic posture / head tilt / sway / nodding → spine line (head → mid-shoulders).
      if (snap.pose) {
        const midShoulder: Point2 = {
          x: (snap.pose.leftShoulder.x + snap.pose.rightShoulder.x) / 2,
          y: (snap.pose.leftShoulder.y + snap.pose.rightShoulder.y) / 2,
        };
        return [{ a: snap.pose.head, b: midShoulder }];
      }
      break;
    }

    case 'overall':
      // BRILLIANT "all axes good" — green spine line as the positive marker.
      if (snap.pose) {
        const midShoulder: Point2 = {
          x: (snap.pose.leftShoulder.x + snap.pose.rightShoulder.x) / 2,
          y: (snap.pose.leftShoulder.y + snap.pose.rightShoulder.y) / 2,
        };
        return [{ a: snap.pose.head, b: midShoulder }];
      }
      break;

    // Verbal axes leave the body alone; subtitle row handles them.
    default:
      break;
  }
  return [];
}

function renderMistakeMarkers(
  overlay: HTMLDivElement,
  moments: AnnotatedMoment[],
  currentT: number,
): void {
  overlay.innerHTML = '';
  if (moments.length === 0) return;

  // One SVG layer for all bone lines — using viewBox 0..100 with
  // preserveAspectRatio="none" lets us specify coords as % of the video.
  // vector-effect=non-scaling-stroke keeps line thickness consistent even as
  // the SVG stretches to non-square aspect ratios.
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'mistake-bone-layer');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');

  const snap = getLandmarksAtTime(currentT, 0.4);

  for (const m of moments) {
    const mark = QUALITY_MARK[m.quality];
    if (!mark) continue;
    const meta = QUALITY_META[m.quality];
    const isCaption = m.axis === 'delivery' || m.axis === 'logic';

    // Caption-strip moments: skip bone, drop glyph in the verbal strip.
    if (isCaption) {
      const [px, py] = AXIS_REGION[m.axis] ?? AXIS_REGION.gesture;
      const el = document.createElement('div');
      el.className = `mistake-marker mistake-${m.quality} mistake-marker-caption`;
      el.textContent = mark;
      el.style.color = meta.color;
      el.style.left = `${px}%`;
      el.style.top = `${py}%`;
      overlay.appendChild(el);
      continue;
    }

    const bones = snap ? pickBones(m, snap) : [];

    if (bones.length === 0) {
      // No landmark coverage at this instant — fall back to the generic axis
      // region so the user still sees *something* (better than dropping the
      // moment entirely the moment MP misses one frame).
      const [px, py] = AXIS_REGION[m.axis] ?? AXIS_REGION.gesture;
      const el = document.createElement('div');
      el.className = `mistake-marker mistake-${m.quality}`;
      el.textContent = mark;
      el.style.color = meta.color;
      el.style.left = `${px}%`;
      el.style.top = `${py}%`;
      overlay.appendChild(el);
      continue;
    }

    // Draw each bone as a coloured line on the SVG layer.
    for (const bone of bones) {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', String(bone.a.x * 100));
      line.setAttribute('y1', String(bone.a.y * 100));
      line.setAttribute('x2', String(bone.b.x * 100));
      line.setAttribute('y2', String(bone.b.y * 100));
      line.setAttribute('stroke', meta.color);
      line.setAttribute('stroke-width', '8');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      line.setAttribute('class', `mistake-bone mistake-${m.quality}`);
      svg.appendChild(line);
    }

    // Glyph sits at the midpoint of the first (primary) bone.
    const primary = bones[0];
    const mx = ((primary.a.x + primary.b.x) / 2) * 100;
    const my = ((primary.a.y + primary.b.y) / 2) * 100;
    const el = document.createElement('div');
    el.className = `mistake-marker mistake-${m.quality}`;
    el.textContent = mark;
    el.style.color = meta.color;
    el.style.left = `${mx}%`;
    // Lift the glyph slightly above the line so the bone remains readable.
    el.style.top = `calc(${my}% - 24px)`;
    overlay.appendChild(el);
  }

  // Append SVG once after collecting all bones (avoids z-order surprises with
  // marker glyphs — divs naturally render on top of the earlier SVG sibling).
  overlay.insertBefore(svg, overlay.firstChild);
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
