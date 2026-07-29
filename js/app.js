import { OrientationTracker } from './orientation.js';
import { buildGrid } from './grid.js';
import { CaptureController } from './capture.js';
import { stitchPanorama } from './align.js';
import { savePhoto, listPhotos, getPhoto, deletePhoto, renamePhoto } from './storage.js';

const SETTINGS_KEY = 'photo360-settings-v1';
const DEFAULT_SETTINGS = {
  density: 'standard',
  poles: true,
  fov: 66,
  output: '2048x1024',
  autoCapture: true,
  refine: true,
};

let settings = loadSettings();
let pendingCanvas = null;
let pendingCoverage = 1;
let currentCaptureController = null;
let currentViewer = null; // active pannellum instance, destroyed on screen change
let currentViewerPhotoId = null;

// ---------------- navigation ----------------
function showScreen(id) {
  if (currentViewer) { try { currentViewer.destroy(); } catch (e) {} currentViewer = null; }
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => showScreen(btn.dataset.back));
});

// ---------------- settings ----------------
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {}
  return { ...DEFAULT_SETTINGS };
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
function applySettingsToForm() {
  document.getElementById('set-density').value = settings.density;
  document.getElementById('set-poles').value = settings.poles ? '1' : '0';
  document.getElementById('set-fov').value = settings.fov;
  document.getElementById('set-fov-value').textContent = settings.fov;
  document.getElementById('set-output').value = settings.output;
  document.getElementById('set-auto').value = settings.autoCapture ? '1' : '0';
  document.getElementById('set-refine').value = settings.refine ? '1' : '0';
}
applySettingsToForm();

document.getElementById('set-density').addEventListener('change', (e) => { settings.density = e.target.value; saveSettings(); });
document.getElementById('set-poles').addEventListener('change', (e) => { settings.poles = e.target.value === '1'; saveSettings(); });
document.getElementById('set-fov').addEventListener('input', (e) => {
  settings.fov = Number(e.target.value);
  document.getElementById('set-fov-value').textContent = settings.fov;
  saveSettings();
});
document.getElementById('set-output').addEventListener('change', (e) => { settings.output = e.target.value; saveSettings(); });
document.getElementById('set-auto').addEventListener('change', (e) => { settings.autoCapture = e.target.value === '1'; saveSettings(); });
document.getElementById('set-refine').addEventListener('change', (e) => { settings.refine = e.target.value === '1'; saveSettings(); });

document.getElementById('btn-settings').addEventListener('click', () => showScreen('screen-settings'));

// ---------------- home ----------------
const homeHint = document.getElementById('home-hint');
if (!window.isSecureContext) {
  homeHint.textContent = "⚠️ Cette page n'est pas ouverte en HTTPS ni via localhost : la caméra sera bloquée. Voir le README pour lancer l'app correctement.";
} else {
  homeHint.textContent = '';
}

document.getElementById('btn-gallery').addEventListener('click', openGallery);
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
  if (action) action(); else showScreen('screen-home');
}

