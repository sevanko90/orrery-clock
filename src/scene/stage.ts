import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { pass, instancedBufferAttribute } from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { PLANE_Y } from './layout';
import { loadOnce } from './textures';

export interface Quality {
  low: boolean;
  pixelRatio: number;
  shadows: boolean;
  bloom: boolean;
  /** A standalone VR headset's browser (phone-class GPU): lighter builds of the heavy scenes. */
  headset: boolean;
}

export function detectQuality(): Quality {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(innerWidth, innerHeight) < 700;
  const low = coarse || small;
  // Standalone headsets: a phone-class GPU drawing two eyes. The Sun's
  // six-sided shadow map is the first thing to go.
  // (?headset=1 gives a desktop browser the same profile, for A/B checks.)
  const headset = /OculusBrowser|Quest|Pico/i.test(navigator.userAgent) || new URLSearchParams(location.search).get('headset') === '1';
  return {
    low,
    pixelRatio: Math.min(devicePixelRatio, low ? 1.5 : 2),
    shadows: !low && !headset,
    bloom: true,
    headset,
  };
}

export const HOME_TARGET = new THREE.Vector3(0, PLANE_Y - 4.6, 0);
export const HOME_CAMERA = new THREE.Vector3(18, 23, 32);

export class Stage {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Scene pass + bloom + tone mapping; null when bloom is off. */
  private pipeline: THREE.RenderPipeline | null = null;
  /** The bloom effect (for tuning strength, radius and threshold). */
  bloomNode: ReturnType<typeof bloom> | null = null;
  /** The star sphere and the sparkling stars (VR keeps them inside its far plane). */
  readonly sky: THREE.Object3D[] = [];
  /** Whether VR frames go through the bloom pipeline (only possible without multiview). */
  xrBloom = false;

  constructor(
    private container: HTMLElement,
    readonly quality: Quality,
  ) {
    // WebGPU where the browser has it; WebGL 2 otherwise. Headsets always take
    // WebGL 2: it's the backend three can drive VR with, drawing both eyes in
    // one pass (multiview).
    this.renderer = new THREE.WebGPURenderer({
      // (?msaa=0 turns multisampling off, to measure its cost on the headset.)
      antialias: new URLSearchParams(location.search).get('msaa') !== '0',
      powerPreference: 'high-performance',
      // (?webgl=1 forces it on the desktop, to check what the headset gets.)
      forceWebGL: quality.headset || new URLSearchParams(location.search).get('webgl') === '1',
      multiview: true,
    });
    this.renderer.setPixelRatio(quality.pixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x050407);

    this.camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.1, 2000);
    this.camera.position.copy(HOME_CAMERA);
    if (container.clientWidth < container.clientHeight) this.camera.position.multiplyScalar(1.5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(HOME_TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 110;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.25;
    this.controls.zoomToCursor = true;
    this.controls.update();

    // A soft warm fill so the woodwork reads even on the Sun's far side.
    const fill = new THREE.HemisphereLight(0xffe2b8, 0x1a1008, 0.35);
    fill.name = 'fill';
    this.scene.add(fill);

    this.addStarfield();
    addEventListener('resize', () => this.resize());
  }

  /** Bring up the GPU backend, the room lighting and the bloom pipeline. Await before the first frame. */
  async init() {
    await this.renderer.init();

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    if (this.quality.bloom && new URLSearchParams(location.search).get('bloom') !== '0') {
      const scenePass = pass(this.scene, this.camera);
      const colour = scenePass.getTextureNode('output');
      const glow = bloom(colour, 0.32, 0.45, 3.2);
      if (this.quality.low) glow.setResolutionScale(0.5);
      this.bloomNode = glow;
      this.pipeline = new THREE.RenderPipeline(this.renderer);
      this.pipeline.outputNode = colour.add(glow);
    }
  }

  /** Which backend is drawing: 'WebGPU' or 'WebGL 2'. */
  get backend() {
    return (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
  }

  private addStarfield() {
    // Milky Way backdrop, tilted from equatorial to ecliptic coordinates.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(900, 64, 32),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, color: new THREE.Color(0.32, 0.32, 0.36) }),
    );
    sky.rotation.x = (-23.44 * Math.PI) / 180;
    sky.material.visible = false;
    sky.name = 'sky';
    this.scene.add(sky);
    this.sky.push(sky);
    loadOnce('stars', this.quality.low ? '256' : '2k')
      .then((t) => {
        sky.material.map = t;
        sky.material.visible = true;
        sky.material.needsUpdate = true;
      })
      .catch(() => undefined);

    // Sparkling foreground stars: fixed-size points, drawn as one instanced sprite.
    const n = this.quality.low ? 1200 : 3500;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const v = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      v.randomDirection().multiplyScalar(600 + Math.random() * 200);
      pos.set([v.x, v.y, v.z], i * 3);
      c.setHSL(0.08 + Math.random() * 0.55, 0.35, 0.55 + Math.random() * 0.45);
      const b = Math.pow(Math.random(), 3) * 1.2 + 0.25;
      col.set([c.r * b, c.g * b, c.b * b], i * 3);
    }
    const mat = new THREE.PointsNodeMaterial({ sizeAttenuation: false, depthWrite: false, transparent: true });
    mat.alphaToCoverage = false;
    mat.positionNode = instancedBufferAttribute(new THREE.InstancedBufferAttribute(pos, 3)) as unknown as THREE.Node<'vec3'>;
    mat.colorNode = instancedBufferAttribute(new THREE.InstancedBufferAttribute(col, 3)) as unknown as THREE.Node<'vec3'>;
    mat.sizeNode = THREE.TSL.float(1.6);
    const stars = new THREE.Sprite(mat);
    stars.count = n;
    stars.frustumCulled = false;
    stars.name = 'stars';
    this.scene.add(stars);
    this.sky.push(stars);
  }

  resize() {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** Is VR drawing both eyes in one pass? */
  get multiview() {
    return this.renderer.xr.isPresenting && (this.renderer.xr as unknown as { useMultiview(): boolean }).useMultiview();
  }

  /**
   * Draw a frame; in VR, from `xrCamera`, the player's camera inside its rig.
   *
   * VR goes straight to the headset unless bloom is asked for. The bloom
   * pipeline's scene pass can't render multiview (both eyes come out as
   * garbage), so bloom in VR needs multiview off; and the pass takes the
   * headset camera without its parent rig, so its pose update is pointed back
   * at the rigged camera here.
   */
  render(xrCamera?: THREE.Camera) {
    const xr = this.renderer.xr;
    if (!xr.isPresenting || !xrCamera) {
      if (this.pipeline) this.pipeline.render();
      else this.renderer.render(this.scene, this.camera);
      return;
    }
    if (!this.pipeline || !this.xrBloom || this.multiview) {
      this.renderer.render(this.scene, xrCamera);
      return;
    }
    const headset = xr.getCamera();
    const update = xr.updateCamera;
    xr.updateCamera = (cam: THREE.PerspectiveCamera) => update.call(xr, cam === (headset as unknown) ? (xrCamera as THREE.PerspectiveCamera) : cam);
    try {
      this.pipeline.render();
    } finally {
      xr.updateCamera = update;
    }
  }
}
