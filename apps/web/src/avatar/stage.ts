import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';

export interface AvatarStage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  vrm: VRM | null;
  fallback: THREE.Object3D | null;
  render: (deltaSec: number) => void;
}

export async function createAvatarStage(canvas: HTMLCanvasElement, vrmUrl: string): Promise<AvatarStage> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101820);

  const camera = new THREE.PerspectiveCamera(30, canvas.width / canvas.height, 0.1, 20);
  camera.position.set(0, 1.35, 1.6);
  camera.lookAt(0, 1.3, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(1, 2, 1);
  scene.add(ambient, dir);

  let vrm: VRM | null = null;
  let fallback: THREE.Object3D | null = null;

  try {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(vrmUrl);
    vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    vrm.scene.rotation.y = Math.PI; // VRM faces away by default; turn toward camera
    scene.add(vrm.scene);
  } catch (err) {
    console.warn('[avatar] VRM load failed, using primitive fallback:', err);
    const group = new THREE.Group();
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 32, 32),
      new THREE.MeshStandardMaterial({ color: 0xffd8b8 }),
    );
    head.position.set(0, 1.5, 0);
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.6, 0.18),
      new THREE.MeshStandardMaterial({ color: 0x3a6ea5 }),
    );
    body.position.set(0, 1.05, 0);
    group.add(head, body);
    fallback = group;
    scene.add(group);
  }

  function render(deltaSec: number) {
    if (vrm) vrm.update(deltaSec);
    renderer.render(scene, camera);
  }

  return { scene, camera, renderer, vrm, fallback, render };
}
