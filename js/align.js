// Post-capture panorama refinement and rendering.
//
// The gyroscope alone is not accurate enough to stitch cleanly: its
// orientation drifts a few degrees, and more importantly the *assumed*
// lens field of view is a guess. A wrong FOV places the same real-world
// object at two different spots when it appears near the edge of two
// neighbouring shots - which is exactly the "everything is duplicated"
// failure this module exists to fix.
//
// So instead of trusting the sensors, we treat the sensor values as a
// starting guess and then refine, by actually comparing the pixels of
// overlapping shots (normalized cross-correlation on greyscale):
//   1. estimate the global horizontal FOV,
//   2. refine every shot's orientation against its neighbours,
//   3. estimate a radial distortion coefficient (phone lenses are not
//      perfectly rectilinear; ignoring that misaligns frame edges),
//   4. equalize exposure between shots,
//   5. render the equirectangular result with feathered blending.
//
// This is the part that takes ~10-60s, like the processing step in
// dedicated panorama apps. It cannot fix parallax (camera translating
// between shots rather than rotating in place) - nothing rotation-based
// can - which is why the in-app tutorial asks the user to keep the phone
// close to their body while turning.

const d2r = Math.PI / 180;

export function verticalFovFromHorizontal(hFovDeg, width, height) {
  const vFovRad = 2 * Math.atan(Math.tan((hFovDeg * d2r) / 2) * (height / width));
  return vFovRad / d2r;
}

// ---------------- small vector helpers ----------------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm(v) {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
}
// Rodrigues rotation of v around unit axis k by angle ang (radians).
function axisRot(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return [
    v[0] * c + kv[0] * s + k[0] * kd,
    v[1] * c + kv[1] * s + k[1] * kd,
    v[2] * c + kv[2] * s + k[2] * kd,
  ];
}

// Applies a small camera-frame rotation (degrees) to a basis.
export function rotateBasis(basis, dyawDeg, dpitchDeg, drollDeg) {
  let { right, up, forward } = basis;
  if (dyawDeg) {
    const a = dyawDeg * d2r;
    right = axisRot(right, up, a);
    forward = axisRot(forward, up, a);
  }
  if (dpitchDeg) {
    const a = dpitchDeg * d2r;
    up = axisRot(up, right, a);
    forward = axisRot(forward, right, a);
  }
  if (drollDeg) {
    const a = drollDeg * d2r;
    right = axisRot(right, forward, a);
    up = axisRot(up, forward, a);
  }
  return { right: norm(right), up: norm(up), forward: norm(forward) };
}

// ---------------- shot preparation ----------------

// A "shot" holds the captured frame plus the sensor-measured camera basis.
// We also precompute a small greyscale version used for matching: the
// optimizer only ever needs coarse structure, and working at ~160x120
// makes each candidate evaluation cheap enough to search thousands of them.
export function prepareShot(imageData, basis) {
  const { width: w, height: h, data } = imageData;
  const gw = 160, gh = Math.max(1, Math.round((h / w) * 160));
  const gray = new Float32Array(gw * gh);
  const sx = w / gw, sy = h / gh;
  for (let y = 0; y < gh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(h, Math.floor((y + 1) * sy));
    for (let x = 0; x < gw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(w, Math.floor((x + 1) * sx));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n++;
        }
      }
      gray[y * gw + x] = n ? sum / n : 0;
    }
  }
  return {
    imageData, w, h, gray, gw, gh,
    basis: { right: [...basis.right], up: [...basis.up], forward: [...basis.forward] },
    baseBasis: { right: [...basis.right], up: [...basis.up], forward: [...basis.forward] },
    gain: 1,
  };
}

// ---------------- projection ----------------
// "ideal" coords are normalized image coords in [-1,1] BEFORE lens
// distortion; the distortion model maps them to actual sensor position.
// Sampling always goes ideal -> distorted -> pixel, so the forward model
// is used consistently everywhere and never needs inverting.

function distort(nx, ny, k1) {
  if (!k1) return [nx, ny];
  const f = 1 + k1 * (nx * nx + ny * ny);
  return [nx * f, ny * f];
}

