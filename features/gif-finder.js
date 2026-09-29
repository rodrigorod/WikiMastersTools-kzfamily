(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.gifFinder = {
    create(runtime) {
      const {
        ALL_COLLECTION_KEY, RARITIES, cardMetaById, idByTitle,
        isCollectionPage, normalizeTitle, readLocalValue, storageGet, storageSet,
        MISSING_IMAGE_CACHE_PREFIX, cacheKey, cacheMemory, isCacheEntryValid
      } = runtime.core;
      const { chooseAverage, formatAverage, getRarityFromCard } = runtime.priceUi;

      let gifButton = null;
      let activeModal = null;
      let currentGifCards = [];
      let isScanning = false;
      let scanRequestId = null;
      let pageFilterActive = false;
      let currentViewMode = 'grid'; // 'grid' | 'list'
      let selectedRarity = 'ALL';
      let searchQuery = '';

      function isGifUrl(url) {
        if (!url || typeof url !== 'string') return false;
        const clean = url.trim().toLowerCase();
        if (clean.startsWith('data:image/gif')) return true;
        return (
          /\.gif(?:$|[?#/])/i.test(clean) ||
          /\/commons\/.*\.gif(?:$|[/?#])/i.test(clean) ||
          /\.gif(?:\.png|\.webp|\.jpg)?(?:$|[?#])/i.test(clean)
        );
      }

      function getAnimatedGifUrl(url) {
        if (!url || typeof url !== 'string') return url;
        // Si c'est un thumbnail Wikimedia d'un GIF (ex: .../thumb/a/b/Foo.gif/300px-Foo.gif.png)
        // on extrait l'URL du fichier original pour avoir l'animation complète.
        const wmMatch = url.match(
          /^(https?:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/thumb(\/[0-9a-f]\/[0-9a-f]{2}\/[^/]+\.gif)(?:\/[^/]+)?$/i
        );
        if (wmMatch) {
          return `${wmMatch[1]}${wmMatch[2]}`;
        }
        return url;
      }

      function isCardGif(card) {
        if (!card) return false;
        const directUrl = card.imageUrl || card.image_url;
        if (isGifUrl(directUrl)) return true;

        if (card.title) {
          const cached = readLocalValue(
            MISSING_IMAGE_CACHE_PREFIX + encodeURIComponent(normalizeTitle(card.title))
          );
          if (cached?.found && (isGifUrl(cached.url) || isGifUrl(cached.fileName))) {
            return true;
          }
        }
        return false;
      }

      function getResolvedImageUrl(card) {
        if (!card) return null;
        const directUrl = card.imageUrl || card.image_url;
        if (directUrl) return getAnimatedGifUrl(directUrl);

        if (card.title) {
          const cached = readLocalValue(
            MISSING_IMAGE_CACHE_PREFIX + encodeURIComponent(normalizeTitle(card.title))
          );
          if (cached?.found && cached?.url) {
            return getAnimatedGifUrl(cached.url);
          }
        }
        return null;
      }

      function safeEscape(str) {
        if (typeof CSS !== 'undefined' && CSS?.escape) {
          return CSS.escape(str);
        }
        return String(str).replace(/["\\]/g, '\\$&');
      }

      function resolveRealCardId(card) {
        if (!card) return null;
        if (card.id && !String(card.id).startsWith('dom-')) return card.id;
        if (card.title) {
          const resolved = idByTitle.get(normalizeTitle(card.title));
          if (resolved) {
            card.id = resolved;
            return resolved;
          }
        }
        return card.id || null;
      }

      function getKnownCollectionCards() {
        const stored = storageGet(ALL_COLLECTION_KEY);
        const collectionEntry = stored[ALL_COLLECTION_KEY];
        const storedCards = Array.isArray(collectionEntry?.cards) ? collectionEntry.cards : [];

        const knownCards = new Map();

        for (const card of storedCards) {
          if (card?.id && card?.title) {
            knownCards.set(card.id, { ...card });
          }
        }

        for (const card of cardMetaById.values()) {
          if (!card?.id || !card?.title) continue;
          const previous = knownCards.get(card.id);
          knownCards.set(card.id, previous ? { ...previous, ...card } : { ...card });
        }

        // Enrichit avec les éléments actuellement présents dans le DOM
        for (const cardEl of document.querySelectorAll('div[class*="glow-"]')) {
          const title = normalizeTitle(cardEl.querySelector('h3')?.textContent);
          if (!title) continue;

          const img =
            cardEl.querySelector('div[class*="top-0"][class*="h-[45%]"] img') ||
            cardEl.querySelector('img');
          const src = img?.currentSrc || img?.src || img?.dataset?.wmOriginalSrc;
          const id = cardEl.dataset?.wmCardId || idByTitle.get(title);
          const rarity = typeof getRarityFromCard === 'function' ? getRarityFromCard(cardEl) : null;

          if (id && knownCards.has(id)) {
            const card = knownCards.get(id);
            if (!card.imageUrl && src) card.imageUrl = src;
            if (!card.rarity && rarity) card.rarity = rarity;
          } else if (id) {
            const meta = cardMetaById.get(id);
            knownCards.set(id, {
              id,
              title,
              imageUrl: meta?.imageUrl || src || null,
              rarity: meta?.rarity || rarity || null,
              wikipediaUrl: meta?.wikipediaUrl || null,
              count: meta?.count || 1
            });
          } else if (title) {
            // Carte découverte dans le DOM sans métadonnée préalable
            const virtualId = `dom-${encodeURIComponent(title)}`;
            if (!knownCards.has(virtualId)) {
              knownCards.set(virtualId, {
                id: virtualId,
                title,
                imageUrl: src || null,
                rarity: rarity || null,
                count: 1
              });
            }
          }
        }

        return {
          cards: [...knownCards.values()],
          isComplete: collectionEntry?.complete === true,
          fetchedAt: Number(collectionEntry?.fetchedAt) || 0
        };
      }

      function getCardPriceInfo(card) {
        const id = resolveRealCardId(card);
        if (!id || String(id).startsWith('dom-')) {
          return { status: 'no_id', average: null, rawPrice: null };
        }

        const entry = cacheMemory?.get(id) || readLocalValue(cacheKey(id));
        const isValid = isCacheEntryValid ? isCacheEntryValid(entry) : Boolean(entry && entry.ok !== false);
        const isPending = Boolean(runtime.priceLoader?.isPending?.(id));

        if (!isValid) {
          return {
            status: isPending ? 'loading' : 'missing',
            average: null,
            rawPrice: null
          };
        }

        if (entry.ok === false) {
          return { status: 'error', average: null, rawPrice: entry };
        }

        const rarity = card.rarity || cardMetaById.get(id)?.rarity || null;
        const average = chooseAverage(entry, null, rarity);
        if (Number.isFinite(average)) {
          return { status: 'ready', average, rawPrice: entry };
        }

        return { status: 'empty', average: null, rawPrice: entry };
      }

      function loadMissingPricesForGifCards(gifCards) {
        if (!runtime.priceLoader?.loadCacheForCards || !Array.isArray(gifCards)) return;

        const cardsToLoad = [];
        for (const card of gifCards) {
          const id = resolveRealCardId(card);
          if (!id || String(id).startsWith('dom-')) continue;

          const entry = cacheMemory?.get(id) || readLocalValue(cacheKey(id));
          const isValid = isCacheEntryValid ? isCacheEntryValid(entry) : Boolean(entry && entry.ok !== false);
          const isPending = Boolean(runtime.priceLoader.isPending?.(id));

          if (!isValid && !isPending) {
            cardsToLoad.push(card);
          }
        }

        if (cardsToLoad.length > 0) {
          try {
            runtime.priceLoader.loadCacheForCards(cardsToLoad);
          } catch (error) {
            runtime.core.reportError?.('chargement prix gif', error);
          }
        }
      }

      function updateGridPriceBadge(badgeEl, card) {
        if (!badgeEl) return;
        const info = getCardPriceInfo(card);
        badgeEl.className = 'wm-gif-price-badge';

        if (info.status === 'loading' || info.status === 'missing') {
          badgeEl.classList.add('is-loading');
          badgeEl.title = 'Chargement du prix moyen…';
          badgeEl.replaceChildren();
          const spinner = document.createElement('span');
          spinner.className = 'wm-average-spinner';
          spinner.setAttribute('aria-hidden', 'true');
          const label = document.createElement('span');
          label.textContent = 'Prix…';
          badgeEl.append(spinner, label);
        } else if (info.status === 'ready') {
          badgeEl.title = 'Prix moyen des ventes (cache 24 h)';
          badgeEl.textContent = `Moy. ${formatAverage(info.average)} W`;
        } else if (info.status === 'error') {
          badgeEl.classList.add('is-empty');
          badgeEl.title = 'Erreur lors du chargement du prix';
          badgeEl.textContent = 'Prix indispo.';
        } else {
          badgeEl.classList.add('is-empty');
          badgeEl.title = info.status === 'no_id'
            ? 'Identifiant de carte inconnu'
            : 'Aucun prix enregistré dans les ventes récentes';
          badgeEl.textContent = 'Moy. —';
        }
      }

      function updateListPriceBadge(badgeEl, card) {
        if (!badgeEl) return;
        const info = getCardPriceInfo(card);
        badgeEl.className = 'wm-gif-row-price';

        if (info.status === 'loading' || info.status === 'missing') {
          badgeEl.classList.add('is-loading');
          badgeEl.title = 'Chargement du prix moyen…';
          badgeEl.replaceChildren();
          const spinner = document.createElement('span');
          spinner.className = 'wm-average-spinner';
          spinner.setAttribute('aria-hidden', 'true');
          const label = document.createElement('span');
          label.textContent = 'Prix…';
          badgeEl.append(spinner, label);
        } else if (info.status === 'ready') {
          badgeEl.title = 'Prix moyen des ventes (cache 24 h)';
          badgeEl.textContent = `Moy. ${formatAverage(info.average)} W`;
        } else if (info.status === 'error') {
          badgeEl.classList.add('is-empty');
          badgeEl.title = 'Erreur lors du chargement du prix';
          badgeEl.textContent = 'Prix indispo.';
        } else {
          badgeEl.classList.add('is-empty');
          badgeEl.title = info.status === 'no_id'
            ? 'Identifiant de carte inconnu'
            : 'Aucun prix enregistré dans les ventes récentes';
          badgeEl.textContent = 'Moy. —';
        }
      }

      function updateDetailPriceBadge(badgeEl, card) {
        if (!badgeEl) return;
        const info = getCardPriceInfo(card);
        badgeEl.className = 'wm-gif-price-badge';

        if (info.status === 'loading' || info.status === 'missing') {
          badgeEl.classList.add('is-loading');
          badgeEl.title = 'Chargement du prix moyen…';
          badgeEl.replaceChildren();
          const spinner = document.createElement('span');
          spinner.className = 'wm-average-spinner';
          spinner.setAttribute('aria-hidden', 'true');
          const label = document.createElement('span');
          label.textContent = 'Chargement du prix…';
          badgeEl.append(spinner, label);
        } else if (info.status === 'ready') {
          badgeEl.title = 'Prix moyen des ventes (cache 24 h)';
          badgeEl.textContent = `Prix moyen : ${formatAverage(info.average)} W`;
        } else if (info.status === 'error') {
          badgeEl.classList.add('is-empty');
          badgeEl.title = 'Erreur lors du chargement du prix';
          badgeEl.textContent = 'Prix moyen indisponible';
        } else {
          badgeEl.classList.add('is-empty');
          badgeEl.title = 'Aucun prix enregistré dans les ventes récentes';
          badgeEl.textContent = 'Prix moyen non disponible';
        }
      }

      function onPriceUpdated(id) {
        if (!id) return;

        if (Array.isArray(currentGifCards)) {
          const targetCard = currentGifCards.find((c) => c.id === id);
          if (targetCard) {
            const info = getCardPriceInfo(targetCard);
            targetCard.average = info.average;
            targetCard.priceEntry = info.rawPrice;
          }
        }

        if (activeModal) {
          const safeId = safeEscape(id);
          const gridBadges = activeModal.querySelectorAll(`[data-gif-card-id="${safeId}"] .wm-gif-price-badge`);
          const listBadges = activeModal.querySelectorAll(`[data-gif-card-id="${safeId}"] .wm-gif-row-price`);

          if (gridBadges.length > 0 || listBadges.length > 0) {
            const card = currentGifCards?.find((c) => c.id === id) || cardMetaById.get(id) || { id };
            for (const badge of gridBadges) {
              updateGridPriceBadge(badge, card);
            }
            for (const badge of listBadges) {
              updateListPriceBadge(badge, card);
            }
          }
        }

        const detailOverlay = typeof document !== 'undefined' && typeof document.getElementById === 'function'
          ? document.getElementById('wm-card-detail-overlay')
          : null;
        if (detailOverlay && detailOverlay.dataset.wmCardId === id) {
          const detailBadge = detailOverlay.querySelector('.wm-gif-price-badge');
          const card = currentGifCards?.find((c) => c.id === id) || cardMetaById.get(id) || { id };
          updateDetailPriceBadge(detailBadge, card);
        }
      }

      function findGifCards() {
        const { cards, isComplete, fetchedAt } = getKnownCollectionCards();
        const priceKeys = cards.map((card) => cacheKey(card.id));
        const prices = storageGet(priceKeys);

        const gifCards = [];

        for (const card of cards) {
          if (isCardGif(card)) {
            const rawPrice = cacheMemory?.get(card.id) || prices[cacheKey(card.id)];
            const rarity = card.rarity || cardMetaById.get(card.id)?.rarity || null;
            const average = rawPrice?.ok !== false
              ? chooseAverage(rawPrice, null, rarity)
              : null;

            gifCards.push({
              ...card,
              imageUrl: getResolvedImageUrl(card),
              average,
              priceEntry: rawPrice
            });
          }
        }

        const rarityWeight = (r) => {
          const index = RARITIES.indexOf(r);
          return index >= 0 ? index : 99;
        };

        gifCards.sort((a, b) => {
          const rDiff = rarityWeight(a.rarity) - rarityWeight(b.rarity);
          if (rDiff !== 0) return rDiff;
          return (a.title || '').localeCompare(b.title || '', 'fr');
        });

        currentGifCards = gifCards;

        return {
          gifCards,
          totalCards: cards.length,
          isComplete,
          fetchedAt
        };
      }

      function ensureToolbarButton() {
        if (!isCollectionPage() || !runtime.settings.isEnabled('gifCards')) {
          document.querySelectorAll('#wm-gif-button, [data-wm-gif-button], .wm-gif-button').forEach((b) => b.remove());
          gifButton = null;
          return;
        }

        const bar = document.getElementById('wm-tools-bar');
        if (!bar) return;

        // Nettoyage immédiat de tout doublon potentiel
        const existing = [...bar.querySelectorAll('#wm-gif-button, [data-wm-gif-button], .wm-gif-button')];
        // Chercher aussi des boutons orphelins qui contiendraient le texte "Cartes GIF"
        for (const btn of bar.querySelectorAll('button')) {
          if (btn.textContent.trim().startsWith('Cartes GIF') && !existing.includes(btn)) {
            existing.push(btn);
          }
        }

        if (existing.length > 1) {
          for (let i = 1; i < existing.length; i += 1) {
            existing[i].remove();
          }
        }

        if (existing.length > 0) {
          gifButton = existing[0];
          gifButton.id = 'wm-gif-button';
          gifButton.dataset.wmGifButton = '1';
          if (!gifButton.classList.contains('wm-gif-button')) {
            gifButton.classList.add('wm-gif-button');
          }
          return;
        }

        gifButton = document.createElement('button');
        gifButton.id = 'wm-gif-button';
        gifButton.dataset.wmGifButton = '1';
        gifButton.type = 'button';
        gifButton.className = 'wm-tool-button';
        gifButton.textContent = 'Cartes GIF';
        gifButton.title = 'Trouver et afficher toutes les cartes de la collection avec une image GIF animée';

        gifButton.addEventListener('click', () => {
          openGifModal();
        });

        const compactBtn = bar.querySelector('[data-wm-compact-button]');
        const sponsor = bar.querySelector('.wm-sponsor-note');

        if (compactBtn) {
          bar.insertBefore(gifButton, compactBtn);
        } else if (sponsor) {
          bar.insertBefore(gifButton, sponsor);
        } else {
          bar.append(gifButton);
        }
      }

      function renderCardGifBadges() {
        if (!isCollectionPage() || !runtime.settings.isEnabled('gifCards')) {
          document.querySelectorAll('.wm-gif-badge').forEach((el) => el.remove());
          document.body?.classList.remove('wm-gif-filter-active');
          document.getElementById('wm-gif-filter-banner')?.remove();
          return;
        }

        let visibleGifCount = 0;

        for (const card of document.querySelectorAll('div[class*="glow-"]')) {
          if (!card.querySelector('h3')) continue;

          const title = normalizeTitle(card.querySelector('h3')?.textContent);
          const id = idByTitle.get(title);
          const meta = id ? cardMetaById.get(id) : null;

          const img =
            card.querySelector('div[class*="top-0"][class*="h-[45%]"] img') ||
            card.querySelector('img');
          const src = img?.currentSrc || img?.src || img?.dataset?.wmOriginalSrc;
          const artUrl = card.style.getPropertyValue('--wm-art-url');

          const hasGif =
            isGifUrl(src) ||
            isGifUrl(artUrl) ||
            (meta && isCardGif(meta));

          const existingBadge = card.querySelector(':scope > .wm-gif-badge');

          if (hasGif) {
            visibleGifCount += 1;
            card.classList.add('wm-card-is-gif');
            if (!existingBadge) {
              const badge = document.createElement('span');
              badge.className = 'wm-gif-badge';
              badge.textContent = 'GIF';
              badge.title = 'Cette carte a une illustration GIF animée';
              card.append(badge);
            }
          } else {
            card.classList.remove('wm-card-is-gif');
            existingBadge?.remove();
          }
        }

        updatePageFilterUi(visibleGifCount);
      }

      function updatePageFilterUi(gifCount = 0) {
        let banner = document.getElementById('wm-gif-filter-banner');

        if (!pageFilterActive) {
          document.body?.classList.remove('wm-gif-filter-active');
          banner?.remove();
          return;
        }

        document.body?.classList.add('wm-gif-filter-active');

        if (!banner) {
          const bar = document.getElementById('wm-tools-bar');
          if (!bar) return;

          banner = document.createElement('div');
          banner.id = 'wm-gif-filter-banner';
          banner.className = 'wm-gif-filter-banner';

          const text = document.createElement('span');
          text.className = 'wm-gif-filter-text';
          banner.append(text);

          const closeBtn = document.createElement('button');
          closeBtn.type = 'button';
          closeBtn.className = 'wm-gif-filter-disable';
          closeBtn.textContent = 'Désactiver le filtre';
          closeBtn.addEventListener('click', () => {
            pageFilterActive = false;
            updatePageFilterUi();
            syncModalFilterCheckbox();
          });
          banner.append(closeBtn);

          bar.insertAdjacentElement('afterend', banner);
        }

        const textEl = banner.querySelector('.wm-gif-filter-text');
        if (textEl) {
          textEl.textContent = `Filtre GIF actif : ${gifCount} carte${gifCount > 1 ? 's' : ''} GIF affichée${gifCount > 1 ? 's' : ''} sur cette page.`;
        }
      }

      function syncModalFilterCheckbox() {
        const checkbox = activeModal?.querySelector('#wm-gif-filter-page-toggle');
        if (checkbox) checkbox.checked = pageFilterActive;
      }

      function findCardElement(cardOrTitle) {
        if (!isCollectionPage()) return null;
        const target = normalizeTitle(typeof cardOrTitle === 'string' ? cardOrTitle : cardOrTitle?.title);
        if (!target) return null;

        for (const h3 of document.querySelectorAll('h3')) {
          if (normalizeTitle(h3.textContent) !== target) continue;
          const card =
            h3.closest('div[class*="glow-"]') ||
            h3.closest('div[class*="rounded-2xl"][class*="overflow-hidden"]') ||
            h3.closest('div[class*="cursor-pointer"]');
          if (card) return card;
        }
        return null;
      }

      function openCardDetailModal(card) {
        document.getElementById('wm-gif-modal-overlay')?.remove();
        document.getElementById('wm-card-detail-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'wm-card-detail-overlay';
        overlay.className = 'wm-modal-overlay wm-gif-overlay';
        overlay.dataset.wmCardId = card?.id || '';

        const modal = document.createElement('div');
        modal.className = 'wm-modal wm-gif-detail-modal';
        overlay.append(modal);

        const close = () => {
          overlay.remove();
        };

        // En-tête
        const header = document.createElement('div');
        header.className = 'wm-gif-header';

        const headingWrap = document.createElement('div');
        const title = document.createElement('h2');
        title.textContent = card.title;

        const subtitle = document.createElement('p');
        const countText = card.count > 1 ? ` • Possédée en ${card.count} exemplaires` : ' • Possédée (1 exemplaire)';
        subtitle.textContent = `Rareté : ${card.rarity || 'Non définie'}${countText}`;

        headingWrap.append(title, subtitle);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'wm-gif-close';
        closeBtn.setAttribute('aria-label', 'Fermer');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', close);

        header.append(headingWrap, closeBtn);
        modal.append(header);

        // Corps avec grand aperçu du GIF animé
        const body = document.createElement('div');
        body.className = 'wm-gif-detail-body';

        const artBox = document.createElement('div');
        artBox.className = 'wm-gif-detail-art';

        if (card.imageUrl) {
          const img = document.createElement('img');
          img.src = card.imageUrl;
          img.alt = card.title;
          artBox.append(img);
        }

        const infoBox = document.createElement('div');
        infoBox.className = 'wm-gif-detail-info';

        const badgeRow = document.createElement('div');
        badgeRow.className = 'wm-gif-detail-badges';

        const rarityBadge = document.createElement('span');
        rarityBadge.className = `wm-gif-rarity-badge wm-rarity-${(card.rarity || 'c').toLowerCase()}`;
        rarityBadge.textContent = card.rarity || '—';

        const gifBadge = document.createElement('span');
        gifBadge.className = 'wm-gif-card-badge';
        gifBadge.textContent = 'GIF ✨';

        const priceBadge = document.createElement('span');
        updateDetailPriceBadge(priceBadge, card);
        const priceInfo = getCardPriceInfo(card);
        if (priceInfo.status === 'missing') {
          loadMissingPricesForGifCards([card]);
          updateDetailPriceBadge(priceBadge, card);
        }

        badgeRow.append(rarityBadge, gifBadge, priceBadge);
        infoBox.append(badgeRow);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'wm-gif-detail-actions';

        const domCard = findCardElement(card);
        if (domCard) {
          const locateBtn = document.createElement('button');
          locateBtn.type = 'button';
          locateBtn.className = 'wm-tool-button wm-gif-detail-action is-primary';
          locateBtn.textContent = '📍 Voir sur la page de collection';
          locateBtn.addEventListener('click', () => {
            close();
            accessCard(card);
          });
          actions.append(locateBtn);
        }

        if (card.wikipediaUrl || card.title) {
          const wikiUrl = card.wikipediaUrl || `https://fr.wikipedia.org/wiki/${encodeURIComponent(normalizeTitle(card.title).replace(/ /g, '_'))}`;
          const wikiBtn = document.createElement('a');
          wikiBtn.className = 'wm-tool-button wm-gif-detail-action';
          wikiBtn.href = wikiUrl;
          wikiBtn.target = '_blank';
          wikiBtn.rel = 'noopener noreferrer';
          wikiBtn.textContent = 'Consulter sur Wikipédia ↗';
          actions.append(wikiBtn);
        }

        if (card.imageUrl) {
          const imgBtn = document.createElement('a');
          imgBtn.className = 'wm-tool-button wm-gif-detail-action';
          imgBtn.href = card.imageUrl;
          imgBtn.target = '_blank';
          imgBtn.rel = 'noopener noreferrer';
          imgBtn.textContent = 'Ouvrir le GIF en taille réelle ↗';
          actions.append(imgBtn);
        }

        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'wm-tool-button wm-secondary-button wm-gif-detail-action';
        backBtn.textContent = '← Retour à la liste des GIFs';
        backBtn.addEventListener('click', () => {
          close();
          openGifModal();
        });
        actions.append(backBtn);

        infoBox.append(actions);
        body.append(artBox, infoBox);
        modal.append(body);

        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) close();
        });

        document.body.append(overlay);
      }

      function accessCard(card) {
        if (!card) return;

        // 1. Chercher si la carte est actuellement affichée dans le DOM
        const domCard = findCardElement(card);

        if (domCard) {
          // Ferme la modale active
          document.getElementById('wm-gif-modal-overlay')?.remove();
          document.getElementById('wm-card-detail-overlay')?.remove();
          activeModal = null;

          // Défilement doux vers la carte
          domCard.scrollIntoView({ behavior: 'smooth', block: 'center' });

          // Effet de halo / projecteur lumineux sur la carte
          domCard.classList.remove('wm-card-spotlight');
          void domCard.offsetWidth; // force reflow
          domCard.classList.add('wm-card-spotlight');
          setTimeout(() => {
            domCard.classList.remove('wm-card-spotlight');
          }, 3200);

          // Clic automatique sur la carte pour ouvrir la vue native du site
          setTimeout(() => {
            domCard.click();
            const clickableChild = domCard.querySelector('div[class*="cursor-pointer"], button');
            if (clickableChild && clickableChild !== domCard) {
              clickableChild.click();
            }
          }, 150);

          return;
        }

        // 2. Si la carte n'est pas sur la page actuelle (ex : pagination ou filtrage actif)
        // Vérifier si un champ de recherche existe sur la page pour tenter de la faire apparaître
        const pageSearchInput = document.querySelector(
          'main input[type="search"], main input[type="text"], input[placeholder*="recherch" i], input[placeholder*="search" i]'
        );

        if (pageSearchInput && !pageSearchInput.value.includes(card.title)) {
          pageSearchInput.value = card.title;
          pageSearchInput.dispatchEvent(new Event('input', { bubbles: true }));
          pageSearchInput.dispatchEvent(new Event('change', { bubbles: true }));

          setTimeout(() => {
            const foundAfterSearch = findCardElement(card);
            if (foundAfterSearch) {
              document.getElementById('wm-gif-modal-overlay')?.remove();
              document.getElementById('wm-card-detail-overlay')?.remove();
              activeModal = null;
              foundAfterSearch.scrollIntoView({ behavior: 'smooth', block: 'center' });
              foundAfterSearch.classList.add('wm-card-spotlight');
              foundAfterSearch.click();
              return;
            }
            openCardDetailModal(card);
          }, 250);
          return;
        }

        // 3. Sinon, ouvrir la fiche détaillée personnalisée de la carte
        openCardDetailModal(card);
      }

      function startCollectionScan(onProgress, onDone) {
        if (isScanning) return;
        isScanning = true;
        scanRequestId = `gif-scan:${Date.now()}:${Math.random().toString(36).slice(2)}`;

        const progressListener = (event) => {
          if (event.detail?.requestId !== scanRequestId) return;
          const loaded = Number(event.detail.loadedPages) || 1;
          const total = Number(event.detail.totalPages) || 1;
          onProgress?.(loaded, total);
        };

        const doneListener = (event) => {
          if (event.detail?.requestId !== scanRequestId) return;
          window.removeEventListener('wm-average-all-collection-progress', progressListener);
          window.removeEventListener('wm-average-all-collection', doneListener);
          isScanning = false;
          scanRequestId = null;

          if (event.detail?.ok && Array.isArray(event.detail?.cards)) {
            const cards = event.detail.cards;
            const complete = Boolean(event.detail.complete);
            const fetchedAt = Date.now();
            const setStorage = runtime.core?.storageSet || storageSet;
            if (setStorage) {
              setStorage({
                [ALL_COLLECTION_KEY]: { fetchedAt, cards, complete }
              });
            }
            if (cardMetaById) {
              for (const card of cards) {
                if (card.id) cardMetaById.set(card.id, { ...card });
                if (card.title && idByTitle) idByTitle.set(normalizeTitle(card.title), card.id);
              }
            }
          }

          onDone?.(event.detail);
        };

        window.addEventListener('wm-average-all-collection-progress', progressListener);
        window.addEventListener('wm-average-all-collection', doneListener);

        window.dispatchEvent(new CustomEvent('wm-average-load-all-collection', {
          detail: {
            requestId: scanRequestId,
            selectedRarities: RARITIES
          }
        }));
      }

      function openGifModal() {
        document.getElementById('wm-gif-modal-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'wm-gif-modal-overlay';
        overlay.className = 'wm-modal-overlay wm-gif-overlay';

        const modal = document.createElement('div');
        modal.className = 'wm-modal wm-gif-modal';
        overlay.append(modal);

        activeModal = modal;

        const refreshModalContent = () => {
          const data = findGifCards();
          loadMissingPricesForGifCards(data.gifCards);
          renderModalContent(modal, data);
        };

        refreshModalContent();

        const close = () => {
          overlay.remove();
          activeModal = null;
        };

        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) close();
        });

        const keyHandler = (event) => {
          if (event.key === 'Escape') {
            close();
            document.removeEventListener('keydown', keyHandler);
          }
        };
        document.addEventListener('keydown', keyHandler);

        document.body.append(overlay);
      }

      function renderModalContent(modal, data) {
        modal.innerHTML = '';

        const { gifCards, totalCards, isComplete, fetchedAt } = data;

        // En-tête
        const header = document.createElement('div');
        header.className = 'wm-gif-header';

        const headingWrap = document.createElement('div');
        const title = document.createElement('h2');
        title.innerHTML = 'Cartes avec image GIF';

        const subtitle = document.createElement('p');
        subtitle.textContent = `${gifCards.length} carte${gifCards.length > 1 ? 's' : ''} GIF trouvée${gifCards.length > 1 ? 's' : ''} parmi ${totalCards} carte${totalCards > 1 ? 's' : ''} analysée${totalCards > 1 ? 's' : ''}`;

        headingWrap.append(title, subtitle);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'wm-gif-close';
        closeBtn.setAttribute('aria-label', 'Fermer');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => {
          document.getElementById('wm-gif-modal-overlay')?.remove();
          activeModal = null;
        });

        header.append(headingWrap, closeBtn);
        modal.append(header);

        // Alerte si la collection n'est pas scannée complètement
        if (!isComplete) {
          const notice = document.createElement('div');
          notice.className = 'wm-gif-notice';

          const noticeText = document.createElement('div');
          noticeText.className = 'wm-gif-notice-text';
          noticeText.innerHTML = `<strong>Collection partielle</strong> (${totalCards} cartes en mémoire). Pour trouver absolument tous vos GIFs, lancez un scan complet.`;

          const scanBtn = document.createElement('button');
          scanBtn.type = 'button';
          scanBtn.className = 'wm-tool-button wm-gif-scan-btn';
          scanBtn.textContent = isScanning ? 'Scan en cours…' : '⚡ Scanner toute la collection';
          scanBtn.disabled = isScanning;

          scanBtn.addEventListener('click', () => {
            scanBtn.disabled = true;
            scanBtn.textContent = 'Scan en cours…';
            startCollectionScan(
              (loaded, total) => {
                scanBtn.textContent = `Page ${loaded}/${total}…`;
              },
              (detail) => {
                if (detail?.ok) {
                  const data = findGifCards();
                  loadMissingPricesForGifCards(data.gifCards);
                  renderModalContent(modal, data);
                  renderCardGifBadges();
                } else {
                  scanBtn.disabled = false;
                  scanBtn.textContent = 'Erreur scan';
                }
              }
            );
          });

          notice.append(noticeText, scanBtn);
          modal.append(notice);
        }

        // Barre d'outils et de filtres
        const controls = document.createElement('div');
        controls.className = 'wm-gif-controls';

        // Recherche
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'wm-gif-search-input';
        searchInput.placeholder = 'Rechercher une carte GIF…';
        searchInput.value = searchQuery;
        searchInput.addEventListener('input', () => {
          searchQuery = searchInput.value.trim().toLowerCase();
          updateCardsView();
        });
        controls.append(searchInput);

        // Vue Galerie vs Liste
        const viewToggle = document.createElement('div');
        viewToggle.className = 'wm-gif-view-toggle';

        const gridBtn = document.createElement('button');
        gridBtn.type = 'button';
        gridBtn.className = `wm-gif-toggle-btn ${currentViewMode === 'grid' ? 'is-active' : ''}`;
        gridBtn.textContent = 'Galerie';
        gridBtn.title = 'Vue galerie avec grands aperçus animés';
        gridBtn.addEventListener('click', () => {
          currentViewMode = 'grid';
          gridBtn.classList.add('is-active');
          listBtn.classList.remove('is-active');
          updateCardsView();
        });

        const listBtn = document.createElement('button');
        listBtn.type = 'button';
        listBtn.className = `wm-gif-toggle-btn ${currentViewMode === 'list' ? 'is-active' : ''}`;
        listBtn.textContent = 'Liste';
        listBtn.title = 'Vue liste compacte';
        listBtn.addEventListener('click', () => {
          currentViewMode = 'list';
          listBtn.classList.add('is-active');
          gridBtn.classList.remove('is-active');
          updateCardsView();
        });

        viewToggle.append(gridBtn, listBtn);
        controls.append(viewToggle);

        // Filtre page collection toggle
        const pageFilterLabel = document.createElement('label');
        pageFilterLabel.className = 'wm-gif-page-filter-label';

        const pageFilterCheckbox = document.createElement('input');
        pageFilterCheckbox.type = 'checkbox';
        pageFilterCheckbox.id = 'wm-gif-filter-page-toggle';
        pageFilterCheckbox.checked = pageFilterActive;
        pageFilterCheckbox.addEventListener('change', () => {
          pageFilterActive = pageFilterCheckbox.checked;
          renderCardGifBadges();
        });

        const pageFilterSpan = document.createElement('span');
        pageFilterSpan.textContent = 'Filtrer aussi sur la page';

        pageFilterLabel.append(pageFilterCheckbox, pageFilterSpan);
        controls.append(pageFilterLabel);

        modal.append(controls);

        // Pilules de rareté
        const rarityPills = document.createElement('div');
        rarityPills.className = 'wm-gif-rarity-pills';

        const countForRarity = (rarity) => {
          if (rarity === 'ALL') return gifCards.length;
          return gifCards.filter((c) => c.rarity === rarity).length;
        };

        const createPill = (rarity, label) => {
          const count = countForRarity(rarity);
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = `wm-gif-pill ${selectedRarity === rarity ? 'is-active' : ''} ${rarity !== 'ALL' ? `wm-rarity-${rarity.toLowerCase()}` : ''}`;
          pill.textContent = `${label} (${count})`;
          pill.disabled = count === 0 && rarity !== 'ALL';
          pill.addEventListener('click', () => {
            selectedRarity = rarity;
            rarityPills.querySelectorAll('.wm-gif-pill').forEach((p) => p.classList.remove('is-active'));
            pill.classList.add('is-active');
            updateCardsView();
          });
          return pill;
        };

        rarityPills.append(createPill('ALL', 'Toutes'));
        for (const rarity of RARITIES) {
          rarityPills.append(createPill(rarity, rarity));
        }
        modal.append(rarityPills);

        // Conteneur de cartes
        const listContainer = document.createElement('div');
        listContainer.className = 'wm-gif-container';
        modal.append(listContainer);

        function updateCardsView() {
          listContainer.innerHTML = '';

          let filtered = gifCards;
          if (selectedRarity !== 'ALL') {
            filtered = filtered.filter((c) => c.rarity === selectedRarity);
          }
          if (searchQuery) {
            filtered = filtered.filter((c) =>
              (c.title || '').toLowerCase().includes(searchQuery)
            );
          }

          if (!filtered.length) {
            const empty = document.createElement('div');
            empty.className = 'wm-gif-empty';
            empty.innerHTML = `
              <div class="wm-gif-empty-icon">🎬</div>
              <h3>Aucune carte GIF trouvée</h3>
              <p>${gifCards.length === 0 ? "Aucune carte avec image animée GIF n'a été détectée dans les cartes chargées." : 'Aucune carte GIF ne correspond à votre filtre.'}</p>
            `;
            listContainer.append(empty);
            return;
          }

          if (currentViewMode === 'grid') {
            const grid = document.createElement('div');
            grid.className = 'wm-gif-grid';

            for (const card of filtered) {
              const cardEl = document.createElement('div');
              cardEl.className = 'wm-gif-card wm-gif-clickable';
              cardEl.dataset.gifCardId = card.id || '';
              cardEl.setAttribute('role', 'button');
              cardEl.setAttribute('tabindex', '0');
              cardEl.title = `Accéder à la carte ${card.title}`;

              cardEl.addEventListener('click', (event) => {
                if (event.target.closest('a')) return;
                accessCard(card);
              });
              cardEl.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  accessCard(card);
                }
              });

              const artWrap = document.createElement('div');
              artWrap.className = 'wm-gif-art-wrap';

              if (card.imageUrl) {
                const img = document.createElement('img');
                img.src = card.imageUrl;
                img.alt = card.title || '';
                img.loading = 'lazy';
                artWrap.append(img);
              } else {
                const placeholder = document.createElement('div');
                placeholder.className = 'wm-gif-placeholder';
                placeholder.textContent = 'GIF';
                artWrap.append(placeholder);
              }

              const badge = document.createElement('span');
              badge.className = 'wm-gif-card-badge';
              badge.textContent = 'GIF ✨';
              artWrap.append(badge);

              if (card.count > 1) {
                const countBadge = document.createElement('span');
                countBadge.className = 'wm-gif-count-badge';
                countBadge.textContent = `×${card.count}`;
                artWrap.append(countBadge);
              }

              const info = document.createElement('div');
              info.className = 'wm-gif-card-info';

              const name = document.createElement('div');
              name.className = 'wm-gif-card-title';
              name.textContent = card.title;
              name.title = card.title;

              const metaRow = document.createElement('div');
              metaRow.className = 'wm-gif-card-meta';

              const rarityBadge = document.createElement('span');
              rarityBadge.className = `wm-gif-rarity-badge wm-rarity-${(card.rarity || 'c').toLowerCase()}`;
              rarityBadge.textContent = card.rarity || '—';

              const priceBadge = document.createElement('span');
              updateGridPriceBadge(priceBadge, card);

              metaRow.append(rarityBadge, priceBadge);

              if (card.wikipediaUrl || card.title) {
                const wikiBtn = document.createElement('a');
                wikiBtn.className = 'wm-gif-wiki-btn';
                wikiBtn.href = card.wikipediaUrl || `https://fr.wikipedia.org/wiki/${encodeURIComponent(normalizeTitle(card.title).replace(/ /g, '_'))}`;
                wikiBtn.target = '_blank';
                wikiBtn.rel = 'noopener noreferrer';
                wikiBtn.textContent = 'W';
                wikiBtn.title = 'Ouvrir l’article Wikipédia';
                metaRow.append(wikiBtn);
              }

              const actionBtn = document.createElement('button');
              actionBtn.type = 'button';
              actionBtn.className = 'wm-tool-button wm-gif-card-action';
              actionBtn.textContent = 'Accéder à la carte →';
              actionBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                accessCard(card);
              });

              info.append(name, metaRow, actionBtn);
              cardEl.append(artWrap, info);
              grid.append(cardEl);
            }

            listContainer.append(grid);
          } else {
            // Vue Liste
            const list = document.createElement('div');
            list.className = 'wm-gif-list';

            for (const [index, card] of filtered.entries()) {
              const row = document.createElement('div');
              row.className = 'wm-gif-row wm-gif-clickable';
              row.dataset.gifCardId = card.id || '';
              row.setAttribute('role', 'button');
              row.setAttribute('tabindex', '0');
              row.title = `Accéder à la carte ${card.title}`;

              row.addEventListener('click', (event) => {
                if (event.target.closest('a')) return;
                accessCard(card);
              });
              row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  accessCard(card);
                }
              });

              const indexEl = document.createElement('div');
              indexEl.className = 'wm-gif-row-index';
              indexEl.textContent = String(index + 1);

              const thumb = document.createElement('div');
              thumb.className = 'wm-gif-row-thumb';
              if (card.imageUrl) {
                const img = document.createElement('img');
                img.src = card.imageUrl;
                img.alt = '';
                img.loading = 'lazy';
                thumb.append(img);
              }

              const titleEl = document.createElement('div');
              titleEl.className = 'wm-gif-row-title';
              titleEl.textContent = card.title;

              const rarityEl = document.createElement('div');
              rarityEl.className = `wm-gif-row-rarity wm-rarity-${(card.rarity || 'c').toLowerCase()}`;
              rarityEl.textContent = card.rarity || '—';

              const countEl = document.createElement('div');
              countEl.className = 'wm-gif-row-count';
              countEl.textContent = card.count > 1 ? `×${card.count}` : '';

              const priceEl = document.createElement('div');
              updateListPriceBadge(priceEl, card);

              const actionBtn = document.createElement('button');
              actionBtn.type = 'button';
              actionBtn.className = 'wm-tool-button wm-gif-row-action';
              actionBtn.textContent = 'Accéder →';
              actionBtn.title = 'Accéder à cette carte';
              actionBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                accessCard(card);
              });

              row.append(indexEl, thumb, titleEl, rarityEl, countEl, priceEl);

              if (card.wikipediaUrl || card.title) {
                const wikiBtn = document.createElement('a');
                wikiBtn.className = 'wm-gif-wiki-btn';
                wikiBtn.href = card.wikipediaUrl || `https://fr.wikipedia.org/wiki/${encodeURIComponent(normalizeTitle(card.title).replace(/ /g, '_'))}`;
                wikiBtn.target = '_blank';
                wikiBtn.rel = 'noopener noreferrer';
                wikiBtn.textContent = 'W';
                wikiBtn.title = 'Wikipédia';
                row.append(wikiBtn);
              }

              row.append(actionBtn);
              list.append(row);
            }

            listContainer.append(list);
          }
        }

        updateCardsView();
      }

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('wm-average-response', (event) => {
          const id = event.detail?.id;
          if (id) {
            onPriceUpdated(id);
          }
        });
      }

      return {
        isGifUrl,
        getAnimatedGifUrl,
        isCardGif,
        findGifCards,
        ensureToolbarButton,
        renderCardGifBadges,
        openGifModal,
        openCardDetailModal,
        accessCard,
        findCardElement,
        getKnownCollectionCards,
        onPriceUpdated,
        loadMissingPricesForGifCards,
        getCardPriceInfo
      };
    }
  };
})();
