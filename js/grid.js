// Builds the list of capture targets {yaw, pitch} covering the sphere,
// given the assumed camera FOV and a density preset.
//
// BOTH spacings are derived from the lens's field of view: column spacing
// from the horizontal FOV, row spacing from the vertical one. Row spacing
// used to be a hardcoded [45, 0, -45] regardless of lens, which was a real
// bug: at a typical phone main-lens FOV (~68 degrees horizontal, so only
// ~54 vertical on a 4:3 frame) that left just 16% vertical overlap against
// 35% horizontal, and for a narrower tele lens it left a literal gap with
// no shared content at all. Rows are captured one after another, so the
// gyro has drifted by the time each new row starts; removing that drift
// requires enough shared content between rows to measure it against.
// With overlap that thin - minus the couple of degrees of orientation
// error every shot carries - there was nearly nothing left to match on,
// so rows stayed misregistered relative to each other. That shows up as
// the same object appearing at several heights, each copy shifted
// sideways by a different amount (measured: 13.2 degrees of yaw disparity
// between the top and bottom rows, versus 0.7 once the rows properly
// overlap).

import { verticalFovFromHorizontal } from './align.js';

export const DENSITY_PRESETS = {
  // Eye-level band only, no zenith/nadir: a cylindrical panorama of the
  // walls. No rows to register against each other (the largest error source
  // in a multi-row capture), the photographer's feet never appear, and the
  // floor and ceiling - the closest surfaces to the lens and the most
  // obliquely viewed, so by far the worst for parallax - are not
  // photographed at all. The trade is that they end up stretched from the
  // nearest captured pixels rather than being real detail.
  panoramique: { overlapH: 0.45, horizonOnly: true, forceNoPoles: true },

  // The same band, plus the upper/lower rings and the zenith and nadir
  // shots needed to photograph the ceiling and floor for real.
  //
  // A band plus two pole shots alone cannot cover the sphere: with a
  // typical main lens the band reaches about +/-27 degrees and a pole shot
  // only reaches down to 63, leaving a wide unphotographed ring. The rings
  // exist to close exactly that gap - they are not an optional extra.
  complet: { overlapH: 0.35, overlapV: 0.30 },

  // Same shape, more overlap everywhere, for when quality matters more than
  // how long the capture takes.
  fine: { overlapH: 0.45, overlapV: 0.45 },
};

// Row centre pitches, evenly spaced, guaranteeing at least `overlapV` of
// vertical overlap between consecutive rows AND at the seam with the
// zenith/nadir shots.
//
// A shot pointed straight up covers (conservatively) everything above
// 90 - vFov/2, and the outermost row's top edge reaches its own centre +
// vFov/2, so their overlap is (rowPitch + vFov - 90). Requiring that to
// clear the same overlap budget as every other seam puts the outermost row
// at (90 - maxStep). An earlier version used (90 - vFov) here, which makes
// the two merely *touch* with zero margin: the couple of degrees of
// orientation error every shot carries then tears that seam open, and
// measured sphere coverage actually dropped (0.992 vs 0.999) despite the
// rows themselves overlapping better. Same budget everywhere avoids that.
function rowPitchesFor(vFovDeg, overlapV) {
  const maxStep = vFovDeg * (1 - overlapV);
  const maxRowPitch = Math.max(0, 90 - maxStep);
  // Wide enough that a single row already reaches the pole shots.
  if (maxRowPitch <= 0) return [0];
  const n = Math.ceil((2 * maxRowPitch) / maxStep) + 1;
  if (n <= 1) return [0];
  const out = [];
  for (let i = 0; i < n; i++) {
    const pitch = -maxRowPitch + (2 * maxRowPitch * i) / (n - 1);
    // Rounded so the value is a clean grouping key (the capture guide and
    // mini-map group targets by `row`) and reads sanely when debugging.
    out.push(Math.round(pitch * 10) / 10);
  }
  return out;
}

// frameAspect is the captured frame's height / width. It matters a lot:
// the same lens held upright rather than sideways puts its WIDE field of
// view on the vertical axis, which roughly doubles how much vertical
// overlap a given number of rows gets (measured for a 68-degree lens with
// 3 rows plus poles: 16% lying down versus 34% upright). It is read from
// the camera at capture time rather than assumed - see frameSizeFor.
export function buildGrid(preset, hFovDeg, includePoles, frameAspect = 480 / 640) {
  const cfg = DENSITY_PRESETS[preset] || DENSITY_PRESETS.complet;
  const vFovDeg = verticalFovFromHorizontal(hFovDeg, 1, frameAspect);
  const rowPitches = cfg.horizonOnly ? [0] : rowPitchesFor(vFovDeg, cfg.overlapV);

  const targets = [];
  for (const pitch of rowPitches) {
    const step = hFovDeg * (1 - cfg.overlapH) / Math.max(0.2, Math.cos(pitch * Math.PI / 180));
    const cols = Math.max(3, Math.round(360 / Math.min(step, 90)));
    for (let i = 0; i < cols; i++) {
      targets.push({ yaw: (360 / cols) * i, pitch, row: pitch, isPole: false });
    }
  }
  if (includePoles && !cfg.forceNoPoles) {
    targets.push({ yaw: 0, pitch: 90, row: 90, isPole: true });
    targets.push({ yaw: 0, pitch: -90, row: -90, isPole: true });
  }
  return targets;
}
