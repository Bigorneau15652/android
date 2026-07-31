import { OrientationTracker } from './orientation.js';
import { buildGrid } from './grid.js';
import { CaptureController, listRearCameras, openCameraStream, CalibrationCapture } from './capture.js';
import { stitchPanorama, calibrateFov, prepareShot } from './align.js';
import { savePhoto, listPhotos, getPhoto, deletePhoto, renamePhoto, recordExport } from './storage.js';
import { buildStandaloneViewer } from './export.js';

const SETTINGS_KEY = 'photo360-settings-v1';
const DEFAULT_SETTINGS = {
  density: 'complet',
  poles: true,
  fov: 66,
  output: '2048x1024',
  autoCapture: true,
  refine: true,
  deviceId: '',
  // Measured horizontal FOV per camera deviceId. Every lens on the phone
  // (and every phone) has a different one, so a single global value would
  // be wrong as soon as the user switches lens or someone else installs
  // the app.
  lensFov: {},
};

let settings = loadSettings();
let pendingCanvas = null;
let pendingCoverage = 1;
let pendingExcludedCount = 0;
let currentCaptureController = null;
let currentViewer = null; // active pannellum instance, destroyed on screen change
let currentViewerPhotoId = null;

// ---------------- navigation ----------------
function showScreen(id) {
  if (currentViewer) {
    // destroy() also tears down the gyroscope listeners Pannellum attaches
    // in orientation mode, so leaving the viewer never leaves them running.
    try { currentViewer.destroy(); } catch (e) {}
    currentViewer = null;
  }
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => {
    // Going back to the home screen must re-read the photo list: it is the
    // gallery now, so a rename or delete has to show up immediately.
    if (btn.dataset.back === 'screen-home') goHome();
    else showScreen(btn.dataset.back);
  });
});

// ---------------- settings ----------------
// Capture modes that no longer exist, mapped to their closest replacement -
// a stored value from an older version must not leave the app with a
// density preset that cannot be resolved.
const RETIRED_DENSITIES = { standard: 'complet', rapide: 'panoramique' };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      if (RETIRED_DENSITIES[s.density]) s.density = RETIRED_DENSITIES[s.density];
      return s;
    }
  } catch (e) {}
  return { ...DEFAULT_SETTINGS };
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
// The FOV for the currently selected lens - the single source of truth
// for both the settings slider and the capture grid, whether it came from
// a manual drag or from calibration. There used to be two separate values
// (a global "manual" one the slider showed, and a per-lens "measured" one
// that silently took priority once set): calibrating never moved the
// slider, and dragging the slider after calibrating had no visible effect
// at all, since currentFov() always preferred the per-lens value. One
// value per lens removes that confusion entirely.
function currentFov() {
  return settings.lensFov[settings.deviceId || 'default'] || settings.fov;
}
function setMeasuredFov(fov) {
  settings.lensFov[settings.deviceId || 'default'] = fov;
  saveSettings();
  applySettingsToForm();
}

function updateLensInfo() {
  const el = document.getElementById('lens-fov-info');
  if (settings.lensFov[settings.deviceId || 'default']) {
    el.className = 'banner banner-info';
    el.textContent = `Angle de champ pour cet objectif : ${currentFov()}° (horizontal). ` +
      `Réglable ci-dessous, ou calibre-le automatiquement pour plus de précision.`;
  } else {
    el.className = 'banner banner-warning';
    el.textContent = `Angle de champ non mesuré pour cet objectif : l'app part de ` +
      `${currentFov()}° et corrigera après la première capture. Lance une calibration ` +
      `pour un résultat correct dès la première fois.`;
  }
}

function applySettingsToForm() {
  document.getElementById('set-density').value = settings.density;
  document.getElementById('set-poles').value = settings.poles ? '1' : '0';
  document.getElementById('set-fov').value = currentFov();
  document.getElementById('set-fov-value').textContent = currentFov();
  document.getElementById('set-output').value = settings.output;
  document.getElementById('set-auto').value = settings.autoCapture ? '1' : '0';
  document.getElementById('set-refine').value = settings.refine ? '1' : '0';
  const lensSel = document.getElementById('set-lens');
  if (lensSel) lensSel.value = settings.deviceId || '';
  updateLensInfo();
}
applySettingsToForm();