function rayFromIdeal(basis, nx, ny, tanH, tanV) {
  const x = nx * tanH, y = ny * tanV;
  return norm([
    x * basis.right[0] + y * basis.up[0] + basis.forward[0],
    x * basis.right[1] + y * basis.up[1] + basis.forward[1],
    x * basis.right[2] + y * basis.up[2] + basis.forward[2],
  ]);
}

// Returns [nx, ny] ideal coords, or null if behind the camera.
function idealFromRay(basis, ray, tanH, tanV) {
  const Z = dot(ray, basis.forward);
  if (Z <= 1e-4) return null;
  return [
    (dot(ray, basis.right) / Z) / tanH,
    (dot(ray, basis.up) / Z) / tanV,
  ];
}

function sampleGray(shot, nx, ny, k1) {
  const [dx, dy] = distort(nx, ny, k1);
  if (dx < -1 || dx > 1 || dy < -1 || dy > 1) return -1;
  const px = (dx * 0.5 + 0.5) * (shot.gw - 1);
  const py = (0.5 - dy * 0.5) * (shot.gh - 1);
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(shot.gw - 1, x0 + 1), y1 = Math.min(shot.gh - 1, y0 + 1);
  const fx = px - x0, fy = py - y0;
  const g = shot.gray;
  const top = g[y0 * shot.gw + x0] * (1 - fx) + g[y0 * shot.gw + x1] * fx;
  const bot = g[y1 * shot.gw + x0] * (1 - fx) + g[y1 * shot.gw + x1] * fx;
  return top * (1 - fy) + bot * fy;
}

// ---------------- matching ----------------

function neighboursOf(shots, i, hFovDeg) {
  // Two shots can only be matched where they overlap, so only consider
  // shots whose viewing directions are closer than roughly one FOV apart.
  const limit = Math.cos(Math.min(85, hFovDeg * 0.95) * d2r);
  const out = [];
  for (let j = 0; j < shots.length; j++) {
    if (j === i) continue;
    const c = dot(shots[i].basis.forward, shots[j].basis.forward);
    if (c > limit) out.push({ j, c });
  }
  out.sort((a, b) => b.c - a.c);
  return out.slice(0, 5).map((o) => o.j);
}

// Collects, once per refinement of shot i, the world rays + greyscale
// values contributed by its neighbours. Candidate orientations for i can
// then be scored cheaply by only re-projecting these fixed rays.
function gatherNeighbourSamples(shots, i, neighbours, params) {
  const { tanH, tanV, k1 } = params;
  const groups = [];
  const STEP = 24;
  for (const j of neighbours) {
    const other = shots[j];
    const rays = [];
    const vals = [];
    for (let a = 0; a < STEP; a++) {
      const nx = -0.85 + (1.7 * a) / (STEP - 1);
      for (let b = 0; b < 18; b++) {
        const ny = -0.85 + (1.7 * b) / 17;
        const v = sampleGray(other, nx, ny, k1);
        if (v < 0) continue;
        rays.push(rayFromIdeal(other.basis, nx, ny, tanH, tanV));
        vals.push(v);
      }
    }
    if (rays.length >= 30) groups.push({ rays, vals });
  }
  return groups;
}

// Normalized cross-correlation of shot i (under a candidate basis)
// against the pre-gathered neighbour samples. Scale/offset invariant, so
// exposure differences between shots don't skew the alignment.
function scoreBasis(shot, basis, groups, params) {
  const { tanH, tanV, k1 } = params;
  let total = 0, totalPossible = 0;
  for (const g of groups) {
    totalPossible += g.rays.length;
    const n = g.rays.length;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, cnt = 0;
    for (let t = 0; t < n; t++) {
      const ideal = idealFromRay(basis, g.rays[t], tanH, tanV);
      if (!ideal) continue;
      const nx = ideal[0], ny = ideal[1];
      if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue;
      const vi = sampleGray(shot, nx, ny, k1);
      if (vi < 0) continue;
      const vj = g.vals[t];
      sa += vj; sb += vi; saa += vj * vj; sbb += vi * vi; sab += vj * vi; cnt++;
    }
    if (cnt < 30) continue;
    const va = saa - (sa * sa) / cnt;
    const vb = sbb - (sb * sb) / cnt;
    if (va <= 1e-6 || vb <= 1e-6) continue;
    const ncc = (sab - (sa * sb) / cnt) / Math.sqrt(va * vb);
    total += ncc * cnt;
  }
  // Divided by how many neighbour samples *could* have been matched, not
  // by how many actually were. Dividing by the matched count rewards a
  // configuration for quietly testing less area - and a too-small assumed
  // FOV does exactly that, since a local rotation can always fake a good
  // match over a small patch, which collapsed the solver towards absurdly
  // narrow FOV values. This denominator is fixed by the sampling grid, so
  // it is identical across candidates: a config wins only by explaining
  // MORE overlap well, never by explaining less.
  return totalPossible > 0 ? total / totalPossible : -2;
}

