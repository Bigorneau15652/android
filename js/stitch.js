// Equirectangular accumulation buffer: each captured shot is reprojected
// with a gnomonic (rectilinear/pinhole) forward projection and blended in
// with a soft edge feather, based on its *measured* yaw/pitch at capture
// time (roll assumed ~0 - the capture screen enforces that visually).
//
// This is intentionally the "simple" tier from CLAUDE.md decisions: no
// feature matching / no true multi-band blending, just weighted averaging
// of overlapping shots, which is enough to avoid hard seams while staying
// small and fast enough to run on a phone in the browser.

import { angleDiff } from './orientation.js';

const d2r = Math.PI / 180;

export class EquirectAccumulator {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.colorSum = new Float32Array(width * height * 3);
    this.weightSum = new Float32Array(width * height);
  }

  // shotCanvas: HTMLCanvasElement/OffscreenCanvas already holding the
  // captured frame. yawC/pitchC in degrees, hFovDeg/vFovDeg the assumed
  // camera field of view for that frame's aspect ratio.
  addShot(shotCanvas, yawC, pitchC, hFovDeg, vFovDeg) {
    const sw = shotCanvas.width, sh = shotCanvas.height;
    const sctx = shotCanvas.getContext('2d');
    const srcData = sctx.getImageData(0, 0, sw, sh).data;

    const tanHalfH = Math.tan((hFovDeg / 2) * d2r);
    const tanHalfV = Math.tan((vFovDeg / 2) * d2r);
    const phi1 = pitchC * d2r;
    const sinPhi1 = Math.sin(phi1), cosPhi1 = Math.cos(phi1);

    // Bounding box in equirect space, with generous margin for pole
    // distortion where a fixed-FOV cone covers a much wider longitude range.
    const marginLon = Math.min(179, (hFovDeg / 2) / Math.max(0.15, Math.cos(phi1)) + 5);
    const marginLat = vFovDeg / 2 + 5;
    const lonMin = yawC - marginLon, lonMax = yawC + marginLon;
    const latMin = Math.max(-90, pitchC - marginLat);
    const latMax = Math.min(90, pitchC + marginLat);

    const rowMin = Math.max(0, Math.floor(((90 - latMax) / 180) * this.height));
    const rowMax = Math.min(this.height - 1, Math.ceil(((90 - latMin) / 180) * this.height));

    const W = this.width, H = this.height;
    for (let row = rowMin; row <= rowMax; row++) {
      const phi = (90 - (row / H) * 180) * d2r;
      const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
      for (let colOffset = -Math.ceil((marginLon / 360) * W); colOffset <= Math.ceil((marginLon / 360) * W); colOffset++) {
        const colBase = Math.round((yawC / 360) * W) + colOffset;
        let col = colBase % W; if (col < 0) col += W;
        const lambda = (col / W) * 360;
        const dLambda = angleDiff(lambda, yawC) * d2r;

        const cosc = sinPhi1 * sinPhi + cosPhi1 * cosPhi * Math.cos(dLambda);
        if (cosc <= 0.15) continue; // behind or too far off-axis

        const x = (cosPhi * Math.sin(dLambda)) / cosc;
        const y = (cosPhi1 * sinPhi - sinPhi1 * cosPhi * Math.cos(dLambda)) / cosc;

        const nx = x / tanHalfH; // -1..1 across frame width
        const ny = y / tanHalfV; // -1..1 across frame height
        if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue;

        const px = (nx * 0.5 + 0.5) * (sw - 1);
        const py = (0.5 - ny * 0.5) * (sh - 1);

        const sample = bilinear(srcData, sw, sh, px, py);
        if (!sample) continue;

        // Feather weight: fades to 0 at the frame edge so overlaps blend.
        const edge = 1 - Math.max(Math.abs(nx), Math.abs(ny));
        const weight = Math.max(0.0001, smoothstep(0, 0.35, edge));

        const di = row * W + col;
        this.weightSum[di] += weight;
        this.colorSum[di * 3] += sample[0] * weight;
        this.colorSum[di * 3 + 1] += sample[1] * weight;
        this.colorSum[di * 3 + 2] += sample[2] * weight;
      }
    }
  }

  // Resolves the accumulation buffers into a canvas, filling any
  // still-empty pixels (usually near the poles if zenith/nadir shots were
  // skipped) by extending the nearest valid pixel in that column.
  toCanvas() {
    const { width: W, height: H, colorSum, weightSum } = this;
    const out = new Uint8ClampedArray(W * H * 4);
    const filled = new Uint8Array(W * H);

    for (let i = 0; i < W * H; i++) {
      const w = weightSum[i];
      if (w > 0) {
        out[i * 4] = colorSum[i * 3] / w;
        out[i * 4 + 1] = colorSum[i * 3 + 1] / w;
        out[i * 4 + 2] = colorSum[i * 3 + 2] / w;
        out[i * 4 + 3] = 255;
        filled[i] = 1;
      }
    }

    // Column-wise nearest-fill from the closest filled row (handles empty
    // caps near the poles without needing dedicated zenith/nadir shots).
    for (let col = 0; col < W; col++) {
      let lastFilled = -1;
      for (let row = 0; row < H; row++) {
        const i = row * W + col;
        if (filled[i]) { lastFilled = row; continue; }
        if (lastFilled >= 0) {
          const si = (lastFilled * W + col) * 4;
          out[i * 4] = out[si]; out[i * 4 + 1] = out[si + 1];
          out[i * 4 + 2] = out[si + 2]; out[i * 4 + 3] = 255;
        }
      }
      lastFilled = -1;
      for (let row = H - 1; row >= 0; row--) {
        const i = row * W + col;
        if (filled[i]) { lastFilled = row; continue; }
        if (out[i * 4 + 3] === 0 && lastFilled >= 0) {
          const si = (lastFilled * W + col) * 4;
          out[i * 4] = out[si]; out[i * 4 + 1] = out[si + 1];
          out[i * 4 + 2] = out[si + 2]; out[i * 4 + 3] = 255;
        }
      }
    }
    // Any pixel still empty (a whole empty column - only if very few shots
    // were taken) gets mid-grey so export never contains transparency.
    for (let i = 0; i < W * H; i++) {
      if (out[i * 4 + 3] === 0) {
        out[i * 4] = 128; out[i * 4 + 1] = 128; out[i * 4 + 2] = 128; out[i * 4 + 3] = 255;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(out, W, H), 0, 0);
    return canvas;
  }

  // Fraction of pixels that received at least one contribution (0..1) -
  // used to warn the user if coverage looks too sparse before export.
  coverage() {
    let filled = 0;
    for (let i = 0; i < this.weightSum.length; i++) if (this.weightSum[i] > 0) filled++;
    return filled / this.weightSum.length;
  }
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function bilinear(data, w, h, px, py) {
  if (px < 0 || py < 0 || px > w - 1 || py > h - 1) return null;
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = px - x0, fy = py - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
    const bot = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out;
}

// Derives vertical FOV from horizontal FOV + capture frame aspect ratio,
// assuming a standard rectilinear (non-fisheye) lens model.
export function verticalFovFromHorizontal(hFovDeg, width, height) {
  const hFovRad = hFovDeg * d2r;
  const vFovRad = 2 * Math.atan(Math.tan(hFovRad / 2) * (height / width));
  return vFovRad / d2r;
}
