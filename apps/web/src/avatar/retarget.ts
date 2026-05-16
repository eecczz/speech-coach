import * as THREE from 'three';
import { type VRM, VRMHumanBoneName, VRMExpressionPresetName } from '@pixiv/three-vrm';
import type {
  FaceLandmarkerResult,
  PoseLandmarkerResult,
  HandLandmarkerResult,
} from '@mediapipe/tasks-vision';

const IDENTITY_Q = new THREE.Quaternion();

// Rest world directions and rotations captured at avatar load.
// We use the bone's actual rest direction to its child rather than assuming a canonical
// local axis, which avoids 180° flips and bone-convention pitfalls.
interface BoneRest {
  restWorldDir: THREE.Vector3;
  initialWorldQ: THREE.Quaternion;
}
const boneRest = new Map<VRMHumanBoneName, BoneRest>();

const ARM_CHAIN: Array<{ bone: VRMHumanBoneName; child: VRMHumanBoneName }> = [
  { bone: VRMHumanBoneName.LeftUpperArm, child: VRMHumanBoneName.LeftLowerArm },
  { bone: VRMHumanBoneName.LeftLowerArm, child: VRMHumanBoneName.LeftHand },
  { bone: VRMHumanBoneName.LeftHand, child: VRMHumanBoneName.LeftMiddleProximal },
  { bone: VRMHumanBoneName.RightUpperArm, child: VRMHumanBoneName.RightLowerArm },
  { bone: VRMHumanBoneName.RightLowerArm, child: VRMHumanBoneName.RightHand },
  { bone: VRMHumanBoneName.RightHand, child: VRMHumanBoneName.RightMiddleProximal },
];

export function initRigForVRM(vrm: VRM): void {
  if (!vrm.humanoid) return;
  boneRest.clear();
  vrm.scene.updateMatrixWorld(true);
  for (const { bone, child } of ARM_CHAIN) {
    const b = vrm.humanoid.getNormalizedBoneNode(bone);
    const c = vrm.humanoid.getNormalizedBoneNode(child);
    if (!b || !c) continue;
    const bWorld = b.getWorldPosition(new THREE.Vector3());
    const cWorld = c.getWorldPosition(new THREE.Vector3());
    const dir = cWorld.sub(bWorld).normalize();
    const q = b.getWorldQuaternion(new THREE.Quaternion());
    boneRest.set(bone, { restWorldDir: dir, initialWorldQ: q });
  }
}

// MediaPipe FaceLandmarker → ARKit blendshape category names.
// These match VRM 1.0 standard mouth shapes by phonetic mapping.
const BLENDSHAPE_TO_VRM: Array<[string, VRMExpressionPresetName]> = [
  ['jawOpen', VRMExpressionPresetName.Aa],
  ['mouthFunnel', VRMExpressionPresetName.Oh],
  ['mouthPucker', VRMExpressionPresetName.Ou],
  ['mouthSmileLeft', VRMExpressionPresetName.Happy],
  ['mouthSmileRight', VRMExpressionPresetName.Happy],
  ['eyeBlinkLeft', VRMExpressionPresetName.BlinkLeft],
  ['eyeBlinkRight', VRMExpressionPresetName.BlinkRight],
];

export function applyFaceToVRM(vrm: VRM, face: FaceLandmarkerResult): void {
  if (!vrm.expressionManager) return;
  const blendshapes = face.faceBlendshapes?.[0]?.categories;
  if (blendshapes && blendshapes.length > 0) {
    const byName = new Map(blendshapes.map((c) => [c.categoryName, c.score]));
    for (const [mpName, vrmName] of BLENDSHAPE_TO_VRM) {
      const v = byName.get(mpName);
      if (v !== undefined) vrm.expressionManager.setValue(vrmName, v);
    }
    vrm.expressionManager.update();
  }

  // Head rotation from facial transformation matrix (column-major 4x4).
  // MediaPipe gives the face's pose in the camera's frame (X right, Y up, Z toward camera
  // by spec — the docs call this "metric/world" coords).
  // The avatar canvas mirrors the user (camera preview has scaleX(-1)), so the user's
  // right is the avatar's right. We negate Y/Z to convert from MediaPipe's image-frame
  // facing direction to the avatar's local head bone frame (it faces +Z toward camera).
  const matrix = face.facialTransformationMatrixes?.[0]?.data;
  if (matrix && matrix.length === 16 && vrm.humanoid) {
    const m = new THREE.Matrix4().fromArray(matrix);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const head = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head);
    if (head) {
      // Yaw (Y) and pitch (X) match user directly; roll (Z) is mirrored to align with
      // the scaleX(-1) preview convention.
      head.quaternion.slerp(new THREE.Quaternion(q.x, q.y, -q.z, q.w), 0.5);
    }
  }
}

