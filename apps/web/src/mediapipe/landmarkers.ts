import {
  FilesetResolver,
  FaceLandmarker,
  PoseLandmarker,
  type FaceLandmarkerResult,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const POSE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export interface Landmarkers {
  face: FaceLandmarker;
  pose: PoseLandmarker;
}

export async function createLandmarkers(): Promise<Landmarkers> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const [face, pose] = await Promise.all([
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      runningMode: 'VIDEO',
      numFaces: 1,
    }),
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
    }),
  ]);
  return { face, pose };
}

export interface FrameResult {
  face: FaceLandmarkerResult;
  pose: PoseLandmarkerResult;
}

export function detect(landmarkers: Landmarkers, video: HTMLVideoElement, tMs: number): FrameResult {
  const face = landmarkers.face.detectForVideo(video, tMs);
  const pose = landmarkers.pose.detectForVideo(video, tMs);
  return { face, pose };
}