// ---------------- lens selection ----------------
const lensSelect = document.getElementById('set-lens');

async function populateLenses() {
  try {
    const cams = await listRearCameras();
    if (!cams.length) return;
    lensSelect.innerHTML = '<option value="">Objectif par défaut (arrière)</option>';
    cams.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = c.deviceId;
      const measured = settings.lensFov[c.deviceId];
      opt.textContent = `${c.label}${measured ? ` — ${measured}°` : ''}`;
      lensSelect.appendChild(opt);
    });
    lensSelect.value = settings.deviceId || '';
  } catch (e) { /* permission not granted yet - list stays as-is */ }
}

lensSelect.addEventListener('change', (e) => {
  settings.deviceId = e.target.value;
  saveSettings();
  applySettingsToForm();
});

document.getElementById('set-density').addEventListener('change', (e) => { settings.density = e.target.value; saveSettings(); });
document.getElementById('set-poles').addEventListener('change', (e) => { settings.poles = e.target.value === '1'; saveSettings(); });
document.getElementById('set-fov').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  document.getElementById('set-fov-value').textContent = v;
  settings.lensFov[settings.deviceId || 'default'] = v;
  saveSettings();
  updateLensInfo();
});
document.getElementById('set-output').addEventListener('change', (e) => { settings.output = e.target.value; saveSettings(); });
document.getElementById('set-auto').addEventListener('change', (e) => { settings.autoCapture = e.target.value === '1'; saveSettings(); });
document.getElementById('set-refine').addEventListener('change', (e) => { settings.refine = e.target.value === '1'; saveSettings(); });

document.getElementById('btn-settings').addEventListener('click', () => {
  showScreen('screen-settings');
  populateLenses();
});

// ---------------- home ----------------
const homeHint = document.getElementById('home-hint');
if (!window.isSecureContext) {
  homeHint.textContent = "⚠️ Cette page n'est pas ouverte en HTTPS ni via localhost : la caméra sera bloquée. Voir le README pour lancer l'app correctement.";
  homeHint.classList.remove('hidden');
}

document.getElementById('btn-new-capture').addEventListener('click', () => {
  if (!localStorage.getItem(ONBOARDING_SEEN_KEY)) openOnboarding(startPrep);
  else startPrep();
});

// ---------------- onboarding tutorial ----------------
const ONBOARDING_SEEN_KEY = 'photo360-onboarding-seen';
const onboardingSlides = document.querySelectorAll('.onboarding-slide');
const onboardingDots = document.querySelectorAll('#onboarding-dots .dot');
const onboardingNextBtn = document.getElementById('btn-onboarding-next');
let onboardingIndex = 0;
let onboardingReturnAction = null; // called instead of going home when the tutorial closes

function showOnboardingSlide(i) {
  onboardingIndex = i;
  onboardingSlides.forEach((el, idx) => el.classList.toggle('active', idx === i));
  onboardingDots.forEach((el, idx) => el.classList.toggle('active', idx === i));
  onboardingNextBtn.textContent = i === onboardingSlides.length - 1 ? 'Commencer' : 'Suivant';
}

function openOnboarding(returnAction) {
  onboardingReturnAction = returnAction || null;
  showOnboardingSlide(0);
  showScreen('screen-onboarding');
}

function closeOnboarding() {
  localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
  const action = onboardingReturnAction;
  onboardingReturnAction = null;
  if (action) action(); else goHome();
}

onboardingNextBtn.addEventListener('click', () => {
  if (onboardingIndex < onboardingSlides.length - 1) showOnboardingSlide(onboardingIndex + 1);
  else closeOnboarding();
});
document.getElementById('btn-onboarding-skip').addEventListener('click', closeOnboarding);
document.getElementById('btn-onboarding-close').addEventListener('click', closeOnboarding);
document.getElementById('btn-help').addEventListener('click', () => openOnboarding(null));

