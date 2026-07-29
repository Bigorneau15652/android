// Builds a self-contained interactive 360 viewer as a single .html file.
//
// The app has no server, so there is no URL to hand someone. Instead the
// photo and the whole viewer are baked into one file: the recipient opens
// it in any browser and can look around, with nothing to install, no
// account, and no connection needed. That covers "send it to someone so
// they can explore it" without introducing hosting.
//
// Everything is inlined (Pannellum's JS and CSS, and the JPEG as a data
// URI) precisely because the file has to keep working after it has been
// emailed, copied to a USB stick, or opened offline.

// Escaping `</script` is not cosmetic: an unescaped occurrence anywhere
// inside inlined JS would close the surrounding <script> tag early and
// break the generated page. The sequence is re-formed by the parser.
function inlineScriptSafe(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

let cachedAssets = null;
async function loadViewerAssets() {
  if (cachedAssets) return cachedAssets;
  // Served from our own origin, and already in the service worker cache,
  // so this still resolves when the phone is offline.
  const [js, css] = await Promise.all([
    fetch('vendor/pannellum/pannellum.js').then((r) => r.text()),
    fetch('vendor/pannellum/pannellum.css').then((r) => r.text()),
  ]);
  cachedAssets = { js, css };
  return cachedAssets;
}

export async function buildStandaloneViewer(jpegBlob, name) {
  const { js, css } = await loadViewerAssets();
  const dataUrl = await blobToDataUrl(jpegBlob);
  const title = escapeHtml(name || 'Photo 360');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<style>
${css}
html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
#panorama { position: absolute; inset: 0; }
#hint {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
  background: rgba(0,0,0,0.55); color: #fff;
  font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  text-align: center; white-space: normal; overflow-wrap: anywhere;
}
#hint b { font-weight: 700; }
#gyro {
  position: absolute; top: 12px; right: 12px; z-index: 5;
  border: none; border-radius: 24px; padding: 9px 14px;
  background: rgba(0,0,0,0.62); color: #fff;
  font: 700 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  cursor: pointer;
}
#gyro.on { background: #2f6fed; }
</style>
</head>
<body>
<div id="panorama"></div>
<button id="gyro" hidden>Visite virtuelle</button>
<div id="hint"><b>${title}</b> — glisse pour regarder autour, pince pour zoomer.</div>
<script>${inlineScriptSafe(js)}</script>
<script>
(function () {
  var viewer = pannellum.viewer('panorama', {
    type: 'equirectangular',
    panorama: ${JSON.stringify(dataUrl)},
    autoLoad: true,
    showControls: false,
    friction: 0.15
  });
  var btn = document.getElementById('gyro');
  if (viewer.isOrientationSupported && viewer.isOrientationSupported()) {
    btn.hidden = false;
    btn.addEventListener('click', function () {
      if (viewer.isOrientationActive()) {
        viewer.stopOrientation();
        btn.classList.remove('on');
        return;
      }
      var DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === 'function') {
        DOE.requestPermission().then(function (res) {
          if (res === 'granted') { viewer.startOrientation(); btn.classList.add('on'); }
        }).catch(function () {});
      } else {
        viewer.startOrientation();
        btn.classList.add('on');
      }
    });
  }
}());
</script>
</body>
</html>`;

  return new Blob([html], { type: 'text/html' });
}
