// Builds the list of capture targets {yaw, pitch} covering the sphere,
// given the assumed camera FOV and a density preset. Row spacing keeps a
// safety margin under the vertical FOV so consecutive rows overlap;
// column spacing keeps a safety margin under the horizontal FOV so
// consecutive shots in a row overlap too, both needed for the accumulator's
// edge-feather blend in stitch.js to actually hide seams.

export const DENSITY_PRESETS = {
  rapide: { rowPitches: [0], overlapH: 0.30 },
  standard: { rowPitches: [45, 0, -45], overlapH: 0.35 },
  fine: { rowPitches: [60, 30, 0, -30, -60], overlapH: 0.4 },
};

export function buildGrid(preset, hFovDeg, includePoles) {
  const cfg = DENSITY_PRESETS[preset] || DENSITY_PRESETS.standard;
  const targets = [];
  for (const pitch of cfg.rowPitches) {
    const step = hFovDeg * (1 - cfg.overlapH) / Math.max(0.2, Math.cos(pitch * Math.PI / 180));
    const cols = Math.max(3, Math.round(360 / Math.min(step, 90)));
    for (let i = 0; i < cols; i++) {
      targets.push({ yaw: (360 / cols) * i, pitch, row: pitch, isPole: false });
    }
  }
  if (includePoles) {
    targets.push({ yaw: 0, pitch: 90, row: 90, isPole: true });
    targets.push({ yaw: 0, pitch: -90, row: -90, isPole: true });
  }
  return targets;
}