onboardingNextBtn.addEventListener('click', () => {
  if (onboardingIndex < onboardingSlides.length - 1) showOnboardingSlide(onboardingIndex + 1);
  else closeOnboarding();
});
document.getElementById('btn-onboarding-skip').addEventListener('click', closeOnboarding);
document.getElementById('btn-onboarding-close').addEventListener('click', closeOnboarding);
document.getElementById('btn-help').addEventListener('click', () => openOnboarding(null));

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

  const targets = buildGrid(settings.density, settings.fov, settings.poles);

  const ctrl = new CaptureController({
    video, overlayCanvas: overlay, tracker, targets,
    settings: {
      hFov: settings.fov, tolerance: 0.22, autoCapture: settings.autoCapture,
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

  ctrl.on('progress', ({ done, total, aligned, level, steady }) => {
    progressEl.textContent = `${done} / ${total}`;
    if (!level) {
      captureBanner.textContent = '📱 Tiens le téléphone bien droit (à plat sur l\'axe vertical).';
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
    showScreen('screen-home');
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
    showScreen('screen-home');
    return;
  }

  const { w: outW, h: outH } = parseOutput(settings.output);
  const result = await stitchPanorama(shots, {
    hFovGuess: settings.fov,
    outWidth: outW,
    outHeight: outH,
    refine: settings.refine,
  }, (frac, label) => {
    processingBar.style.width = `${Math.round(frac * 100)}%`;
    if (label) processingLabel.textContent = label;
  });

  pendingCanvas = result.canvas;
  pendingCoverage = result.coverage;
  // The solver's own FOV estimate is far more reliable than the manual
  // guess, so keep it as the starting point for the next capture.
  if (settings.refine && result.hFovDeg && Math.abs(result.hFovDeg - settings.fov) > 0.5) {
    settings.fov = result.hFovDeg;
    saveSettings();
    applySettingsToForm();
  }
  openPreview();
}

// ---------------- preview ----------------
const previewPannellumEl = document.getElementById('preview-pannellum');
const previewCoverageBanner = document.getElementById('preview-coverage-banner');
const previewNameInput = document.getElementById('preview-name');

function openPreview() {
  showScreen('screen-preview');
  const coverage = pendingCoverage;
  if (coverage < 0.97) {
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
  showScreen('screen-home');
});

document.getElementById('btn-preview-save').addEventListener('click', async () => {
  const name = previewNameInput.value.trim() || 'Photo 360';
  await persistCurrentPhoto(name);
  alert('Photo enregistrée dans la galerie.');
  showScreen('screen-home');
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

async function shareBlob(blob, name) {
  const filename = `${sanitizeFilename(name)}.jpg`;
  const file = new File([blob], filename, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: name,
        text: `Photo 360° : ${name}`,
      });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled
    }
  }
  const saved = await downloadBlob(blob, name);
  if (saved) {
    alert("Le partage direct n'est pas disponible sur ce navigateur : le fichier a été enregistré. " +
      'Ouvre ton application email ou de messagerie et joins-le manuellement.');
  }
}

// Enregistre le blob sur le téléphone. Quand le navigateur le permet
// (File System Access API), ouvre le sélecteur natif Android : l'utilisateur
// choisit lui-même le dossier (stockage interne, carte SD, Drive...) et peut
// modifier le nom de fichier proposé avant de valider. Sinon, retombe sur le
// téléchargement classique du navigateur (toujours dans "Téléchargements",
// nom de fichier imposé). Renvoie false si l'utilisateur annule le
// sélecteur (pas de fallback forcé dans ce cas - il a choisi d'annuler).
async function downloadBlob(blob, name) {
  const filename = `${sanitizeFilename(name)}.jpg`;
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Image JPEG', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
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
  return true;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'photo360';
}

// ---------------- gallery ----------------
const galleryList = document.getElementById('gallery-list');
const galleryEmpty = document.getElementById('gallery-empty');

async function openGallery() {
  showScreen('screen-gallery');
  const photos = await listPhotos();
  galleryList.innerHTML = '';
  galleryEmpty.classList.toggle('hidden', photos.length > 0);
  for (const p of photos) {
    const thumbUrl = URL.createObjectURL(p.thumbBlob || p.blob);
    const item = document.createElement('button');
    item.className = 'gallery-item';
    item.innerHTML = `<img src="${thumbUrl}" alt=""><div class="gi-name"></div>`;
    item.querySelector('.gi-name').textContent = p.name;
    item.addEventListener('click', () => openViewer(p.id));
    galleryList.appendChild(item);
  }
}

// ---------------- viewer ----------------
const viewerPannellumEl = document.getElementById('viewer-pannellum');
const viewerTitle = document.getElementById('viewer-title');

async function openViewer(id) {
  const record = await getPhoto(id);
  if (!record) return;
  currentViewerPhotoId = id;
  showScreen('screen-viewer');
  viewerTitle.textContent = record.name;
  const url = URL.createObjectURL(record.blob);
  viewerPannellumEl.innerHTML = '';
  currentViewer = window.pannellum.viewer(viewerPannellumEl, {
    type: 'equirectangular', panorama: url, autoLoad: true,
  });
}

document.getElementById('btn-viewer-share').addEventListener('click', async () => {
  const record = await getPhoto(currentViewerPhotoId);
  if (record) await shareBlob(record.blob, record.name);
});
document.getElementById('btn-viewer-download').addEventListener('click', async () => {
  const record = await getPhoto(currentViewerPhotoId);
  if (record) await downloadBlob(record.blob, record.name);
});
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
  showScreen('screen-gallery');
  openGallery();
});

// ---------------- service worker ----------------
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