// ---------------- lens calibration ----------------
// A refused calibration is reported as such rather than silently storing a
// value we don't believe: every later capture would be built on it.
function calibrationFailureMessage(reason) {
  const retry = "\n\nLa valeur précédente est conservée. Tu peux réessayer.";
  switch (reason) {
    case 'no_movement':
      return "Calibration impossible : les images n'ont pas changé pendant que le " +
        'téléphone tournait. Vérifie que la caméra n\'est pas masquée et refais un ' +
        'essai en pivotant réellement sur toi-même.' + retry;
    case 'no_match':
      return "Calibration impossible : l'app n'a pas réussi à faire correspondre les " +
        'images entre elles. Place-toi dans un endroit bien éclairé, avec des détails ' +
        'visibles (meubles, affiches, fenêtres), et pivote plus lentement et ' +
        'régulièrement, sans te déplacer.' + retry;
    case 'out_of_range':
      return "Calibration impossible : la valeur mesurée sort de la plage plausible " +
        "pour un objectif de smartphone, elle n'est donc pas fiable. Refais un essai " +
        'en pivotant plus lentement, sur au moins trois quarts de tour.' + retry;
    case 'not_enough_frames':
      return "Calibration interrompue : pas assez d'images ont été prises. Recommence " +
        'en pivotant régulièrement jusqu\'à la fin du décompte.' + retry;
    default:
      return "La calibration n'a pas abouti." + retry;
  }
}
const calibVideo = document.getElementById('calib-video');
const calibProgress = document.getElementById('calib-progress');
const calibStatus = document.getElementById('calib-status');
const calibBanner = document.getElementById('calib-banner');
let calibStream = null;
let calibController = null;

function stopCalibration() {
  if (calibController) { calibController.stop(); calibController = null; }
  if (calibStream) {
    for (const t of calibStream.getTracks()) t.stop();
    calibStream = null;
  }
}

document.getElementById('btn-calib-cancel').addEventListener('click', () => {
  stopCalibration();
  showScreen('screen-settings');
});

document.getElementById('btn-calibrate').addEventListener('click', async () => {
  if (!window.isSecureContext) {
    alert("La caméra n'est pas accessible sur cette page (contexte non sécurisé).");
    return;
  }
  showScreen('screen-calibrate');
  calibStatus.textContent = 'Initialisation…';
  calibProgress.textContent = '0 / 8';
  calibBanner.classList.remove('hidden');

  try {
    if (!tracker) {
      tracker = new OrientationTracker();
      await tracker.start();
    }
  } catch (err) {
    stopCalibration();
    showScreen('screen-settings');
    alert(err.message || "Capteurs d'orientation indisponibles.");
    return;
  }

  try {
    calibStream = await openCameraStream(settings.deviceId);
    calibVideo.srcObject = calibStream;
    await calibVideo.play();
  } catch (err) {
    stopCalibration();
    showScreen('screen-settings');
    alert('Accès caméra refusé ou indisponible.');
    return;
  }
  // Labels only become readable once a stream has been granted, so this is
  // the first point where the lens list can be shown properly.
  populateLenses();

  calibStatus.textContent = 'Pivote lentement…';
  // Frame count and step come from CalibrationCapture's documented
  // defaults (a near-full turn), which is what the FOV estimate needs.
  calibController = new CalibrationCapture({ video: calibVideo, tracker });
  calibController.onFrame = (n, total) => {
    calibProgress.textContent = `${n} / ${total}`;
  };
  calibController.onDone = async (rawShots) => {
    stopCalibration();
    showScreen('screen-processing');
    processingLabel.textContent = 'Mesure de l’angle de champ…';
    processingBar.style.width = '0%';
    await new Promise((r) => setTimeout(r, 50));

    const shots = rawShots.map((s) => prepareShot(s.imageData, s.basis));
    const { fov, reason } = await calibrateFov(shots, {}, (frac, label) => {
      processingBar.style.width = `${Math.round(frac * 100)}%`;
      if (label) processingLabel.textContent = label;
    });

    if (fov) {
      setMeasuredFov(Math.round(fov));
      populateLenses();
      alert(`Angle de champ mesuré : ${Math.round(fov)}° horizontal.\n\n` +
        `Le nombre de photos et l'assemblage s'adapteront désormais à cet objectif.`);
    } else {
      alert(calibrationFailureMessage(reason));
    }
    showScreen('screen-settings');
  };
  calibController.start();
});