// Local coarse-to-fine search over (yaw, pitch, roll) corrections.
function refineShotOrientation(shots, i, params, stages) {
  const neighbours = neighboursOf(shots, i, params.hFovDeg);
  if (!neighbours.length) return 0;
  const groups = gatherNeighbourSamples(shots, i, neighbours, params);
  if (!groups.length) return 0;

  const start = shots[i].basis;
  let bestD = [0, 0, 0];
  let bestScore = scoreBasis(shots[i], start, groups, params);
  const baseScore = bestScore;

  for (const { step, radius, rollStep, rollRadius } of stages) {
    const c = bestD.slice();
    for (let dy = -radius; dy <= radius; dy += step) {
      for (let dp = -radius; dp <= radius; dp += step) {
        for (let dr = -rollRadius; dr <= rollRadius; dr += rollStep || 1) {
          const cand = [c[0] + dy, c[1] + dp, c[2] + dr];
          const basis = rotateBasis(start, cand[0], cand[1], cand[2]);
          const s = scoreBasis(shots[i], basis, groups, params);
          if (s > bestScore) { bestScore = s; bestD = cand; }
          if (!rollRadius) break;
        }
      }
    }
  }
  if (bestScore > baseScore) {
    shots[i].basis = rotateBasis(start, bestD[0], bestD[1], bestD[2]);
  }
  return bestScore;
}

const REFINE_STAGES = [
  { step: 2, radius: 6, rollStep: 2, rollRadius: 4 },
  { step: 0.75, radius: 1.5, rollStep: 1, rollRadius: 1 },
  { step: 0.25, radius: 0.5, rollStep: 0, rollRadius: 0 },
];
const QUICK_STAGES = [
  { step: 2, radius: 6, rollStep: 2, rollRadius: 2 },
  { step: 0.75, radius: 1.5, rollStep: 0, rollRadius: 0 },
];

function makeParams(hFovDeg, k1, shot) {
  const vFovDeg = verticalFovFromHorizontal(hFovDeg, shot.w, shot.h);
  return {
    hFovDeg, vFovDeg, k1,
    tanH: Math.tan((hFovDeg / 2) * d2r),
    tanV: Math.tan((vFovDeg / 2) * d2r),
  };
}

function snapshotBases(shots) {
  return shots.map((s) => ({
    right: [...s.basis.right], up: [...s.basis.up], forward: [...s.basis.forward],
  }));
}
function restoreBases(shots, snap) {
  shots.forEach((s, i) => {
    s.basis = { right: [...snap[i].right], up: [...snap[i].up], forward: [...snap[i].forward] };
  });
}

// Mean alignment quality across all shots, used to compare whole
// configurations (e.g. two candidate FOV values) against each other.
function configScore(shots, params) {
  let total = 0, n = 0;
  for (let i = 0; i < shots.length; i++) {
    const neighbours = neighboursOf(shots, i, params.hFovDeg);
    if (!neighbours.length) continue;
    const groups = gatherNeighbourSamples(shots, i, neighbours, params);
    if (!groups.length) continue;
    total += scoreBasis(shots[i], shots[i].basis, groups, params);
    n++;
  }
  return n ? total / n : -2;
}

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

