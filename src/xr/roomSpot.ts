import * as THREE from 'three/webgpu';
import type { Placement } from './tabletop';

/**
 * Tabletop: where the orrery was left, kept between sessions with one WebXR
 * persistent anchor (Quest ties it to the room's map). The anchor sits at
 * the orrery's base, turned with it; beside its handle the scale and
 * whether it was on a table are saved.
 *
 * Quest allows a site only a few persistent anchors (8), and the first
 * version made a new one every time the orrery came to rest, deleting the
 * old after: they soon failed. Now there is only ever one: the old
 * persistent anchor is deleted before the new one asks for its handle, and
 * any left over from before are cleared at the session's start. (Saving it
 * relative to the floor plane was tried too: Quest's floor plane can come
 * back turned half round in a new session.)
 */
export interface SavedSpot {
  uuid: string;
  metresPerUnit: number;
  placement: Placement;
}
const KEY = 'tabletop-anchor';
/** How long to wait at the start for the saved anchor to be found (ms). */
const WAIT_MS = 10000;

export type SpotState = 'none' | 'restoring' | 'restored' | 'saving' | 'saved' | 'unsupported' | 'failed';

export class RoomSpot {
  state: SpotState = 'none';
  /** The last failure's message (telemetry). */
  error: string | null = null;
  private anchor: XRAnchor | null = null;
  private pending: SavedSpot | null = null;
  private until = 0;
  private busy = false;
  /** Each step, for telemetry (a sampled state hides quick failures). */
  onEvent: ((e: Record<string, unknown>) => void) | null = null;
  private log(event: string, more: Record<string, unknown> = {}) {
    this.onEvent?.({ kind: 'spot', event, ...more });
  }

  /** Session start: clear stray persistent anchors, and look for the saved one. */
  begin(session: XRSession) {
    this.anchor = null;
    this.pending = null;
    this.error = null;
    const saved = load();
    this.log('begin', {
      saved: saved?.uuid ?? null,
      known: session.persistentAnchors ? [...session.persistentAnchors] : null,
      canRestore: !!session.restorePersistentAnchor,
    });
    // Leftovers count against the site's few: cleared one at a time, after the
    // saved one is restored (alongside it, at the session's start, Quest refused).
    const known = [...(session.persistentAnchors ?? [])].filter((id) => id !== saved?.uuid);
    const clear = () => {
      void (async () => {
        for (const id of known) await this.drop(session, id, 'stray');
      })();
    };
    if (!saved) {
      this.state = 'none';
      clear();
      return;
    }
    if (!session.restorePersistentAnchor) {
      this.state = 'unsupported';
      return;
    }
    this.pending = saved;
    this.until = performance.now() + WAIT_MS;
    this.state = 'restoring';
    session
      .restorePersistentAnchor(saved.uuid)
      .then((a) => {
        this.anchor = a;
        this.log('restore-found', { uuid: saved.uuid });
      })
      .catch((e) => {
        this.pending = null;
        forget();
        this.fail(e);
        this.log('restore-failed', { uuid: saved.uuid, error: this.error });
      })
      .finally(clear);
  }

  end() {
    this.anchor = null;
    this.pending = null;
  }

  /** Still waiting to put the orrery back (don't save over the spot meanwhile). */
  get restoring() {
    if (this.pending && performance.now() > this.until) {
      this.pending = null;
      this.state = 'failed';
      this.error = 'saved anchor not found in time';
      this.log('restore-timeout');
    }
    return this.pending !== null;
  }

  /** Stop waiting (the player has taken the orrery elsewhere). */
  abandon() {
    this.pending = null;
    if (this.state === 'restoring') this.state = 'none';
  }

  /** Once: the saved spot (base position and turn in the room) when its anchor is tracked. */
  restored(frame: XRFrame | null, space: XRReferenceSpace | null): { position: THREE.Vector3; yaw: number; saved: SavedSpot } | null {
    if (!this.restoring || !this.anchor || !frame || !space) return null;
    const pose = frame.getPose(this.anchor.anchorSpace, space);
    if (!pose) return null;
    const saved = this.pending!;
    this.pending = null;
    this.state = 'restored';
    this.log('restored', { uuid: saved.uuid });
    return { ...poseOf(new THREE.Matrix4().fromArray(pose.transform.matrix)), saved };
  }

