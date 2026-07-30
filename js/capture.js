// Drives the capture screen: camera stream, orientation-guided reticle
// overlay, auto/manual shutter, and collecting each accepted frame.
//
// Frames are kept (downscaled) rather than stitched on the fly, because
// the post-capture refinement in align.js needs to compare shots against
// each other to correct the sensor's orientation error and the assumed
// lens FOV - impossible once they've been flattened into one buffer.

import { angleDiff } from './orientation.js';
import { prepareShot } from './align.js';

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
const FLUO_GREEN = '#39ff6a';

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

// Yaw target: a thick ring the fixed center dot must slide into. A dark
// halo is drawn behind the colored ring so it stays visible against both
// bright and dark camera backgrounds.
function drawRing(ctx, cx, cy, r, thickness, color) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = thickness + 5;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = thickness;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.92;
  ctx.stroke();
  ctx.restore();
}

// Off-screen yaw target: a real arrow (shaft + single head), not a bare
// triangle - a triangle's three corners each look like they could be "the"
// point, which is exactly what made the old off-screen indicator ambiguous.
// Only ever points left or right now that the ring handles yaw alone, so
// there's no diagonal case to get wrong.
function drawHorizontalArrow(ctx, w, h, dir) {
  const cy = h / 2;
  const cx = dir > 0 ? w - 66 : 66;
  ctx.save();
  ctx.translate(cx, cy);
  if (dir < 0) ctx.scale(-1, 1);
  ctx.beginPath();
  ctx.moveTo(-26, -7); ctx.lineTo(6, -7); ctx.lineTo(6, -18); ctx.lineTo(30, 0);
  ctx.lineTo(6, 18); ctx.lineTo(6, 7); ctx.lineTo(-26, 7);
  ctx.closePath();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = '#ffcc33';
  ctx.fill();
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
    this.settings = settings; // { hFov, yawToleranceDeg, pitchToleranceDeg, autoCapture, holdMs, rollLimit, steadyLimit }
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

  // Horizontal bar (roulis/roll): a fixed dashed reference line plus a
  // solid bar that rotates with the phone's actual roll, exactly like a
  // real spirit level - turn the phone until the solid bar lies flat on
  // the dashed one. Turns fluo green once level, independently of yaw/pitch.
  _drawLevelBar(ctx, w, h, roll, rollOk) {
    const barW = Math.min(w, h) * 0.5;
    // Below the top icon bar (~64px) *and* the guidance banner that can
    // show right above it (up to ~140px, wrapped to two lines on a narrow
    // screen) - drawing it any higher gets it hidden under that banner
    // exactly when rollOk is false, i.e. exactly when it's needed most.
    const cx = w / 2, cy = 170;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(cx - barW / 2, cy); ctx.lineTo(cx + barW / 2, cy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.translate(cx, cy);
    ctx.rotate(-roll * d2r);
    const color = rollOk ? FLUO_GREEN : '#141414';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.beginPath(); ctx.moveTo(-barW / 2, 0); ctx.lineTo(barW / 2, 0); ctx.stroke();
    ctx.lineWidth = 6;
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(-barW / 2, 0); ctx.lineTo(barW / 2, 0); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(-barW / 2, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(barW / 2, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Vertical bar (inclinaison/pitch): a track on the screen's right edge
  // with a marker sliding up when the target's row needs more upward tilt,
  // down when it needs less - independent of yaw, since a whole row shares
  // the same target pitch and this stays valid while sweeping across it.
  // Kept entirely in the top-right corner, well clear of the row the ring
  // travels along (screen vertical center) - the ring's on-screen range
  // can get close to either screen edge, and a track spanning the center
  // row would visually collide with it there. Living in its own strip
  // above the ring's row means the two can never overlap regardless of
  // how far the ring has slid horizontally.
  _drawTiltBar(ctx, w, h, pitchError, pitchOk) {
    const maxRangeDeg = 30;
    const trackH = Math.min(h * 0.16, 120);
    const x = w - 40;
    const cy = 170; // same height as the level bar, opposite side of the screen
    const y0 = cy - trackH / 2, y1 = cy + trackH / 2;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20,20,20,0.9)';
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();

    // Sweet-spot band, sized from the actual tolerance so it's an honest
    // preview of how much slack there is, not just a fixed decoration.
    const tolFrac = Math.min(1, this.settings.pitchToleranceDeg / maxRangeDeg);
    const bandHalf = (trackH / 2) * tolFrac;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(57,255,106,0.35)';
    ctx.beginPath(); ctx.moveTo(x, cy - bandHalf); ctx.lineTo(x, cy + bandHalf); ctx.stroke();

    // pitchError > 0 means the target sits above the current aim -> marker
    // above center, telling the user which way to tilt to chase it.
    const clamped = Math.max(-maxRangeDeg, Math.min(maxRangeDeg, pitchError));
    const my = cy - (clamped / maxRangeDeg) * (trackH / 2);
    ctx.beginPath();
    ctx.arc(x, my, 11, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, my, 8, 0, Math.PI * 2);
    ctx.fillStyle = pitchOk ? FLUO_GREEN : '#ffffff';
    ctx.fill();
    ctx.restore();
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

    // Three independent gauges, one rotation axis each, so correcting one
    // never visually disturbs the others: yaw (ring), pitch (tilt bar),
    // roll (level bar). All three must read "good" at once (plus holding
    // still) before a shot is taken.
    const roll = this.tracker.roll || 0;
    const rollOk = Math.abs(roll) <= this.settings.rollLimit;

    const pitchError = target.pitch - this.tracker.pitch;
    const pitchOk = Math.abs(pitchError) <= this.settings.pitchToleranceDeg;

    const dYaw = angleDiff(target.yaw, this.tracker.yaw);
    const yawOk = Math.abs(dYaw) <= this.settings.yawToleranceDeg;

    const steady = this._angSpeed <= this.settings.steadyLimit;
    const aligned = yawOk && pitchOk && rollOk && steady;

    // Ring stays purely horizontal: its screen x comes only from the yaw
    // difference (a plain single-angle gnomonic projection, pitch is never
    // part of this), its y is fixed at screen center.
    //
    // The on-screen check must compare nx itself against the screen-space
    // bound (not dYaw in degrees against an angular bound) - tan() is
    // nonlinear, so those two comparisons diverge well before the edge of
    // the screen, letting the ring silently render far outside the canvas
    // with no arrow ever appearing to replace it. The <90 degree guard
    // additionally stops tan()'s sign flip past the asymptote from making
    // a target almost directly behind the phone look like a small,
    // "on-screen" nx.
    const tanHalfH = Math.tan((this.settings.hFov / 2) * d2r);
    const nx = Math.abs(dYaw) < 85 ? Math.tan(dYaw * d2r) / tanHalfH : Infinity;
    if (Math.abs(nx) <= 1.15) {
      const cx = w / 2 + nx * (w / 2);
      const cy = h / 2;
      const ringR = Math.min(w, h) * 0.14;
      // Amber while the aim is right but the phone is still moving, so the
      // wait reads as "hold still" rather than as the guide being broken.
      const ringColor = aligned ? '#ffffff' : (yawOk ? '#ffcc33' : FLUO_BLUE);
      drawRing(ctx, cx, cy, ringR, 12, ringColor);
    } else {
      drawHorizontalArrow(ctx, w, h, dYaw > 0 ? 1 : -1);
    }

    this._drawLevelBar(ctx, w, h, roll, rollOk);
    this._drawTiltBar(ctx, w, h, pitchError, pitchOk);

    // Fixed aim dot (bore-sight): always screen-center, drawn last so it
    // stays on top of the ring.
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 15, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    this._emit('progress', {
      done: this.doneCount(), total: this.totalCount(), aligned,
      yawOk, pitchOk, rollOk, steady, rowPitch: target.pitch,
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
    this.shots.push(prepareShot(imageData, basis, { yaw: target.yaw, pitch: target.pitch }));

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
