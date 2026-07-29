import { OrientationTracker } from './orientation.js';
import { buildGrid } from './grid.js';
import { CaptureController } from './capture.js';
import { savePhoto, listPhotos, getPhoto, deletePhoto, renamePhoto } from './storage.js';

const SETTINGS_KEY = 'photo360-settings-v1';
const DEFAULT_SETTINGS = {
  density: 'standard',
  poles: true,
  fov: 66,
  output: '2048x1024',
  autoCapture: true,
};

let settings = loadSettings();
let pendingAccumulator = null;
let pendingCanvas = null;
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

document.getElementById('btn-settings').addEventListener('click', () => showScreen('screen-settings'));

// ---------------- home ----------------
const homeHint = document.getElementById('home-hint');
if (!window.isSecureContext) {
  homeHint.textContent = "⚠️ Cette page n'est pas ouverte en HTTPS ni via localhost : la caméra sera bloquée. Voir le README pour lancer l'app correctement.";
} else {
  homeHint.textContent = '';
}

document.getElementById('btn-gallery').addEventListener('click', openGallery);
document.getElementById('btn-new-capture').addEventListener('click', startPrep);

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

  const captureW = 1280, captureH = 960;
  const targets = buildGrid(settings.density, settings.fov, settings.poles);
  const { w: outW, h: outH } = parseOutput(settings.output);

  const ctrl = new CaptureController({
    video, overlayCanvas: overlay, tracker, targets,
    settings: {
      hFov: settings.fov, tolerance: 0.16, autoCapture: settings.autoCapture,
      captureW, captureH, holdMs: 350, rollLimit: 12,
    },
    outputWidth: outW, outputHeight: outH,
  });
  currentCaptureController = ctrl;

  try {
    await ctrl.startCamera();
  } catch (err) {
    showScreen('screen-prep');
    prepFail("Accès caméra refusé ou indisponible. Autorise la caméra pour ce site puis réessaie.");
    return;
  }

  ctrl.on('progress', ({ done, total, aligned, level }) => {
    progressEl.textContent = `${done} / ${total}`;
    if (!level) {
      captureBanner.textContent = '📱 Tiens le téléphone bien droit (à plat sur l\'axe vertical).';
      captureBanner.classList.remove('hidden');
    } else if (settings.autoCapture && aligned) {
      captureBanner.textContent = '✅ Cible atteinte, capture…';
      captureBanner.classList.remove('hidden');
    } else {
      captureBanner.classList.add('hidden');
    }
  });
  ctrl.on('done', (accumulator) => finishCapture(accumulator));

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

async function finishCapture(accumulator) {
  currentCaptureController.stopCamera();
  showScreen('screen-processing');
  // Let the processing screen paint before the synchronous, potentially
  // heavy toCanvas() gap-fill pass runs.
  await new Promise((r) => setTimeout(r, 50));
  pendingAccumulator = accumulator;
  pendingCanvas = accumulator.toCanvas();
  openPreview();
}

// ---------------- preview ----------------
const previewPannellumEl = document.getElementById('preview-pannellum');
const previewCoverageBanner = document.getElementById('preview-coverage-banner');
const previewNameInput = document.getElementById('preview-name');

function openPreview() {
  showScreen('screen-preview');
  const coverage = pendingAccumulator.coverage();
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
  pendingAccumulator = null; pendingCanvas = null;
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
  downloadBlob(blob, name);
  alert("Le partage direct n'est pas disponible sur ce navigateur : le fichier a été téléchargé. " +
    'Ouvre ton application email et joins-le manuellement depuis le dossier Téléchargements.');
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(name)}.jpg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
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
