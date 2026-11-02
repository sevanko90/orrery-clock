import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { PLANE_Y } from './layout';
import { loadOnce } from './textures';

export interface Quality {
  low: boolean;
  pixelRatio: number;
  shadows: boolean;
  bloom: boolean;
}

export function detectQuality(): Quality {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(innerWidth, innerHeight) < 700;
  const low = coarse || small;
  return {
    low,
    pixelRatio: Math.min(devicePixelRatio, low ? 1.5 : 2),
    shadows: !low,
    bloom: true,
  };
}

export const HOME_TARGET = new THREE.Vector3(0, PLANE_Y - 4.6, 0);
export const HOME_CAMERA = new THREE.Vector3(18, 23, 32);

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;

  constructor(
    private container: HTMLElement,
    readonly quality: Quality,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(quality.pixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.error('WebGL context lost');
    });

    this.scene.background = new THREE.Color(0x050407);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

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
    this.scene.add(fill);

    // Bloom renders into half-float targets; some browsers (notably Safari's
    // WebGL on certain GPUs) can't render to those, which would leave a blank
    // canvas. Only enable post-processing when it's supported.
    const ext = this.renderer.extensions;
    const canFloat = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    if (quality.bloom && canFloat && new URLSearchParams(location.search).get('bloom') !== '0') {
      this.composer = new EffectComposer(this.renderer);
      this.composer.setPixelRatio(quality.pixelRatio);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      const res = new THREE.Vector2(container.clientWidth, container.clientHeight).multiplyScalar(quality.low ? 0.5 : 1);
      this.bloom = new UnrealBloomPass(res, 0.32, 0.45, 3.2);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }

    this.addStarfield();
    addEventListener('resize', () => this.resize());
  }

  private addStarfield() {
    // Milky Way backdrop, tilted from equatorial to ecliptic coordinates.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(900, 64, 32),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, color: new THREE.Color(0.32, 0.32, 0.36) }),
    );
    sky.rotation.x = (-23.44 * Math.PI) / 180;
    sky.material.visible = false;
    this.scene.add(sky);
    loadOnce('stars', this.quality.low ? '256' : '2k')
      .then((t) => {
        sky.material.map = t;
        sky.material.visible = true;
        sky.material.needsUpdate = true;
      })
      .catch(() => undefined);

    // Sparkling foreground stars.
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
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false }),
    );
    this.scene.add(stars);
  }

  resize() {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
