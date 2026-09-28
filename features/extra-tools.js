(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.extraTools = {
    create(runtime) {
      const isEnabled = runtime.settings.isEnabled;

      let unreadCount = null;
      let notificationObserver = null;
      let observedBell = null;
      let audioContext = null;
      const assetCache = new Map();

      const TRANSPARENT_PIXEL =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

      function readNotificationCount() {
        const bell = document.querySelector('button[aria-label="Notifications"]');
        if (!bell) return null;
        const badge = bell.querySelector(':scope > span');
        if (!badge) return 0;
        const match = String(badge.textContent || '').match(/\d+/);
        return match ? Number(match[0]) : 1;
      }

      function playNotificationChime() {
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtx) return;
          audioContext ||= new AudioCtx();
          const context = audioContext;

          const play = () => {
            const now = context.currentTime;
            for (const note of [
              { frequency: 660, start: now, duration: 0.075 },
              { frequency: 880, start: now + 0.09, duration: 0.10 }
            ]) {
              const oscillator = context.createOscillator();
              const gain = context.createGain();
              oscillator.type = 'sine';
              oscillator.frequency.setValueAtTime(note.frequency, note.start);
              gain.gain.setValueAtTime(0.0001, note.start);
              gain.gain.exponentialRampToValueAtTime(0.055, note.start + 0.012);
              gain.gain.exponentialRampToValueAtTime(0.0001, note.start + note.duration);
              oscillator.connect(gain);
              gain.connect(context.destination);
              oscillator.start(note.start);
              oscillator.stop(note.start + note.duration + 0.02);
            }
          };

          if (context.state === 'suspended') {
            context.resume().then(play).catch(() => {});
          } else {
            play();
          }
        } catch (error) {
          console.debug('[WM Average] son de notification indisponible', error);
        }
      }

      function syncNotificationSound() {
        if (!isEnabled('notificationSound')) {
          unreadCount = null;
          notificationObserver?.disconnect();
          notificationObserver = null;
          observedBell = null;
          return;
        }

        const bell = document.querySelector('button[aria-label="Notifications"]');
        if (bell !== observedBell) {
          notificationObserver?.disconnect();
          notificationObserver = null;
          observedBell = bell;

          if (bell) {
            notificationObserver = new MutationObserver(() => syncNotificationSound());
            notificationObserver.observe(bell, {
              childList: true,
              subtree: true,
              characterData: true
            });
          }
        }

        const count = readNotificationCount();
        if (count == null) return;

        const previous = unreadCount;
        unreadCount = count;

        if (previous !== null && count > previous) {
          playNotificationChime();
        }
      }

      function syncHiddenStats() {
        document.documentElement.classList.toggle(
          'wm-hide-card-stats',
          isEnabled('hideCardStats')
        );
      }

      function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener('load', () => resolve(String(reader.result || '')), { once: true });
          reader.addEventListener('error', () => reject(reader.error || new Error('Lecture image impossible')), { once: true });
          reader.readAsDataURL(blob);
        });
      }

      async function assetAsDataUrl(rawUrl) {
        const url = String(rawUrl || '').trim();
        if (!url) return TRANSPARENT_PIXEL;
        if (url.startsWith('data:')) return url;

        let absolute;
        try {
          absolute = new URL(url, location.href).href;
        } catch (_) {
          return TRANSPARENT_PIXEL;
        }

        if (assetCache.has(absolute)) return assetCache.get(absolute);

        const promise = (async () => {
          try {
            const target = new URL(absolute);
            const sameOrigin = target.origin === location.origin;
            const response = await fetch(absolute, {
              cache: 'force-cache',
              credentials: sameOrigin ? 'include' : 'omit',
              mode: sameOrigin ? 'same-origin' : 'cors'
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return await blobToDataUrl(await response.blob());
          } catch (_) {
            return TRANSPARENT_PIXEL;
          }
        })();

        assetCache.set(absolute, promise);
        return promise;
      }

      async function inlineCssUrls(value) {
        const text = String(value || '');
        const matches = [...text.matchAll(/url\((['"]?)(.*?)\1\)/g)];
        if (!matches.length) return text;

        let output = text;
        for (const match of matches) {
          const dataUrl = await assetAsDataUrl(match[2]);
          output = output.replace(match[0], `url("${dataUrl.replace(/"/g, '%22')}")`);
        }
        return output;
      }

      async function applyRenderedStyle(source, target, pseudo = null) {
        const computed = getComputedStyle(source, pseudo);

        for (let index = 0; index < computed.length; index += 1) {
          const property = computed[index];
          let value = computed.getPropertyValue(property);

          if (
            property === 'background-image' ||
            property === 'mask-image' ||
            property === '-webkit-mask-image'
          ) {
            value = await inlineCssUrls(value);
          }

          try {
            target.style.setProperty(property, value, computed.getPropertyPriority(property));
          } catch (_) {}
        }

        return computed;
      }

      function pseudoHasPaint(style) {
        const borderWidth =
          (parseFloat(style.borderTopWidth) || 0) +
          (parseFloat(style.borderRightWidth) || 0) +
          (parseFloat(style.borderBottomWidth) || 0) +
          (parseFloat(style.borderLeftWidth) || 0);

        return (
          (style.content && style.content !== 'none' && style.content !== 'normal') ||
          (style.backgroundImage && style.backgroundImage !== 'none') ||
          (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') ||
          (style.boxShadow && style.boxShadow !== 'none') ||
          borderWidth > 0
        );
      }

      async function buildPseudo(source, pseudo) {
        if (!(source instanceof HTMLElement)) return null;
        if (['IMG', 'INPUT', 'BR', 'HR', 'META', 'LINK'].includes(source.tagName)) return null;

        const style = getComputedStyle(source, pseudo);
        if (!pseudoHasPaint(style)) return null;

        const node = document.createElement('span');
        await applyRenderedStyle(source, node, pseudo);
        node.setAttribute('aria-hidden', 'true');

        const content = style.content;
        if (
          content &&
          content !== 'none' &&
          content !== 'normal' &&
          content !== '""' &&
          content !== "''"
        ) {
          node.textContent = content.replace(/^['"]|['"]$/g, '');
        }

        return node;
      }

      function isSnapshotControl(element) {
        return Boolean(
          element?.matches?.(
            '.wm-copy-card-button, .wm-wikipedia-card-button, .wm-missing-image-credit, ' +
            '.wm-average-badge, button, a'
          )
        );
      }

      async function cloneRenderedNode(source) {
        if (source.nodeType === Node.TEXT_NODE) {
          return document.createTextNode(source.textContent || '');
        }

        if (!(source instanceof Element) || isSnapshotControl(source)) {
          return null;
        }

        const clone = source.cloneNode(false);

        if (clone instanceof HTMLElement || clone instanceof SVGElement) {
          await applyRenderedStyle(source, clone);
        }

        if (source instanceof HTMLImageElement && clone instanceof HTMLImageElement) {
          clone.removeAttribute('srcset');
          clone.removeAttribute('sizes');
          clone.src = await assetAsDataUrl(source.currentSrc || source.src);
          clone.crossOrigin = 'anonymous';
        }

        const before = await buildPseudo(source, '::before');
        if (before) clone.append(before);

        for (const child of source.childNodes) {
          const childClone = await cloneRenderedNode(child);
          if (childClone) clone.append(childClone);
        }

        const after = await buildPseudo(source, '::after');
        if (after) clone.append(after);

        return clone;
      }

      async function snapshotCard(card) {
        const rect = card.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        const scale = 2;

        const clone = await cloneRenderedNode(card);
        if (!(clone instanceof Element)) throw new Error('Carte impossible à copier');

        clone.style.setProperty('transform', 'none', 'important');
        clone.style.setProperty('margin', '0', 'important');
        clone.style.setProperty('width', width + 'px', 'important');
        clone.style.setProperty('height', height + 'px', 'important');
        clone.style.setProperty('max-width', 'none', 'important');
        clone.style.setProperty('max-height', 'none', 'important');
        clone.style.setProperty('will-change', 'auto', 'important');

        const wrapper = document.createElement('div');
        wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
        wrapper.style.width = width + 'px';
        wrapper.style.height = height + 'px';
        wrapper.style.margin = '0';
        wrapper.style.padding = '0';
        wrapper.append(clone);

        const serialized = new XMLSerializer().serializeToString(wrapper);
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
          '<foreignObject x="0" y="0" width="100%" height="100%">' +
          serialized +
          '</foreignObject></svg>';

        const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));

        try {
          const image = await new Promise((resolve, reject) => {
            const img = new Image();
            img.addEventListener('load', () => resolve(img), { once: true });
            img.addEventListener('error', () => reject(new Error('Rendu de la carte impossible')), { once: true });
            img.src = svgUrl;
          });

          const canvas = document.createElement('canvas');
          canvas.width = width * scale;
          canvas.height = height * scale;

          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas indisponible');

          context.scale(scale, scale);
          context.drawImage(image, 0, 0, width, height);

          return await new Promise((resolve, reject) => {
            canvas.toBlob(
              (blob) => blob ? resolve(blob) : reject(new Error('PNG impossible')),
              'image/png'
            );
          });
        } finally {
          URL.revokeObjectURL(svgUrl);
        }
      }

      function setCopyState(button, state) {
        button.dataset.wmCopyState = state;
        button.textContent =
          state === 'done' ? '✓' :
          state === 'failed' ? '×' :
          state === 'busy' ? '…' : '⧉';

        const label =
          state === 'done' ? 'Carte copiée' :
          state === 'failed' ? 'Échec de la copie' :
          state === 'busy' ? 'Copie en cours' :
          'Copier la carte comme image';

        button.title = label;
        button.setAttribute('aria-label', label);
      }

      function installCopyButton(card) {
        if (card.querySelector(':scope > .wm-copy-card-button')) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wm-copy-card-button';
        setCopyState(button, 'idle');

        button.addEventListener('pointerdown', (event) => event.stopPropagation());
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();

          if (!event.isTrusted || button.dataset.wmCopyState === 'busy') return;

          if (
            typeof ClipboardItem !== 'function' ||
            typeof navigator.clipboard?.write !== 'function'
          ) {
            setCopyState(button, 'failed');
            setTimeout(() => setCopyState(button, 'idle'), 1800);
            return;
          }

          setCopyState(button, 'busy');
          const pngPromise = snapshotCard(card);

          navigator.clipboard.write([
            new ClipboardItem({ 'image/png': pngPromise })
          ]).then(
            () => {
              setCopyState(button, 'done');
              setTimeout(() => setCopyState(button, 'idle'), 1800);
            },
            (error) => {
              console.debug('[WM Average] copie image indisponible', error);
              setCopyState(button, 'failed');
              setTimeout(() => setCopyState(button, 'idle'), 1800);
            }
          );
        });

        card.append(button);
      }

      function syncCopyButtons() {
        if (!isEnabled('copyCardImage')) {
          document.querySelectorAll('.wm-copy-card-button').forEach((button) => button.remove());
          return;
        }

        for (const modal of document.querySelectorAll('div[class*="fixed"][class*="inset-0"]')) {
          for (const card of modal.querySelectorAll('div[class*="glow-"]')) {
            if (!card.querySelector('h3')) continue;
            installCopyButton(card);
          }
        }
      }

      function render() {
        syncHiddenStats();
        syncNotificationSound();
        syncCopyButtons();
      }

      return { render };
    }
  };
})();