// Evaluates one lens-model candidate. Always restarts from the supplied
// sensor orientations rather than from whatever the previous candidate
// converged to: chaining candidates biases the search badly, because the
// orientations bend to fit whichever FOV was tried first, that config then
// scores best simply because it was the one fitted, and the true FOV is
// never selected.
async function evaluateCandidate(shots, sensorBases, candFov, candK1) {
  restoreBases(shots, sensorBases);
  const params = makeParams(candFov, candK1, shots[0]);
  for (let i = 0; i < shots.length; i++) refineShotOrientation(shots, i, params, QUICK_STAGES);
  const score = configScore(shots, params);
  await yieldToUi();
  return { score, hFov: candFov, k1: candK1, bases: snapshotBases(shots) };
}

// Plain NCC between two shots' greyscale buffers, pixel-for-pixel with no
// reprojection: answers "are these the same picture?", not "do they align".
function rawFrameCorrelation(a, b) {
  const n = a.gray.length;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) {
    const x = a.gray[i], y = b.gray[i];
    sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 1e-6 || vb <= 1e-6) return 1; // featureless: treat as "unchanged"
  return (sab - (sa * sb) / n) / Math.sqrt(va * vb);
}

function sensorBasesOf(shots) {
  return shots.map((s) => ({
    right: [...s.baseBasis.right], up: [...s.baseBasis.up], forward: [...s.baseBasis.forward],
  }));
}

// Measures a lens's horizontal field of view from a short set of
// overlapping frames, without assuming anything about which lens it is.
// Used by the in-app calibration flow so the capture grid can be sized
// correctly *before* a real capture - important because an uncalibrated
// guess that is too narrow leaves holes in the sphere, and one that is
// too wide makes the user take far more photos than necessary.
// Returns { fov, score, reason }. fov is null when the result should not
// be trusted, with `reason` saying why, so the caller can tell the user
// what to do differently instead of silently storing a wrong value.
export async function calibrateFov(shots, options, onProgress) {
  // Lower bound is deliberately not "any lens that exists": below ~35
  // degrees a full sphere would need hundreds of shots, so such a value is
  // far more likely to be the optimizer sliding towards a degenerate
  // narrow-FOV solution than a lens someone is really panning with. An
  // estimate landing on the bound is reported as a failure rather than
  // stored.
  const { min = 35, max = 125, minScore = 0.35 } = options || {};
  if (shots.length < 3) return { fov: null, score: 0, reason: 'not_enough_frames' };

  // Sanity check before any fitting: if consecutive frames are essentially
  // the same picture while the sensor claims the phone turned, then the
  // camera feed and the sensor disagree about reality (frozen preview,
  // user not actually rotating, stuck sensor). Any FOV "measured" from
  // that is meaningless, and it scores high enough to slip past the
  // score threshold, so it has to be caught explicitly.
  let staticPairs = 0, comparablePairs = 0;
  for (let i = 0; i + 1 < shots.length; i++) {
    const a = shots[i], b = shots[i + 1];
    if (a.gw !== b.gw || a.gh !== b.gh) continue;
    comparablePairs++;
    if (rawFrameCorrelation(a, b) > 0.985) staticPairs++;
  }
  if (comparablePairs > 0 && staticPairs / comparablePairs > 0.5) {
    return { fov: null, score: 0, reason: 'no_movement' };
  }

  const sensorBases = sensorBasesOf(shots);
  let best = { score: -Infinity, hFov: null };

  const scan = async (from, to, step, label) => {
    const values = [];
    for (let v = from; v <= to + 1e-6; v += step) values.push(Math.round(v * 10) / 10);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < min || v > max) continue;
      const r = await evaluateCandidate(shots, sensorBases, v, 0);
      if (r.score > best.score) best = r;
      if (onProgress) onProgress((i + 1) / values.length, label);
    }
  };

  await scan(min, max, 10, 'Analyse de l’objectif');
  await scan(best.hFov - 8, best.hFov + 8, 3, 'Affinage');
  await scan(best.hFov - 2, best.hFov + 2, 1, 'Affinage précis');

  // Refuse to report a value we don't actually believe. Two tell-tale
  // signs of a failed calibration: the frames never really matched (low
  // score - blurry, dark or featureless scene, or the user translated
  // instead of rotating), or the optimum sits against the edge of the
  // search range, which means the true value is outside it or the score
  // surface is flat noise with no real optimum at all. Reporting a
  // confident-looking wrong FOV would be worse than reporting nothing,
  // since every later capture would be built on it.
  if (best.score < minScore) return { fov: null, score: best.score, reason: 'no_match' };
  if (best.hFov <= min + 1 || best.hFov >= max - 1) {
    return { fov: null, score: best.score, reason: 'out_of_range' };
  }
  return { fov: best.hFov, score: best.score, reason: null };
}