// Applies face rotation + jaw to a non-VRM primitive group (head=children[0], body=children[1]).
// Lets us verify MediaPipe tracking when no .vrm asset is provided.
export function applyFaceToFallback(group: THREE.Object3D, face: FaceLandmarkerResult): void {
  const head = group.children[0];
  if (!head) return;

  const matrix = face.facialTransformationMatrixes?.[0]?.data;
  if (matrix && matrix.length === 16) {
    const m = new THREE.Matrix4().fromArray(matrix);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    head.quaternion.set(q.x, -q.y, -q.z, q.w);
  }

  const jaw = face.faceBlendshapes?.[0]?.categories.find((c) => c.categoryName === 'jawOpen')?.score ?? 0;
  head.scale.setScalar(1 + jaw * 0.4);
}

// "차렷" stance: arms straight down at sides. Tiny outward bias (~3°) only to avoid
// clipping the torso mesh; visually it reads as fully vertical.
const A_POSE_UPPER_TARGETS = new Map<VRMHumanBoneName, THREE.Vector3>([
  [VRMHumanBoneName.LeftUpperArm, new THREE.Vector3(0.05, -0.999, 0).normalize()],
  [VRMHumanBoneName.RightUpperArm, new THREE.Vector3(-0.05, -0.999, 0).normalize()],
]);

// Visibility threshold: MediaPipe assigns 0..1 confidence per landmark. Below this,
// the model is mostly hallucinating from upper-body context — skip retargeting that joint.
const VISIBILITY_MIN = 0.5;

// Aligns a bone so its rest world direction (saved at avatar init) rotates to
// match `targetWorldDir`. Convention-independent — works regardless of bone's local axes.
function setBoneWorldDirection(
  bone: THREE.Object3D,
  boneName: VRMHumanBoneName,
  targetWorldDir: THREE.Vector3,
  slerp = 0.35,
): void {
  if (!bone.parent) return;
  const rest = boneRest.get(boneName);
  if (!rest) return;

  const deltaWorldQ = new THREE.Quaternion().setFromUnitVectors(rest.restWorldDir, targetWorldDir);
  const newWorldQ = deltaWorldQ.multiply(rest.initialWorldQ.clone());

  const parentInvWorldQ = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  const newLocalQ = parentInvWorldQ.multiply(newWorldQ);

  bone.quaternion.slerp(newLocalQ, slerp);
}

// Relax an upper arm toward A-pose at the shoulder.
function relaxUpperToAPose(bone: THREE.Object3D | null, boneName: VRMHumanBoneName, slerp = 0.08): void {
  if (!bone) return;
  const target = A_POSE_UPPER_TARGETS.get(boneName);
  if (!target) return;
  setBoneWorldDirection(bone, boneName, target, slerp);
}

// Relax a lower arm to identity local rotation — it continues straight from its parent
// (upper arm), no elbow bend.
function relaxLowerToStraight(bone: THREE.Object3D | null, slerp = 0.08): void {
  if (!bone) return;
  bone.quaternion.slerp(IDENTITY_Q, slerp);
}

export function applyPoseToVRM(vrm: VRM, pose: PoseLandmarkerResult): void {
  if (!vrm.humanoid) return;
  const lm = pose.landmarks?.[0]; // image-space, has reliable .visibility

  // --- Spine tilt from shoulder line (gentle, image-space y so unit-agnostic) ---
  if (lm) {
    const lsImg = lm[11];
    const rsImg = lm[12];
    const lsVis = lsImg?.visibility ?? 0;
    const rsVis = rsImg?.visibility ?? 0;
    if (lsImg && rsImg && lsVis >= VISIBILITY_MIN && rsVis >= VISIBILITY_MIN) {
      const dx = rsImg.x - lsImg.x;
      const dy = rsImg.y - lsImg.y;
      if (Math.abs(dx) >= 0.05) {
        const tilt = Math.atan2(dy, Math.abs(dx));
        const clamped = Math.max(-0.4, Math.min(0.4, tilt));
        const spine = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Spine);
        if (spine) {
          spine.rotation.z = spine.rotation.z * 0.7 + -clamped * 0.3 * 0.3;
        }
      }
    }
  }

  // --- Arms LOCKED to A-pose ---
  // Per user decision (2026-05-16): arm tracking too noisy; lock to A-pose so the avatar
  // looks consistent regardless of what MediaPipe sees. Head/spine/face/fingers continue.
  lockArmsToAPose(vrm);
}

