import type {
  FaceLandmarkerResult,
  PoseLandmarkerResult,
  HandLandmarkerResult,
} from '@mediapipe/tasks-vision';
import * as THREE from 'three';

// 5-fps vision signal frame, mirrors VisionFrame in packages/schema.
export interface VisionFrame {
  t: number;
  gaze_fixation_ratio: number;
  posture_sway: number;
  shoulder_tilt: number;
  expression_diversity: number;
  hand_gesture_freq: number;
  head_pitch_deg: number;
  head_yaw_deg: number;
  head_roll_deg: number;
  chin_on_hand: boolean;
  mouth_open: number;
}

// Internal state — rolling buffers + last positions.
const SHOULDER_BUFFER_S = 1.0;
const HAND_VELOCITY_THRESHOLD = 0.5; // image-normalized units/sec

interface ShoulderSample {
  t: number;
  midY: number;
}
const shoulderBuf: ShoulderSample[] = [];

let lastHand: { t: number; x: number; y: number } | null = null;
let handMovingFrames = 0;
let handTotalFrames = 0;

const GAZE_CONE_RAD = (15 * Math.PI) / 180; // ±15°

interface HeadPose {
  pitchDeg: number; // +down, -up
  yawDeg: number;   // +subject-left
  rollDeg: number;  // +tilt toward subject-right shoulder
}

function computeHeadPose(face: FaceLandmarkerResult): HeadPose | null {
  const matrix = face.facialTransformationMatrixes?.[0]?.data;
  if (!matrix || matrix.length !== 16) return null;
  const m = new THREE.Matrix4().fromArray(matrix);
  const e = new THREE.Euler().setFromRotationMatrix(m, 'YXZ');
  // YXZ: e.y = yaw, e.x = pitch, e.z = roll
  return {
    pitchDeg: THREE.MathUtils.radToDeg(e.x),
    yawDeg: THREE.MathUtils.radToDeg(e.y),
    rollDeg: THREE.MathUtils.radToDeg(e.z),
  };
}

function computeGazeFixation(face: FaceLandmarkerResult): number {
  const matrix = face.facialTransformationMatrixes?.[0]?.data;
  if (!matrix || matrix.length !== 16) return 0;
  const m = new THREE.Matrix4().fromArray(matrix);
  const fwd = new THREE.Vector3();
  m.extractBasis(new THREE.Vector3(), new THREE.Vector3(), fwd);
  const cameraFwd = new THREE.Vector3(0, 0, 1);
  const angle = fwd.angleTo(cameraFwd);
  return Math.max(0, 1 - angle / GAZE_CONE_RAD);
}

function computeMouthOpen(face: FaceLandmarkerResult): number {
  const cats = face.faceBlendshapes?.[0]?.categories;
  if (!cats) return 0;
  const jaw = cats.find((c) => c.categoryName === 'jawOpen');
  return jaw?.score ?? 0;
}

// Returns true when a hand wrist landmark sits inside the face bounding box —
// proxy for "propping head on hand" (턱 괴기). Uses pose landmark 15/16 (wrist)
// and face landmark 152 (chin tip) + 10 (forehead) for the face bounds.
function computeChinOnHand(
  face: FaceLandmarkerResult,
  pose: PoseLandmarkerResult,
): boolean {
  const fl = face.faceLandmarks?.[0];
  const pl = pose.landmarks?.[0];
  if (!fl || !pl || fl.length < 200 || pl.length < 17) return false;
  // Face image-space bounds — landmark indices: 10=forehead top, 152=chin tip,
  // 234=left cheek, 454=right cheek (image-mirrored = subject's anatomical right).
  const top = fl[10];
  const bottom = fl[152];
  const left = fl[234];
  const right = fl[454];
  if (!top || !bottom || !left || !right) return false;
  const minX = Math.min(left.x, right.x);
  const maxX = Math.max(left.x, right.x);
  const minY = Math.min(top.y, bottom.y);
  const maxY = Math.max(top.y, bottom.y);
  // Expand bounds by 20% so hands resting on cheek/chin still count.
  const padX = (maxX - minX) * 0.2;
  const padY = (maxY - minY) * 0.2;
  const inBox = (x: number, y: number) =>
    x >= minX - padX && x <= maxX + padX && y >= minY - padY && y <= maxY + padY;
  // Pose-detected wrists (15=anatomical left, 16=anatomical right). Image-space x/y.
  const lw = pl[15];
  const rw = pl[16];
  return (lw && inBox(lw.x, lw.y)) || (rw && inBox(rw.x, rw.y)) || false;
}