// ---------------- exposure equalization ----------------

function estimateGains(shots, params) {
  // Pairwise brightness ratios in the overlaps, solved in log space so
  // each shot gets a multiplicative gain bringing it in line with its
  // neighbours (removes the visible brightness banding between shots).
  const pairs = [];
  for (let i = 0; i < shots.length; i++) {
    const neighbours = neighboursOf(shots, i, params.hFovDeg);
    for (const j of neighbours) {
      if (j < i) continue;
      const groups = gatherNeighbourSamples(shots, i, [j], params);
      if (!groups.length) continue;
      const g = groups[0];
      let si = 0, sj = 0, cnt = 0;
      for (let t = 0; t < g.rays.length; t++) {
        const ideal = idealFromRay(shots[i].basis, g.rays[t], params.tanH, params.tanV);
        if (!ideal) continue;
        const vi = sampleGray(shots[i], ideal[0], ideal[1], params.k1);
        if (vi < 0) continue;
        si += vi; sj += g.vals[t]; cnt++;
      }
      if (cnt < 40) continue;
      const mi = si / cnt, mj = sj / cnt;
      if (mi < 4 || mj < 4) continue;
      pairs.push({ i, j, logRatio: Math.log(mj / mi) }); // lg_i - lg_j = logRatio
    }
  }
  const lg = new Float64Array(shots.length);
  for (let iter = 0; iter < 60; iter++) {
    const sum = new Float64Array(shots.length);
    const cnt = new Float64Array(shots.length);
    for (const p of pairs) {
      sum[p.i] += lg[p.j] + p.logRatio; cnt[p.i]++;
      sum[p.j] += lg[p.i] - p.logRatio; cnt[p.j]++;
    }
    for (let i = 0; i < shots.length; i++) if (cnt[i]) lg[i] = sum[i] / cnt[i];
  }
  let mean = 0;
  for (let i = 0; i < shots.length; i++) mean += lg[i];
  mean /= Math.max(1, shots.length);
  shots.forEach((s, i) => {
    s.gain = Math.min(1.5, Math.max(0.67, Math.exp(lg[i] - mean)));
  });
}

// ---------------- rendering ----------------

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function bilinearRGB(data, w, h, px, py, out) {
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = px - x0, fy = py - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
    const bot = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
}