// ---------------- prep (permissions) ----------------
const prepStatus = document.getElementById('prep-status');
const prepError = document.getElementById('prep-error');
const prepRetry = document.getElementById('btn-prep-retry');

let tracker = null;

async function startPrep() {
  showScreen('screen-prep');
  prepError.classList.add('hidden');
  prepRetry.classList.add('hidden');
  prepStatus.classList.remove('hidden');
  prepStatus.textContent = 'Initialisation de la caméra et des capteurs…';

  if (!window.isSecureContext) {
    prepFail("Contexte non sécurisé : ouvre cette app via une adresse http://localhost:... ou https://, pas en fichier local direct (voir le README).");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    prepFail("Ce navigateur ne permet pas l'accès à la caméra. Utilise Chrome sur Android.");
    return;
  }
  if (!window.DeviceOrientationEvent) {
    prepFail("Ce navigateur ne fournit pas les données du gyroscope, nécessaires pour guider la capture.");
    return;
  }

  try {
    tracker = new OrientationTracker();
    await tracker.start();
    goToCapture();
  } catch (err) {
    prepFail(err.message || "Impossible d'accéder aux capteurs d'orientation.");
  }
}

function prepFail(message) {
  prepStatus.classList.add('hidden');
  prepError.textContent = message;
  prepError.classList.remove('hidden');
  prepRetry.classList.remove('hidden');
}
prepRetry.addEventListener('click', startPrep);

// ---------------- capture ----------------
const video = document.getElementById('capture-video');
const overlay = document.getElementById('capture-overlay');
const progressEl = document.getElementById('capture-progress');
const captureBanner = document.getElementById('capture-banner');

function parseOutput(str) {
  const [w, h] = str.split('x').map(Number);
  return { w, h };
}

async function goToCapture() {
  showScreen('screen-capture');
  overlay.width = window.innerWidth;
  overlay.height = window.innerHeight;

  const fov = currentFov();
  const ctrl = new CaptureController({
    video, overlayCanvas: overlay, tracker, targets: [],
    settings: {
      hFov: fov, deviceId: settings.deviceId,
      yawToleranceDeg: 10, pitchToleranceDeg: 10, autoCapture: settings.autoCapture,
      // Longer hold + a steadiness requirement: a frame grabbed while the
      // phone is still swinging is blurred and mis-tagged, which no amount
      // of post-processing can undo.
      holdMs: 600, rollLimit: 16, steadyLimit: 8,
    },
  });
  currentCaptureController = ctrl;

  try {
    await ctrl.startCamera();
  } catch (err) {
    showScreen('screen-prep');
    prepFail("Accès caméra refusé ou indisponible. Autorise la caméra pour ce site puis réessaie.");
    return;
  }

  // Built only now, because it depends on two things the camera has to be
  // running to know: the selected lens's field of view (so a wide-angle
  // needs fewer shots and a tele more) and the shape of the frames this
  // camera actually delivers - holding the phone upright puts the lens's
  // wide field of view on the vertical axis, which changes how many rows
  // are needed to overlap properly.
  ctrl.setTargets(buildGrid(settings.density, fov, settings.poles, ctrl.frameAspect()));

  ctrl.on('progress', ({ done, total, aligned, rollOk, pitchOk, steady }) => {
    progressEl.textContent = `${done} / ${total}`;
    if (!rollOk) {
      captureBanner.textContent = '📱 Nivelle le téléphone : aligne la barre du haut (en vert quand c\'est bon).';
      captureBanner.classList.remove('hidden');
    } else if (!pitchOk) {
      captureBanner.textContent = '↕️ Ajuste l\'inclinaison avec la jauge de droite (en vert quand c\'est bon).';
      captureBanner.classList.remove('hidden');
    } else if (!steady) {
      captureBanner.textContent = '✋ Immobilise le téléphone un instant…';
      captureBanner.classList.remove('hidden');
    } else if (settings.autoCapture && aligned) {
      captureBanner.textContent = '✅ Cible atteinte, capture…';
      captureBanner.classList.remove('hidden');
    } else {
      captureBanner.classList.add('hidden');
    }
  });
  ctrl.on('done', (shots) => finishCapture(shots));

  document.getElementById('btn-capture-manual').onclick = () => ctrl.captureCurrent();
  document.getElementById('btn-capture-skip').onclick = () => ctrl.skipCurrent();
  document.getElementById('btn-capture-finish').onclick = () => ctrl.finishEarly();
  document.getElementById('btn-capture-cancel').onclick = () => {
    ctrl.stop();
    ctrl.stopCamera();
    goHome();
  };

  ctrl.start();
}

