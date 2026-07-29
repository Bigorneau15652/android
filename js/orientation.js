// Device-orientation math: converts alpha/beta/gamma (W3C DeviceOrientation)
// into a compass yaw (0-360, 0=North, clockwise) and pitch (-90..+90,
// +90=zenith) for the direction the back camera is pointing, assuming the
// phone is held with negligible roll (see README - this is what lets the
// stitcher skip full 3-axis correction).
//
// Rotation matrix formula is the standard device->world (X=East,Y=North,Z=Up)
// matrix from the W3C Device Orientation spec's non-normative appendix.

export class OrientationTracker {
  constructor() {
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.ready = false;
    this._listeners = new Set();
    this._handler = (e) => this._onEvent(e);
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

    // Column 3 of the device->world rotation matrix (R * [0,0,1]) gives the
    // world-frame direction of the device's screen normal; the back camera
    // looks the opposite way, so we negate it below.
    const r13 = cA * sG + cG * sA * sB;
    const r23 = sA * sG - cA * cG * sB;
    const r33 = cB * cG;

    const east = -r13, north = -r23, up = -r33;

    let yaw = Math.atan2(east, north) / d2r;
    if (yaw < 0) yaw += 360;
    const pitch = Math.asin(Math.max(-1, Math.min(1, up))) / d2r;
    // Roll: how level the phone is around the forward axis (0 = perfectly
    // upright/level). Approximated from gamma/beta; only used to warn the
    // user, never to correct the projection.
    const roll = gamma;

    this.yaw = yaw;
    this.pitch = pitch;
    this.roll = roll;

    if (this._resolveFirst) { this._resolveFirst(); this._resolveFirst = null; }
    for (const fn of this._listeners) fn({ yaw, pitch, roll });
  }
}

// Smallest signed angular difference a-b in degrees, result in (-180,180].
export function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}
