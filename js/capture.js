// Drives the capture screen: camera stream, orientation-guided reticle
// overlay, auto/manual shutter, and collecting each accepted frame.
//
// Frames are kept (downscaled) rather than stitched on the fly, because
// the post-capture refinement in align.js needs to compare shots against
// each other to correct the sensor's orientation error and the assumed
// lens FOV - impossible once they've been flattened into one buffer.

import { angleDiff } from './orientation.js';
import { prepareShot, verticalFovFromHorizontal } from './align.js';

// Stored frame size. Big enough that a shot still out-resolves its slice
// of a 4096-wide equirect output, small enough that a dense grid stays
// well inside a phone browser's memory budget (~1.2MB per shot).
const STORE_W = 640, STORE_H = 480;
const d2r = Math.PI / 180;

// Lists the phone's rear cameras (ultra-wide / main / tele are separate
// devices on Android). Labels are only exposed once camera permission has
// been granted, so this is called after a stream has been opened at least
// once; without labels we still return the devices, just numbered.
export async function listRearCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const rear = cams.filter((d) => /back|arri|rear|environment/i.test(d.label || ''));
  const list = rear.length ? rear : cams;
  return list.map((d, i) => ({
    deviceId: d.deviceId,
    label: d.label || `Objectif ${i + 1}`,
  }));
}

// Opens a camera stream, preferring an explicitly chosen device.
export async function openCameraStream(deviceId) {
  const base = { width: { ideal: 1920 }, height: { ideal: 1440 } };
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false, video: { ...base, deviceId: { exact: deviceId } },
      });
    } catch (err) {
      // Device disappeared (lens list changes between sessions on some
      // phones) - fall through to the default rear camera rather than
      // failing the whole capture.
    }
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false, video: { ...base, facingMode: { ideal: 'environment' } },
  });
}

// Grabs a burst of overlapping frames while the user pans, for lens
// calibration. Frames are taken every `stepDeg` of measured rotation, so
// they overlap for any lens from tele to ultra-wide - we cannot assume a
// field of view here, since measuring it is the whole point.
//
// The defaults cover close to a full turn on purpose. FOV is inferred from
// how far the image content shifts for a rotation the gyro reports, so the
// bigger the rotation actually spanned, the better that ratio is pinned
// down; a short pan leaves the FOV weakly determined and the estimate
// drifts towards implausibly wide values.
export class CalibrationCapture {
  constructor({ video, tracker, frames = 16, stepDeg = 20 }) {
    this.video = video;
    this.tracker = tracker;
    this.frames = frames;
    this.stepDeg = stepDeg;
    this.shots = [];
    this._running = false;
    this._lastForward = null;
    this._canvas = document.createElement('canvas');
    this._canvas.width = STORE_W;
    this._canvas.height = STORE_H;
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this.onFrame = null;
    this.onDone = null;
  }

  start() {
    this._running = true;
    this._loop();
  }
  stop() { this._running = false; }

  _angleFromLast() {
    const f = this.tracker.forwardVec;
    if (!this._lastForward || !f) return Infinity;
    const c = Math.max(-1, Math.min(1,
      f[0] * this._lastForward[0] + f[1] * this._lastForward[1] + f[2] * this._lastForward[2]));
    return Math.acos(c) / d2r;
  }

  _loop() {
    if (!this._running) return;
    if (this._angleFromLast() >= this.stepDeg) this._grab();
    if (this._running) requestAnimationFrame(() => this._loop());
  }

  _grab() {
    const f = this.tracker.forwardVec;
    if (!f) return;
    this._ctx.drawImage(this.video, 0, 0, STORE_W, STORE_H);
    this.shots.push({
      imageData: this._ctx.getImageData(0, 0, STORE_W, STORE_H),
      basis: {
        right: this.tracker.rightVec.slice(),
        up: this.tracker.upVec.slice(),
        forward: this.tracker.forwardVec.slice(),
      },
    });
    this._lastForward = [...f];
    if (this.onFrame) this.onFrame(this.shots.length, this.frames);
    if (this.shots.length >= this.frames) {
      this._running = false;
      if (this.onDone) this.onDone(this.shots);
    }
  }
}

