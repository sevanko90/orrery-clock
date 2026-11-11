import * as THREE from 'three/webgpu';
import type { Materials } from './materials';
import type { Bodies, Body } from './bodies';
import {
  BREAKAWAY,
  PETROVA_LINE,
  VOGON_DEMOLITION,
  SPACE_1999,
  WORMHOLE,
  UTOPIA_PLANITIA,
  WAR_OF_THE_WORLDS,
  tooFrequent,
} from '../fiction/catalog';
import { DAY } from './fictionScenes/shared';
import { WarOfTheWorlds } from './fictionScenes/warOfTheWorlds';
import { UtopiaPlanitia } from './fictionScenes/utopiaPlanitia';
import { Breakaway } from './fictionScenes/breakaway';
import { Wormhole } from './fictionScenes/wormhole';
import { Demolition } from './fictionScenes/demolition';
import { PetrovaLine } from './fictionScenes/petrovaLine';
import { CeresStationPlace, ErosPlace, RingGatePlace, TychoStationPlace } from './fictionScenes/expanse';

// ---- Fiction mode -----------------------------------------------------------------------

export class Fiction {
  readonly root = new THREE.Group();
  readonly bodies: Body[];
  private wotw: WarOfTheWorlds;
  private breakaway: Breakaway;
  private demolition: Demolition;
  private utopia: UtopiaPlanitia;
  private wormhole: Wormhole;
  /** The always-on places: what each one shows, and how it moves. */
  private places: { id: string; object: THREE.Object3D; update: (simMs: number, elapsed: number) => void }[];
  /**
   * Fiction mode proper: shows the places and the catalogue. The dated events
   * run regardless, whenever the clock is in one (a Thursday morning, the
   * August volley), mode or no mode.
   */
  private on = false;
  /** Places switched off from the catalogue. */
  private hiddenPlaces = new Set<string>();
  /** Entry whose scene is playing: everything else steps aside. */
  private playing: string | null = null;

  constructor(bodies: Bodies, mats: Materials) {
    this.root.name = 'fiction';
    this.wotw = new WarOfTheWorlds(bodies, mats);
    this.root.add(this.wotw.group);
    this.breakaway = new Breakaway(bodies);
    this.root.add(this.breakaway.group);
    this.demolition = new Demolition(bodies, mats);
    this.root.add(this.demolition.group);
    this.utopia = new UtopiaPlanitia(bodies.surfaceFrame('mars')!, mats);
    this.wormhole = new Wormhole(bodies);
    this.root.add(this.wormhole.anchor);
    const petrova = new PetrovaLine(bodies);
    this.root.add(petrova.object);
    const expanse = [new CeresStationPlace(mats), new ErosPlace(), new TychoStationPlace(mats), new RingGatePlace()];
    this.root.add(...expanse.map((p) => p.object));
    this.places = [
      { id: UTOPIA_PLANITIA.id, object: this.utopia.anchor, update: (_ms, elapsed) => this.utopia.update(elapsed) },
      { id: WORMHOLE.id, object: this.wormhole.anchor, update: (_ms, elapsed) => this.wormhole.update(elapsed) },
      { id: PETROVA_LINE.id, object: petrova.object, update: (_ms, elapsed) => petrova.update(elapsed) },
      ...expanse.map((p) => ({ id: p.body.id, object: p.object, update: (ms: number, elapsed: number) => p.update(ms, elapsed) })),
    ];
    this.bodies = [
      this.wotw.body,
      this.breakaway.body,
      this.demolition.body,
      this.demolition.bypassBody,
      this.demolition.fleetBody,
      this.utopia.body,
      this.wormhole.body,
      petrova.body,
      ...expanse.map((p) => p.body),
    ];
    this.setEnabled(false);
  }

  get enabled() {
    return this.on;
  }

  setEnabled(on: boolean) {
    this.on = on;
    this.refresh();
  }

  /** Show or hide one of the always-on places. */
  setPlaceShown(id: string, shown: boolean) {
    if (shown) this.hiddenPlaces.delete(id);
    else this.hiddenPlaces.add(id);
    this.refresh();
  }

  placeShown(id: string) {
    return !this.hiddenPlaces.has(id);
  }

  /** A scene is playing (or null when it ends): hide whatever isn't part of it. */
  setPlaying(id: string | null) {
    this.playing = id;
    this.refresh();
  }

