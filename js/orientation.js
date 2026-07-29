// Device-orientation math: converts alpha/beta/gamma (W3C DeviceOrientation)
// into the camera's world-space basis vectors (right/up/forward, each a
// unit vector expressed in East/North/Up world coordinates) plus a
// yaw/pitch/roll summary for the UI.
//
// Earlier versions derived yaw/pitch/roll as independent Euler angles and
// re-composed a rotation from them for the stitcher. That silently broke
// specifically in the "phone held upright, pointed at the horizon" pose
// used for every shot: at beta=90 degrees the W3C alpha/beta/gamma
// parameterization hits a gimbal-lock-like singularity where gamma stops
// meaning "camera roll" and starts behaving like additional yaw instead
// (verified by direct computation - perturbing gamma near beta=90 mostly
// rotates the derived forward vector's East/North components, barely its
// Up component). Recomposing a rotation from that gamma value therefore
// rolled shots by the wrong amount/axis, which is what caused the
// double/tripled content after stitching.
//
// The fix: read the camera's right/up/forward vectors directly off the
// full device->world rotation matrix's columns (basic linear algebra - a
// rotation matrix's column i is just "where local axis i ends up in world
// space", true regardless of the Euler parameterization's own
// degeneracies) instead of re-deriving them from yaw/pitch/roll angles.
// yaw/pitch/roll are still computed, but only as a read-only summary for
// the on-screen guide, derived *from* the vectors rather than the other
// way around.

const SMOOTHING_ALPHA = 0.25; // 0..1, lower = smoother but laggier

export class OrientationTracker {
  constructor() {
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    // Unit vectors in world (East, North, Up) coordinates.
    this.forwardVec = [0, 1, 0]; // camera boresight direction
    this.rightVec = [1, 0, 0]; // "right" edge of the photo
    this.upVec = [0, 0, 1]; // "up" edge of the photo
    this.ready = false;
    this._listeners = new Set();
    this._handler = (e) => this._onEvent(e);
    this._lockedType = null; // 'deviceorientationabsolute' | 'deviceorientation'
    this._smoothed = false;
  }

  onUpdate(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  async start() {
    // iOS-style permission gate; harmless no-op on Android Chrome.
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') throw new Error('Permission capteurs refusée');
      } catch (err) {
        throw new Error('Permission capteurs refusée');
      }
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          window.removeEventListener('deviceorientationabsolute', this._handler);
          window.removeEventListener('deviceorientation', this._handler);
          reject(new Error(
            "Aucune donnée de capteur d'orientation reçue. " +
            "Vérifie que le gyroscope est autorisé pour ce site."
          ));
        }
      }, 4000);
      const firstEvent = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.ready = true;
          resolve();
        }
      };
      window.addEventListener('deviceorientationabsolute', this._handler, true);
      window.addEventListener('deviceorientation', this._handler, true);
      this._resolveFirst = firstEvent;
    });
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this._handler, true);
    window.removeEventListener('deviceorientation', this._handler, true);
  }

  _onEvent(event) {
    // Some browsers/OS versions fire both 'deviceorientation' and
    // 'deviceorientationabsolute' concurrently, each backed by a different
    // underlying sensor fusion pipeline (magnetometer-corrected vs
    // gyro-only). Reading from both interleaved makes the orientation jump
    // between two inconsistent references frame to frame. Lock onto
    // whichever type shows up first and ignore the other for the session.
    if (this._lockedType == null) {
      this._lockedType = event.type;
      const other = event.type === 'deviceorientationabsolute' ? 'deviceorientation' : 'deviceorientationabsolute';
      window.removeEventListener(other, this._handler, true);
    } else if (event.type !== this._lockedType) {
      return;
    }

    let alpha = event.alpha, beta = event.beta, gamma = event.gamma;
    if (alpha == null || beta == null || gamma == null) return;

    // Some Android builds only expose a compass-referenced alpha via
    // webkitCompassHeading (rare) — prefer absolute event/flag when present.
    if (typeof event.webkitCompassHeading === 'number') {
      alpha = event.webkitCompassHeading;
    }

    const d2r = Math.PI / 180;
    const a = alpha * d2r, b = beta * d2r, g = gamma * d2r;
    const cA = Math.cos(a), sA = Math.sin(a);
    const cB = Math.cos(b), sB = Math.sin(b);
    const cG = Math.cos(g), sG = Math.sin(g);

    // Full device->world rotation matrix (W3C spec's non-normative
    // appendix). Column 1 = world image of device +X (right), column 2 =
    // +Y (up), column 3 = +Z (screen normal, out of the screen toward the
    // user - the back camera looks the opposite way, hence forward negates it).
    const r11 = cA * cG - sA * sB * sG, r21 = cG * sA + cA * sB * sG, r31 = -cB * sG;
    const r12 = -cB * sA, r22 = cA * cB, r32 = sB;
    const r13 = cA * sG + cG * sA * sB, r23 = sA * sG - cA * cG * sB, r33 = cB * cG;

    const rawRight = [r11, r21, r31];
    const rawUp = [r12, r22, r32];
    const rawForward = [-r13, -r23, -r33];

    // Nlerp smoothing to kill frame-to-frame sensor jitter (the on-screen
    // target/roll-outline visibly "vibrating"): blend each basis vector a
    // little toward the fresh raw sample and re-normalize. Fine for small
    // per-frame deltas (this is noise reduction, not large interpolation),
    // and self-corrects every frame since it always blends toward a fresh,
    // properly-orthogonal raw sample rather than compounding drift.
    if (!this._smoothed) {
      this.rightVec = rawRight; this.upVec = rawUp; this.forwardVec = rawForward;
      this._smoothed = true;
    } else {
      this.rightVec = normalize(lerpVec(this.rightVec, rawRight, SMOOTHING_ALPHA));
      this.upVec = normalize(lerpVec(this.upVec, rawUp, SMOOTHING_ALPHA));
      this.forwardVec = normalize(lerpVec(this.forwardVec, rawForward, SMOOTHING_ALPHA));
    }

    const [east, north, up] = this.forwardVec;
    let yaw = Math.atan2(east, north) / d2r;
    if (yaw < 0) yaw += 360;
    this.yaw = yaw;
    this.pitch = Math.asin(clamp(up, -1, 1)) / d2r;
    // "Level" means the photo's right edge has no Up component - this is
    // the actual geometric definition of roll, computed from the vector
    // (not re-derived from gamma, which is unreliable in this pose - see
    // the module comment above).
    this.roll = Math.asin(clamp(this.rightVec[2], -1, 1)) / d2r;

    if (this._resolveFirst) { this._resolveFirst(); this._resolveFirst = null; }
    for (const fn of this._listeners) fn({ yaw: this.yaw, pitch: this.pitch, roll: this.roll });
  }
}

function lerpVec(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function normalize(v) {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Smallest signed angular difference a-b in degrees, result in (-180,180].
export function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}