const processingLabel = document.getElementById('processing-label');
const processingBar = document.getElementById('processing-bar');

async function finishCapture(shots) {
  currentCaptureController.stopCamera();
  showScreen('screen-processing');
  processingLabel.textContent = 'Préparation…';
  processingBar.style.width = '0%';
  await new Promise((r) => setTimeout(r, 50));

  if (!shots.length) {
    alert("Aucune photo n'a été prise.");
    goHome();
    return;
  }

  const { w: outW, h: outH } = parseOutput(settings.output);
  const result = await stitchPanorama(shots, {
    hFovGuess: currentFov(),
    outWidth: outW,
    outHeight: outH,
    refine: settings.refine,
  }, (frac, label) => {
    processingBar.style.width = `${Math.round(frac * 100)}%`;
    if (label) processingLabel.textContent = label;
  });

  pendingCanvas = result.canvas;
  pendingCoverage = result.coverage;
  pendingExcludedCount = result.excludedCount || 0;
  // The solver measures the lens far more reliably than any manual guess,
  // so remember it against the lens that was actually used.
  if (settings.refine && result.hFovDeg) setMeasuredFov(Math.round(result.hFovDeg));
  openPreview();
}

// ---------------- preview ----------------
const previewPannellumEl = document.getElementById('preview-pannellum');
const previewCoverageBanner = document.getElementById('preview-coverage-banner');
const previewNameInput = document.getElementById('preview-name');

// The capture grid covers the full sphere geometrically (verified: 100% for
// every supported lens, and still 100% with several degrees of orientation
// error injected), so a *small* shortfall here is not a capture mistake to
// warn about - it is the couple of percent that the real per-shot
// orientation error inevitably nibbles off, essentially all of it in the
// last few degrees around the zenith and nadir, where it is filled by
// stretching the nearest pixels and is invisible in practice. This used to
// be 0.97, which real captures land just under almost every time, so the
// warning fired constantly for a non-issue and buried the cases that
// genuinely deserve attention. Only a shortfall big enough to leave a
// visible smeared patch is worth surfacing.
const COVERAGE_WARN = 0.92;

function openPreview() {
  showScreen('screen-preview');
  const coverage = pendingCoverage;
  if (pendingExcludedCount > 0) {
    const s = pendingExcludedCount > 1 ? 's' : '';
    // More specific and actionable than the generic coverage banner below:
    // names the likely real-world cause (a shot's compass reading
    // disagreed with where it was actually aimed - most often magnetic
    // interference from nearby electronics) rather than just reporting a
    // percentage, per the project's own rule that data-quality banners
    // must say what to check, not just how much is missing.
    previewCoverageBanner.textContent =
      `⚠️ ${pendingExcludedCount} photo${s} ignorée${s} : le capteur d'orientation ne correspondait plus ` +
      `à la cible visée au moment de la prise (souvent causé par des interférences magnétiques près d'un ` +
      `écran, d'une tour PC ou d'objets métalliques). La zone concernée a été comblée avec les pixels les ` +
      `plus proches — pour un meilleur résultat, refais la capture en t'éloignant un peu de ces appareils.`;
    previewCoverageBanner.classList.remove('hidden');
  } else if (coverage < COVERAGE_WARN) {
    previewCoverageBanner.textContent = `⚠️ Couverture incomplète (${Math.round(coverage * 100)}% de la sphère). ` +
      `Les zones manquantes ont été comblées avec les pixels les plus proches — vérifie le rendu ci-dessus. ` +
      `Tu peux recommencer la capture si le résultat n'est pas satisfaisant.`;
    previewCoverageBanner.classList.remove('hidden');
  } else {
    previewCoverageBanner.classList.add('hidden');
  }
  previewNameInput.value = `Photo 360 - ${new Date().toLocaleDateString('fr-FR')}`;

  pendingCanvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    previewPannellumEl.innerHTML = '';
    currentViewer = window.pannellum.viewer(previewPannellumEl, {
      type: 'equirectangular', panorama: url, autoLoad: true,
    });
  }, 'image/jpeg', 0.9);
}

