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
function angularDeg(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / d2r;
}
// Same yaw/pitch -> world-frame (East, North, Up) basis convention as
// orientation.js's forwardVec=[east,north,up]/atan2(east,north)/asin(up).
function basisFromYawPitch(yawDeg, pitchDeg) {
  const l = yawDeg * d2r, p = pitchDeg * d2r;
  return {
    forward: [Math.sin(l) * Math.cos(p), Math.cos(l) * Math.cos(p), Math.sin(p)],
    right: [Math.cos(l), -Math.sin(l), 0],
    up: [-Math.sin(l) * Math.sin(p), -Math.cos(l) * Math.sin(p), Math.cos(p)],
  };
}
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
//
// targetHint (optional {yaw, pitch}) is the on-screen target this shot was
// captured for, if any - see stitchPanorama's outlier check for why it
// matters.
export function prepareShot(imageData, basis, targetHint = null) {
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
    targetHint,
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
  const STEP = 30;
  const STEP_Y = 22;
  for (const j of neighbours) {
    const other = shots[j];
    const rays = [];
    const vals = [];
    for (let a = 0; a < STEP; a++) {
      const nx = -0.85 + (1.7 * a) / (STEP - 1);
      for (let b = 0; b < STEP_Y; b++) {
        const ny = -0.85 + (1.7 * b) / (STEP_Y - 1);
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

// One coarse-to-fine grid search, starting from a given center and score.
function refineFrom(shots, i, groups, params, start, centerD, centerScore, stages) {
  let bestD = centerD, bestScore = centerScore;
  for (const { step, radius, rollStep, rollRadius } of stages) {
    const c = bestD;
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
  return { d: bestD, score: bestScore };
}

// Local coarse-to-fine search over (yaw, pitch, roll) corrections.
//
// topK controls how many of the coarse stage's local peaks get carried
// into the finer stages, each refined independently before a winner is
// picked. A repetitive surface (e.g. a wood floor's plank grain, seen
// nearly edge-to-edge in a downward-tilted shot with barely any other
// content to anchor it) can score a wrong candidate a few degrees away
// competitively at the coarse stage's resolution - committing to just the
// single best pick there (topK=1) permanently locks every finer stage
// onto that wrong branch, since each stage only searches around the
// previous stage's winner. Carrying a few distinct peaks forward and
// letting each be judged on its own fully-refined merit avoids that,
// without ever touching how any single candidate's own local search is
// scored (an earlier attempt to nudge the score *inside* the local search
// itself made clean, unambiguous matches worse and was reverted - this
// keeps that scoring pure and only adds a tie-break at the very end).
function refineShotOrientation(shots, i, params, stages, topK = 1) {
  const neighbours = neighboursOf(shots, i, params.hFovDeg);
  if (!neighbours.length) return 0;
  const groups = gatherNeighbourSamples(shots, i, neighbours, params);
  if (!groups.length) return 0;

  const start = shots[i].basis;
  const baseScore = scoreBasis(shots[i], start, groups, params);
  const [coarseStage, ...fineStages] = stages;

  const peaks = [{ d: [0, 0, 0], score: baseScore }];
  if (coarseStage) {
    const { step, radius, rollStep, rollRadius } = coarseStage;
    for (let dy = -radius; dy <= radius; dy += step) {
      for (let dp = -radius; dp <= radius; dp += step) {
        for (let dr = -rollRadius; dr <= rollRadius; dr += rollStep || 1) {
          const cand = [dy, dp, dr];
          const basis = rotateBasis(start, cand[0], cand[1], cand[2]);
          peaks.push({ d: cand, score: scoreBasis(shots[i], basis, groups, params) });
          if (!rollRadius) break;
        }
      }
    }
  }
  peaks.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const p of peaks) {
    if (picked.length >= topK) break;
    const tooClose = picked.some((q) =>
      Math.abs(q.d[0] - p.d[0]) < coarseStage.step && Math.abs(q.d[1] - p.d[1]) < coarseStage.step);
    if (!tooClose) picked.push(p);
  }

  let best = null;
  for (const peak of picked) {
    const refined = refineFrom(shots, i, groups, params, start, peak.d, peak.score, fineStages);
    // Same deviation-from-sensor-baseline tie-breaker already used to pick
    // between whole-FOV candidates, here breaking ties between orientation
    // candidates instead - a small nudge, not a hard constraint, so a
    // clearly-better-scoring far candidate still wins on real evidence.
    const deviation = Math.hypot(refined.d[0], refined.d[1], refined.d[2]);
    const pickScore = refined.score - 0.01 * deviation;
    if (!best || pickScore > best.pickScore) best = { ...refined, pickScore };
  }

  if (best.score > baseScore) {
    shots[i].basis = rotateBasis(start, best.d[0], best.d[1], best.d[2]);
  }
  return best.score;
}

const REFINE_STAGES = [
  { step: 2, radius: 6, rollStep: 2, rollRadius: 4 },
  { step: 0.75, radius: 1.5, rollStep: 1, rollRadius: 1 },
  { step: 0.25, radius: 0.5, rollStep: 0, rollRadius: 0 },
  { step: 0.08, radius: 0.16, rollStep: 0, rollRadius: 0 },
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

// How far, on average, refinement had to pull shots away from where the
// sensor actually measured them (in degrees).
function meanDeviationFromSensor(shots, sensorBases) {
  let total = 0;
  for (let i = 0; i < shots.length; i++) {
    const a = shots[i].basis.forward, b = sensorBases[i].forward;
    const c = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    total += Math.acos(c) / d2r;
  }
  return shots.length ? total / shots.length : 0;
}

// Evaluates one lens-model candidate. Always restarts from the supplied
// sensor orientations rather than from whatever the previous candidate
// converged to: chaining candidates biases the search badly, because the
// orientations bend to fit whichever FOV was tried first, that config then
// scores best simply because it was the one fitted, and the true FOV is
// never selected.
//
// `pickScore` (used only to CHOOSE between candidates, never fed into the
// per-shot local search itself) subtracts a penalty for how far shots had
// to move from their sensor reading. This exists because of a failure mode
// found on real captures with repetitive architecture (tiled floors,
// evenly spaced picture frames/door frames): the photometric match can
// score deceptively well for a *wrong* FOV, because a wrong FOV combined
// with shots nudged towards the next repeat of the pattern still overlaps
// pixel-for-pixel almost as well as the true alignment - classic aliasing.
// A correct FOV only ever needs to explain a few degrees of real gyro
// noise per shot; a wrong one has to systematically drag shots further
// to fake the overlap, which this penalty makes visible. Per-shot search
// itself stays pure photometric score (bounded to +-6 degrees by
// REFINE_STAGES/QUICK_STAGES already), so genuine corrections up to that
// bound are never suppressed - only the FOV choice is guarded.
const FOV_PICK_DEVIATION_PENALTY = 0.05;

async function evaluateCandidate(shots, sensorBases, candFov, candK1) {
  restoreBases(shots, sensorBases);
  const params = makeParams(candFov, candK1, shots[0]);
  for (let i = 0; i < shots.length; i++) refineShotOrientation(shots, i, params, QUICK_STAGES);
  const score = configScore(shots, params);
  const deviation = meanDeviationFromSensor(shots, sensorBases);
  await yieldToUi();
  return {
    score, hFov: candFov, k1: candK1, bases: snapshotBases(shots), deviation,
    pickScore: score - FOV_PICK_DEVIATION_PENALTY * deviation,
  };
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
  let best = { score: -Infinity, pickScore: -Infinity, hFov: null };

  const scan = async (from, to, step, label) => {
    const values = [];
    for (let v = from; v <= to + 1e-6; v += step) values.push(Math.round(v * 10) / 10);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < min || v > max) continue;
      const r = await evaluateCandidate(shots, sensorBases, v, 0);
      if (r.pickScore > best.pickScore) best = r;
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

// Solves, together, a per-shot brightness gain AND one radial vignetting
// profile shared by every shot (they all come from the same lens).
//
// Fitting only per-shot gains, as this used to, cannot see vignetting at
// all: it compared the AVERAGE brightness of each overlap, which throws
// away where in the frame each sample sat. That left every frame darker
// towards its edges. Soft blending used to hide it by averaging
// overlapping shots together, but once each output pixel is taken from a
// single shot the profile becomes plainly visible - every shot renders
// bright at its centre and dark at its rim, so the panorama looks quilted
// out of tiles. Estimating the profile removes the cause instead.
//
// Model: observed = true * G_shot * exp(a * r2), with r2 the squared
// normalised radius in the frame (1 at a corner). For one world point seen
// by two shots, the unknown "true" cancels:
//   log(obs_i) - log(obs_j) = (lgObs_i - lgObs_j) + a * (r2_i - r2_j)
// which is linear in the per-shot offsets and in a, and is solved by
// alternating between the two.
function estimateGains(shots, params) {
  const { tanH, tanV, k1 } = params;
  const pairs = [];
  const STEP = 14;
  for (let i = 0; i < shots.length; i++) {
    for (const j of neighboursOf(shots, i, params.hFovDeg)) {
      if (j <= i) continue;
      let n = 0, sLog = 0, sD = 0, sDLog = 0, sDD = 0;
      for (let a2 = 0; a2 < STEP; a2++) {
        const nxj = -0.85 + (1.7 * a2) / (STEP - 1);
        for (let b2 = 0; b2 < STEP; b2++) {
          const nyj = -0.85 + (1.7 * b2) / (STEP - 1);
          const vj = sampleGray(shots[j], nxj, nyj, k1);
          if (vj < 4) continue;
          const ray = rayFromIdeal(shots[j].basis, nxj, nyj, tanH, tanV);
          const ideal = idealFromRay(shots[i].basis, ray, tanH, tanV);
          if (!ideal) continue;
          const vi = sampleGray(shots[i], ideal[0], ideal[1], k1);
          if (vi < 4) continue;
          const r2i = (ideal[0] * ideal[0] + ideal[1] * ideal[1]) / 2;
          const r2j = (nxj * nxj + nyj * nyj) / 2;
          const logDiff = Math.log(vi / vj);
          const dr2 = r2i - r2j;
          n++; sLog += logDiff; sD += dr2; sDLog += dr2 * logDiff; sDD += dr2 * dr2;
        }
      }
      if (n >= 40) pairs.push({ i, j, n, sLog, sD, sDLog, sDD });
    }
  }
  if (!pairs.length) return 0;

  const lg = new Float64Array(shots.length);
  let a = 0;
  for (let outer = 0; outer < 6; outer++) {
    for (let iter = 0; iter < 40; iter++) {
      const sum = new Float64Array(shots.length);
      const cnt = new Float64Array(shots.length);
      for (const p of pairs) {
        // lg is the CORRECTION, i.e. the negative of the shot's own offset.
        const ratio = a * (p.sD / p.n) - (p.sLog / p.n);
        sum[p.i] += lg[p.j] + ratio; cnt[p.i]++;
        sum[p.j] += lg[p.i] - ratio; cnt[p.j]++;
      }
      for (let i = 0; i < shots.length; i++) if (cnt[i]) lg[i] = sum[i] / cnt[i];
    }
    let num = 0, den = 0;
    for (const p of pairs) {
      const c = -(lg[p.i] - lg[p.j]);
      num += p.sDLog - c * p.sD;
      den += p.sDD;
    }
    if (den > 1e-9) {
      // Clamped to physically sensible vignetting: darker towards the rim,
      // never brighter by much, so a bad fit cannot invent a glow.
      a = Math.min(0.05, Math.max(-0.6, num / den));
    }
  }

  let mean = 0;
  for (let i = 0; i < shots.length; i++) mean += lg[i];
  mean /= Math.max(1, shots.length);
  shots.forEach((s, i) => {
    s.gain = Math.min(1.5, Math.max(0.67, Math.exp(lg[i] - mean)));
  });
  return a;
}

// ---------------- rendering ----------------

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

// Walks every output pixel this shot can contribute to, handing the
// callback the output index plus both the undistorted and distorted frame
// coordinates. Shared by both rendering passes so the projection and the
// scan-window bookkeeping live in exactly one place.
function forEachCoveredPixel(shot, params, outW, outH, cb) {
  const { tanH, tanV, k1 } = params;
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

      cb(row * outW + col, nx, ny, dx, dy);
    }
  }
}

// How much better (in the 0..1 "distance from frame border" quality below)
// one shot must be before it takes a pixel outright. Small, so the blend is
// confined to a narrow band along the seam between two shots.
const SEAM_HANDOFF = 0.01;
// Past this margin the loser's weight is exp(-6), i.e. nothing; skipping it
// also means most pixels never pay for a bilinear sample at all.
const SEAM_CUTOFF = SEAM_HANDOFF * 6;

// Low-frequency correction works on a heavily reduced copy of the
// panorama: exposure and vignetting differences between shots are, by
// definition, smooth and large-scale, so they survive this reduction
// intact while all real detail is averaged away.
const LOW_DIV = 8;

// Separable box blur over a low-resolution RGB field, wrapping in
// longitude (the panorama joins back on itself) and clamping in latitude.
function blurLowRGB(src, w, h, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = -radius; k <= radius; k++) {
        let xx = (x + k) % w; if (xx < 0) xx += w;
        const i = (y * w + xx) * 3;
        r += src[i]; g += src[i + 1]; b += src[i + 2];
      }
      const o = (y * w + x) * 3;
      tmp[o] = r / span; tmp[o + 1] = g / span; tmp[o + 2] = b / span;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const i = (yy * w + x) * 3;
        r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2];
      }
      const o = (y * w + x) * 3;
      out[o] = r / span; out[o + 1] = g / span; out[o + 2] = b / span;
    }
  }
  return out;
}

