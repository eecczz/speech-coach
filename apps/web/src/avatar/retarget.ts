import * as THREE from 'three';
import { type VRM, VRMHumanBoneName, VRMExpressionPresetName } from '@pixiv/three-vrm';
import type { FaceLandmarkerResult, PoseLandmarkerResult } from '@mediapipe/tasks-vision';

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

  // Head rotation from facial transformation matrix (column-major 4x4)
  const matrix = face.facialTransformationMatrixes?.[0]?.data;
  if (matrix && matrix.length === 16 && vrm.humanoid) {
    const m = new THREE.Matrix4().fromArray(matrix);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    // MediaPipe coordinates: X right, Y down, Z forward.
    // VRM: X right, Y up, Z back. Flip Y/Z.
    const head = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head);
    if (head) {
      head.quaternion.copy(new THREE.Quaternion(q.x, -q.y, -q.z, q.w));
    }
  }
}

export function applyPoseToVRM(vrm: VRM, pose: PoseLandmarkerResult): void {
  if (!vrm.humanoid) return;
  const lm = pose.landmarks?.[0];
  if (!lm || lm.length < 25) return;

  // MediaPipe pose: 11=left shoulder, 12=right shoulder (image-mirrored).
  // Compute shoulder line tilt to drive spine roll. Subtle to avoid jitter.
  const ls = lm[11];
  const rs = lm[12];
  if (!ls || !rs) return;
  const dx = rs.x - ls.x;
  const dy = rs.y - ls.y;
  const tiltRad = Math.atan2(dy, dx);
  const spine = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Spine);
  if (spine) {
    spine.rotation.z = -tiltRad * 0.5; // dampened
  }
}
