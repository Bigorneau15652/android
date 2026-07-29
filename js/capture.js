// Drives the capture screen: camera stream, orientation-guided reticle
// overlay, auto/manual shutter, and feeding each accepted frame into the
// EquirectAccumulator immediately (kept out of memory afterwards) so peak
// RAM stays low even for a dense grid on a phone browser.

import { angleDiff } from './orientation.js';
import { EquirectAccumulator, verticalFovFromHorizontal } from './stitch.js';

const d2r = Math.PI / 180;

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
    if (this.targets.every((t) => t.done)) { this.currentIndex = -1; return; }
    // Pick the nearest not-done target to current yaw/pitch for shorter panning.
    const yaw = this.tracker.yaw, pitch = this.tracker.pitch;
    let best = -1, bestDist = Infinity;
    this.targets.forEach((t, i) => {
      if (t.done) return;
      const dy = angleDiff(t.yaw, yaw), dp = t.pitch - pitch;
      const dist = dy * dy + dp * dp;
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    this.currentIndex = best;
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

  _drawOverlay() {
    const canvas = this.overlay;
    const w = canvas.width, h = canvas.height;
    const ctx = this.octx;
    ctx.clearRect(0, 0, w, h);

    if (this.currentIndex < 0) return;
    const target = this.targets[this.currentIndex];
    const proj = this._projectToView(target.yaw, target.pitch);

    // Roll (level) indicator bar at the bottom. Drawn with a dark outline
    // behind the colored line so it stays legible against any camera
    // background (bright sky, white wall, ...), not just by chance.
    const roll = this.tracker.roll || 0;
    const level = Math.abs(roll) <= this.settings.rollLimit;
    ctx.save();
    ctx.translate(w / 2, h - 60);
    const rr = -roll * d2r;
    const x0 = -70 * Math.cos(rr), y0 = -70 * Math.sin(rr);
    const x1 = 70 * Math.cos(rr), y1 = 70 * Math.sin(rr);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 8; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.strokeStyle = level ? '#3ddc84' : '#ffcc33'; ctx.lineWidth = 4; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, 7);
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, 7);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.restore();

    let aligned = false;
    if (proj.visible && proj.onScreen) {
      const cx = w / 2 + proj.nx * (w / 2);
      const cy = h / 2 - proj.ny * (h / 2) * (w / h < 1 ? 1 : 1);
      const distNorm = Math.max(Math.abs(proj.nx), Math.abs(proj.ny));
      aligned = distNorm <= this.settings.tolerance && level;
      const ringColor = aligned ? '#3ddc84' : '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, 46, 0, Math.PI * 2);
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 46, 0, Math.PI * 2);
      ctx.lineWidth = 5;
      ctx.strokeStyle = ringColor;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = ringColor;
      ctx.fill();
    } else {
      // Off-screen: draw a directional arrow at the edge pointing toward target.
      const angle = Math.atan2(-proj.ny || 0, proj.nx || (angleDiff(target.yaw, this.tracker.yaw) >= 0 ? 1 : -1));
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

    this._emit('progress', {
      done: this.doneCount(), total: this.totalCount(), aligned, level,
      rowPitch: target.pitch,
    });

    if (aligned && this.settings.autoCapture) {
      if (this._alignedSince == null) this._alignedSince = performance.now();
      if (!this._captureBusy && performance.now() - this._alignedSince >= this.settings.holdMs) {
        this._captureBusy = true;
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