function computePostureSway(pose: PoseLandmarkerResult, tSec: number): number {
  const lm = pose.landmarks?.[0];
  if (!lm || lm.length < 13) return 0;
  const ls = lm[11];
  const rs = lm[12];
  if (!ls || !rs) return 0;
  const midY = (ls.y + rs.y) / 2;
  shoulderBuf.push({ t: tSec, midY });
  // Drop samples older than window.
  while (shoulderBuf.length && shoulderBuf[0].t < tSec - SHOULDER_BUFFER_S) {
    shoulderBuf.shift();
  }
  if (shoulderBuf.length < 3) return 0;
  const mean = shoulderBuf.reduce((s, p) => s + p.midY, 0) / shoulderBuf.length;
  const variance =
    shoulderBuf.reduce((s, p) => s + (p.midY - mean) ** 2, 0) / shoulderBuf.length;
  return Math.sqrt(variance);
}

function computeShoulderTilt(pose: PoseLandmarkerResult): number {
  const lm = pose.landmarks?.[0];
  if (!lm) return 0;
  const ls = lm[11];
  const rs = lm[12];
  if (!ls || !rs) return 0;
  const dx = rs.x - ls.x;
  const dy = rs.y - ls.y;
  if (Math.abs(dx) < 0.01) return 0;
  return dy / Math.abs(dx);
}

function computeExpressionDiversity(face: FaceLandmarkerResult): number {
  // Entropy of active (>0.1) blendshape categories.
  const bs = face.faceBlendshapes?.[0]?.categories;
  if (!bs || bs.length === 0) return 0;
  const active = bs.filter((c) => c.score > 0.1);
  if (active.length === 0) return 0;
  const total = active.reduce((s, c) => s + c.score, 0);
  if (total <= 0) return 0;
  let entropy = 0;
  for (const c of active) {
    const p = c.score / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

function computeHandGestureFreq(hand: HandLandmarkerResult, tSec: number): number {
  const lm = hand.landmarks?.[0];
  if (!lm || lm.length === 0) {
    lastHand = null;
    return handTotalFrames > 0 ? handMovingFrames / handTotalFrames : 0;
  }
  const wrist = lm[0];
  handTotalFrames++;
  if (lastHand) {
    const dt = Math.max(1e-3, tSec - lastHand.t);
    const dx = wrist.x - lastHand.x;
    const dy = wrist.y - lastHand.y;
    const speed = Math.hypot(dx, dy) / dt;
    if (speed > HAND_VELOCITY_THRESHOLD) handMovingFrames++;
  }
  lastHand = { t: tSec, x: wrist.x, y: wrist.y };
  return handTotalFrames > 0 ? handMovingFrames / handTotalFrames : 0;
}

export function computeVisionFrame(
  tSec: number,
  face: FaceLandmarkerResult,
  pose: PoseLandmarkerResult,
  hand: HandLandmarkerResult,
): VisionFrame {
  const headPose = computeHeadPose(face);
  return {
    t: tSec,
    gaze_fixation_ratio: computeGazeFixation(face),
    posture_sway: computePostureSway(pose, tSec),
    shoulder_tilt: computeShoulderTilt(pose),
    expression_diversity: computeExpressionDiversity(face),
    hand_gesture_freq: computeHandGestureFreq(hand, tSec),
    head_pitch_deg: headPose?.pitchDeg ?? 0,
    head_yaw_deg: headPose?.yawDeg ?? 0,
    head_roll_deg: headPose?.rollDeg ?? 0,
    chin_on_hand: computeChinOnHand(face, pose),
    mouth_open: computeMouthOpen(face),
  };
}

export function resetSignalState(): void {
  shoulderBuf.length = 0;
  lastHand = null;
  handMovingFrames = 0;
  handTotalFrames = 0;
}