const FLUO_BLUE = '#12e1ff';

// Groups targets into the rows the on-screen mini-map draws: zenith (if
// present) on top, then each pitch row high-to-low sorted by yaw, then
// nadir (if present) at the bottom. Poles get their own single-cell row.
function buildMiniMapRows(targets) {
  const poles = targets.filter((t) => t.isPole);
  const rowTargets = targets.filter((t) => !t.isPole);
  const pitches = [...new Set(rowTargets.map((t) => t.row))].sort((a, b) => b - a);
  const rows = pitches.map((p) => rowTargets.filter((t) => t.row === p).sort((a, b) => a.yaw - b.yaw));
  const zenith = poles.find((t) => t.pitch > 0);
  const nadir = poles.find((t) => t.pitch < 0);
  const all = [];
  if (zenith) all.push([zenith]);
  all.push(...rows);
  if (nadir) all.push([nadir]);
  return all;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Target reticle: a rounded rectangle with a circular hole punched out
// (via destination-out, revealing the live camera feed through it) that
// the fixed center crosshair should land inside.
function drawTargetFrame(ctx, cx, cy, w, h, holeR, color) {
  ctx.save();
  ctx.translate(cx, cy);
  roundRectPath(ctx, -w / 2, -h / 2, w, h, 16);
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.stroke();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(0, 0, holeR, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

export class CaptureController {
  constructor({ video, overlayCanvas, tracker, targets, settings }) {
    this.video = video;
    this.overlay = overlayCanvas;
    this.octx = overlayCanvas.getContext('2d');
    this.tracker = tracker;
    this.targets = targets.map((t) => ({ ...t, done: false }));
    // -1 = "no target picked yet", not "targets[0]" - _advanceToNextPending
    // uses this to know there's no real "current row" preference on the
    // very first pick, so it picks whichever target is actually nearest to
    // the camera's starting orientation instead of defaulting to row 0 of
    // the grid array (which happens to be the top pitch row).
    this.currentIndex = -1;
    this.settings = settings; // { hFov, tolerance, autoCapture, holdMs, rollLimit, steadyLimit }
    this.vFov = verticalFovFromHorizontal(settings.hFov, STORE_W, STORE_H);
    this.shots = [];
    this.stream = null;
    this._running = false;
    this._alignedSince = null;
    this._captureBusy = false;
    this._angSpeed = 0; // smoothed degrees/second, for the steadiness gate
    this._prevForward = null;
    this._prevT = 0;
    this.listeners = { progress: [], shot: [], done: [], error: [] };
    this._shotCanvas = document.createElement('canvas');
    this._shotCanvas.width = STORE_W;
    this._shotCanvas.height = STORE_H;
    this._shotCtx = this._shotCanvas.getContext('2d', { willReadFrequently: true });
  }

  on(event, fn) { this.listeners[event].push(fn); }
  _emit(event, ...args) { for (const fn of this.listeners[event]) fn(...args); }

  async startCamera() {
    this.stream = await openCameraStream(this.settings.deviceId);
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stopCamera() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }

  remainingCount() { return this.targets.filter((t) => !t.done).length; }
  totalCount() { return this.targets.length; }
  doneCount() { return this.targets.filter((t) => t.done).length; }

  start() {
    this._running = true;
    this._advanceToNextPending();
    this._loop();
  }

  stop() {
    this._running = false;
  }

  _advanceToNextPending() {
    const pending = this.targets.filter((t) => !t.done);
    if (!pending.length) { this.currentIndex = -1; return; }
    // Prefer finishing the current row (sweeping left/right, an easy small
    // pan) before hopping to a different pitch row - jumping rows on every
    // shot was what made the guide feel like it kept "starting over" with
    // the off-screen arrow. Only cross rows once the current one is done.
    const yaw = this.tracker.yaw, pitch = this.tracker.pitch;
    const currentRow = this.currentIndex >= 0 ? this.targets[this.currentIndex].row : null;
    const sameRowPending = pending.filter((t) => t.row === currentRow);
    const pool = sameRowPending.length ? sameRowPending : pending;
    let bestTarget = null, bestDist = Infinity;
    for (const t of pool) {
      const dy = angleDiff(t.yaw, yaw), dp = t.pitch - pitch;
      const dist = dy * dy + dp * dp;
      if (dist < bestDist) { bestDist = dist; bestTarget = t; }
    }
    this.currentIndex = this.targets.indexOf(bestTarget);
    // The hold timer must restart for the new target: without this, if two
    // targets are close enough that the new one is already inside
    // tolerance the instant we switch to it, the stale "aligned since"
    // timestamp from the *previous* target reads as already-elapsed and
    // fires an immediate capture - which then advances again, repeats
    // next frame, and so on. That's the rapid strobe/flicker bug where the
    // guide burns through several close targets at ~60/s instead of
    // waiting for a deliberate, held-still aim on each one.
    this._alignedSince = null;
  }

  _loop() {
    if (!this._running) return;
    this._drawOverlay();
    requestAnimationFrame(() => this._loop());
  }

  _projectToView(targetYaw, targetPitch) {
    const yaw = this.tracker.yaw, pitch = this.tracker.pitch;
    const phi1 = pitch * d2r, phi = targetPitch * d2r;
    const dLambda = angleDiff(targetYaw, yaw) * d2r;
    const cosc = Math.sin(phi1) * Math.sin(phi) + Math.cos(phi1) * Math.cos(phi) * Math.cos(dLambda);
    if (cosc <= 0.05) return { visible: false };
    const x = (Math.cos(phi) * Math.sin(dLambda)) / cosc;
    const y = (Math.cos(phi1) * Math.sin(phi) - Math.sin(phi1) * Math.cos(phi) * Math.cos(dLambda)) / cosc;
    const tanHalfH = Math.tan((this.settings.hFov / 2) * d2r);
    const tanHalfV = Math.tan((this.vFov / 2) * d2r);
    const nx = x / tanHalfH, ny = y / tanHalfV;
    return { visible: true, nx, ny, onScreen: Math.abs(nx) <= 1.15 && Math.abs(ny) <= 1.15 };
  }

  // Bottom mini-map: one small rectangle per target, arranged in rows that
  // mirror the real capture grid (fewer shots near the poles), turning
  // from fluo blue to white as each one gets captured.
  _drawMiniMap(ctx, w, h) {
    if (!this._miniMapRows) this._miniMapRows = buildMiniMapRows(this.targets);
    const rows = this._miniMapRows;
    if (!rows.length) return;

    const cw = 13, chh = 17, gapX = 5, gapY = 5, pad = 10;
    const panelH = rows.length * (chh + gapY) - gapY + pad * 2;
    const panelW = Math.max(...rows.map((r) => r.length)) * (cw + gapX) - gapX + pad * 2;
    const panelX = (w - panelW) / 2;
    const panelY = h - panelH - 110; // clears the bottom action bar

    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    roundRectPath(ctx, panelX, panelY, panelW, panelH, 12);
    ctx.fill();

    const current = this.currentIndex >= 0 ? this.targets[this.currentIndex] : null;
    rows.forEach((row, ri) => {
      const rowW = row.length * (cw + gapX) - gapX;
      const startX = panelX + (panelW - rowW) / 2;
      const y = panelY + pad + ri * (chh + gapY);
      row.forEach((t, ci) => {
        const x = startX + ci * (cw + gapX);
        ctx.fillStyle = t.done ? '#ffffff' : FLUO_BLUE;
        roundRectPath(ctx, x, y, cw, chh, 3);
        ctx.fill();
        if (t === current) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#ffffff';
          roundRectPath(ctx, x - 2, y - 2, cw + 4, chh + 4, 4);
          ctx.stroke();
        }
      });
    });
  }

  // Smoothed angular speed of the camera, in degrees/second. Used to
  // refuse firing while the phone is still swinging: a frame grabbed
  // mid-motion is both motion-blurred and tagged with an orientation that
  // has already moved on by the time the frame is read, which then fights
  // the post-capture alignment.
  _updateAngularSpeed() {
    const now = performance.now();
    const f = this.tracker.forwardVec;
    if (!f) return;
    if (this._prevForward) {
      const dt = (now - this._prevT) / 1000;
      if (dt > 0.01) {
        const c = Math.max(-1, Math.min(1,
          f[0] * this._prevForward[0] + f[1] * this._prevForward[1] + f[2] * this._prevForward[2]));
        const deg = Math.acos(c) / d2r;
        const inst = deg / dt;
        this._angSpeed = this._angSpeed * 0.7 + inst * 0.3;
        this._prevForward = [...f];
        this._prevT = now;
      }
    } else {
      this._prevForward = [...f];
      this._prevT = now;
    }
  }

  _drawOverlay() {
    const canvas = this.overlay;
    const w = canvas.width, h = canvas.height;
    const ctx = this.octx;
    ctx.clearRect(0, 0, w, h);

    this._updateAngularSpeed();
    this._drawMiniMap(ctx, w, h);

    if (this.currentIndex < 0) return;
    const target = this.targets[this.currentIndex];
    const proj = this._projectToView(target.yaw, target.pitch);

    const roll = this.tracker.roll || 0;
    const level = Math.abs(roll) <= this.settings.rollLimit;
    const steady = this._angSpeed <= this.settings.steadyLimit;

    let aligned = false;
    if (proj.visible && proj.onScreen) {
      const cx = w / 2 + proj.nx * (w / 2);
      const cy = h / 2 - proj.ny * (h / 2);
      // Euclidean, to match the circular hole drawn below: a point that
      // visually looks inside the hole must always count as aligned, or
      // the guide feels broken ("I put the dot in the hole and nothing
      // happens"). Deriving holeR from the same tolerance value (scaled by
      // the smaller screen dimension) guarantees that.
      const distNorm = Math.sqrt(proj.nx * proj.nx + proj.ny * proj.ny);
      const onTarget = distNorm <= this.settings.tolerance && level;
      aligned = onTarget && steady;

      const rectW = Math.min(w, h) * 0.42;
      const rectH = rectW * 1.35;
      const holeR = this.settings.tolerance * (Math.min(w, h) / 2);
      // Amber while the aim is right but the phone is still moving, so the
      // wait reads as "hold still" rather than as the guide being broken.
      const frameColor = aligned ? '#ffffff' : (onTarget ? '#ffcc33' : FLUO_BLUE);
      drawTargetFrame(ctx, cx, cy, rectW, rectH, holeR, frameColor);

      // Once the aim circle is close to the target's hole, show a second
      // rectangle tracing the phone's *actual current* roll/tilt: the user
      // rotates the phone until this white outline lines up with the
      // (axis-aligned) target frame above it.
      const nearHole = distNorm <= this.settings.tolerance * 2.2;
      if (nearHole) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-roll * d2r);
        ctx.lineWidth = 3;
        ctx.strokeStyle = level ? 'rgba(255,255,255,0.95)' : 'rgba(255,204,51,0.95)';
        roundRectPath(ctx, -rectW / 2 - 7, -rectH / 2 - 7, rectW + 14, rectH + 14, 18);
        ctx.stroke();
        ctx.restore();
      }
    } else {
      // Off-screen: draw a directional arrow at the edge pointing toward
      // target. Worked entirely in canvas pixel space (+x = right, +y =
      // down) to avoid the math-convention/screen-convention sign mixing
      // that previously made the arrow point vertically backwards (it used
      // atan2(-ny, nx) for the angle but then *also* negated sin(angle)
      // when placing it on screen, double-flipping the vertical sign).
      //
      // Beyond ~87 degrees of separation the gnomonic projection is
      // undefined (proj.visible is false) - fall back to a plain yaw/pitch
      // bearing so the arrow still points up/down as well as left/right.
      let dx, dy;
      if (proj.visible) {
        dx = proj.nx;
        dy = -proj.ny; // +ny (target above) -> screen up -> negative canvas dy
      } else {
        dx = angleDiff(target.yaw, this.tracker.yaw);
        dy = -(target.pitch - this.tracker.pitch);
      }
      const mag = Math.hypot(dx, dy) || 1;
      const ux = dx / mag, uy = dy / mag;
      const R = w / 2 - 60;
      const rx = w / 2 + ux * R;
      const ry = h / 2 + uy * R;
      const rot = Math.atan2(uy, ux); // canvas rotate: local +x maps to (cos,sin) = (ux,uy)

      ctx.save();
      ctx.translate(rx, ry);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(20, 0); ctx.lineTo(-14, 14); ctx.lineTo(-14, -14);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 4; ctx.stroke();
      ctx.fillStyle = '#ffcc33';
      ctx.fill();
      ctx.restore();
    }

    // Fixed aim crosshair (bore-sight): always screen-center, drawn last
    // so it stays on top of the target frame/hole beneath it.
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 15, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    this._emit('progress', {
      done: this.doneCount(), total: this.totalCount(), aligned, level, steady,
      rowPitch: target.pitch,
    });

    if (aligned && this.settings.autoCapture) {
      if (this._alignedSince == null) this._alignedSince = performance.now();
      const now = performance.now();
      const cooledDown = now >= (this._cooldownUntil || 0);
      if (!this._captureBusy && cooledDown && now - this._alignedSince >= this.settings.holdMs) {
        this._captureBusy = true;
        // Hard floor on top of the hold-timer reset in _advanceToNextPending:
        // guarantees a visible beat between two captures even if some other
        // edge case leaves alignment continuously true across the switch.
        this._cooldownUntil = now + this.settings.holdMs;
        this.captureCurrent().finally(() => { this._captureBusy = false; });
      }
    } else {
      this._alignedSince = null;
    }
  }

  async captureCurrent() {
    if (this.currentIndex < 0) return false;
    const target = this.targets[this.currentIndex];
    // Snapshot the actual measured basis vectors (not just yaw/pitch/roll
    // scalars) so the aligner can compensate for any roll exactly - see
    // orientation.js for why re-deriving a rotation from the roll angle
    // alone isn't reliable in this pose. These are only a starting guess:
    // align.js refines them against the neighbouring shots' pixels.
    const basis = {
      right: this.tracker.rightVec.slice(),
      up: this.tracker.upVec.slice(),
      forward: this.tracker.forwardVec.slice(),
    };

    this._shotCtx.drawImage(this.video, 0, 0, STORE_W, STORE_H);
    const imageData = this._shotCtx.getImageData(0, 0, STORE_W, STORE_H);
    this.shots.push(prepareShot(imageData, basis));

    target.done = true;
    if (navigator.vibrate) navigator.vibrate(40);

    const thumb = document.createElement('canvas');
    thumb.width = 96; thumb.height = 72;
    thumb.getContext('2d').drawImage(this._shotCanvas, 0, 0, 96, 72);
    this._emit('shot', { dataUrl: thumb.toDataURL('image/jpeg', 0.6), index: this.currentIndex });

    this._advanceToNextPending();
    if (this.currentIndex < 0) {
      this._running = false;
      this._emit('done', this.shots);
    }
    return true;
  }

  skipCurrent() {
    if (this.currentIndex < 0) return;
    this.targets[this.currentIndex].done = true;
    this._advanceToNextPending();
    if (this.currentIndex < 0) {
      this._running = false;
      this._emit('done', this.shots);
    }
  }

  finishEarly() {
    this._running = false;
    this._emit('done', this.shots);
  }
}
