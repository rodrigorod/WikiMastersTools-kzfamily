function getExtensionRuntime() {
  return (typeof browser !== 'undefined' && browser?.runtime)
    ? browser.runtime
    : (typeof chrome !== 'undefined' && chrome?.runtime)
      ? chrome.runtime
      : null;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  (() => {
    // Pont page -> extension : capture l'onglet réel puis recadre la carte.
    // Aucun SVG/foreignObject n'est utilisé, donc le rendu copié est exactement
    // celui que le navigateur affiche et ne peut pas être bloqué par un canvas tainté.
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;

      const message = event.data;
      if (
        !message ||
        message.source !== 'wm-average-page' ||
        message.type !== 'capture-card-image' ||
        typeof message.requestId !== 'string' ||
        !message.rect
      ) {
        return;
      }

      const reply = (ok, error = null) => {
        window.postMessage({
          source: 'wm-average-extension',
          type: 'copy-card-image-result',
          requestId: message.requestId,
          ok,
          error
        }, '*');
      };

      const sendRuntimeMessage = (payload) => new Promise((resolve, reject) => {
        const runtime =
          typeof browser !== 'undefined' && browser?.runtime
            ? browser.runtime
            : typeof chrome !== 'undefined' && chrome?.runtime
              ? chrome.runtime
              : null;

        if (!runtime?.sendMessage) {
          reject(new Error('Messagerie extension indisponible'));
          return;
        }

        if (typeof browser !== 'undefined' && browser?.runtime?.sendMessage) {
          browser.runtime.sendMessage(payload).then(resolve, reject);
          return;
        }

        runtime.sendMessage(payload, (response) => {
          const lastError =
            typeof chrome !== 'undefined' && chrome?.runtime?.lastError
              ? chrome.runtime.lastError
              : null;

          if (lastError) {
            reject(new Error(lastError.message));
          } else {
            resolve(response);
          }
        });
      });

      const imageFromUrl = (url) => new Promise((resolve, reject) => {
        const image = new Image();
        image.addEventListener('load', () => resolve(image), { once: true });
        image.addEventListener('error', () => reject(new Error('Capture illisible')), { once: true });
        image.src = url;
      });

      const canvasBlob = (canvas) => new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('PNG impossible')),
          'image/png'
        );
      });

      try {
        const captured = await sendRuntimeMessage({ type: 'wm-capture-visible-tab' });
        if (!captured?.ok || typeof captured.dataUrl !== 'string') {
          throw new Error(captured?.error || 'Capture de l’onglet impossible');
        }

        const screenshot = await imageFromUrl(captured.dataUrl);
        const viewportWidth = Math.max(1, window.innerWidth);
        const viewportHeight = Math.max(1, window.innerHeight);
        const scaleX = screenshot.naturalWidth / viewportWidth;
        const scaleY = screenshot.naturalHeight / viewportHeight;

        const rect = message.rect;
        const left = Math.max(0, Number(rect.left) || 0);
        const top = Math.max(0, Number(rect.top) || 0);
        const right = Math.min(viewportWidth, Number(rect.right) || 0);
        const bottom = Math.min(viewportHeight, Number(rect.bottom) || 0);

        if (right <= left || bottom <= top) {
          throw new Error('La carte n’est pas visible à l’écran');
        }

        const sx = Math.round(left * scaleX);
        const sy = Math.round(top * scaleY);
        const sw = Math.max(1, Math.round((right - left) * scaleX));
        const sh = Math.max(1, Math.round((bottom - top) * scaleY));

        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;

        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas indisponible');

        context.drawImage(
          screenshot,
          sx, sy, sw, sh,
          0, 0, sw, sh
        );

        const blob = await canvasBlob(canvas);

        const firefoxClipboard =
          typeof browser !== 'undefined' &&
          browser?.clipboard?.setImageData;

        if (firefoxClipboard) {
          await browser.clipboard.setImageData(await blob.arrayBuffer(), 'png');
          reply(true);
          return;
        }

        if (
          typeof ClipboardItem === 'function' &&
          typeof navigator.clipboard?.write === 'function'
        ) {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);
          reply(true);
          return;
        }

        throw new Error('API de copie d’image indisponible');
      } catch (error) {
        console.error('[WM Average] capture/copie image impossible', error);
        reply(false, String(error?.message || error));
      }
    });

    if (window.__wmAverageBootstrapInjected) return;
    window.__wmAverageBootstrapInjected = true;

    // Posé dès document_start : le CSS peut masquer le design WikiMasters
    // avant le premier paint, sauf si l'utilisateur a désactivé les cartes premium.
    let premiumCardsEnabled = true;
    try {
      const saved = JSON.parse(localStorage.getItem('wm_feature_settings_v1') || 'null');
      premiumCardsEnabled = saved?.premiumCards !== false;
    } catch (_) {}

    if (premiumCardsEnabled) {
      document.documentElement?.classList.add('wm-premium-cards-enabled');
    }

    const extensionRuntime = getExtensionRuntime();
    if (!extensionRuntime?.getURL) return;

    const paths = [
      'bridge/core.js',
      'bridge/collection.js',
      'bridge/packs.js',
      'bridge/intercept.js',
      'bridge/marketplace.js',
      'bridge/prices.js',
      'page-bridge.js',
      'features/core.js',
      'features/settings.js',
      'features/image-resolver.js',
      'features/price-ui.js',
      'features/price-loader.js',
      'features/card-extras.js',
      'features/pull-stats.js',
      'features/compact-mode.js',
      'features/trades.js',
      'features/modal-ui.js',
      'features/packs.js',
      'features/ranking.js',
      'features/collection-bulk.js',
      'features/gif-finder.js',
      'features/collection-discard.js',
      'features/extra-tools.js',
      'features/app.js',
      'content.js'
    ];

    const parent = document.head || document.documentElement;

    const injectScript = (path) => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = extensionRuntime.getURL(path);
      script.async = false;
      script.dataset.wmAverageInjected = '1';

      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => {
        reject(new Error(`Impossible de charger ${path}`));
      }, { once: true });

      parent.appendChild(script);
    });

    (async () => {
      try {
        for (const path of paths) {
          await injectScript(path);
        }
      } catch (error) {
        // Évite de laisser les cartes masquées si l'initialisation de l'extension échoue.
        document.documentElement?.classList.remove('wm-premium-cards-enabled');
        console.error('[WM Average] chargement séquentiel interrompu', error);
      }
    })();
  })();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getExtensionRuntime };
}