function lockArmsToAPose(vrm: VRM): void {
  if (!vrm.humanoid) return;
  for (const upperName of [VRMHumanBoneName.LeftUpperArm, VRMHumanBoneName.RightUpperArm]) {
    const upper = vrm.humanoid.getNormalizedBoneNode(upperName);
    if (upper) relaxUpperToAPose(upper, upperName, 0.5);
  }
  for (const lowerName of [VRMHumanBoneName.LeftLowerArm, VRMHumanBoneName.RightLowerArm]) {
    const lower = vrm.humanoid.getNormalizedBoneNode(lowerName);
    if (lower) relaxLowerToStraight(lower, 0.5);
  }
  // Also relax hand bones to identity so wrist orientation doesn't drift.
  for (const handName of [VRMHumanBoneName.LeftHand, VRMHumanBoneName.RightHand]) {
    const hand = vrm.humanoid.getNormalizedBoneNode(handName);
    if (hand) hand.quaternion.slerp(IDENTITY_Q, 0.5);
  }
}

// === Fingers ===
//
// MediaPipe HandLandmarker outputs 21 landmarks per hand. We compute joint flex angles
// (angle between successive segments) and apply them to VRM finger bones as rotation
// around the bone's bending axis.
//
// Landmark indices per finger:
//   thumb:  1 (CMC) → 2 (MCP) → 3 (IP) → 4 (TIP)
//   index:  5 (MCP) → 6 (PIP) → 7 (DIP) → 8 (TIP)
//   middle: 9 → 10 → 11 → 12
//   ring:   13 → 14 → 15 → 16
//   little: 17 → 18 → 19 → 20
// VRM 1.0 finger bone naming uses {Side}{Finger}{Joint} where Joint is one of
// Metacarpal|Proximal|Distal for thumb, Proximal|Intermediate|Distal for others.

interface FingerSpec {
  // Landmark indices: a → b → c → d  (a is "base / palm-ward", d is fingertip)
  lm: [number, number, number, number];
  // VRM bone names for the 3 joints, in order (rotation at a, b, c).
  // For thumb: Metacarpal, Proximal, Distal.
  // For others: Proximal, Intermediate, Distal.
  leftBones: [VRMHumanBoneName, VRMHumanBoneName, VRMHumanBoneName];
  rightBones: [VRMHumanBoneName, VRMHumanBoneName, VRMHumanBoneName];
}

const FINGERS: FingerSpec[] = [
  {
    lm: [1, 2, 3, 4],
    leftBones: [
      VRMHumanBoneName.LeftThumbMetacarpal,
      VRMHumanBoneName.LeftThumbProximal,
      VRMHumanBoneName.LeftThumbDistal,
    ],
    rightBones: [
      VRMHumanBoneName.RightThumbMetacarpal,
      VRMHumanBoneName.RightThumbProximal,
      VRMHumanBoneName.RightThumbDistal,
    ],
  },
  {
    lm: [5, 6, 7, 8],
    leftBones: [
      VRMHumanBoneName.LeftIndexProximal,
      VRMHumanBoneName.LeftIndexIntermediate,
      VRMHumanBoneName.LeftIndexDistal,
    ],
    rightBones: [
      VRMHumanBoneName.RightIndexProximal,
      VRMHumanBoneName.RightIndexIntermediate,
      VRMHumanBoneName.RightIndexDistal,
    ],
  },
  {
    lm: [9, 10, 11, 12],
    leftBones: [
      VRMHumanBoneName.LeftMiddleProximal,
      VRMHumanBoneName.LeftMiddleIntermediate,
      VRMHumanBoneName.LeftMiddleDistal,
    ],
    rightBones: [
      VRMHumanBoneName.RightMiddleProximal,
      VRMHumanBoneName.RightMiddleIntermediate,
      VRMHumanBoneName.RightMiddleDistal,
    ],
  },
  {
    lm: [13, 14, 15, 16],
    leftBones: [
      VRMHumanBoneName.LeftRingProximal,
      VRMHumanBoneName.LeftRingIntermediate,
      VRMHumanBoneName.LeftRingDistal,
    ],
    rightBones: [
      VRMHumanBoneName.RightRingProximal,
      VRMHumanBoneName.RightRingIntermediate,
      VRMHumanBoneName.RightRingDistal,
    ],
  },
  {
    lm: [17, 18, 19, 20],
    leftBones: [
      VRMHumanBoneName.LeftLittleProximal,
      VRMHumanBoneName.LeftLittleIntermediate,
      VRMHumanBoneName.LeftLittleDistal,
    ],
    rightBones: [
      VRMHumanBoneName.RightLittleProximal,
      VRMHumanBoneName.RightLittleIntermediate,
      VRMHumanBoneName.RightLittleDistal,
    ],
  },
];