// Pushes the sharp mosaic's large-scale tone onto that of the seamless
// smooth blend, leaving its detail untouched. This is what stops a
// winner-take-all mosaic from looking like a patchwork of differently
// exposed facets while keeping every bit of its sharpness.
function applyLowFrequencyCorrection(
  colorSum, weightSum, outW, outH,
  softColor, softW, sharpLowColor, sharpLowW, lowW, lowH,
) {
  const lowN = lowW * lowH;
  const diff = new Float32Array(lowN * 3);
  for (let i = 0; i < lowN; i++) {
    const a = softW[i], b = sharpLowW[i];
    if (a <= 0 || b <= 0) continue;
    for (let c = 0; c < 3; c++) {
      diff[i * 3 + c] = softColor[i * 3 + c] / a - sharpLowColor[i * 3 + c] / b;
    }
  }
  // Blurred so the correction itself carries no trace of the low-res grid.
  const smooth = blurLowRGB(diff, lowW, lowH, 2);

  for (let row = 0; row < outH; row++) {
    const fy = Math.min(lowH - 1, row / LOW_DIV);
    const y0 = Math.min(lowH - 1, fy | 0), y1 = Math.min(lowH - 1, y0 + 1);
    const ty = fy - y0;
    for (let col = 0; col < outW; col++) {
      const di = row * outW + col;
      if (weightSum[di] <= 0) continue;
      const fx = col / LOW_DIV;
      const x0 = Math.min(lowW - 1, fx | 0), x1 = (x0 + 1) % lowW;
      const tx = fx - x0;
      const w = weightSum[di];
      for (let c = 0; c < 3; c++) {
        const top = smooth[(y0 * lowW + x0) * 3 + c] * (1 - tx) + smooth[(y0 * lowW + x1) * 3 + c] * tx;
        const bot = smooth[(y1 * lowW + x0) * 3 + c] * (1 - tx) + smooth[(y1 * lowW + x1) * 3 + c] * tx;
        colorSum[di * 3 + c] += (top * (1 - ty) + bot * ty) * w;
      }
    }
  }
}