document.getElementById('btn-preview-discard').addEventListener('click', () => {
  pendingCanvas = null;
  goHome();
});

document.getElementById('btn-preview-save').addEventListener('click', async () => {
  const name = previewNameInput.value.trim() || 'Photo 360';
  await persistCurrentPhoto(name);
  goHome();
});

document.getElementById('btn-preview-share').addEventListener('click', () => sharePendingCanvas(previewNameInput.value.trim() || 'photo360'));
document.getElementById('btn-preview-download').addEventListener('click', () => downloadPendingCanvas(previewNameInput.value.trim() || 'photo360'));

function persistCurrentPhoto(name) {
  return new Promise((resolve) => {
    pendingCanvas.toBlob((blob) => {
      const thumb = document.createElement('canvas');
      thumb.width = 320; thumb.height = 160;
      thumb.getContext('2d').drawImage(pendingCanvas, 0, 0, 320, 160);
      thumb.toBlob(async (thumbBlob) => {
        await savePhoto({ name, blob, thumbBlob, width: pendingCanvas.width, height: pendingCanvas.height });
        resolve();
      }, 'image/jpeg', 0.7);
    }, 'image/jpeg', 0.9);
  });
}

function sharePendingCanvas(name) {
  pendingCanvas.toBlob(async (blob) => {
    await shareBlob(blob, name);
  }, 'image/jpeg', 0.9);
}
function downloadPendingCanvas(name) {
  pendingCanvas.toBlob((blob) => downloadBlob(blob, name), 'image/jpeg', 0.9);
}

const FORMATS = {
  jpg: { ext: 'jpg', mime: 'image/jpeg', label: 'Image JPEG', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
  html: { ext: 'html', mime: 'text/html', label: 'Page web 360', accept: { 'text/html': ['.html'] } },
};

// All three exit paths return the same shape ({ method, filename } or null
// when the user cancelled) so callers can record consistently where a
// photo actually ended up.
async function shareBlob(blob, name, formatKey = 'jpg') {
  const fmt = FORMATS[formatKey];
  const filename = `${sanitizeFilename(name)}.${fmt.ext}`;
  const file = new File([blob], filename, { type: fmt.mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: name,
        text: `Photo 360° : ${name}`,
      });
      return { method: 'share', filename, format: formatKey };
    } catch (err) {
      if (err && err.name === 'AbortError') return null; // user cancelled
    }
  }
  const saved = await downloadBlob(blob, name, formatKey);
  if (saved) {
    alert("Le partage direct n'est pas disponible sur ce navigateur : le fichier a été enregistré. " +
      'Ouvre ton application email ou de messagerie et joins-le manuellement.');
  }
  return saved;
}

// Enregistre le blob sur le téléphone. Quand le navigateur le permet
// (File System Access API), ouvre le sélecteur natif : l'utilisateur choisit
// lui-même le dossier (stockage interne, carte SD, Drive...) et peut modifier
// le nom de fichier proposé. Sinon, retombe sur le téléchargement classique
// du navigateur (dossier Téléchargements, nom imposé) - c'est notamment le
// cas de Chrome sur Android, qui n'expose pas ce sélecteur.
async function downloadBlob(blob, name, formatKey = 'jpg') {
  const fmt = FORMATS[formatKey];
  const filename = `${sanitizeFilename(name)}.${fmt.ext}`;
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: fmt.label, accept: fmt.accept }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      // handle.name is the name the user actually confirmed, which may
      // differ from the one we suggested.
      return { method: 'picker', filename: handle.name || filename, format: formatKey };
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      // Any other error (partial/older browser support): fall through to
      // the classic download below.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { method: 'download', filename, format: formatKey };
}

