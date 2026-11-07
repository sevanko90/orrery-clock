import * as THREE from 'three/webgpu';

/**
 * Engraved labels on the controllers: a small brass plate per control,
 * standing just off the controller with a fine leader line to the button or
 * stick it names. They fade in when a controller is raised and turned to be
 * read (near the face, top toward the eyes) and fade away otherwise, so they
 * teach the controls without cluttering the view. They also show for the
 * first half minute in VR, so the player finds out they're there.
 *
 * Anchored to each control's node on the controller model (its touch point
 * where the profile has one; the Quest 3 model doesn't, so else the
 * control's root or moving part), so they sit on the real buttons of
 * whatever controller the headset reports.
 */

type Hand = 'left' | 'right';

/** What each control does, by WebXR input-profile component id. */
const TEXT: Record<Hand, Record<string, string[]>> = {
  left: {
    'xr-standard-thumbstick': import.meta.env.DEV ? ['Walk / fly', 'click: screenshot'] : ['Walk / fly'],
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

/**
 * Where each control's plate stands, from the control (metres, in the
 * controller's space): `side` away from the body (outward; negative is the
 * inside, toward the other hand), `up` off the controller's top face, and
 * `forward` along the pointing direction.
 *
 * Held up to be read, a controller's top faces the eyes, so `forward` is
 * what reads as up and down: plates are spaced along it (the upper face
 * button's and the trigger's high, the lower button's middling, the grip's
 * low) and lifted only a little off the face. The stick's stands outside,
 * the buttons' and the grip's inside, so leader lines don't cross.
 */
const LAYOUT: Record<string, { side: number; up: number; forward: number }> = {
  'xr-standard-thumbstick': { side: 0.065, up: 0.015, forward: 0 },
  'x-button': { side: -0.06, up: 0.015, forward: -0.005 },
  'a-button': { side: -0.06, up: 0.015, forward: -0.005 },
  'y-button': { side: -0.045, up: 0.015, forward: 0.04 },
  'b-button': { side: -0.045, up: 0.015, forward: 0.04 },
  'xr-standard-trigger': { side: 0.015, up: 0.02, forward: 0.09 },
  'xr-standard-squeeze': { side: -0.06, up: 0, forward: -0.055 },
};

/** Plate height (metres); its width follows the text. */
const PLATE_H = 0.013;
/** How far a plate stands off its control (metres). */
const STAND_OFF = 0.035;

interface Component {
  touchPointNode?: THREE.Object3D;
  rootNodeName?: string;
  visualResponses?: Record<string, { valueNode?: THREE.Object3D }>;
}

/** Where a control is on the model: its touch point, else its root node, else a moving part of it. */
function anchorOf(model: THREE.Object3D, c: Component | undefined): THREE.Object3D | null {
  if (!c) return null;
  if (c.touchPointNode) return c.touchPointNode;
  const root = c.rootNodeName ? model.getObjectByName(c.rootNodeName) : undefined;
  if (root) return root;
  for (const r of Object.values(c.visualResponses ?? {})) if (r.valueNode) return r.valueNode;
  return null;
}

const box = new THREE.Box3();
/**
 * The control's position (world): a touch point is a point; otherwise the
 * centre of the control's geometry (a root node sits at the model's origin,
 * its mesh offset from it, so its own position is the controller's centre).
 */
function anchorPosition(node: THREE.Object3D, isTouchPoint: boolean, out: THREE.Vector3) {
  if (isTouchPoint) return node.getWorldPosition(out);
  box.setFromObject(node);
  return box.isEmpty() ? node.getWorldPosition(out) : box.getCenter(out);
}
interface ModelLike extends THREE.Object3D {
  motionController?: { components: Record<string, Component> } | null;
}

interface Built {
  model: ModelLike;
  hand: Hand;
  group: THREE.Group;
  materials: (THREE.MeshBasicMaterial | THREE.LineBasicMaterial)[];
  plates: THREE.Mesh[];
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
  private head = new THREE.Vector3();
  private eyeQ = new THREE.Quaternion();
  private q = new THREE.Quaternion();
  private fwd = new THREE.Vector3();
  private up = new THREE.Vector3();

  /**
   * Per frame. `controllers`: each controller's grip space, the model loaded
   * into it and its handedness (null until known). `eyes`: the camera (the
   * plates turn to face it); `metresPerUnit`: the world scale.
   */
  update(dt: number, controllers: { grip: THREE.Object3D; ray: THREE.Object3D; model: ModelLike; hand: Hand | null }[], eyes: THREE.Object3D, metresPerUnit: number) {
    // From the camera's matrix as the renderer left it (the XR camera's position and
    // quaternion fields aren't kept in step, so getWorldQuaternion() rebuilds a wrong one).
    eyes.matrixWorld.decompose(this.head, this.eyeQ, this.tmp);
    const head = this.head;
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
          asset: (c.model.motionController as { assetUrl?: string } | null | undefined)?.assetUrl ?? null,
          components: comps ? Object.keys(comps) : null,
          anchors: comps ? Object.entries(comps).filter(([, v]) => anchorOf(c.model, v)).map(([k]) => k) : null,
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
      // Raised in front of the face: near, within ~40° of the gaze, pointing upward
      // (at least ~30° above level) with its top toward the eyes. Arms out, hands in
      // the lap, or aiming the controller don't count.
      const gaze = this.fwd.set(0, 0, -1).applyQuaternion(this.eyeQ);
      const inView = gaze.dot(toEye.clone().negate()) > 0.77;
      // (The pointing direction is the target ray's −Z; the grip's −Z runs along the handle.)
      const pointing = this.fwd.set(0, 0, -1).transformDirection(c.ray.matrixWorld);
      const upright = pointing.y > 0.5;
      const want = this.showing > 0 || (dist < 0.5 && inView && upright && facing > 0) ? 1 : 0;
      Object.assign(this.state[b.hand] as object, { dist: +dist.toFixed(2), facing: +facing.toFixed(2), inView, upright, opacity: +(this.opacity.get(b.group) ?? 0).toFixed(2) });
      const o0 = this.opacity.get(b.group) ?? 0;
      // A gentle fade (~0.8 s), not a pop.
      const o = o0 + THREE.MathUtils.clamp(want - o0, -dt * 1.25, dt * 1.25);
      this.opacity.set(b.group, o);
      b.group.visible = o > 0.01;
      for (const m of b.materials) m.opacity = o;
      if (b.group.visible) {
        // Face the eyes whatever way the controller is turned (seen from above, a plate lying on it is edge-on).
        b.group.getWorldQuaternion(this.q).invert().multiply(this.eyeQ);
        for (const p of b.plates) p.quaternion.copy(this.q);
      }
    }
  }

  private build(model: ModelLike, hand: Hand): Built | null {
    const comps = model.motionController!.components;
    const group = new THREE.Group();
    group.name = `controller-labels-${hand}`;
    const materials: Built['materials'] = [];
    const plates: THREE.Mesh[] = [];
    model.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
    // Outward is −x for the left hand, +x for the right.
    const outward = hand === 'left' ? -1 : 1;
    // Leader lines to controls under or beside the face stop where they first touch the controller's mesh.
    const caster = new THREE.Raycaster();
    let any = false;
    for (const [id, lines] of Object.entries(TEXT[hand])) {
      const node = anchorOf(model, comps[id]);
      if (!node) continue;
      any = true;
      const p = anchorPosition(node, node === comps[id]?.touchPointNode, new THREE.Vector3()).applyMatrix4(inv);
      const l = LAYOUT[id] ?? { side: STAND_OFF, up: 0.02, forward: 0 };
      const at = p.clone().add(new THREE.Vector3(l.side * outward, l.up, -l.forward));

      const tex = plateTexture(lines);
      const mat = new THREE.MeshBasicMaterial({ map: tex.texture, transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(PLATE_H * tex.aspect, PLATE_H * lines.length), mat);
      plate.position.copy(at);
      plate.renderOrder = 24;
      plates.push(plate);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xd9b46a, transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
      // The line ends at the control; for the trigger and grip (under and beside the
      // face) where it first touches the controller, so it doesn't run through it.
      let end = p;
      if (id === 'xr-standard-trigger' || id === 'xr-standard-squeeze') {
        const from = at.clone().applyMatrix4(model.matrixWorld);
        const to = p.clone().applyMatrix4(model.matrixWorld);
        caster.set(from, to.clone().sub(from).normalize());
        caster.far = from.distanceTo(to);
        const hit = caster.intersectObject(model, true).find((h) => (h.object as THREE.Mesh).isMesh && !group.children.includes(h.object));
        if (hit) end = hit.point.applyMatrix4(inv);
      }
      const leader = new THREE.Line(new THREE.BufferGeometry().setFromPoints([end, at]), lineMat);
      // Drawn before the plates, so a plate always covers the end of its line.
      leader.renderOrder = 23;
      group.add(plate, leader);
      materials.push(mat, lineMat);
    }
    if (!any) return null;
    group.visible = false;
    model.add(group);
    const b = { model, hand, group, materials, plates };
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