async function renderEquirect(shots, params, outW, outH, onProgress) {
  const vignA = params.vignA || 0;
  const n = outW * outH;
  const colorSum = new Float32Array(n * 3);
  const weightSum = new Float32Array(n);
  // Best "quality" any shot achieves for each output pixel, where quality
  // is distance from the frame border (1 dead centre, 0 at the very edge).
  const bestQ = new Float32Array(n).fill(-1);

  const lowW = Math.max(1, Math.ceil(outW / LOW_DIV));
  const lowH = Math.max(1, Math.ceil(outH / LOW_DIV));
  const lowN = lowW * lowH;
  // Same pixels accumulated twice at low resolution: once with the sharp
  // seam weights, once with a broad smooth weight. Their difference is
  // exactly the large-scale error the sharp mosaic carries.
  const softColor = new Float32Array(lowN * 3), softW = new Float32Array(lowN);
  const sharpLowColor = new Float32Array(lowN * 3), sharpLowW = new Float32Array(lowN);

  // --- Pass 1: find, per output pixel, the best any shot can do ---
  for (const shot of shots) {
    forEachCoveredPixel(shot, params, outW, outH, (di, nx, ny) => {
      const q = 1 - Math.max(Math.abs(nx), Math.abs(ny));
      if (q > bestQ[di]) bestQ[di] = q;
    });
    await yieldToUi();
  }

  // --- Pass 2: composite ---
  //
  // Weighting relative to the winner, rather than by an absolute function
  // of position in the frame, is what keeps detail intact. The version
  // before used pow(edge, 8), whose *relative* split between two
  // overlapping shots depends on where in their frames the pixel happens
  // to fall: measured, edge 0.31 vs 0.30 blends them 57/43 - averaging two
  // views of the same thing almost equally - while 0.10 vs 0.05 is
  // winner-take-all. Over much of every overlap content was therefore a
  // half-and-half average of two shots, and wherever they disagreed
  // (residual misalignment, and parallax, which no rotation-only model can
  // fix) that average washed detail out until objects became
  // unrecognisable.
  //
  // But taking each pixel from a single shot has its own failure, and it
  // is just as visible: consecutive shots do not share an exposure, a
  // white balance or a vignetting profile, so a hard handover between them
  // shows up as a mosaic of polygonal facets in slightly different tones -
  // obvious on any large flat surface like a ceiling. Soft averaging used
  // to smear those steps into invisibility; that is the one thing it was
  // good at.
  //
  // So both are accumulated, and the result keeps the high frequencies of
  // the sharp mosaic while borrowing the low frequencies of the smooth
  // one. Detail comes from a single shot and stays sharp; exposure and
  // vignetting are carried by the smooth blend and cross seams without a
  // step.
  const rgb = [0, 0, 0];
  for (let si = 0; si < shots.length; si++) {
    const shot = shots[si];
    const data = shot.imageData.data;
    const sw = shot.w, sh = shot.h;
    const gain = shot.gain;
    forEachCoveredPixel(shot, params, outW, outH, (di, nx, ny, dx, dy) => {
      const q = 1 - Math.max(Math.abs(nx), Math.abs(ny));
      const behind = bestQ[di] - q;
      const sharpW = behind > SEAM_CUTOFF ? 0 : (behind <= 0 ? 1 : Math.exp(-behind / SEAM_HANDOFF));
      // Broad and smooth, so the low-frequency blend never has a seam of
      // its own to pass on.
      const smoothW = q > 0.02 ? 1 : 0;
      if (sharpW === 0 && smoothW === 0) return;

      bilinearRGB(data, sw, sh, (dx * 0.5 + 0.5) * (sw - 1), (0.5 - dy * 0.5) * (sh - 1), rgb);
      // Undo the lens's own falloff before anything else, so a pixel means
      // the same thing wherever in its frame it came from.
      const k = gain * Math.exp(-vignA * (nx * nx + ny * ny) / 2);
      const r = rgb[0] * k, g = rgb[1] * k, b = rgb[2] * k;

      if (sharpW > 0) {
        weightSum[di] += sharpW;
        colorSum[di * 3] += r * sharpW;
        colorSum[di * 3 + 1] += g * sharpW;
        colorSum[di * 3 + 2] += b * sharpW;
      }

      const row = (di / outW) | 0, col = di - row * outW;
      const li = ((row / LOW_DIV) | 0) * lowW + ((col / LOW_DIV) | 0);
      if (smoothW > 0) {
        softW[li] += smoothW;
        softColor[li * 3] += r * smoothW;
        softColor[li * 3 + 1] += g * smoothW;
        softColor[li * 3 + 2] += b * smoothW;
      }
      if (sharpW > 0) {
        sharpLowW[li] += sharpW;
        sharpLowColor[li * 3] += r * sharpW;
        sharpLowColor[li * 3 + 1] += g * sharpW;
        sharpLowColor[li * 3 + 2] += b * sharpW;
      }
    });
    if (onProgress) onProgress((si + 1) / shots.length);
    await yieldToUi();
  }

  applyLowFrequencyCorrection(
    colorSum, weightSum, outW, outH,
    softColor, softW, sharpLowColor, sharpLowW, lowW, lowH,
  );

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

  // A shot's own sensor reading can occasionally be badly wrong at the
  // exact instant of capture - most plausibly magnetic interference near
  // electronics (a monitor, a desktop tower) briefly disturbing the
  // compass. When that happens, its content renders at a completely
  // wrong spot in the panorama - a duplicate-looking "ghost" of whatever
  // is actually there, potentially tens of degrees away, far beyond what
  // the bounded per-shot refinement below can ever correct (it only ever
  // searches a few degrees around wherever it starts).
  //
  // A shot can only ever have been auto-captured once its aim was within
  // the guide's own tolerance of its target (a few degrees), so a sensor
  // reading disagreeing with its capture target by much more than that
  // was almost certainly wrong at that instant. Guessing where such a
  // shot actually belongs was tried and found unreliable - a wrong
  // position can score deceptively well against a neighbour it doesn't
  // really belong to, and risks pulling that neighbour's own alignment
  // off too - so it's simply excluded from the render instead. The gap
  // it leaves gets filled by neighbouring shots stretching to cover it,
  // the same graceful fallback already used for a disabled zenith/nadir
  // shot, which is a far less jarring result than confidently duplicating
  // real content in the wrong place.
  const EXCLUDE_DEVIATION_DEG = 25;
  let excludedCount = 0;
  const plausible = shots.filter((s) => {
    if (!s.targetHint) return true;
    const targetBasis = basisFromYawPitch(s.targetHint.yaw, s.targetHint.pitch);
    return angularDeg(targetBasis.forward, s.baseBasis.forward) <= EXCLUDE_DEVIATION_DEG;
  });
  // Only apply the filter if it leaves something to render - if every
  // shot somehow tripped it (a systemic issue, not a one-off glitch),
  // rendering with the sensor readings as-is is still better than
  // rendering nothing.
  if (plausible.length > 0 && plausible.length < shots.length) {
    excludedCount = shots.length - plausible.length;
    shots = plausible;
  }

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
      if (r.pickScore > best.pickScore) best = r;
      report(0.05 + 0.3 * ((ci + 1) / fovCandidates.length),
        `Calibrage de l'objectif (${ci + 1}/${fovCandidates.length})`);
    }

    // --- 2. Fine FOV scan, one degree at a time ---
    const coarseFov = best.hFov;
    for (let cand = coarseFov - 3; cand <= coarseFov + 3; cand += 1) {
      if (cand === coarseFov || cand < fovMin || cand > fovMax) continue;
      const r = await evaluate(cand, 0);
      if (r.pickScore > best.pickScore) best = r;
      report(0.35 + 0.15 * ((cand - (coarseFov - 3) + 1) / 7), 'Calibrage précis de l’objectif');
    }

    // --- 3. Radial distortion (phone lenses are not perfectly rectilinear,
    // which misaligns frame edges exactly where shots overlap) ---
    for (const ck of k1Candidates) {
      if (ck === 0) continue;
      const r = await evaluate(best.hFov, ck);
      if (r.pickScore > best.pickScore) best = r;
    }
    report(0.6, 'Correction de la distorsion');

    if (best.hFov !== hFovGuess && best.pickScore < baseline.pickScore + 0.01) best = baseline;
    hFov = best.hFov;
    k1 = best.k1;
    restoreBases(shots, best.bases);

    // --- 4. Full-precision orientation refinement with the final lens model ---
    for (let pass = 0; pass < 2; pass++) {
      const params = makeParams(hFov, k1, shots[0]);
      for (let i = 0; i < shots.length; i++) {
        refineShotOrientation(shots, i, params, REFINE_STAGES, 3);
        if (i % 4 === 0) await yieldToUi();
      }
      report(0.6 + 0.2 * ((pass + 1) / 2), `Recalage des photos (passe ${pass + 1}/2)`);
      await yieldToUi();
    }
  }

  const params = makeParams(hFov, k1, shots[0]);

  // --- 5. Exposure equalization ---
  if (shots.length >= 2) {
    params.vignA = estimateGains(shots, params);
    report(0.85, 'Égalisation des expositions');
    await yieldToUi();
  }

  // --- 6. Render ---
  const result = await renderEquirect(shots, params, outWidth, outHeight, (f) => {
    report(0.85 + 0.15 * f, 'Assemblage de l’image finale');
  });
  report(1, 'Terminé');

  return { canvas: result.canvas, coverage: result.coverage, hFovDeg: hFov, k1, excludedCount };
}