// Human-readable summary of a photo's export history, e.g.
// "Téléchargé le 29/07/2026 → Salle_204.jpg".
const EXPORT_METHOD_LABEL = {
  picker: 'Enregistré',
  download: 'Téléchargé',
  share: 'Partagé',
};
function describeExport(entry) {
  if (!entry) return '';
  const when = new Date(entry.at).toLocaleDateString('fr-FR');
  const what = entry.format === 'html' ? ' (page web)' : '';
  return `${EXPORT_METHOD_LABEL[entry.method] || 'Exporté'} le ${when} → ${entry.filename}${what}`;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'photo360';
}

// ---------------- home gallery ----------------
const homeList = document.getElementById('home-list');
const homeEmpty = document.getElementById('home-empty');
const exportBtn = document.getElementById('btn-export');
// Object URLs for the thumbnails currently on screen; revoked when the
// list is rebuilt so repeated refreshes don't leak blob URLs.
let homeThumbUrls = [];
let latestPhotoId = null;

async function refreshHome() {
  const photos = await listPhotos();
  for (const u of homeThumbUrls) URL.revokeObjectURL(u);
  homeThumbUrls = [];
  homeList.innerHTML = '';
  homeEmpty.classList.toggle('hidden', photos.length > 0);
  latestPhotoId = photos.length ? photos[0].id : null;
  exportBtn.disabled = !latestPhotoId;

  for (const p of photos) {
    const url = URL.createObjectURL(p.thumbBlob || p.blob);
    homeThumbUrls.push(url);
    const card = document.createElement('button');
    card.className = 'home-card';
    card.type = 'button';
    card.innerHTML =
      '<img alt="">' +
      '<span class="home-card-badge">360°</span>' +
      '<span class="home-card-overlay">' +
        '<span class="home-card-name"></span>' +
        '<span class="home-card-date"></span>' +
        '<span class="home-card-export"></span>' +
      '</span>';
    card.querySelector('img').src = url;
    card.querySelector('.home-card-name').textContent = p.name;
    card.querySelector('.home-card-date').textContent =
      new Date(p.createdAt).toLocaleString('fr-FR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    const lastExport = p.exports && p.exports.length ? p.exports[p.exports.length - 1] : null;
    card.querySelector('.home-card-export').textContent =
      lastExport ? `✔ ${describeExport(lastExport)}` : '';
    card.addEventListener('click', () => openViewer(p.id));
    homeList.appendChild(card);
  }
}

function goHome() {
  showScreen('screen-home');
  refreshHome();
}

// The floating export button acts on the most recent photo - the one the
// user just made. Any other photo is exported from its own viewer, which
// is where per-photo actions live.
exportBtn.addEventListener('click', async () => {
  if (!latestPhotoId) return;
  const record = await getPhoto(latestPhotoId);
  if (!record) return;
  const result = await shareBlob(record.blob, record.name);
  if (result) {
    await recordExport(latestPhotoId, result);
    refreshHome();
  }
});

refreshHome();

// ---------------- viewer ----------------
const viewerPannellumEl = document.getElementById('viewer-pannellum');
const viewerTitle = document.getElementById('viewer-title');
const gyroBtn = document.getElementById('btn-viewer-gyro');
const viewerExportStatus = document.getElementById('viewer-export-status');
const viewerExportInfo = document.getElementById('viewer-export-info');
let viewerObjectUrl = null;

// Shows where this photo has already been saved or sent, so the user does
// not have to remember - that was the point of asking for it.
async function showViewerExportInfo() {
  const record = await getPhoto(currentViewerPhotoId);
  const last = record && record.exports && record.exports.length
    ? record.exports[record.exports.length - 1] : null;
  viewerExportInfo.textContent = last ? describeExport(last) : 'Pas encore exportée';
}

async function openViewer(id) {
  const record = await getPhoto(id);
  if (!record) return;
  currentViewerPhotoId = id;
  showScreen('screen-viewer');
  viewerTitle.textContent = record.name;
  if (viewerObjectUrl) URL.revokeObjectURL(viewerObjectUrl);
  viewerObjectUrl = URL.createObjectURL(record.blob);
  viewerPannellumEl.innerHTML = '';
  // Pannellum already handles drag-to-look and pinch-to-zoom; the gyro
  // ("virtual tour") mode is its own orientation support, toggled below.
  // Its built-in control chrome is hidden: the zoom buttons sit in the
  // top-left corner, right underneath this screen's own back button, and
  // touch gestures cover the same job on a phone anyway.
  currentViewer = window.pannellum.viewer(viewerPannellumEl, {
    type: 'equirectangular',
    panorama: viewerObjectUrl,
    autoLoad: true,
    showControls: false,
    friction: 0.15,
  });
  updateGyroButton();
  showViewerExportInfo();
}

function updateGyroButton() {
  const active = !!(currentViewer && currentViewer.isOrientationActive && currentViewer.isOrientationActive());
  gyroBtn.classList.toggle('active', active);
  gyroBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
}

gyroBtn.addEventListener('click', async () => {
  if (!currentViewer) return;
  if (!currentViewer.isOrientationSupported || !currentViewer.isOrientationSupported()) {
    alert("Ce téléphone ou ce navigateur ne fournit pas les capteurs d'orientation " +
      'nécessaires. Tu peux quand même explorer la photo au doigt : glisse pour ' +
      'regarder autour de toi, pince pour zoomer.');
    return;
  }
  if (currentViewer.isOrientationActive()) {
    currentViewer.stopOrientation();
  } else {
    // iOS-style permission gate; a no-op on Android Chrome.
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        if (await DOE.requestPermission() !== 'granted') {
          alert("Accès aux capteurs refusé : la visite virtuelle ne peut pas démarrer.");
          return;
        }
      } catch (e) {
        alert("Accès aux capteurs refusé : la visite virtuelle ne peut pas démarrer.");
        return;
      }
    }
    currentViewer.startOrientation();
  }
  updateGyroButton();
});

