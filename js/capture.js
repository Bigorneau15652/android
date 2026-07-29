// Drives the capture screen: camera stream, orientation-guided reticle
// overlay, auto/manual shutter, and feeding each accepted frame into the
// EquirectAccumulator immediately (kept out of memory afterwards) so peak
// RAM stays low even for a dense grid on a phone browser.

import { angleDiff } from './orientation.js';
import { EquirectAccumulator, verticalFovFromHorizontal } from './stitch.js';

const d2r = Math.PI / 180;
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
  constructor({ video, overlayCanvas, tracker, targets, settings, outputWidth, outputHeight }) {
    this.video = video;
    this.overlay = overlayCanvas;
    this.octx = overlayCanvas.getContext('2d');
    this.tracker = tracker;
    this.targets = targets.map((t) => ({ ...t, done: false }));
    this.currentIndex = 0;
    this.settings = settings; // { hFov, tolerance, autoCapture, captureW, captureH, holdMs, rollLimit }
    this.vFov = verticalFovFromHorizontal(settings.hFov, settings.captureW, settings.captureH);
    this.accumulator = new EquirectAccumulator(outputWidth, outputHeight);
    this.stream = null;
    this._running = false;
    this._alignedSince = null;
    this._captureBusy = false;
    this.listeners = { progress: [], shot: [], done: [], error: [] };
    this._shotCanvas = document.createElement('canvas');
    this._shotCanvas.width = settings.captureW;
    this._shotCanvas.height = settings.captureH;
    this._shotCtx = this._shotCanvas.getContext('2d', { willReadFrequently: true });
  }

  on(event, fn) { this.listeners[event].push(fn); }
  _emit(event, ...args) { for (const fn of this.listeners[event]) fn(...args); }

  async startCamera() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: this.settings.captureW },
        height: { ideal: this.settings.captureH },
      },
    });
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

  _drawOverlay() {
    const canvas = this.overlay;
    const w = canvas.width, h = canvas.height;
    const ctx = this.octx;
    ctx.clearRect(0, 0, w, h);

    this._drawMiniMap(ctx, w, h);

    if (this.currentIndex < 0) return;
    const target = this.targets[this.currentIndex];
    const proj = this._projectToView(target.yaw, target.pitch);

    const roll = this.tracker.roll || 0;
    const level = Math.abs(roll) <= this.settings.rollLimit;

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
      aligned = distNorm <= this.settings.tolerance && level;

      const rectW = Math.min(w, h) * 0.42;
      const rectH = rectW * 1.35;
      const holeR = this.settings.tolerance * (Math.min(w, h) / 2);
      const frameColor = aligned ? '#ffffff' : FLUO_BLUE;
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
      // target. Beyond ~87 degrees of separation the gnomonic projection
      // is undefined (proj.visible is false) - fall back to a plain
      // yaw/pitch bearing so the arrow still points up/down as well as
      // left/right instead of collapsing to a left-right-only hint, which
      // was why tilting up for the top row/zenith shots felt like the
      // guide "lost" the target.
      let angle;
      if (proj.visible) {
        angle = Math.atan2(-proj.ny, proj.nx);
      } else {
        const dy = angleDiff(target.yaw, this.tracker.yaw);
        const dp = target.pitch - this.tracker.pitch;
        angle = Math.atan2(dp, dy);
      }
      const rx = w / 2 + Math.cos(angle) * (w / 2 - 60);
      const ry = h / 2 - Math.sin(angle) * (h / 2 - 60);
      ctx.save();
      ctx.translate(rx, ry);
      ctx.rotate(-angle);
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
      done: this.doneCount(), total: this.totalCount(), aligned, level,
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
    const yawC = this.tracker.yaw, pitchC = this.tracker.pitch;

    const { captureW: cw, captureH: ch } = this.settings;
    this._shotCtx.drawImage(this.video, 0, 0, cw, ch);
    this.accumulator.addShot(this._shotCanvas, yawC, pitchC, this.settings.hFov, this.vFov);

    target.done = true;
    if (navigator.vibrate) navigator.vibrate(40);

    const thumb = document.createElement('canvas');
    thumb.width = 96; thumb.height = 72;
    thumb.getContext('2d').drawImage(this._shotCanvas, 0, 0, 96, 72);
    this._emit('shot', { dataUrl: thumb.toDataURL('image/jpeg', 0.6), index: this.currentIndex });

    this._advanceToNextPending();
    if (this.currentIndex < 0) {
      this._running = false;
      this._emit('done', this.accumulator);
    }
    return true;
  }

  skipCurrent() {
    if (this.currentIndex < 0) return;
    this.targets[this.currentIndex].done = true;
    this._advanceToNextPending();
    if (this.currentIndex < 0) {
      this._running = false;
      this._emit('done', this.accumulator);
    }
  }

  finishEarly() {
    this._running = false;
    this._emit('done', this.accumulator);
  }
}