// Finger curl smoothing — fingers jitter a lot from per-frame noise.
const fingerAngleSmoothed = new Map<VRMHumanBoneName, number>();
const FINGER_SMOOTH_ALPHA = 0.4;

function smoothAngle(boneName: VRMHumanBoneName, target: number): number {
  const prev = fingerAngleSmoothed.get(boneName);
  if (prev === undefined) {
    fingerAngleSmoothed.set(boneName, target);
    return target;
  }
  const next = prev * (1 - FINGER_SMOOTH_ALPHA) + target * FINGER_SMOOTH_ALPHA;
  fingerAngleSmoothed.set(boneName, next);
  return next;
}

export function applyHandsToVRM(vrm: VRM, handResult: HandLandmarkerResult): void {
  if (!vrm.humanoid) return;
  const lists = handResult.landmarks ?? [];
  const handednesses = handResult.handednesses ?? [];

  for (let h = 0; h < lists.length; h++) {
    const lm = lists[h];
    if (!lm || lm.length < 21) continue;

    // MediaPipe HandLandmarker handedness assumes a mirrored selfie input.
    // Our MediaStream is NOT mirrored, so MP's "Left" is actually the subject's
    // anatomical RIGHT. We swap accordingly.
    const handedness = handednesses[h]?.[0]?.categoryName;
    const side: 'left' | 'right' = handedness === 'Left' ? 'right' : 'left';

    applyFingersForHand(vrm, lm, side);
  }
}

function applyFingersForHand(
  vrm: VRM,
  lm: Array<{ x: number; y: number; z: number }>,
  side: 'left' | 'right',
): void {
  if (!vrm.humanoid) return;

  // Curl direction sign — empirical: most VRM normalized finger bones bend with a
  // negative rotation.z for the left hand and positive for the right. Adjust if a
  // specific VRM model bends backwards.
  const curlSign = side === 'left' ? -1 : 1;

  for (const f of FINGERS) {
    const [a, b, c, d] = f.lm;
    const bones = side === 'left' ? f.leftBones : f.rightBones;

    // 3D vectors in MediaPipe hand-local frame.
    const va = new THREE.Vector3(lm[a].x, lm[a].y, lm[a].z);
    const vb = new THREE.Vector3(lm[b].x, lm[b].y, lm[b].z);
    const vc = new THREE.Vector3(lm[c].x, lm[c].y, lm[c].z);
    const vd = new THREE.Vector3(lm[d].x, lm[d].y, lm[d].z);

    // Joint flex = angle between successive bone segments.
    // angleA: at joint a — between (palm baseline) and (a→b). We approximate the palm
    //   baseline as (a−wrist=lm[0]) direction; landmark 0 is wrist.
    const wrist = new THREE.Vector3(lm[0].x, lm[0].y, lm[0].z);
    const palmBaseline = va.clone().sub(wrist);
    const segAB = vb.clone().sub(va);
    const segBC = vc.clone().sub(vb);
    const segCD = vd.clone().sub(vc);

    if (palmBaseline.lengthSq() < 1e-6 || segAB.lengthSq() < 1e-6) continue;
    if (segBC.lengthSq() < 1e-6 || segCD.lengthSq() < 1e-6) continue;

    const angleA = palmBaseline.angleTo(segAB); // rotation at proximal-most joint
    const angleB = segAB.angleTo(segBC);        // middle joint
    const angleC = segBC.angleTo(segCD);        // distal joint

    applyFingerJoint(vrm, bones[0], curlSign * angleA);
    applyFingerJoint(vrm, bones[1], curlSign * angleB);
    applyFingerJoint(vrm, bones[2], curlSign * angleC);
  }
}

function applyFingerJoint(vrm: VRM, boneName: VRMHumanBoneName, rawAngle: number): void {
  if (!vrm.humanoid) return;
  const bone = vrm.humanoid.getNormalizedBoneNode(boneName);
  if (!bone) return;

  // Clamp to physically reasonable curl (~ -100° .. +100°).
  const clamped = Math.max(-1.75, Math.min(1.75, rawAngle));
  const smoothed = smoothAngle(boneName, clamped);

  // VRM normalized finger bones bend around their local Z axis. (Most VRM models follow
  // this convention; adjust to .x or .y if a particular model bends along a different axis.)
  bone.rotation.z = smoothed;
}