async function renderEquirect(shots, params, outW, outH, onProgress) {
  const colorSum = new Float32Array(outW * outH * 3);
  const weightSum = new Float32Array(outW * outH);
  const { tanH, tanV, k1 } = params;
  const rgb = [0, 0, 0];

  for (let si = 0; si < shots.length; si++) {
    const shot = shots[si];
    const data = shot.imageData.data;
    const sw = shot.w, sh = shot.h;
    const f = shot.basis.forward;
    const pitchC = Math.asin(Math.max(-1, Math.min(1, f[2]))) / d2r;
    let yawC = Math.atan2(f[0], f[1]) / d2r;
    if (yawC < 0) yawC += 360;

    // Generous scan window: pole distortion widens the longitude range,
    // and a rolled frame's bounding box is larger than an upright one.
    const marginLon = Math.min(179, (params.hFovDeg / 2) / Math.max(0.15, Math.cos(pitchC * d2r)) + 18);
    const marginLat = params.vFovDeg / 2 + 18;
    const rowMin = Math.max(0, Math.floor(((90 - Math.min(90, pitchC + marginLat)) / 180) * outH));
    const rowMax = Math.min(outH - 1, Math.ceil(((90 - Math.max(-90, pitchC - marginLat)) / 180) * outH));
    const colSpan = Math.ceil((marginLon / 360) * outW);
    const colCenter = Math.round((yawC / 360) * outW);

    for (let row = rowMin; row <= rowMax; row++) {
      const phi = (90 - (row / outH) * 180) * d2r;
      const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
      for (let o = -colSpan; o <= colSpan; o++) {
        let col = (colCenter + o) % outW; if (col < 0) col += outW;
        const lambda = (col / outW) * 360 * d2r;
        const ray = [cosPhi * Math.sin(lambda), cosPhi * Math.cos(lambda), sinPhi];

        const ideal = idealFromRay(shot.basis, ray, tanH, tanV);
        if (!ideal) continue;
        const nx = ideal[0], ny = ideal[1];
        if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue;
        const [dx, dy] = distort(nx, ny, k1);
        if (dx < -1 || dx > 1 || dy < -1 || dy > 1) continue;

        bilinearRGB(data, sw, sh, (dx * 0.5 + 0.5) * (sw - 1), (0.5 - dy * 0.5) * (sh - 1), rgb);

        // Feather towards the frame edge so overlapping shots cross-fade
        // instead of showing a hard seam.
        const edge = 1 - Math.max(Math.abs(nx), Math.abs(ny));
        const weight = Math.max(0.0002, smoothstep(0, 0.45, edge));

        const di = row * outW + col;
        weightSum[di] += weight;
        colorSum[di * 3] += rgb[0] * shot.gain * weight;
        colorSum[di * 3 + 1] += rgb[1] * shot.gain * weight;
        colorSum[di * 3 + 2] += rgb[2] * shot.gain * weight;
      }
    }
    if (onProgress) onProgress((si + 1) / shots.length);
    await yieldToUi();
  }

  return resolveCanvas(colorSum, weightSum, outW, outH);
}

