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
  // Haze the colour of the horizon, so distant hills fade into the sky.
  scene.background = new THREE.Color(0xc2d3e3);
  scene.fog = new THREE.Fog(0xc2d3e3, 700, 4500);
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x4a4632, 1.6));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.8);
  sun.position.set(300, 600, 200);
  scene.add(sun);
  const sky = skyDome(sun.position.clone().normalize());
  scene.add(sky);
  /** Renders a frame with the sky centred on the camera. */
  const render = () => {
    sky.position.copy(camera.position);
    renderer.render(scene, camera);
  };

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
    render();
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
      render();
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
      render();
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

/**
 * A sky to drive under: blue overhead fading to a pale hazy horizon, a glow
 * round the sun, fair-weather cumulus lit from the sun's side with greyer
 * bases, and high wisps of cirrus. Clouds sit on a plane, so they bunch up
 * toward the horizon as real ones do. Drawn first, behind everything.
 */
function skyDome(sunDir: THREE.Vector3): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: { sunDir: { value: sunDir } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 sunDir;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 6; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
        return v;
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 zenith = vec3(0.23, 0.45, 0.78), horizon = vec3(0.76, 0.83, 0.89);
        vec3 col = mix(horizon, zenith, pow(h, 0.5));
        if (d.y < 0.0) col = mix(horizon, vec3(0.6, 0.64, 0.64), min(1.0, -d.y * 4.0));
        float sd = max(dot(d, sunDir), 0.0);
        col += vec3(1.0, 0.92, 0.75) * (pow(sd, 800.0) * 3.0 + pow(sd, 10.0) * 0.16);
        if (d.y > 0.0) {
          vec2 uv = d.xz / (d.y + 0.06) * 0.9;
          float fade = smoothstep(0.0, 0.18, d.y);
          // Cirrus: streaks high up.
          float ci = fbm(vec2(uv.x * 0.35 + 20.0, uv.y * 2.5));
          col = mix(col, vec3(0.97, 0.98, 1.0), smoothstep(0.58, 0.85, ci) * 0.3 * fade);
          // Cumulus: puffs, brighter on the side toward the sun, grey underneath.
          float n = fbm(uv + vec2(3.1, 7.4));
          float cover = smoothstep(0.47, 0.66, n);
          float toward = fbm(uv + vec2(3.1, 7.4) + sunDir.xz * 0.12);
          float lit = clamp(0.82 + (n - toward) * 3.5, 0.55, 1.08);
          vec3 cloud = vec3(1.0, 0.99, 0.97) * lit;
          cloud = mix(cloud, vec3(0.6, 0.64, 0.7), smoothstep(0.7, 0.9, n) * 0.45);
          cloud = mix(cloud, horizon, 1.0 - fade);
          col = mix(col, cloud, cover * smoothstep(0.0, 0.06, d.y));
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(7000, 48, 24), material);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}