  /**
   * Anchor the orrery where it now is (base at `position` in the room, turned
   * by `yaw`), replacing the one anchor, and save it with the scale and placement.
   * False if it can't take it now (busy: try again later).
   */
  save(
    frame: XRFrame | null,
    space: XRReferenceSpace | null,
    session: XRSession | null,
    position: THREE.Vector3,
    yaw: number,
    metresPerUnit: number,
    placement: Placement,
  ) {
    if (this.busy || !frame || !space || !session) return false;
    if (!frame.createAnchor) {
      this.state = 'unsupported';
      return true;
    }
    this.busy = true;
    this.state = 'saving';
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    // (Made now, inside the frame: a frame is only good during its callback.)
    const made = frame.createAnchor(
      new XRRigidTransform({ x: position.x, y: position.y, z: position.z }, { x: q.x, y: q.y, z: q.z, w: q.w }),
      space,
    );
    const old = load();
    void (async () => {
      try {
        const a = await made;
        // The old persistent anchor goes first, so there's room for the new; and
        // while its live anchor is still held (deleting that first left the
        // persistent delete failing: 'already being restored or deleted').
        if (old) {
          forget();
          await this.drop(session, old.uuid, 'replaced');
        }
        this.anchor?.delete();
        this.anchor = a;
        if (!a.requestPersistentHandle) {
          this.state = 'unsupported';
          return;
        }
        const uuid = await a.requestPersistentHandle();
        save({ uuid, metresPerUnit, placement });
        this.state = 'saved';
        this.error = null;
        this.log('saved', { uuid, replaced: old?.uuid ?? null, stored: load()?.uuid ?? null });
      } catch (e) {
        this.fail(e);
        this.log('save-failed', { error: this.error });
      } finally {
        this.busy = false;
      }
    })();
    return true;
  }

  /**
   * Start afresh ("Place in front of me"): delete every persistent anchor the
   * browser knows for this site, and forget the saved spot. Nothing new is
   * saved until it's done.
   */
  reset(session: XRSession | null) {
    this.pending = null;
    forget();
    this.state = 'none';
    const live = this.anchor;
    this.anchor = null;
    if (!session) {
      live?.delete();
      return;
    }
    const known = session.persistentAnchors ? [...session.persistentAnchors] : [];
    this.log('reset', { known });
    this.busy = true;
    // One at a time (in parallel, Quest answered 'already being restored or deleted'); the live anchor last.
    void (async () => {
      for (const id of known) await this.drop(session, id, 'reset');
    })().finally(() => {
      live?.delete();
      this.busy = false;
      this.log('reset-done', { left: session.persistentAnchors ? [...session.persistentAnchors] : null });
    });
  }

  /**
   * Delete a persistent anchor. Quest refused to delete ones not loaded this
   * session ('Anchor deletion failed'), so on failure restore it, then try again.
   */
  private async drop(session: XRSession, uuid: string, why: string) {
    if (!session.deletePersistentAnchor) return;
    try {
      await session.deletePersistentAnchor(uuid);
      this.log('deleted', { uuid, why });
      return;
    } catch (e) {
      this.log('delete-refused', { uuid, why, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
    try {
      const a = await session.restorePersistentAnchor?.(uuid);
      await session.deletePersistentAnchor(uuid);
      a?.delete();
      this.log('deleted-after-restore', { uuid, why });
    } catch (e) {
      this.fail(e, false);
      this.log('delete-failed', { uuid, why, error: this.error });
    }
  }

  private fail(e: unknown, setState = true) {
    this.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (setState) this.state = 'failed';
  }
}

/** Position and turn about the vertical of a room pose. */
export function poseOf(m: THREE.Matrix4) {
  const position = new THREE.Vector3().setFromMatrixPosition(m);
  // The turn: where the pose's forward (−z) points, on the horizontal.
  const fwd = new THREE.Vector3(0, 0, -1).transformDirection(m);
  return { position, yaw: Math.atan2(-fwd.x, -fwd.z) };
}

function load(): SavedSpot | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as SavedSpot | null;
    return s && typeof s.uuid === 'string' ? s : null;
  } catch {
    return null;
  }
}
function save(s: SavedSpot) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
function forget() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
