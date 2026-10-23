// three.js preview of the exact kn5 model that gets exported. AC space
// (X east, Y up, Z south) is right-handed with Y up, the same as three.js,
// so positions, normals and winding go straight in.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Kn5Model, Kn5Node, Kn5Texture } from "../core/kn5";
import type { RoadPlan } from "../core/road";
import { toAc } from "../core/mesh";

export interface PreviewScene {
  /** Renders a frame from behind the start line and returns PNG bytes. */
  snapshot(width: number, height: number): Promise<Uint8Array>;
  open(): void;
  close(): void;
  toggleDrive(): void;
  /** Point the camera (AC coordinates) and render one frame; for screenshots. */
  view(eye: [number, number, number], target: [number, number, number]): void;
  dispose(): void;
}

type RawImage = { rgba: Uint8Array; width: number; height: number };

async function textureFrom(tex: Kn5Texture | undefined, canvas: OffscreenCanvas | undefined, raw?: RawImage): Promise<THREE.Texture | null> {
  let t: THREE.Texture | null = null;
  if (canvas) t = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
  else if (raw) {
    t = new THREE.DataTexture(raw.rgba, raw.width, raw.height, THREE.RGBAFormat);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
  }
  else if (tex && /\.png$/i.test(tex.name)) {
    const bmp = await createImageBitmap(new Blob([tex.data as BlobPart], { type: "image/png" }));
    t = new THREE.Texture(bmp as unknown as HTMLImageElement);
  }
  if (!t) return null;
  t.flipY = false; // kn5 UVs put v = 0 at the top of the image
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export async function createPreview(
  canvas: HTMLCanvasElement,
  model: Kn5Model,
  plan: RoadPlan,
  chunkImages: Map<string, OffscreenCanvas>,
  rawTextures: Record<string, RawImage> = {},
): Promise<PreviewScene> {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb7d0);
  scene.fog = new THREE.Fog(0x9fb7d0, 600, 4000);
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x4a4632, 1.6));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.8);
  sun.position.set(300, 600, 200);
  scene.add(sun);

  const textures = new Map(model.textures.map((t) => [t.name, t]));
  const materials = new Map<string, THREE.Material>();
  for (const m of model.materials) {
    const texName = m.textures.txDiffuse;
    const chunkKey = /^(terrain|backdrop)_/.test(m.name) ? m.name.slice(m.name.indexOf("_") + 1) : undefined;
    const map = await textureFrom(textures.get(texName), chunkKey ? chunkImages.get(chunkKey) : undefined, rawTextures[texName]);
    materials.set(m.name, new THREE.MeshLambertMaterial({
      map,
      color: map ? 0xffffff : 0x6b7a4a,
      // Foliage sprites: cut out by alpha, like ksPerPixelAT in game.
      ...(m.alphaTested ? { alphaTest: 0.5 } : {}),
    }));
  }

  const meshes: THREE.Mesh[] = [];
  const add = (n: Kn5Node) => {
    if (n.kind === "node") {
      n.children.forEach(add);
      return;
    }
    if (n.renderable === false) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(n.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(n.normals, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(n.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(n.indices, 1));
    const mesh = new THREE.Mesh(g, materials.get(n.material));
    meshes.push(mesh);
    scene.add(mesh);
  };
  add(model.root);

  // Start and finish markers (hidden in the Content Manager snapshot).
  const markers: THREE.Mesh[] = [];
  const marker = (i: number, color: number) => {
    const s = plan.samples[i];
    const p = toAc(s.pos[0], s.pos[1], s.h + 2);
    const m = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), new THREE.MeshBasicMaterial({ color }));
    m.position.set(...p);
    markers.push(m);
    scene.add(m);
  };
  marker(0, 0x4fd486);
  if (!plan.closed) marker(plan.samples.length - 1, 0xef5b5b);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 8000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;

  // Highest surface under a point (AC x, z), so the camera never starts inside a building or a hill.
  const ray = new THREE.Raycaster();
  const topAt = (x: number, z: number, from: number): number => {
    ray.set(new THREE.Vector3(x, from + 500, z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? hit.point.y : -Infinity;
  };
  const startView = () => {
    // Above the treetops behind the start, looking ~200 m up the road.
    const s = plan.samples[0], ahead = plan.samples[Math.min(plan.samples.length - 1, 100)];
    const eye = toAc(s.pos[0] - s.tan[0] * 40, s.pos[1] - s.tan[1] * 40, s.h + 35);
    eye[1] = Math.max(eye[1], topAt(eye[0], eye[2], eye[1]) + 10);
    camera.position.set(...eye);
    controls.target.set(...toAc(ahead.pos[0], ahead.pos[1], ahead.h));
    controls.update();
  };
  startView();

  const resize = () => {
    const w = canvas.clientWidth || 1024, h = canvas.clientHeight || 576;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  let running = false;
  let driving = false;
  let driveS = 0;
  let last = performance.now();
  const loop = (now: number) => {
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (driving) {
      driveS += dt * 25;
      const n = plan.samples.length;
      const idx = Math.floor(driveS / 2) % n;
      const s = plan.samples[idx], ahead = plan.samples[Math.min(n - 1, idx + 12)];
      camera.position.set(...toAc(s.pos[0], s.pos[1], s.h + 1.3));
      controls.target.set(...toAc(ahead.pos[0], ahead.pos[1], ahead.h + 1));
      if (!plan.closed && idx >= n - 13) driveS = 0;
    }
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  window.addEventListener("resize", resize);

  return {
    async snapshot(width, height) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      startView();
      markers.forEach((m) => (m.visible = false));
      renderer.render(scene, camera);
      markers.forEach((m) => (m.visible = true));
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/png"));
      return new Uint8Array(await blob.arrayBuffer());
    },
    open() {
      running = true;
      resize();
      startView();
      last = performance.now();
      requestAnimationFrame(loop);
    },
    close() {
      running = false;
      driving = false;
    },
    view(eye, target) {
      driving = false;
      camera.position.set(...eye);
      controls.target.set(...target);
      controls.update();
      renderer.render(scene, camera);
    },
    toggleDrive() {
      driving = !driving;
      driveS = 0;
      if (!driving) startView();
    },
    dispose() {
      running = false;
      window.removeEventListener("resize", resize);
      controls.dispose();
      for (const m of meshes) m.geometry.dispose();
      for (const m of materials.values()) {
        (m as THREE.MeshLambertMaterial).map?.dispose();
        m.dispose();
      }
      renderer.dispose();
    },
  };
}