  /** Recurring events skipped at the clock's current speed (they'd come round too often to be anything but noise). */
  private skipped = new Set<string>();

  private refresh() {
    const inScene = (id: string) => this.playing === null || this.playing === id;
    // An event shows when no other scene is playing and, unless it's the one playing, it isn't skipped for coming round too often.
    const shows = (id: string) => inScene(id) && (this.playing === id || !this.skipped.has(id));
    for (const p of this.places) p.object.visible = this.on && this.placeShown(p.id) && inScene(p.id);
    this.wotw.suppressed = !shows(WAR_OF_THE_WORLDS.id);
    this.breakaway.suppressed = !shows(SPACE_1999.id);
    this.demolition.suppressed = !shows(VOGON_DEMOLITION.id);
    // Suppressed scenes stop updating, so give the real Earth and Moon back now.
    if (this.demolition.suppressed) this.demolition.release();
    if (this.breakaway.suppressed) this.breakaway.release();
  }

  /** `speed`: the clock's speed (sim seconds per second), for skipping events that would come round too often. */
  update(simMs: number, dt: number, elapsed: number, jumped: boolean, camera: THREE.Camera, speed = 1) {
    const skipped = [WAR_OF_THE_WORLDS, SPACE_1999, VOGON_DEMOLITION].filter((e) => tooFrequent(e, speed)).map((e) => e.id);
    if (skipped.length !== this.skipped.size || skipped.some((id) => !this.skipped.has(id))) {
      this.skipped = new Set(skipped);
      this.refresh();
    }
    this.wotw.update(simMs, dt, jumped);
    this.breakaway.update(simMs, dt, jumped);
    this.demolition.update(simMs, dt, jumped, camera);
    for (const p of this.places) if (p.object.visible) p.update(simMs, elapsed);
  }

  /** Scene parts whose shaders should be compiled now (once, ahead of first use), or null. */
  /** Where fiction's glow sprites live: its own root, and Utopia Planitia (which rides on Mars, in the bodies). */
  get spriteRoots(): THREE.Object3D[] {
    return [this.root, this.utopia.anchor];
  }

  /** Smallest apparent size of on-screen signs (radians across): bigger in the tabletop, where the solar system is small. */
  set minSignAngle(a: number) {
    this.demolition.minSignAngle = a;
  }
  /** Tabletop: the construction hologram keeps its smoked glass on (the Sun is always in view). */
  set tabletop(on: boolean) {
    this.demolition.tabletop = on;
  }

  /** The parts whose shaders are worth building ahead of time (the Demolition: its first frame otherwise stalls). */
  get warmupRoot(): THREE.Object3D {
    return this.demolition.group;
  }

  takeWarmup(): THREE.Object3D | null {
    if (!this.demolition.warmupDue) return null;
    this.demolition.warmupDue = false;
    return this.demolition.group;
  }

  /** Camera shake from fiction (the planet exploding), 0..1. */
  get quake() {
    return this.demolition.quake;
  }

  /** A camera beat a scene wants at `simMs` (a new key means fly to frame its points), or null. */
  sceneBeat(id: string, simMs: number): { key: string; points: THREE.Vector3[]; duration: number } | null {
    return id === VOGON_DEMOLITION.id ? this.demolition.beat(simMs) : null;
  }

  /** The replay speed a scene wants at `simMs` (sim seconds per second), or null to leave it be. */
  scenePace(id: string, simMs: number): number | null {
    return id === VOGON_DEMOLITION.id ? this.demolition.pace(simMs) : null;
  }

  /**
   * When (sim ms) the camera should stop framing a scene and ride along with
   * its body instead, or null to keep the framed view.
   */
  followFrom(id: string): number | null {
    return id === SPACE_1999.id ? BREAKAWAY + 0.06 * DAY : null;
  }

  /** Points a camera should frame to watch an entry play out (empty: just focus its body). */
  framePoints(id: string): THREE.Vector3[] {
    if (id === WAR_OF_THE_WORLDS.id) return this.wotw.framePoints();
    if (id === SPACE_1999.id) return this.breakaway.framePoints();
    if (id === VOGON_DEMOLITION.id) return this.demolition.framePoints();
    return [];
  }
}
