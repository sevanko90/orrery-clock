import * as THREE from 'three/webgpu';

/**
 * Engraved labels on the controllers: a small brass plate per control,
 * standing just off the controller with a fine leader line to the button or
 * stick it names. They fade in when a controller is raised and turned to be
 * read (near the face, top toward the eyes) and fade away otherwise, so they
 * teach the controls without cluttering the view. They also show for the
 * first half minute in VR, so the player finds out they're there.
 *
 * Anchored to the controller model's touch points (each profile's model names
 * one per component), so they sit on the real buttons of whatever controller
 * the headset reports.
 */

type Hand = 'left' | 'right';

/** What each control does, by WebXR input-profile component id. */
const TEXT: Record<Hand, Record<string, string[]>> = {
  left: {
    'xr-standard-thumbstick': ['Walk / fly'],
    'xr-standard-trigger': ['Jetpack'],
    'x-button': ['Time panel'],
    'y-button': ['Scene panel'],
    ...(import.meta.env.DEV ? { 'xr-standard-squeeze': ['Marker'] } : {}),
  },
  right: {
    'xr-standard-thumbstick': ['Turn · rise / sink', 'click: now'],
    'xr-standard-trigger': ['Select'],
    'xr-standard-squeeze': ['Hold + stick: scale'],
    'a-button': ['Faster'],
    'b-button': ['Slower'],
  },
};

/** Plate height (metres); its width follows the text. */
const PLATE_H = 0.011;
/** How far a plate stands off its control (metres). */
const STAND_OFF = 0.035;

interface Component {
  touchPointNode?: THREE.Object3D;
}
interface ModelLike extends THREE.Object3D {
  motionController?: { components: Record<string, Component> } | null;
}

interface Built {
  model: ModelLike;
  hand: Hand;
  group: THREE.Group;
  materials: (THREE.MeshBasicMaterial | THREE.LineBasicMaterial)[];
}

export class ControllerLabels {
  private built: Built[] = [];
  /** Telemetry: per hand, what was found and why the labels show or not. */
  readonly state: Record<string, unknown> = {};
  private opacity = new Map<THREE.Object3D, number>();
  /** Seconds left of showing regardless (on arrival, so the player learns they exist). */
  private showing = 0;

  /** Show the labels for `seconds` whatever the controllers' pose. */
  showFor(seconds: number) {
    this.showing = seconds;
  }
  private tmp = new THREE.Vector3();
  private up = new THREE.Vector3();

  /**
   * Per frame. `controllers`: each controller's grip space, the model loaded
   * into it and its handedness (null until known). `head`: the eyes (world);
   * `metresPerUnit`: the world scale.
   */
  update(dt: number, controllers: { grip: THREE.Object3D; model: ModelLike; hand: Hand | null }[], head: THREE.Vector3, metresPerUnit: number) {
    this.showing = Math.max(0, this.showing - dt);
    for (const c of controllers) {
      let b = this.built.find((x) => x.model === c.model);
      if (b && b.hand !== c.hand) {
        b.group.removeFromParent();
        this.built.splice(this.built.indexOf(b), 1);
        b = undefined;
      }
      if (!b && c.hand && c.model.motionController) b = this.build(c.model, c.hand) ?? undefined;
      if (c.hand) {
        const comps = c.model.motionController?.components;
        this.state[c.hand] = {
          controller: !!c.model.motionController,
          components: comps ? Object.keys(comps) : null,
          touchPoints: comps ? Object.entries(comps).filter(([, v]) => v.touchPointNode).map(([k]) => k) : null,
          built: !!b,
        };
      }
      if (!b) continue;
      // Shown when the controller is near the face and its top turned toward the eyes.
      const at = c.grip.getWorldPosition(this.tmp);
      const toEye = head.clone().sub(at);
      const dist = toEye.length() * metresPerUnit;
      this.up.set(0, 1, 0).transformDirection(c.grip.matrixWorld);
      const facing = toEye.normalize().dot(this.up);
      const want = this.showing > 0 || (dist < 0.6 && facing > 0.2) ? 1 : 0;
      Object.assign(this.state[b.hand] as object, { dist: +dist.toFixed(2), facing: +facing.toFixed(2), opacity: +(this.opacity.get(b.group) ?? 0).toFixed(2) });
      const o0 = this.opacity.get(b.group) ?? 0;
      const o = o0 + THREE.MathUtils.clamp(want - o0, -dt * 4, dt * 4);
      this.opacity.set(b.group, o);
      b.group.visible = o > 0.01;
      for (const m of b.materials) m.opacity = o;
    }
  }

  private build(model: ModelLike, hand: Hand): Built | null {
    const comps = model.motionController!.components;
    const group = new THREE.Group();
    group.name = `controller-labels-${hand}`;
    const materials: Built['materials'] = [];
    model.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
    // The controller's centre (model space), to push plates outward from it.
    const box = new THREE.Box3().setFromObject(model).applyMatrix4(inv);
    const centre = box.getCenter(new THREE.Vector3());
    let any = false;
    for (const [id, lines] of Object.entries(TEXT[hand])) {
      const node = comps[id]?.touchPointNode;
      if (!node) continue;
      any = true;
      const p = node.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      // Out from the controller's centre, sideways and up, so plates fan out round it.
      const out = p.clone().sub(centre).setY(0);
      if (out.lengthSq() < 1e-8) out.set(hand === 'left' ? -1 : 1, 0, 0);
      out.normalize();
      const at = p.clone().addScaledVector(out, STAND_OFF).add(new THREE.Vector3(0, 0.018, 0));

      const tex = plateTexture(lines);
      const mat = new THREE.MeshBasicMaterial({ map: tex.texture, transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(PLATE_H * tex.aspect, PLATE_H * lines.length), mat);
      plate.position.copy(at);
      // Lying back toward the eyes, like a label engraved on a sloping face.
      plate.rotation.x = -1.0;
      plate.renderOrder = 24;
      const lineMat = new THREE.LineBasicMaterial({ color: 0xd9b46a, transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
      const leader = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, at]), lineMat);
      leader.renderOrder = 24;
      group.add(plate, leader);
      materials.push(mat, lineMat);
    }
    if (!any) return null;
    group.visible = false;
    model.add(group);
    const b = { model, hand, group, materials };
    this.built.push(b);
    return b;
  }
}

/** An engraved plate: dark lettering cut into brass. */
function plateTexture(lines: string[]) {
  const lineH = 56;
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  g.font = '600 40px Cinzel, Georgia, serif';
  const w = Math.ceil(Math.max(...lines.map((l) => g.measureText(l).width)) + 44);
  c.width = w;
  c.height = lineH * lines.length + 8;
  const grad = g.createLinearGradient(0, 0, w, c.height);
  grad.addColorStop(0, '#8a6a30');
  grad.addColorStop(0.5, '#c9a052');
  grad.addColorStop(1, '#7a5a26');
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(2, 2, w - 4, c.height - 4, 14);
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = '#3a2810';
  g.stroke();
  g.font = '600 40px Cinzel, Georgia, serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((l, i) => {
    const y = 4 + lineH * (i + 0.5);
    // Engraved: a light lower edge under dark lettering.
    g.fillStyle = 'rgba(255, 236, 190, 0.45)';
    g.fillText(l, w / 2, y + 1.5);
    g.fillStyle = '#2a1a08';
    g.fillText(l, w / 2, y);
  });
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, aspect: w / (c.height / lines.length) };
}
