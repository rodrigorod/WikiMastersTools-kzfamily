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

      function roundedRectPath(context, x, y, width, height, radius) {
        const r = Math.max(0, Math.min(radius, width / 2, height / 2));
        context.beginPath();
        context.moveTo(x + r, y);
        context.arcTo(x + width, y, x + width, y + height, r);
        context.arcTo(x + width, y + height, x, y + height, r);
        context.arcTo(x, y + height, x, y, r);
        context.arcTo(x, y, x + width, y, r);
        context.closePath();
      }

      function relativeRect(element, cardRect) {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left - cardRect.left,
          y: rect.top - cardRect.top,
          width: rect.width,
          height: rect.height
        };
      }

      function parseObjectPositionY(image) {
        const raw = getComputedStyle(image).objectPosition || '50% 50%';
        const parts = raw.trim().split(/\s+/);
        const value = parts[1] || parts[0] || '50%';

        if (value.endsWith('%')) {
          const percent = Number.parseFloat(value);
          if (Number.isFinite(percent)) return Math.max(0, Math.min(1, percent / 100));
        }

        if (value === 'top') return 0;
        if (value === 'bottom') return 1;
        return 0.5;
      }

      function drawImageCover(context, image, x, y, width, height, focusY = 0.5) {
        if (!image?.naturalWidth || !image?.naturalHeight || width <= 0 || height <= 0) return;

        const sourceRatio = image.naturalWidth / image.naturalHeight;
        const targetRatio = width / height;

        let sx = 0;
        let sy = 0;
        let sw = image.naturalWidth;
        let sh = image.naturalHeight;

        if (sourceRatio > targetRatio) {
          sw = image.naturalHeight * targetRatio;
          sx = (image.naturalWidth - sw) / 2;
        } else {
          sh = image.naturalWidth / targetRatio;
          sy = (image.naturalHeight - sh) * focusY;
          sy = Math.max(0, Math.min(image.naturalHeight - sh, sy));
        }

        context.drawImage(image, sx, sy, sw, sh, x, y, width, height);
      }

      async function loadSnapshotImage(rawUrl) {
        if (!rawUrl) return null;

        const dataUrl = await assetAsDataUrl(rawUrl);
        if (!dataUrl || dataUrl === TRANSPARENT_PIXEL) return null;

        return await new Promise((resolve, reject) => {
          const image = new Image();
          image.addEventListener('load', () => resolve(image), { once: true });
          image.addEventListener('error', () => reject(new Error('Image de carte illisible')), { once: true });
          image.src = dataUrl;
        });
      }

      function canvasBlob(canvas) {
        return new Promise((resolve, reject) => {
          canvas.toBlob(
            (blob) => blob ? resolve(blob) : reject(new Error('PNG impossible')),
            'image/png'
          );
        });
      }

      function fitCanvasFont(context, text, maxWidth, maxSize, minSize, family, weight = 800) {
        let size = maxSize;

        while (size > minSize) {
          context.font = `${weight} ${size}px ${family}`;
          if (context.measureText(text).width <= maxWidth) break;
          size -= 0.5;
        }

        return size;
      }

      function wrapCanvasText(context, text, maxWidth, maxLines = Infinity) {
        const paragraphs = String(text || '')
          .replace(/\r\n?/g, '\n')
          .split('\n');

        const lines = [];
        let truncated = false;

        for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
          const words = paragraphs[paragraphIndex]
            .trim()
            .split(/\s+/)
            .filter(Boolean);

          if (!words.length) {
            if (lines.length && lines.length < maxLines) lines.push('');
            continue;
          }

          let line = '';

          for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
            const word = words[wordIndex];
            const next = line ? `${line} ${word}` : word;

            if (!line || context.measureText(next).width <= maxWidth) {
              line = next;
              continue;
            }

            lines.push(line);
            line = word;

            if (lines.length >= maxLines) {
              truncated = true;
              break;
            }
          }

          if (truncated) break;

          if (line) {
            if (lines.length < maxLines) {
              lines.push(line);
            } else {
              truncated = true;
              break;
            }
          }

          if (
            paragraphIndex < paragraphs.length - 1 &&
            lines.length < maxLines
          ) {
            lines.push('');
          }
        }

        if (truncated && lines.length) {
          let last = lines[lines.length - 1];

          while (last && context.measureText(last + '…').width > maxWidth) {
            last = last.slice(0, -1);
          }

          lines[lines.length - 1] =
            last.replace(/[\s,.;:!?-]+$/g, '') + '…';
        }

        return lines;
      }

      function fitCanvasParagraphs(
        context,
        text,
        maxWidth,
        maxHeight,
        family,
        maxFontSize,
        minFontSize,
        weight = 500
      ) {
        let fontSize = maxFontSize;
        let lines = [];
        let lineHeight = fontSize * 1.2;

        while (fontSize >= minFontSize) {
          lineHeight = fontSize * 1.2;
          context.font = `${weight} ${fontSize}px ${family}`;
          lines = wrapCanvasText(context, text, maxWidth, Infinity);

          if (lines.length * lineHeight <= maxHeight) {
            return { fontSize, lineHeight, lines };
          }

          fontSize -= 0.25;
        }

        fontSize = minFontSize;
        lineHeight = fontSize * 1.15;
        context.font = `${weight} ${fontSize}px ${family}`;

        const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
        lines = wrapCanvasText(context, text, maxWidth, maxLines);

        return { fontSize, lineHeight, lines };
      }

      function rarityOf(card) {
        for (const rarity of ['L', 'UR', 'SR', 'R', 'PC', 'C']) {
          if (card.classList.contains('glow-' + rarity.toLowerCase())) return rarity;
        }

        return (
          card.querySelector('div[class*="top-2"][class*="left-2"]')?.textContent
            ?.replace('✦', '')
            ?.trim() ||
          ''
        );
      }

      function rarityAccent(rarity) {
        return ({
          L: '#ffd45a',
          UR: '#ff9f43',
          SR: '#c98cff',
          R: '#64bfff',
          PC: '#6ee7ad',
          C: '#b7c1ce'
        })[rarity] || '#b7c1ce';
      }

      function cardStat(card, selector) {
        const icon = card.querySelector(selector);
        if (!icon) return '';
        const holder = icon.closest('div');
        return holder?.textContent?.trim() || '';
      }

      async function snapshotCard(card) {
        const cardRect = card.getBoundingClientRect();
        const width = Math.max(1, Math.round(cardRect.width || 288));
        const height = Math.max(1, Math.round(cardRect.height || 420));
        const scale = 2;
        const isPremium = card.classList.contains('wm-premium-card');

        const outerPad = 18;
        const canvasWidth = width + outerPad * 2;
        const canvasHeight = height + outerPad * 2;

        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth * scale;
        canvas.height = canvasHeight * scale;

        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas indisponible');

        context.scale(scale, scale);

        const rarity = rarityOf(card);
        const accent = rarityAccent(rarity);
        const radius = 16;

        // Fond extérieur du PNG : permet de voir les coins arrondis et le glow.
        context.fillStyle = '#050505';
        context.fillRect(0, 0, canvasWidth, canvasHeight);

        context.save();
        context.translate(outerPad, outerPad);

        // Ombre/glow de rareté derrière la carte, sans ajouter de bordure.
        context.save();
        roundedRectPath(context, 0, 0, width, height, radius);
        context.fillStyle = '#0b0b0b';
        context.shadowColor = accent + '99';
        context.shadowBlur = 18;
        context.shadowOffsetX = 0;
        context.shadowOffsetY = 0;
        context.fill();
        context.restore();

        const titleElement = card.querySelector('h3');
        const descriptionElement = card.querySelector('p');
        const averageElement = card.querySelector('.wm-average-badge');
        const artLayer = card.querySelector('div[class*="top-0"][class*="h-[45%]"]');
        const artImage = artLayer?.querySelector('img') || null;
        const fallbackTitle = card.querySelector('.wm-missing-title-art-text');
        const nativeBackgroundImage = !isPremium
          ? card.querySelector(':scope > img')
          : null;

        const artUrl =
          artImage?.currentSrc ||
          artImage?.src ||
          String(card.style.getPropertyValue('--wm-art-url') || '')
            .replace(/^\s*url\(["']?/, '')
            .replace(/["']?\)\s*$/, '');

        const nativeBackgroundUrl =
          nativeBackgroundImage?.currentSrc ||
          nativeBackgroundImage?.src ||
          '';

        let image = null;
        let nativeBackground = null;

        try {
          image = await loadSnapshotImage(artUrl);
        } catch (error) {
          console.debug('[WM Average] image ignorée pour le partage', error);
        }

        if (!isPremium && nativeBackgroundUrl) {
          try {
            nativeBackground = await loadSnapshotImage(nativeBackgroundUrl);
          } catch (error) {
            console.debug('[WM Average] fond WikiMasters ignoré pour le partage', error);
          }
        }

        context.save();
        roundedRectPath(context, 0, 0, width, height, radius);
        context.clip();

        if (isPremium) {
          // Design full-art de l'extension.
          if (image) {
            context.save();
            context.filter = 'blur(10px) brightness(0.46) saturate(0.92)';
            context.globalAlpha = 0.92;
            drawImageCover(context, image, -10, -10, width + 20, height + 20, 0.42);
            context.restore();
          } else {
            const background = context.createLinearGradient(0, 0, width, height);
            background.addColorStop(0, '#242a34');
            background.addColorStop(0.5, '#121722');
            background.addColorStop(1, '#080a0e');
            context.fillStyle = background;
            context.fillRect(0, 0, width, height);
          }

          const darken = context.createLinearGradient(0, 0, 0, height);
          darken.addColorStop(0, 'rgba(0,0,0,0.05)');
          darken.addColorStop(0.42, 'rgba(0,0,0,0.12)');
          darken.addColorStop(0.60, 'rgba(0,0,0,0.68)');
          darken.addColorStop(1, 'rgba(0,0,0,0.94)');
          context.fillStyle = darken;
          context.fillRect(0, 0, width, height);

          if (image && artLayer) {
            const artRect = relativeRect(artLayer, cardRect);

            if (artRect) {
              const extendedHeight = Math.min(
                height - artRect.y,
                Math.max(artRect.height, height * 0.53)
              );

              context.save();
              context.rect(artRect.x, artRect.y, artRect.width, extendedHeight);
              context.clip();

              context.filter = 'none';
              context.globalAlpha = 1;
              drawImageCover(
                context,
                image,
                artRect.x,
                artRect.y,
                artRect.width,
                extendedHeight,
                parseObjectPositionY(artImage)
              );

              const fade = context.createLinearGradient(
                0,
                artRect.y + artRect.height * 0.55,
                0,
                artRect.y + extendedHeight
              );
              fade.addColorStop(0, 'rgba(0,0,0,0)');
              fade.addColorStop(1, 'rgba(8,10,14,0.96)');
              context.fillStyle = fade;
              context.fillRect(
                artRect.x,
                artRect.y,
                artRect.width,
                extendedHeight
              );
              context.restore();
            }
          } else if (fallbackTitle) {
            context.save();
            const glow = context.createRadialGradient(
              width * 0.35, height * 0.20, 0,
              width * 0.35, height * 0.20, width * 0.72
            );
            glow.addColorStop(0, accent + '55');
            glow.addColorStop(1, 'rgba(0,0,0,0)');
            context.fillStyle = glow;
            context.fillRect(0, 0, width, height * 0.60);

            const fallbackText =
              fallbackTitle.textContent?.trim() ||
              titleElement?.textContent?.trim() ||
              '';
            const family = getComputedStyle(fallbackTitle).fontFamily || 'sans-serif';
            const size = fitCanvasFont(
              context,
              fallbackText,
              width - 42,
              38,
              12,
              family,
              900
            );

            context.font = `900 ${size}px ${family}`;
            context.fillStyle = accent;
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.shadowColor = 'rgba(0,0,0,0.82)';
            context.shadowBlur = 10;
            context.fillText(fallbackText, width / 2, height * 0.29);
            context.restore();
          }
        } else {
          // Design WikiMasters natif : on réutilise son vrai fond de rareté.
          if (nativeBackground) {
            context.save();

            // Le fond natif possède scale-[1.8]. On reproduit ce zoom en
            // recadrant davantage l'image source autour de son centre.
            const zoom = 1.8;
            const sourceWidth = nativeBackground.naturalWidth / zoom;
            const sourceHeight = nativeBackground.naturalHeight / zoom;
            const sx = (nativeBackground.naturalWidth - sourceWidth) / 2;
            const sy = (nativeBackground.naturalHeight - sourceHeight) / 2;

            context.drawImage(
              nativeBackground,
              sx,
              sy,
              sourceWidth,
              sourceHeight,
              0,
              0,
              width,
              height
            );
            context.restore();
          } else {
            const fallback = context.createLinearGradient(0, 0, 0, height);
            fallback.addColorStop(0, '#f1e5cf');
            fallback.addColorStop(1, '#d7c5aa');
            context.fillStyle = fallback;
            context.fillRect(0, 0, width, height);
          }

          // Léger voile supérieur présent sur la carte native.
          const topShade = context.createLinearGradient(0, 0, 0, height * 0.42);
          topShade.addColorStop(0, 'rgba(0,0,0,0.10)');
          topShade.addColorStop(1, 'rgba(0,0,0,0)');
          context.fillStyle = topShade;
          context.fillRect(0, 0, width, height * 0.42);

          // Le fichier de rareté natif contient parfois des bandes sombres
          // latérales. Pour le PNG partagé, on redessine la zone basse en
          // pleine largeur afin que le panneau titre/description colle bien
          // aux bords internes de la carte, comme sur l'UI réelle.
          const nativeTextPanel =
            titleElement?.closest('div[class*="top-[45%]"]') ||
            descriptionElement?.parentElement ||
            null;
          const nativeTextPanelRect = relativeRect(nativeTextPanel, cardRect);
          const nativePanelTop = nativeTextPanelRect?.y ?? Math.round(height * 0.45);

          if (nativeBackground && nativePanelTop < height) {
            context.save();
            context.beginPath();
            context.rect(0, nativePanelTop, width, height - nativePanelTop);
            context.clip();

            // Recadre légèrement les côtés du fond de rareté pour supprimer
            // ses marges sombres tout en conservant sa texture/couleur.
            const panelCropX = nativeBackground.naturalWidth * 0.10;
            const panelCropWidth = nativeBackground.naturalWidth * 0.80;
            const panelCropY = nativeBackground.naturalHeight * 0.40;
            const panelCropHeight = nativeBackground.naturalHeight * 0.60;

            context.drawImage(
              nativeBackground,
              panelCropX,
              panelCropY,
              panelCropWidth,
              panelCropHeight,
              0,
              nativePanelTop,
              width,
              height - nativePanelTop
            );
            context.restore();
          }

          // Photo native pleine largeur, comme sur la vraie carte WikiMasters.
          if (image && artLayer) {
            const artRect = relativeRect(artLayer, cardRect);

            if (artRect) {
              context.save();
              context.rect(artRect.x, artRect.y, artRect.width, artRect.height);
              context.clip();

              drawImageCover(
                context,
                image,
                artRect.x,
                artRect.y,
                artRect.width,
                artRect.height,
                parseObjectPositionY(artImage)
              );

              const nativeFadeHeight = Math.min(48, artRect.height * 0.32);
              const nativeFade = context.createLinearGradient(
                0,
                artRect.y + artRect.height - nativeFadeHeight,
                0,
                artRect.y + artRect.height
              );
              nativeFade.addColorStop(0, 'rgba(0,0,0,0)');
              nativeFade.addColorStop(1, 'rgba(0,0,0,0.50)');
              context.fillStyle = nativeFade;
              context.fillRect(
                artRect.x,
                artRect.y + artRect.height - nativeFadeHeight,
                artRect.width,
                nativeFadeHeight
              );
              context.restore();
            }
          }
        }

        // Badge rareté.
        context.save();
        context.font = '900 10px sans-serif';
        const rarityWidth = Math.max(30, context.measureText(rarity).width + 14);
        roundedRectPath(context, 10, 10, rarityWidth, 22, 8);
        context.fillStyle = accent;
        context.fill();
        context.fillStyle = '#111318';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(rarity, 10 + rarityWidth / 2, 21);
        context.restore();

        // Titre : couleur rareté en full-art, vraie couleur DOM en natif.
        const title = titleElement?.textContent?.trim() || '';
        const titleRect = relativeRect(titleElement, cardRect);

        if (title) {
          const titleStyle = getComputedStyle(titleElement);
          const family = titleStyle.fontFamily || 'sans-serif';
          const x = titleRect ? Math.max(12, titleRect.x) : 14;
          const y = titleRect ? titleRect.y : height * 0.67;
          const maxWidth = titleRect?.width || width - x - 14;
          const nativeFontSize = Number.parseFloat(titleStyle.fontSize) || 16;
          const size = fitCanvasFont(
            context,
            title,
            maxWidth,
            isPremium ? 17 : nativeFontSize,
            9,
            family,
            900
          );

          context.save();
          context.font = `900 ${size}px ${family}`;
          context.fillStyle = isPremium ? accent : titleStyle.color;
          context.textAlign = 'left';
          context.textBaseline = 'top';

          if (isPremium) {
            context.shadowColor = 'rgba(0,0,0,0.9)';
            context.shadowBlur = 3;
          }

          context.fillText(title, x, y);
          context.restore();
        }

        // Prix moyen.
        if (averageElement && averageElement.offsetParent !== null) {
          const averageText = averageElement.textContent?.trim() || '';
          const rect = relativeRect(averageElement, cardRect);

          if (averageText && rect) {
            const averageStyle = getComputedStyle(averageElement);

            context.save();
            context.font = '800 9px sans-serif';
            const pillWidth = Math.max(
              rect.width,
              context.measureText(averageText).width + 14
            );
            const pillHeight = Math.max(18, rect.height);

            roundedRectPath(
              context,
              rect.x,
              rect.y,
              pillWidth,
              pillHeight,
              pillHeight / 2
            );

            context.fillStyle =
              averageStyle.backgroundColor &&
              averageStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
                ? averageStyle.backgroundColor
                : 'rgba(6, 95, 70, 0.92)';
            context.fill();

            context.strokeStyle = 'rgba(110, 231, 173, 0.72)';
            context.lineWidth = 1;
            context.stroke();

            context.fillStyle =
              averageStyle.color || '#d1fae5';
            context.textBaseline = 'middle';
            context.textAlign = 'center';
            context.fillText(
              averageText,
              rect.x + pillWidth / 2,
              rect.y + pillHeight / 2
            );
            context.restore();
          }
        }

        // Description complète : on utilise tout le textContent du <p>,
        // même si WikiMasters le line-clamp visuellement. La taille est ajustée
        // pour remplir l'espace disponible sans perdre les paragraphes.
        const description = descriptionElement?.textContent?.trim() || '';
        const descriptionRect = relativeRect(descriptionElement, cardRect);

        if (description && descriptionElement) {
          const style = getComputedStyle(descriptionElement);

          const parsedFontSize = Number.parseFloat(style.fontSize);
          const baseFontSize = Number.isFinite(parsedFontSize)
            ? Math.max(8, Math.min(10.5, parsedFontSize))
            : 10;

          const family = style.fontFamily || 'sans-serif';

          const titleBottom = titleRect
            ? titleRect.y + titleRect.height
            : height * 0.50;

          const averageRect =
            averageElement && averageElement.offsetParent !== null
              ? relativeRect(averageElement, cardRect)
              : null;

          const textPanel =
            titleElement?.closest('div[class*="top-[45%]"]') ||
            descriptionElement.parentElement;
          const textPanelRect = relativeRect(textPanel, cardRect);

          const contentStart = Math.max(
            titleBottom + 5,
            averageRect ? averageRect.y + averageRect.height + 5 : 0,
            textPanelRect ? textPanelRect.y + 28 : 0
          );

          const attackIconForLayout = card.querySelector('svg.lucide-swords');
          const defenseIconForLayout = card.querySelector('svg.lucide-shield');
          const statsRow =
            attackIconForLayout?.closest('div[class*="border-t"]') ||
            defenseIconForLayout?.closest('div[class*="border-t"]') ||
            attackIconForLayout?.closest('div[class*="justify-between"]') ||
            defenseIconForLayout?.closest('div[class*="justify-between"]');

          const statsRect = relativeRect(statsRow, cardRect);

          const panelBottom = textPanelRect
            ? textPanelRect.y + textPanelRect.height - 8
            : height - 10;

          const contentBottom = Math.min(
            panelBottom,
            statsRect?.y ? statsRect.y - 5 : panelBottom
          );

          const availableHeight = Math.max(
            30,
            contentBottom - contentStart
          );

          const descriptionX =
            descriptionRect?.x ||
            (textPanelRect ? textPanelRect.x + 12 : 12);

          const descriptionWidth = Math.max(
            60,
            descriptionRect?.width ||
            (textPanelRect
              ? textPanelRect.width - 24
              : width - descriptionX - 12)
          );

          context.save();

          const fitted = fitCanvasParagraphs(
            context,
            description,
            descriptionWidth,
            availableHeight,
            family,
            baseFontSize,
            5.5,
            500
          );

          context.font =
            `500 ${fitted.fontSize}px ${family}`;
          context.fillStyle = isPremium
            ? 'rgba(255,255,255,0.88)'
            : style.color;
          context.textAlign = 'left';
          context.textBaseline = 'top';

          fitted.lines.forEach((line, index) => {
            if (!line) return;

            context.fillText(
              line,
              descriptionX,
              contentStart + index * fitted.lineHeight
            );
          });

          context.restore();
        }

        // Stats si elles sont visibles.
        const statsHidden =
          document.documentElement.classList.contains('wm-hide-card-stats');

        if (!statsHidden) {
          const attackIcon = card.querySelector('svg.lucide-swords');
          const defenseIcon = card.querySelector('svg.lucide-shield');
          const attack = cardStat(card, 'svg.lucide-swords');
          const defense = cardStat(card, 'svg.lucide-shield');

          if (attack || defense) {
            const statsY = height - 24;
            context.save();
            context.font = '800 10px sans-serif';
            context.textBaseline = 'middle';

            if (attack) {
              context.fillStyle = '#f87171';
              context.textAlign = 'left';
              context.fillText('ATK', 14, statsY);
              context.fillStyle = isPremium
                ? '#ffffff'
                : getComputedStyle(
                    attackIcon?.closest('div')?.querySelector('span') ||
                    attackIcon?.closest('div') ||
                    card
                  ).color;
              context.fillText(attack, 38, statsY);
            }

            if (defense) {
              const valueWidth = context.measureText(defense).width;
              context.fillStyle = '#93c5fd';
              context.textAlign = 'right';
              context.fillText('DEF', width - valueWidth - 20, statsY);
              context.fillStyle = isPremium
                ? '#ffffff'
                : getComputedStyle(
                    defenseIcon?.closest('div')?.querySelector('span') ||
                    defenseIcon?.closest('div') ||
                    card
                  ).color;
              context.fillText(defense, width - 14, statsY);
            }

            context.restore();
          }
        }

        context.restore();
        context.restore();

        return await canvasBlob(canvas);
      }

      function setCopyState(button, state) {
        button.dataset.wmCopyState = state;

        const text =
          state === 'done' ? 'Copiée' :
          state === 'failed' ? 'Échec' :
          state === 'busy' ? 'Partage…' :
          'Partager';

        const iconPath =
          state === 'done'
            ? 'M5 12l4 4L19 7'
            : state === 'failed'
              ? 'M6 6l12 12M18 6L6 18'
              : 'M9 8h10v12H9zM5 16H4V4h11v1';

        button.replaceChildren();

        const label = document.createElement('span');
        label.className = 'wm-copy-card-label';
        label.textContent = text;

        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('aria-hidden', 'true');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', iconPath);
        icon.append(path);

        button.append(label, icon);

        const aria =
          state === 'done' ? 'Carte copiée' :
          state === 'failed' ? 'Échec de la copie' :
          state === 'busy' ? 'Copie en cours' :
          'Partager la carte comme image';

        button.title = aria;
        button.setAttribute('aria-label', aria);
      }

      function requestClipboardWrite(dataUrl) {
        const requestId =
          'wm-copy-' +
          Date.now().toString(36) +
          '-' +
          Math.random().toString(36).slice(2, 9);

        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            window.removeEventListener('message', onMessage);
            reject(new Error('La copie a expiré'));
          }, 8000);

          function onMessage(messageEvent) {
            if (messageEvent.source !== window) return;

            const message = messageEvent.data;
            if (
              !message ||
              message.source !== 'wm-average-extension' ||
              message.type !== 'copy-card-image-result' ||
              message.requestId !== requestId
            ) {
              return;
            }

            clearTimeout(timeout);
            window.removeEventListener('message', onMessage);

            if (message.ok) {
              resolve(true);
            } else {
              reject(new Error(message.error || 'Copie refusée'));
            }
          }

          window.addEventListener('message', onMessage);
          window.postMessage({
            source: 'wm-average-page',
            type: 'copy-card-image',
            requestId,
            dataUrl
          }, '*');
        });
      }

      function installCopyButton(card) {
        if (card.querySelector(':scope > .wm-copy-card-button')) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wm-copy-card-button';
        setCopyState(button, 'idle');

        button.addEventListener('pointerdown', (event) => event.stopPropagation());
        button.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();

          if (!event.isTrusted || button.dataset.wmCopyState === 'busy') return;

          setCopyState(button, 'busy');

          try {
            const blob = await snapshotCard(card);
            const dataUrl = await blobToDataUrl(blob);
            await requestClipboardWrite(dataUrl);
            setCopyState(button, 'done');
          } catch (error) {
            console.error('[WM Average] copie image impossible', error);
            setCopyState(button, 'failed');
            button.title = 'Échec : ' + String(error?.message || error);
          }

          setTimeout(() => setCopyState(button, 'idle'), 1800);
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