function resolveCanvas(colorSum, weightSum, W, H) {
  const out = new Uint8ClampedArray(W * H * 4);
  const filled = new Uint8Array(W * H);
  let filledCount = 0;
  for (let i = 0; i < W * H; i++) {
    const w = weightSum[i];
    if (w > 0) {
      out[i * 4] = colorSum[i * 3] / w;
      out[i * 4 + 1] = colorSum[i * 3 + 1] / w;
      out[i * 4 + 2] = colorSum[i * 3 + 2] / w;
      out[i * 4 + 3] = 255;
      filled[i] = 1;
      filledCount++;
    }
  }
  // Fill any gap (typically the poles when zenith/nadir shots were
  // skipped) by extending the nearest captured pixel in that column.
  for (let col = 0; col < W; col++) {
    let last = -1;
    for (let row = 0; row < H; row++) {
      const i = row * W + col;
      if (filled[i]) { last = row; continue; }
      if (last >= 0) {
        const s = (last * W + col) * 4;
        out[i * 4] = out[s]; out[i * 4 + 1] = out[s + 1];
        out[i * 4 + 2] = out[s + 2]; out[i * 4 + 3] = 255;
      }
    }
    last = -1;
    for (let row = H - 1; row >= 0; row--) {
      const i = row * W + col;
      if (filled[i]) { last = row; continue; }
      if (out[i * 4 + 3] === 0 && last >= 0) {
        const s = (last * W + col) * 4;
        out[i * 4] = out[s]; out[i * 4 + 1] = out[s + 1];
        out[i * 4 + 2] = out[s + 2]; out[i * 4 + 3] = 255;
      }
    }
  }
  for (let i = 0; i < W * H; i++) {
    if (out[i * 4 + 3] === 0) {
      out[i * 4] = 128; out[i * 4 + 1] = 128; out[i * 4 + 2] = 128; out[i * 4 + 3] = 255;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
  return { canvas, coverage: filledCount / (W * H) };
}

// ---------------- top-level pipeline ----------------

export async function stitchPanorama(shots, options, onProgress) {
  const {
    hFovGuess = 66,
    outWidth = 2048,
    outHeight = 1024,
    refine = true,
    // Candidates are relative to the incoming guess rather than a fixed
    // list, so this works for any lens (ultra-wide, main, tele) once that
    // lens has been calibrated - a fixed main-camera band would be plain
    // wrong for a 110-degree ultra-wide.
    fovScales = [0.75, 0.85, 0.92, 1, 1.08, 1.16, 1.28],
    fovMin = 24,
    fovMax = 125,
    k1Candidates = [0, -0.05, -0.1, 0.05],
  } = options || {};

  const report = (frac, label) => { if (onProgress) onProgress(Math.min(1, Math.max(0, frac)), label); };

  let hFov = hFovGuess;
  let k1 = 0;

  if (refine && shots.length >= 2) {
    const sensorBases = sensorBasesOf(shots);
    const evaluate = (candFov, candK1) => evaluateCandidate(shots, sensorBases, candFov, candK1);

    // Baseline: the user's / previous run's FOV. Any candidate has to
    // clearly beat this to be adopted, so that a capture with too little
    // overlap to decide (where the score surface is mostly noise) falls
    // back to the known-reasonable value instead of locking onto a
    // spurious extreme.
    const baseline = await evaluate(hFovGuess, 0);
    let best = { ...baseline };

    // --- 1. Coarse FOV scan: which field of view explains the overlaps? ---
    // This is the step that removes the duplicated-objects problem: with a
    // wrong FOV, the same object near two frames' edges lands in two
    // different places in the panorama.
    const fovCandidates = fovScales
      .map((s) => Math.round(hFovGuess * s))
      .filter((v) => v >= fovMin && v <= fovMax && v !== hFovGuess);
    for (let ci = 0; ci < fovCandidates.length; ci++) {
      const r = await evaluate(fovCandidates[ci], 0);
      if (r.score > best.score) best = r;
      report(0.05 + 0.3 * ((ci + 1) / fovCandidates.length),
        `Calibrage de l'objectif (${ci + 1}/${fovCandidates.length})`);
    }

    // --- 2. Fine FOV scan, one degree at a time ---
    const coarseFov = best.hFov;
    for (let cand = coarseFov - 3; cand <= coarseFov + 3; cand += 1) {
      if (cand === coarseFov || cand < fovMin || cand > fovMax) continue;
      const r = await evaluate(cand, 0);
      if (r.score > best.score) best = r;
      report(0.35 + 0.15 * ((cand - (coarseFov - 3) + 1) / 7), 'Calibrage précis de l’objectif');
    }

    // --- 3. Radial distortion (phone lenses are not perfectly rectilinear,
    // which misaligns frame edges exactly where shots overlap) ---
    for (const ck of k1Candidates) {
      if (ck === 0) continue;
      const r = await evaluate(best.hFov, ck);
      if (r.score > best.score) best = r;
    }
    report(0.6, 'Correction de la distorsion');

    if (best.hFov !== hFovGuess && best.score < baseline.score + 0.01) best = baseline;
    hFov = best.hFov;
    k1 = best.k1;
    restoreBases(shots, best.bases);

    // --- 4. Full-precision orientation refinement with the final lens model ---
    for (let pass = 0; pass < 2; pass++) {
      const params = makeParams(hFov, k1, shots[0]);
      for (let i = 0; i < shots.length; i++) {
        refineShotOrientation(shots, i, params, REFINE_STAGES);
        if (i % 4 === 0) await yieldToUi();
      }
      report(0.6 + 0.2 * ((pass + 1) / 2), `Recalage des photos (passe ${pass + 1}/2)`);
      await yieldToUi();
    }
  }

  const params = makeParams(hFov, k1, shots[0]);

  // --- 5. Exposure equalization ---
  if (shots.length >= 2) {
    estimateGains(shots, params);
    report(0.85, 'Égalisation des expositions');
    await yieldToUi();
  }

  // --- 6. Render ---
  const result = await renderEquirect(shots, params, outWidth, outHeight, (f) => {
    report(0.85 + 0.15 * f, 'Assemblage de l’image finale');
  });
  report(1, 'Terminé');

  return { canvas: result.canvas, coverage: result.coverage, hFovDeg: hFov, k1 };
}