// Every export path funnels through here so the history stays complete
// however the file left the app.
async function exportCurrentPhoto(action, formatKey) {
  const record = await getPhoto(currentViewerPhotoId);
  if (!record) return;
  let blob = record.blob;
  if (formatKey === 'html') {
    viewerExportStatus.textContent = 'Préparation du fichier…';
    viewerExportStatus.classList.remove('hidden');
    try {
      blob = await buildStandaloneViewer(record.blob, record.name);
    } catch (err) {
      viewerExportStatus.classList.add('hidden');
      alert("Impossible de préparer la page web : " + (err && err.message ? err.message : 'erreur inconnue'));
      return;
    }
    viewerExportStatus.classList.add('hidden');
  }
  const result = action === 'share'
    ? await shareBlob(blob, record.name, formatKey)
    : await downloadBlob(blob, record.name, formatKey);
  if (result) {
    await recordExport(currentViewerPhotoId, result);
    showViewerExportInfo();
  }
}

document.getElementById('btn-viewer-share').addEventListener('click', () => exportCurrentPhoto('share', 'jpg'));
document.getElementById('btn-viewer-download').addEventListener('click', () => exportCurrentPhoto('download', 'jpg'));
document.getElementById('btn-viewer-web').addEventListener('click', () => exportCurrentPhoto('share', 'html'));
document.getElementById('btn-viewer-rename').addEventListener('click', async () => {
  const record = await getPhoto(currentViewerPhotoId);
  if (!record) return;
  const name = prompt('Nouveau nom :', record.name);
  if (name && name.trim()) {
    await renamePhoto(currentViewerPhotoId, name.trim());
    viewerTitle.textContent = name.trim();
  }
});
document.getElementById('btn-viewer-delete').addEventListener('click', async () => {
  if (!confirm('Supprimer définitivement cette photo 360 ?')) return;
  await deletePhoto(currentViewerPhotoId);
  goHome();
});

// ---------------- service worker ----------------
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
