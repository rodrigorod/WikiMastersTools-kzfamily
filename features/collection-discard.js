(() => {
  const registry = (typeof window !== 'undefined' ? window : global).__wmAverageFeatures ||= {};

  registry.collectionDiscard = {
    create(runtime) {
      const {
        ALL_COLLECTION_KEY, RARITIES, cardMetaById, idByTitle,
        isCollectionPage, normalizeTitle, readLocalValue, storageGet, storageSet,
        cacheKey, cacheMemory, isCacheEntryValid, reportError
      } = runtime.core;
      const { chooseAverage, formatAverage, getRarityFromCard } = runtime.priceUi;

      let discardButton = null;
      let activeDiscardModal = null;
      let activeDiscardModalRefresh = null;
      let refreshTimeout = null;
      let isScanning = false;
      let scanRequestId = null;

      function startCollectionScan(onProgress, onDone) {
        if (isScanning) return;
        isScanning = true;
        scanRequestId = `discard-scan:${Date.now()}:${Math.random().toString(36).slice(2)}`;

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

      function loadMissingPrices(cardsToLoad) {
        if (!runtime.priceLoader?.loadCacheForCards || !Array.isArray(cardsToLoad)) return;
        const missing = [];
        for (const card of cardsToLoad) {
          const id = resolveRealCardId(card);
          if (!id || String(id).startsWith('dom-')) continue;
          const entry = cacheMemory?.get(id) || readLocalValue(cacheKey(id));
          const isValid = isCacheEntryValid ? isCacheEntryValid(entry) : Boolean(entry && entry.ok !== false);
          const isPending = Boolean(runtime.priceLoader?.isPending?.(id));
          if (!isValid && !isPending) {
            missing.push(card);
          }
        }
        if (missing.length > 0) {
          try {
            runtime.priceLoader.loadCacheForCards(missing);
          } catch (e) {
            reportError?.('chargement prix defausse', e);
          }
        }
      }

      function onPriceUpdated(id) {
        if (!id || !activeDiscardModal) return;
        if (refreshTimeout) return;
        refreshTimeout = setTimeout(() => {
          refreshTimeout = null;
          if (activeDiscardModal && typeof activeDiscardModalRefresh === 'function') {
            activeDiscardModalRefresh();
          }
        }, 150);
      }

      // État de filtrage par défaut
      const DEFAULT_CONFIG = {
        maxPrice: 10,
        selectedRarities: new Set(['C', 'PC', 'R']), // C, PC, R sélectionnés par défaut ; SR, UR, L exclus pour sécurité
        keepAtLeastOne: true, // Garder au moins 1 exemplaire (doublons uniquement)
        ignoreUnpriced: true, // Ne pas défausser les cartes sans prix connu
        excludedCardIds: new Set(), // IDs de cartes décochées manuellement dans l'aperçu
        searchQuery: '',
        tagFilterMode: 'all', // 'all' | 'untagged' | 'tagged' | 'custom'
        selectedTags: new Set()
      };

      let currentConfig = {
        maxPrice: DEFAULT_CONFIG.maxPrice,
        selectedRarities: new Set(DEFAULT_CONFIG.selectedRarities),
        keepAtLeastOne: DEFAULT_CONFIG.keepAtLeastOne,
        ignoreUnpriced: DEFAULT_CONFIG.ignoreUnpriced,
        excludedCardIds: new Set(),
        searchQuery: '',
        tagFilterMode: DEFAULT_CONFIG.tagFilterMode,
        selectedTags: new Set()
      };

      function normalizeTags(raw) {
        if (!raw) return [];
        if (Array.isArray(raw)) {
          return raw
            .map((item) => {
              if (!item) return '';
              if (typeof item === 'string') return item.trim();
              if (typeof item === 'object') return (item.name || item.label || item.title || item.tag || '').trim();
              return String(item).trim();
            })
            .filter(Boolean);
        }
        if (typeof raw === 'string') {
          return raw.split(',').map((s) => s.trim()).filter(Boolean);
        }
        return [];
      }

      function extractTagsFromCardElement(cardEl) {
        if (!cardEl) return [];
        const tags = new Set();
        if (cardEl.dataset?.tags) {
          normalizeTags(cardEl.dataset.tags).forEach((t) => tags.add(t));
        }
        if (cardEl.dataset?.tag) {
          normalizeTags(cardEl.dataset.tag).forEach((t) => tags.add(t));
        }
        if (cardEl.dataset?.label) {
          normalizeTags(cardEl.dataset.label).forEach((t) => tags.add(t));
        }
        if (cardEl.dataset?.labels) {
          normalizeTags(cardEl.dataset.labels).forEach((t) => tags.add(t));
        }

        const badgeEls = cardEl.querySelectorAll('[class*="tag"], [class*="label"], [data-tag-name]');
        for (const b of badgeEls) {
          if (
            b.classList.contains('wm-average-badge') ||
            b.classList.contains('wm-rarity-pill') ||
            b.classList.contains('wm-discard-tag-badge')
          ) {
            continue;
          }
          const t = (b.dataset?.tagName || b.dataset?.tag || b.textContent || '').trim();
          if (t && t.length <= 35 && !t.startsWith('Moy.') && !t.startsWith('x') && !/^(C|PC|R|SR|UR|L)$/i.test(t)) {
            tags.add(t);
          }
        }
        return [...tags];
      }

      function getTagsFromCards(cards) {
        const tagCounts = new Map();
        let untaggedCount = 0;
        for (const card of cards) {
          if (!card) continue;
          const cardTags = Array.isArray(card.tags) ? card.tags : normalizeTags(card.tags || card.labels);
          const copies = Math.max(1, Number(card.count) || 1);
          if (!cardTags.length) {
            untaggedCount += copies;
          } else {
            for (const t of cardTags) {
              const trimmed = String(t).trim();
              if (trimmed) {
                tagCounts.set(trimmed, (tagCounts.get(trimmed) || 0) + copies);
              }
            }
          }
        }
        return { tagCounts, untaggedCount };
      }

      function isValidUuid(id) {
        return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
      }

      function resolveCardUuids(candidate) {
        const uuids = new Set();
        const card = candidate.card || candidate;

        if (Array.isArray(card.ownedCardIds)) {
          for (const id of card.ownedCardIds) {
            if (isValidUuid(id)) uuids.add(id);
          }
        }
        if (isValidUuid(card.ownedCardId)) {
          uuids.add(card.ownedCardId);
        }
        if (isValidUuid(card.id)) {
          uuids.add(card.id);
        }

        const elements = candidate.domElements && candidate.domElements.length
          ? candidate.domElements
          : (typeof findCardElements === 'function' ? findCardElements(card) : []);

        for (const el of elements) {
          const checkbox = el.querySelector('input[type="checkbox"]');
          const val = checkbox?.value;
          if (isValidUuid(val)) uuids.add(val);
          if (isValidUuid(el.dataset?.userCardId)) uuids.add(el.dataset.userCardId);
          if (isValidUuid(el.dataset?.cardId)) uuids.add(el.dataset.cardId);
          if (isValidUuid(el.dataset?.id)) uuids.add(el.dataset.id);
          if (isValidUuid(el.dataset?.wmCardId)) uuids.add(el.dataset.wmCardId);
        }

        return [...uuids];
      }

      function getDiscardCardIds(candidate) {
        const uuids = resolveCardUuids(candidate);
        const count = Math.max(1, candidate.discardCount || 1);
        if (uuids.length > 0) {
          return uuids.slice(0, count);
        }
        if (isValidUuid(candidate.id)) {
          return [candidate.id];
        }
        return [];
      }

      function applyDiscardedCardsToStorage(discardedIds) {
        if (!Array.isArray(discardedIds) || !discardedIds.length) return;
        const idSet = new Set(discardedIds);
        const getStorage = runtime.core?.storageGet || storageGet;
        const setStorage = runtime.core?.storageSet || storageSet;
        if (!getStorage || !setStorage) return;

        const stored = getStorage(ALL_COLLECTION_KEY) || {};
        const collectionEntry = stored[ALL_COLLECTION_KEY];
        if (!collectionEntry || !Array.isArray(collectionEntry.cards)) return;

        const updatedCards = [];
        for (const card of collectionEntry.cards) {
          let discardedCopies = 0;
          if (Array.isArray(card.ownedCardIds)) {
            const initialLen = card.ownedCardIds.length;
            card.ownedCardIds = card.ownedCardIds.filter((id) => !idSet.has(id));
            discardedCopies = initialLen - card.ownedCardIds.length;
          }
          if (idSet.has(card.ownedCardId)) {
            if (discardedCopies === 0) discardedCopies = 1;
            card.ownedCardId = card.ownedCardIds?.[0] || null;
          }
          if (idSet.has(card.id)) {
            if (discardedCopies === 0) discardedCopies = 1;
          }

          const currentCount = Math.max(0, Number(card.count) || 1);
          const newCount = Math.max(0, currentCount - discardedCopies);
          if (newCount > 0) {
            card.count = newCount;
            updatedCards.push(card);
          }
          if (cardMetaById && card.id) {
            if (newCount > 0) {
              const meta = cardMetaById.get(card.id);
              if (meta) meta.count = newCount;
            } else {
              cardMetaById.delete(card.id);
            }
          }
        }

        collectionEntry.cards = updatedCards;
        setStorage({
          [ALL_COLLECTION_KEY]: collectionEntry
        });
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
          const resolved = idByTitle?.get(normalizeTitle(card.title));
          if (resolved) {
            card.id = resolved;
            return resolved;
          }
        }
        return card.id || null;
      }

      function getKnownCollectionCards() {
        const getStorage = runtime.core?.storageGet || storageGet;
        const stored = getStorage(ALL_COLLECTION_KEY) || {};
        const collectionEntry = stored[ALL_COLLECTION_KEY];
        const storedCards = Array.isArray(collectionEntry?.cards) ? collectionEntry.cards : [];

        const knownCards = new Map();

        for (const card of storedCards) {
          if (card?.id && card?.title) {
            knownCards.set(card.id, {
              ...card,
              tags: Array.isArray(card.tags) ? [...card.tags] : normalizeTags(card.tags || card.labels),
              ownedCardIds: Array.isArray(card.ownedCardIds) ? [...card.ownedCardIds] : (card.ownedCardId ? [card.ownedCardId] : [])
            });
          }
        }

        if (cardMetaById) {
          for (const card of cardMetaById.values()) {
            if (!card?.id || !card?.title) continue;
            const previous = knownCards.get(card.id);
            const cardTags = Array.isArray(card.tags) ? card.tags : normalizeTags(card.tags || card.labels);
            const mergedTags = previous
              ? [...new Set([...(previous.tags || []), ...cardTags])]
              : cardTags;
            const mergedOwnedIds = previous
              ? [...new Set([...(previous.ownedCardIds || []), ...(card.ownedCardIds || []), card.ownedCardId].filter(Boolean))]
              : (Array.isArray(card.ownedCardIds) ? [...card.ownedCardIds] : (card.ownedCardId ? [card.ownedCardId] : []));
            knownCards.set(card.id, {
              ...(previous || {}),
              ...card,
              tags: mergedTags,
              ownedCardIds: mergedOwnedIds
            });
          }
        }

        // Enrichit avec les éléments actuellement présents dans le DOM
        if (typeof document !== 'undefined') {
          for (const cardEl of document.querySelectorAll('div[class*="glow-"], div[class*="rounded-2xl"][class*="cursor-pointer"]')) {
            const h3 = cardEl.querySelector('h3');
            const title = normalizeTitle(h3?.textContent);
            if (!title) continue;

            const img =
              cardEl.querySelector('div[class*="top-0"][class*="h-[45%]"] img') ||
              cardEl.querySelector('img');
            const src = img?.currentSrc || img?.src || img?.dataset?.wmOriginalSrc;
            const id = cardEl.dataset?.wmCardId || (idByTitle ? idByTitle.get(title) : null);
            const rarity = typeof getRarityFromCard === 'function' ? getRarityFromCard(cardEl) : null;
            const domTags = extractTagsFromCardElement(cardEl);

            const checkbox = cardEl.querySelector('input[type="checkbox"]');
            const checkboxVal = checkbox?.value;
            const domUuid = isValidUuid(checkboxVal)
              ? checkboxVal
              : (isValidUuid(cardEl.dataset?.userCardId)
                ? cardEl.dataset.userCardId
                : (isValidUuid(cardEl.dataset?.cardId) ? cardEl.dataset.cardId : null));

            // Détection d'un éventuel badge de quantité dans le DOM (ex: "x2", "x3")
            let domCount = 1;
            const countText = cardEl.textContent || '';
            const matchCount = countText.match(/\bx\s*(\d+)\b/i);
            if (matchCount) {
              domCount = Math.max(1, parseInt(matchCount[1], 10) || 1);
            }

            if (id && knownCards.has(id)) {
              const card = knownCards.get(id);
              if (!card.imageUrl && src) card.imageUrl = src;
              if (!card.rarity && rarity) card.rarity = rarity;
              card.domCount = (card.domCount || 0) + domCount;
              card.count = Math.max(card.count || 1, card.domCount);
              if (domTags.length > 0) {
                card.tags = [...new Set([...(card.tags || []), ...domTags])];
              }
              if (domUuid && (!Array.isArray(card.ownedCardIds) || !card.ownedCardIds.includes(domUuid))) {
                card.ownedCardIds = [...(card.ownedCardIds || []), domUuid];
              }
            } else if (id) {
              const meta = cardMetaById ? cardMetaById.get(id) : null;
              const metaTags = Array.isArray(meta?.tags) ? meta.tags : normalizeTags(meta?.tags || meta?.labels);
              const metaOwnedIds = Array.isArray(meta?.ownedCardIds) ? meta.ownedCardIds : (meta?.ownedCardId ? [meta.ownedCardId] : []);
              knownCards.set(id, {
                id,
                title,
                imageUrl: meta?.imageUrl || src || null,
                rarity: meta?.rarity || rarity || null,
                wikipediaUrl: meta?.wikipediaUrl || null,
                domCount,
                count: Math.max(meta?.count || 1, domCount),
                tags: [...new Set([...metaTags, ...domTags])],
                ownedCardIds: domUuid ? [...new Set([...metaOwnedIds, domUuid])] : metaOwnedIds,
                ownedCardId: meta?.ownedCardId || domUuid || null
              });
            } else if (title) {
              const virtualId = `dom-${encodeURIComponent(title)}`;
              if (!knownCards.has(virtualId)) {
                knownCards.set(virtualId, {
                  id: virtualId,
                  title,
                  imageUrl: src || null,
                  rarity: rarity || null,
                  domCount,
                  count: domCount,
                  tags: domTags,
                  ownedCardIds: domUuid ? [domUuid] : [],
                  ownedCardId: domUuid || null
                });
              } else {
                const card = knownCards.get(virtualId);
                card.domCount = (card.domCount || 1) + domCount;
                card.count = Math.max(card.count || 1, card.domCount);
                if (domTags.length > 0) {
                  card.tags = [...new Set([...(card.tags || []), ...domTags])];
                }
                if (domUuid && (!Array.isArray(card.ownedCardIds) || !card.ownedCardIds.includes(domUuid))) {
                  card.ownedCardIds = [...(card.ownedCardIds || []), domUuid];
                }
              }
            }
          }
        }

        return {
          cards: [...knownCards.values()],
          isComplete: collectionEntry?.complete === true,
          fetchedAt: Number(collectionEntry?.fetchedAt) || 0
        };
      }

      function getCardAveragePrice(card) {
        const id = resolveRealCardId(card);
        if (id && !String(id).startsWith('dom-')) {
          const entry = cacheMemory?.get(id) || readLocalValue(cacheKey(id));
          const isValid = isCacheEntryValid ? isCacheEntryValid(entry) : Boolean(entry && entry.ok !== false);
          if (isValid && entry?.ok !== false) {
            const rarity = card.rarity || cardMetaById?.get(id)?.rarity || null;
            const average = chooseAverage(entry, null, rarity);
            if (Number.isFinite(average)) {
              return average;
            }
          }
        }

        // Fallback DOM : inspecte si le badge wm-average-badge est présent sur la carte
        const elements = findCardElements(card);
        for (const el of elements) {
          const badgeText = el.querySelector('.wm-average-badge')?.textContent || '';
          const match = badgeText.match(/Moy\.\s*([\d\s,.]+)\s*W/i);
          if (match) {
            const parsed = parseFloat(match[1].replace(/\s/g, '').replace(',', '.'));
            if (Number.isFinite(parsed)) {
              return parsed;
            }
          }
        }

        return null;
      }

      function findCardElements(card) {
        if (!card || typeof document === 'undefined') return [];
        const results = [];
        const id = resolveRealCardId(card);

        if (id && !String(id).startsWith('dom-')) {
          const els = document.querySelectorAll(`[data-wm-card-id="${safeEscape(id)}"]`);
          for (const el of els) results.push(el);
        }

        if (card.title) {
          const targetTitle = normalizeTitle(card.title);
          for (const h3 of document.querySelectorAll('h3')) {
            if (normalizeTitle(h3.textContent) === targetTitle) {
              const cardEl =
                h3.closest('div[class*="rounded-2xl"][class*="overflow-hidden"]') ||
                h3.closest('div[class*="glow-"]') ||
                h3.closest('div[class*="cursor-pointer"]');
              if (cardEl && !results.includes(cardEl)) {
                results.push(cardEl);
              }
            }
          }
        }

        return results;
      }

      /**
       * Filtrage pur des cartes candidates à la défausse.
       * Exporté pour tests unitaires et utilisé par le modal.
       */
      function computeDiscardCandidates(cards, options = {}, priceResolver = getCardAveragePrice) {
        const maxPrice = Number.isFinite(Number(options.maxPrice)) ? Number(options.maxPrice) : 10;
        const selectedRarities = options.selectedRarities instanceof Set
          ? options.selectedRarities
          : new Set(options.selectedRarities || ['C', 'PC', 'R']);
        const keepAtLeastOne = options.keepAtLeastOne !== false;
        const ignoreUnpriced = options.ignoreUnpriced !== false;
        const excludedCardIds = options.excludedCardIds instanceof Set
          ? options.excludedCardIds
          : new Set(options.excludedCardIds || []);
        const searchQuery = String(options.searchQuery || '').trim().toLowerCase();
        const tagFilterMode = options.tagFilterMode || 'all'; // 'all' | 'untagged' | 'tagged' | 'custom'
        const selectedTags = options.selectedTags instanceof Set
          ? options.selectedTags
          : Array.isArray(options.selectedTags)
            ? new Set(options.selectedTags)
            : null;

        const candidates = [];

        for (const card of cards) {
          if (!card || !card.title) continue;

          // 0. Filtre d'étiquettes
          const cardTags = Array.isArray(card.tags)
            ? card.tags
            : normalizeTags(card.tags || card.labels);
          const isUntagged = cardTags.length === 0;

          if (tagFilterMode === 'untagged') {
            if (!isUntagged) continue;
          } else if (tagFilterMode === 'tagged') {
            if (isUntagged) continue;
          } else if (tagFilterMode === 'custom' && selectedTags) {
            if (isUntagged) {
              if (!selectedTags.has('__UNTAGGED__')) continue;
            } else {
              const hasMatching = cardTags.some((t) => selectedTags.has(t));
              if (!hasMatching) continue;
            }
          }

          // 1. Filtre de rareté
          const rarity = card.rarity || 'C';
          if (!selectedRarities.has(rarity)) {
            continue;
          }

          // 2. Filtre de prix moyen
          const average = priceResolver(card);
          if (average == null) {
            if (ignoreUnpriced) {
              // Sécurité : carte sans cote moyenne ignorée
              continue;
            }
          } else if (average > maxPrice) {
            // Carte trop chère : exclue du seuil de défausse
            continue;
          }

          // 3. Calcul du nombre d'exemplaires défaussables
          const ownedCount = Math.max(1, Number(card.count) || 1);
          let discardCount = 0;

          if (keepAtLeastOne) {
            discardCount = Math.max(0, ownedCount - 1);
          } else {
            discardCount = ownedCount;
          }

          if (discardCount <= 0) {
            // Aucun exemplaire défaussable (ex: carte unique protégée)
            continue;
          }

          // 4. Filtre de recherche textuelle facultative
          if (searchQuery && !normalizeTitle(card.title).toLowerCase().includes(searchQuery)) {
            continue;
          }

          const cardId = card.id || `title-${normalizeTitle(card.title)}`;
          const isSelected = !excludedCardIds.has(cardId);
          const domElements = findCardElements(card);
          const onCurrentPage = domElements.length > 0;

          candidates.push({
            card,
            id: cardId,
            title: card.title,
            rarity,
            imageUrl: card.imageUrl || card.image_url || null,
            average,
            ownedCount,
            discardCount,
            tags: cardTags,
            ownedCardIds: Array.isArray(card.ownedCardIds) ? [...card.ownedCardIds] : (card.ownedCardId ? [card.ownedCardId] : []),
            ownedCardId: card.ownedCardId || null,
            isSelected,
            onCurrentPage,
            domElements
          });
        }

        // Tri par rareté croissante (C -> PC -> R -> SR -> UR -> L), puis par prix croissant
        const rarityRank = (r) => {
          const idx = RARITIES.indexOf(r);
          return idx >= 0 ? idx : 99;
        };

        candidates.sort((a, b) => {
          // Inverser l'ordre des raretés pour mettre les communes en premier
          const rDiff = rarityRank(b.rarity) - rarityRank(a.rarity);
          if (rDiff !== 0) return rDiff;
          const aPrice = a.average != null ? a.average : -1;
          const bPrice = b.average != null ? b.average : -1;
          if (aPrice !== bPrice) return aPrice - bPrice;
          return a.title.localeCompare(b.title, 'fr');
        });

        return candidates;
      }

      function findNativeSelectButton() {
        if (typeof document === 'undefined') return null;
        const buttons = [...document.querySelectorAll('button')];

        // Chercher d'abord un bouton dont le texte exact est "Sélectionner"
        const exact = buttons.find((btn) => {
          if (btn.closest('#wm-tools-bar') || btn.closest('.wm-modal-overlay') || btn.closest('.wm-discard-modal')) {
            return false;
          }
          const text = normalizeTitle(btn.textContent).toLowerCase();
          return text === 'selectionner' || text === 'sélectionner';
        });
        if (exact) return exact;

        // Sinon chercher un bouton contenant "sélectionner"
        return buttons.find((btn) => {
          if (btn.closest('#wm-tools-bar') || btn.closest('.wm-modal-overlay') || btn.closest('.wm-discard-modal')) {
            return false;
          }
          const text = normalizeTitle(btn.textContent).toLowerCase();
          return text.includes('selectionner') || text.includes('sélectionner');
        });
      }

      function findNativeDiscardButton() {
        if (typeof document === 'undefined') return null;
        const buttons = [...document.querySelectorAll('button')];
        return buttons.find((btn) => {
          if (btn.closest('#wm-tools-bar') || btn.closest('.wm-modal-overlay') || btn.closest('.wm-discard-modal')) {
            return false;
          }
          const text = normalizeTitle(btn.textContent).toLowerCase();
          return text.includes('défausser') || text.includes('defausser');
        });
      }

      function isCardElementSelected(cardEl) {
        if (!cardEl) return false;
        const checkbox = cardEl.querySelector('input[type="checkbox"]');
        if (checkbox) return checkbox.checked;
        if (cardEl.getAttribute('aria-selected') === 'true') return true;
        if (cardEl.getAttribute('aria-checked') === 'true') return true;
        if (cardEl.dataset.selected === 'true') return true;
        const className = cardEl.className || '';
        if (/ring-2|ring-4|border-emerald|border-green|border-purple|border-primary|bg-primary/i.test(className)) {
          return true;
        }
        const indicator = cardEl.querySelector('[data-state="checked"], [aria-checked="true"], .is-selected');
        return Boolean(indicator);
      }

      function selectCardElement(cardEl) {
        if (!cardEl) return;
        if (isCardElementSelected(cardEl)) return;

        const checkbox = cardEl.querySelector('input[type="checkbox"]');
        if (checkbox && !checkbox.checked) {
          checkbox.click();
          return;
        }

        const clickable = cardEl.querySelector('div[class*="cursor-pointer"]') || cardEl;
        clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }

      function activateNativeSelectionMode() {
        const selectBtn = findNativeSelectButton();
        if (selectBtn) {
          const text = normalizeTitle(selectBtn.textContent).toLowerCase();
          // Si le texte est "sélectionner", on clique pour activer
          if (text === 'selectionner' || text === 'sélectionner' || text.startsWith('selectionner') || text.startsWith('sélectionner')) {
            selectBtn.click();
            return true;
          }
        }
        return false;
      }

      function showToast(message, type = 'info') {
        if (typeof document === 'undefined') return;
        document.querySelectorAll('.wm-discard-toast').forEach((t) => t.remove());

        const toast = document.createElement('div');
        toast.className = `wm-discard-toast is-${type}`;
        toast.textContent = message;
        document.body.append(toast);

        setTimeout(() => {
          toast.classList.add('is-visible');
        }, 10);

        setTimeout(() => {
          toast.classList.remove('is-visible');
          setTimeout(() => toast.remove(), 300);
        }, 3500);
      }

      function filterWikiMastersPageByRarity(rarity) {
        if (!rarity || typeof document === 'undefined') return false;
        const targetR = String(rarity).trim().toUpperCase();
        const rarityFullNames = {
          C: 'COMMUNE',
          PC: 'PEU COMMUNE',
          R: 'RARE',
          SR: 'SUPER RARE',
          UR: 'ULTRA RARE',
          L: 'LÉGENDAIRE'
        };
        const fullName = rarityFullNames[targetR] || '';

        const elements = [
          ...document.querySelectorAll('button, [role="tab"], [role="button"], a')
        ];

        // 1. Bouton avec texte exact targetR (ex: "C")
        let target = elements.find((el) => {
          if (el.closest('#wm-tools-bar') || el.closest('.wm-modal-overlay') || el.closest('.wm-discard-modal')) return false;
          const txt = normalizeTitle(el.textContent).trim().toUpperCase();
          return txt === targetR;
        });

        // 2. Bouton commençant par "C " ou "C (" ou texte complet (ex: "C (12)")
        if (!target) {
          target = elements.find((el) => {
            if (el.closest('#wm-tools-bar') || el.closest('.wm-modal-overlay') || el.closest('.wm-discard-modal')) return false;
            const txt = normalizeTitle(el.textContent).trim().toUpperCase();
            return (
              txt.startsWith(targetR + ' ') ||
              txt.startsWith(targetR + '(') ||
              txt.startsWith(targetR + '\n') ||
              (fullName && (txt === fullName || txt.startsWith(fullName + ' ') || txt.startsWith(fullName + '(')))
            );
          });
        }

        // 3. Fallback attribut data-rarity
        if (!target) {
          target = elements.find((el) => {
            if (el.closest('#wm-tools-bar') || el.closest('.wm-modal-overlay') || el.closest('.wm-discard-modal')) return false;
            return el.dataset?.rarity?.toUpperCase() === targetR;
          });
        }

        if (target) {
          target.click();
          return true;
        }
        return false;
      }

      /**
       * Sélectionne les cartes candidates visibles sur la page active.
       * Si aucune carte n'est sur la page actuelle, bascule automatiquement sur l'onglet de rareté adapté !
       */
      async function executeSelectionOnPage(candidates) {
        let pageCandidates = candidates.filter((c) => c.isSelected && c.onCurrentPage);

        // Si aucune carte n'est sur la page actuelle, tenter de basculer automatiquement sur la rareté
        if (!pageCandidates.length) {
          const selectedCandidates = candidates.filter((c) => c.isSelected);
          if (!selectedCandidates.length) {
            showToast('Aucune carte sélectionnée.', 'warning');
            return 0;
          }

          const targetRarities = [...new Set(selectedCandidates.map((c) => c.rarity))];
          let switched = false;
          for (const r of targetRarities) {
            switched = filterWikiMastersPageByRarity(r);
            if (switched) {
              showToast(`Affichage des cartes ${r} sur la page…`, 'info');
              break;
            }
          }

          if (switched) {
            await new Promise((resolve) => setTimeout(resolve, 600));

            // Re-détection après le changement d'onglet
            for (const cand of candidates) {
              cand.domElements = findCardElements(cand.card);
              cand.onCurrentPage = cand.domElements.length > 0;
            }
            pageCandidates = candidates.filter((c) => c.isSelected && c.onCurrentPage);
          }
        }

        if (!pageCandidates.length) {
          showToast('Aucune carte ciblée n’est visible. Filtrez votre collection par rareté sur le site pour les afficher.', 'warning');
          return 0;
        }

        activateNativeSelectionMode();
        // Légère attente pour que le DOM active le mode sélection
        await new Promise((resolve) => setTimeout(resolve, 250));

        let selectedCount = 0;
        for (const candidate of pageCandidates) {
          const elements = candidate.domElements && candidate.domElements.length
            ? candidate.domElements
            : findCardElements(candidate.card);

          // Si l'utilisateur doit défausser N copies, on sélectionne jusqu'à N éléments
          const countToSelect = Math.min(candidate.discardCount, elements.length);
          for (let i = 0; i < countToSelect; i += 1) {
            selectCardElement(elements[i]);
            selectedCount += 1;
          }
        }

        const remainingTotal = candidates
          .filter((c) => c.isSelected && !c.onCurrentPage)
          .reduce((sum, c) => sum + c.discardCount, 0);

        if (remainingTotal > 0) {
          showToast(`${selectedCount} carte(s) cochée(s) sur cette page (${remainingTotal} restante(s) sur d'autres onglets) !`, 'success');
        } else {
          showToast(`${selectedCount} carte(s) cochée(s) sur la page !`, 'success');
        }

        return selectedCount;
      }

      /**
       * Sélectionne les cartes visibles et clique sur le bouton natif Défausser.
       */
      async function executeDiscardOnPage(candidates) {
        const count = await executeSelectionOnPage(candidates);
        if (count <= 0) return;

        // Attente pour que le bouton natif Défausser apparaisse ou s'active
        await new Promise((resolve) => setTimeout(resolve, 350));

        let nativeDiscardBtn = findNativeDiscardButton();
        if (!nativeDiscardBtn) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          nativeDiscardBtn = findNativeDiscardButton();
        }

        if (nativeDiscardBtn) {
          nativeDiscardBtn.click();
          showToast('Fenêtre de confirmation officielle ouverte !', 'info');
        } else {
          showToast(`${count} carte(s) sélectionnée(s). Cliquez sur « Défausser » en haut pour confirmer.`, 'info');
        }
      }

      /**
       * Défausse directe en masse via l'API officielle WikiMasters.
       * POST /api/user-cards/bulk-discard
       * Payload: { card_ids: [string, ...] }
       */
      async function executeDirectBulkDiscard(candidates, onProgress) {
        const activeCandidates = candidates.filter((c) => c.isSelected);
        if (!activeCandidates.length) {
          showToast('Aucune carte sélectionnée.', 'warning');
          return { success: false, discardedCount: 0 };
        }

        const totalCopies = activeCandidates.reduce((sum, c) => sum + c.discardCount, 0);

        const confirmMsg = `⚠️ Confirmation de défausse directe :
Voulez-vous vraiment défausser définitivement ${totalCopies} carte(s) pour un gain de +${totalCopies} WB ?

Cette action est irréversible.`;
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm(confirmMsg)) {
            return { success: false, cancelled: true };
          }
        }

        const cardIdsToDiscard = [];
        for (const cand of activeCandidates) {
          const ids = getDiscardCardIds(cand);
          cardIdsToDiscard.push(...ids);
        }

        if (cardIdsToDiscard.length === 0) {
          showToast('Impossible de défausser : aucun identifiant valide trouvé. Veuillez synchroniser votre collection.', 'warning');
          return { success: false, error: 'NO_IDS' };
        }

        showToast(`Défausse en cours de ${cardIdsToDiscard.length} carte(s)…`, 'info');

        const BATCH_SIZE = 100;
        let successCount = 0;
        const failedIds = [];
        const doFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : fetch;

        for (let i = 0; i < cardIdsToDiscard.length; i += BATCH_SIZE) {
          const batch = cardIdsToDiscard.slice(i, i + BATCH_SIZE);
          try {
            const res = await doFetch('/api/user-cards/bulk-discard', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              credentials: 'include',
              body: JSON.stringify({
                card_ids: batch
              })
            });

            if (res && (res.ok || res.status === 200)) {
              successCount += batch.length;
              onProgress?.(successCount, cardIdsToDiscard.length);
            } else {
              failedIds.push(...batch);
              console.error('[WM Discard] Erreur HTTP défausse directe', res?.status);
            }
          } catch (err) {
            failedIds.push(...batch);
            console.error('[WM Discard] Erreur réseau défausse directe', err);
          }
        }

        if (successCount > 0) {
          const successfulIds = cardIdsToDiscard.filter((id) => !failedIds.includes(id));
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('wm-average-cards-discarded', {
              detail: { cardIds: successfulIds }
            }));
          }

          applyDiscardedCardsToStorage(successfulIds);
          showToast(`${successCount} carte(s) défaussée(s) avec succès (+${successCount} WB) !`, 'success');
        }

        if (failedIds.length > 0) {
          showToast(`Erreur lors de la défausse de ${failedIds.length} carte(s).`, 'warning');
        }

        return {
          success: successCount > 0,
          discardedCount: successCount,
          failedCount: failedIds.length
        };
      }

      function openDiscardModal() {
        if (activeDiscardModal) {
          activeDiscardModal.remove();
          activeDiscardModal = null;
        }

        let { cards, isComplete, fetchedAt } = getKnownCollectionCards();
        if (!cards.length) {
          if (runtime.modalUi?.showInfoModal) {
            runtime.modalUi.showInfoModal(
              'Collection vide ou non chargée',
              'Aucune carte n’a été détectée dans ta collection. Ouvre la page Collection ou utilise « Charger les prix » avant de défausser.'
            );
          }
          return;
        }

        let { tagCounts, untaggedCount } = getTagsFromCards(cards);

        const computeRarityCounts = (cardsList) => {
          const counts = { C: 0, PC: 0, R: 0, SR: 0, UR: 0, L: 0 };
          for (const c of cardsList) {
            const r = c.rarity || 'C';
            counts[r] = (counts[r] || 0) + Math.max(1, Number(c.count) || 1);
          }
          return counts;
        };

        let currentRarityCounts = computeRarityCounts(cards);

        const overlay = document.createElement('div');
        overlay.id = 'wm-discard-overlay';
        overlay.className = 'wm-modal-overlay wm-discard-overlay';

        const modal = document.createElement('div');
        modal.className = 'wm-modal wm-discard-modal';

        // 1. En-tête
        const header = document.createElement('div');
        header.className = 'wm-discard-header';

        const headingWrap = document.createElement('div');
        const title = document.createElement('h2');
        title.textContent = 'Défausse par prix moyen';

        const subtitle = document.createElement('p');
        subtitle.textContent = 'Défausse automatiquement les cartes en dessous d’un prix en WB. (1 carte défaussée = 1 WB)';
        headingWrap.append(title, subtitle);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'wm-discard-close';
        closeBtn.textContent = '×';
        closeBtn.setAttribute('aria-label', 'Fermer');

        header.append(headingWrap, closeBtn);

        // 2. Corps
        const body = document.createElement('div');
        body.className = 'wm-discard-body';

        let buildTagChips = null;

        // Alerte si la collection n'est pas scannée complètement
        let syncNotice = null;
        if (!isComplete) {
          syncNotice = document.createElement('div');
          syncNotice.className = 'wm-discard-sync-notice';

          const syncText = document.createElement('div');
          syncText.className = 'wm-discard-sync-text';
          syncText.innerHTML = `<strong>Collection non synchronisée</strong> (${cards.length} titres en mémoire). Pour analyser l'ensemble de votre collection, lancez une synchronisation complète.`;

          const syncBtn = document.createElement('button');
          syncBtn.type = 'button';
          syncBtn.className = 'wm-tool-button wm-discard-sync-btn';
          syncBtn.textContent = isScanning ? 'Synchronisation…' : '⚡ Synchroniser la collection';
          syncBtn.disabled = isScanning;

          syncBtn.addEventListener('click', () => {
            syncBtn.disabled = true;
            syncBtn.textContent = 'Synchronisation…';
            startCollectionScan(
              (loaded, total) => {
                syncBtn.textContent = `Page ${loaded}/${total}…`;
              },
              (detail) => {
                if (detail?.ok) {
                  showToast('Collection synchronisée avec succès !', 'success');
                  const refreshed = getKnownCollectionCards();
                  cards = refreshed.cards;
                  isComplete = refreshed.isComplete;
                  currentRarityCounts = computeRarityCounts(cards);
                  const refreshedTags = getTagsFromCards(cards);
                  tagCounts = refreshedTags.tagCounts;
                  untaggedCount = refreshedTags.untaggedCount;
                  buildTagChips?.();
                  syncNotice?.remove();
                  syncNotice = null;
                  updateRarityChips();
                  refreshPreview();
                } else {
                  syncBtn.disabled = false;
                  syncBtn.textContent = 'Erreur synchronisation';
                  showToast('Erreur lors de la synchronisation de la collection.', 'warning');
                }
              }
            );
          });

          syncNotice.append(syncText, syncBtn);
          body.prepend(syncNotice);
        }

        // Section Filtres
        const configCard = document.createElement('div');
        configCard.className = 'wm-discard-config-card';

        // A. Seuil de prix
        const priceSection = document.createElement('div');
        priceSection.className = 'wm-discard-config-row';

        const priceLabel = document.createElement('label');
        priceLabel.className = 'wm-discard-label';
        priceLabel.htmlFor = 'wm-discard-price-input';
        priceLabel.textContent = 'Prix moyen maximum :';

        const priceInputWrap = document.createElement('div');
        priceInputWrap.className = 'wm-discard-input-wrap';

        const priceInput = document.createElement('input');
        priceInput.id = 'wm-discard-price-input';
        priceInput.type = 'number';
        priceInput.min = '0';
        priceInput.max = '100000';
        priceInput.step = '1';
        priceInput.value = String(currentConfig.maxPrice);
        priceInput.className = 'wm-discard-number-input';

        const priceUnit = document.createElement('span');
        priceUnit.className = 'wm-discard-input-unit';
        priceUnit.textContent = 'WB';

        priceInputWrap.append(priceInput, priceUnit);

        const priceTip = document.createElement('p');
        priceTip.className = 'wm-discard-tip';
        priceTip.textContent = 'Toutes les cartes dont le prix moyen est inférieur ou égal à cette valeur seront ciblées.';

        priceSection.append(priceLabel, priceInputWrap, priceTip);

        // B. Filtre de raretés
        const raritySection = document.createElement('div');
        raritySection.className = 'wm-discard-config-row';

        const rarityLabelRow = document.createElement('div');
        rarityLabelRow.className = 'wm-discard-label-row';

        const rarityLabel = document.createElement('strong');
        rarityLabel.className = 'wm-discard-label';
        rarityLabel.textContent = 'Raretés autorisées à la défausse :';

        const presetsWrap = document.createElement('div');
        presetsWrap.className = 'wm-discard-presets';

        const createPresetBtn = (label, rarities) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'wm-tool-button wm-discard-preset-btn';
          btn.textContent = label;
          btn.addEventListener('click', () => {
            currentConfig.selectedRarities.clear();
            rarities.forEach((r) => currentConfig.selectedRarities.add(r));
            updateRarityChips();
            refreshPreview();
          });
          return btn;
        };

        const presetCommon = createPresetBtn('Communes (C, PC)', ['C', 'PC']);
        const presetRare = createPresetBtn('C, PC, R (Recommandé)', ['C', 'PC', 'R']);
        const presetAllSafe = createPresetBtn('Tout sauf L / UR', ['C', 'PC', 'R', 'SR']);
        presetsWrap.append(presetCommon, presetRare, presetAllSafe);

        rarityLabelRow.append(rarityLabel, presetsWrap);

        const rarityGrid = document.createElement('div');
        rarityGrid.className = 'wm-discard-rarity-grid';

        const rarityChips = new Map();

        const rarityNames = {
          C: 'Commune',
          PC: 'Peu Commune',
          R: 'Rare',
          SR: 'Super Rare',
          UR: 'Ultra Rare',
          L: 'Légendaire'
        };

        // Afficher de C vers L (du plus courant au plus précieux)
        const displayRarities = ['C', 'PC', 'R', 'SR', 'UR', 'L'];

        for (const rarity of displayRarities) {
          const chip = document.createElement('label');
          chip.className = `wm-discard-rarity-chip wm-rarity-${rarity.toLowerCase()}`;

          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = currentConfig.selectedRarities.has(rarity);

          const badge = document.createElement('span');
          badge.className = 'wm-rarity-pill';
          badge.textContent = rarity;

          const desc = document.createElement('span');
          desc.className = 'wm-rarity-name';
          desc.textContent = `${rarityNames[rarity] || rarity} (${currentRarityCounts[rarity] || 0})`;

          chip.append(checkbox, badge, desc);
          rarityGrid.append(chip);
          rarityChips.set(rarity, { chip, checkbox, desc });

          checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
              currentConfig.selectedRarities.add(rarity);
            } else {
              currentConfig.selectedRarities.delete(rarity);
            }
            updateRarityChips();
            refreshPreview();
          });
        }

        const updateRarityChips = () => {
          for (const [r, { chip, checkbox, desc }] of rarityChips) {
            checkbox.checked = currentConfig.selectedRarities.has(r);
            chip.classList.toggle('is-selected', checkbox.checked);
            if (desc) {
              desc.textContent = `${rarityNames[r] || r} (${currentRarityCounts[r] || 0})`;
            }
          }
          checkRarityWarnings();
        };

        const rarityWarningBox = document.createElement('div');
        rarityWarningBox.className = 'wm-discard-warning-box';

        const checkRarityWarnings = () => {
          const hasUR = currentConfig.selectedRarities.has('UR');
          const hasL = currentConfig.selectedRarities.has('L');
          const hasSR = currentConfig.selectedRarities.has('SR');

          rarityWarningBox.replaceChildren();

          if (hasL || hasUR) {
            rarityWarningBox.className = 'wm-discard-warning-box is-danger';
            rarityWarningBox.textContent = '⚠️ Attention : Vous avez sélectionné des raretés Légendaire (L) ou Ultra-Rare (UR). Assurez-vous vraiment de vouloir les défausser !';
          } else if (hasSR) {
            rarityWarningBox.className = 'wm-discard-warning-box is-warning';
            rarityWarningBox.textContent = '⚠️ Attention : Vous avez inclus la rareté Super Rare (SR).';
          } else {
            rarityWarningBox.className = 'wm-discard-warning-box is-hidden';
          }
        };

        raritySection.append(rarityLabelRow, rarityGrid, rarityWarningBox);

        // C. Filtre par étiquettes
        const tagSection = document.createElement('div');
        tagSection.className = 'wm-discard-config-row wm-discard-tag-section';

        const tagLabelRow = document.createElement('div');
        tagLabelRow.className = 'wm-discard-label-row';

        const tagLabel = document.createElement('strong');
        tagLabel.className = 'wm-discard-label';
        tagLabel.textContent = 'Étiquettes :';

        const tagPresetsWrap = document.createElement('div');
        tagPresetsWrap.className = 'wm-discard-presets';

        const tagPresetAll = document.createElement('button');
        tagPresetAll.type = 'button';
        tagPresetAll.className = 'wm-tool-button wm-discard-preset-btn';
        tagPresetAll.textContent = 'Toutes';

        const tagPresetUntagged = document.createElement('button');
        tagPresetUntagged.type = 'button';
        tagPresetUntagged.className = 'wm-tool-button wm-discard-preset-btn';
        tagPresetUntagged.textContent = '🏷️ Sans étiquette uniquement';

        const tagPresetTagged = document.createElement('button');
        tagPresetTagged.type = 'button';
        tagPresetTagged.className = 'wm-tool-button wm-discard-preset-btn';
        tagPresetTagged.textContent = '🏷️ Étiquetées uniquement';

        tagPresetsWrap.append(tagPresetAll, tagPresetUntagged, tagPresetTagged);
        tagLabelRow.append(tagLabel, tagPresetsWrap);

        const tagGrid = document.createElement('div');
        tagGrid.className = 'wm-discard-tag-grid';

        const tagChips = new Map();

        const updateTagChipsUi = () => {
          if (currentConfig.tagFilterMode === 'all') {
            for (const [, { chip, checkbox }] of tagChips) {
              checkbox.checked = true;
              chip.classList.add('is-selected');
            }
          } else if (currentConfig.tagFilterMode === 'untagged') {
            for (const [name, { chip, checkbox }] of tagChips) {
              const isUn = name === '__UNTAGGED__';
              checkbox.checked = isUn;
              chip.classList.toggle('is-selected', isUn);
            }
          } else if (currentConfig.tagFilterMode === 'tagged') {
            for (const [name, { chip, checkbox }] of tagChips) {
              const isTag = name !== '__UNTAGGED__';
              checkbox.checked = isTag;
              chip.classList.toggle('is-selected', isTag);
            }
          } else {
            // custom mode
            for (const [name, { chip, checkbox }] of tagChips) {
              const sel = currentConfig.selectedTags.has(name);
              checkbox.checked = sel;
              chip.classList.toggle('is-selected', sel);
            }
          }
        };

        buildTagChips = () => {
          tagGrid.replaceChildren();
          tagChips.clear();

          const untaggedChip = document.createElement('label');
          untaggedChip.className = 'wm-discard-tag-chip is-untagged';
          const untaggedCheckbox = document.createElement('input');
          untaggedCheckbox.type = 'checkbox';
          untaggedCheckbox.checked = currentConfig.tagFilterMode === 'all' || currentConfig.tagFilterMode === 'untagged' || currentConfig.selectedTags.has('__UNTAGGED__');
          const untaggedBadge = document.createElement('span');
          untaggedBadge.className = 'wm-discard-tag-chip-name';
          untaggedBadge.textContent = `🏷️ Sans étiquette (${untaggedCount})`;
          untaggedChip.append(untaggedCheckbox, untaggedBadge);
          tagGrid.append(untaggedChip);
          tagChips.set('__UNTAGGED__', { chip: untaggedChip, checkbox: untaggedCheckbox });

          const sortedTags = [...tagCounts.keys()].sort((a, b) => a.localeCompare(b, 'fr'));
          for (const tagName of sortedTags) {
            const count = tagCounts.get(tagName) || 0;
            const chip = document.createElement('label');
            chip.className = 'wm-discard-tag-chip';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = currentConfig.tagFilterMode === 'all' || currentConfig.tagFilterMode === 'tagged' || currentConfig.selectedTags.has(tagName);
            const badge = document.createElement('span');
            badge.className = 'wm-discard-tag-chip-name';
            badge.textContent = `🏷️ ${tagName} (${count})`;
            chip.append(checkbox, badge);
            tagGrid.append(chip);
            tagChips.set(tagName, { chip, checkbox });
          }

          for (const [tagName, { checkbox }] of tagChips) {
            checkbox.addEventListener('change', () => {
              currentConfig.tagFilterMode = 'custom';
              if (checkbox.checked) {
                currentConfig.selectedTags.add(tagName);
              } else {
                currentConfig.selectedTags.delete(tagName);
              }
              updateTagChipsUi();
              refreshPreview();
            });
          }

          updateTagChipsUi();
        };

        tagPresetAll.addEventListener('click', () => {
          currentConfig.tagFilterMode = 'all';
          currentConfig.selectedTags.clear();
          for (const key of tagChips.keys()) currentConfig.selectedTags.add(key);
          updateTagChipsUi();
          refreshPreview();
        });

        tagPresetUntagged.addEventListener('click', () => {
          currentConfig.tagFilterMode = 'untagged';
          currentConfig.selectedTags.clear();
          currentConfig.selectedTags.add('__UNTAGGED__');
          updateTagChipsUi();
          refreshPreview();
        });

        tagPresetTagged.addEventListener('click', () => {
          currentConfig.tagFilterMode = 'tagged';
          currentConfig.selectedTags.clear();
          for (const key of tagChips.keys()) {
            if (key !== '__UNTAGGED__') currentConfig.selectedTags.add(key);
          }
          updateTagChipsUi();
          refreshPreview();
        });

        buildTagChips();
        tagSection.append(tagLabelRow, tagGrid);

        // D. Options de sécurité
        const safetySection = document.createElement('div');
        safetySection.className = 'wm-discard-safety-section';

        // Option 1 : Conserver au moins 1 exemplaire
        const keepOption = document.createElement('label');
        keepOption.className = 'wm-missing-option wm-discard-option is-selected';

        const keepInput = document.createElement('input');
        keepInput.type = 'checkbox';
        keepInput.checked = currentConfig.keepAtLeastOne;

        const keepText = document.createElement('span');
        keepText.className = 'wm-missing-text';

        const keepTitle = document.createElement('strong');
        keepTitle.textContent = 'Conserver au moins 1 exemplaire (doublons uniquement)';

        const keepDesc = document.createElement('span');
        keepDesc.textContent = 'Recommandé : Vos cartes uniques ne seront jamais défaussées. Seuls vos doubles supplémentaires sont ciblés.';

        keepText.append(keepTitle, keepDesc);
        keepOption.append(keepInput, keepText);

        const keepWarning = document.createElement('div');
        keepWarning.className = 'wm-discard-warning-box is-danger is-hidden';
        keepWarning.textContent = '⚠️ Danger : En décochant cette option, même vos exemplaires uniques de cartes seront définitivement défaussés !';

        keepInput.addEventListener('change', () => {
          currentConfig.keepAtLeastOne = keepInput.checked;
          keepOption.classList.toggle('is-selected', currentConfig.keepAtLeastOne);
          keepWarning.classList.toggle('is-hidden', currentConfig.keepAtLeastOne);
          refreshPreview();
        });

        // Option 2 : Ignorer les cartes sans prix moyen
        const unpricedOption = document.createElement('label');
        unpricedOption.className = 'wm-missing-option wm-discard-option is-selected';

        const unpricedInput = document.createElement('input');
        unpricedInput.type = 'checkbox';
        unpricedInput.checked = currentConfig.ignoreUnpriced;

        const unpricedText = document.createElement('span');
        unpricedText.className = 'wm-missing-text';

        const unpricedTitle = document.createElement('strong');
        unpricedTitle.textContent = 'Ignorer les cartes sans prix moyen connu';

        const unpricedDesc = document.createElement('span');
        unpricedDesc.textContent = 'Protège les cartes dont la cote n’est pas encore disponible en cache afin d’éviter de jeter des cartes de valeur par mégarde.';

        unpricedText.append(unpricedTitle, unpricedDesc);
        unpricedOption.append(unpricedInput, unpricedText);

        unpricedInput.addEventListener('change', () => {
          currentConfig.ignoreUnpriced = unpricedInput.checked;
          unpricedOption.classList.toggle('is-selected', currentConfig.ignoreUnpriced);
          refreshPreview();
        });

        const unpricedNotice = document.createElement('div');
        unpricedNotice.className = 'wm-discard-unpriced-notice is-hidden';

        const unpricedNoticeText = document.createElement('div');
        unpricedNoticeText.className = 'wm-discard-unpriced-text';

        const unpricedActions = document.createElement('div');
        unpricedActions.className = 'wm-discard-unpriced-actions';

        const loadPricesBtn = document.createElement('button');
        loadPricesBtn.type = 'button';
        loadPricesBtn.className = 'wm-tool-button wm-secondary-button';
        loadPricesBtn.textContent = '⚡ Charger les prix manquants';

        const includeUnpricedBtn = document.createElement('button');
        includeUnpricedBtn.type = 'button';
        includeUnpricedBtn.className = 'wm-tool-button wm-secondary-button';
        includeUnpricedBtn.textContent = 'Inclure sans prix';

        unpricedActions.append(loadPricesBtn, includeUnpricedBtn);
        unpricedNotice.append(unpricedNoticeText, unpricedActions);

        safetySection.append(keepOption, keepWarning, unpricedOption, unpricedNotice);

        configCard.append(priceSection, raritySection, tagSection, safetySection);

        // 3. Barre de statistiques en direct & actions de prévisualisation
        const statsBar = document.createElement('div');
        statsBar.className = 'wm-discard-stats-bar';

        const statsText = document.createElement('div');
        statsText.className = 'wm-discard-stats-text';

        const statsCount = document.createElement('strong');
        statsCount.textContent = '0 carte à défausser';

        const statsGain = document.createElement('span');
        statsGain.className = 'wm-discard-wb-gain';
        statsGain.textContent = 'Gain : 0 WB';

        const statsPage = document.createElement('span');
        statsPage.className = 'wm-discard-page-count';
        statsPage.textContent = '(0 sur la page)';

        statsText.append(statsCount, statsGain, statsPage);

        const listControls = document.createElement('div');
        listControls.className = 'wm-discard-list-controls';

        const toggleAllBtn = document.createElement('button');
        toggleAllBtn.type = 'button';
        toggleAllBtn.className = 'wm-tool-button wm-secondary-button';
        toggleAllBtn.textContent = 'Tout désélectionner';

        listControls.append(toggleAllBtn);
        statsBar.append(statsText, listControls);

        // 4. Liste de prévisualisation
        const previewWrap = document.createElement('div');
        previewWrap.className = 'wm-discard-preview-wrap';

        const previewList = document.createElement('div');
        previewList.className = 'wm-discard-card-list';

        previewWrap.append(previewList);

        // Assemblage du corps de la modale
        body.append(configCard, statsBar, previewWrap);

        // 5. Pied de page (Footer)
        const footer = document.createElement('div');
        footer.className = 'wm-discard-footer';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'wm-tool-button wm-secondary-button';
        cancelBtn.textContent = 'Annuler';

        const footerActions = document.createElement('div');
        footerActions.className = 'wm-discard-footer-actions';

        const selectPageBtn = document.createElement('button');
        selectPageBtn.type = 'button';
        selectPageBtn.className = 'wm-tool-button';
        selectPageBtn.textContent = 'Sélectionner sur la page (0)';

        const discardNowBtn = document.createElement('button');
        discardNowBtn.type = 'button';
        discardNowBtn.className = 'wm-tool-button wm-secondary-button';
        discardNowBtn.textContent = 'Défausser sur la page (0)';

        const bulkDiscardBtn = document.createElement('button');
        bulkDiscardBtn.type = 'button';
        bulkDiscardBtn.className = 'wm-tool-button wm-danger-button wm-discard-bulk-btn';
        bulkDiscardBtn.textContent = '⚡ Défausser tout (0)';

        footerActions.append(selectPageBtn, discardNowBtn, bulkDiscardBtn);
        footer.append(cancelBtn, footerActions);

        const updateFooterButtons = (totalCount, pageCount) => {
          const hasTotal = totalCount > 0;
          const hasPage = pageCount > 0;

          selectPageBtn.disabled = !hasTotal;
          discardNowBtn.disabled = !hasTotal;
          bulkDiscardBtn.disabled = !hasTotal;

          if (hasPage) {
            selectPageBtn.textContent = `Sélectionner sur cette page (${pageCount})`;
            discardNowBtn.textContent = `Défausser sur cette page (${pageCount})`;
          } else if (hasTotal) {
            selectPageBtn.textContent = `Aller aux cartes & Sélectionner (${totalCount})`;
            discardNowBtn.textContent = `Aller aux cartes & Défausser (${totalCount})`;
          } else {
            selectPageBtn.textContent = 'Sélectionner sur la page (0)';
            discardNowBtn.textContent = 'Défausser sur la page (0)';
          }

          bulkDiscardBtn.textContent = `⚡ Défausser tout (${totalCount})`;
        };

        // Logique de rafraîchissement dynamique du tableau
        let currentCandidates = [];

        function refreshPreview() {
          currentCandidates = computeDiscardCandidates(cards, currentConfig, getCardAveragePrice);

          // Calcul des cartes sans prix dans les raretés sélectionnées
          const unpricedList = [];
          let unpricedCopies = 0;

          for (const card of cards) {
            const rarity = card.rarity || 'C';
            if (!currentConfig.selectedRarities.has(rarity)) continue;
            if (currentConfig.searchQuery && !normalizeTitle(card.title).toLowerCase().includes(currentConfig.searchQuery)) continue;

            const cardTags = Array.isArray(card.tags) ? card.tags : normalizeTags(card.tags || card.labels);
            const isUntagged = cardTags.length === 0;
            if (currentConfig.tagFilterMode === 'untagged') {
              if (!isUntagged) continue;
            } else if (currentConfig.tagFilterMode === 'tagged') {
              if (isUntagged) continue;
            } else if (currentConfig.tagFilterMode === 'custom' && currentConfig.selectedTags) {
              if (isUntagged) {
                if (!currentConfig.selectedTags.has('__UNTAGGED__')) continue;
              } else {
                if (!cardTags.some((t) => currentConfig.selectedTags.has(t))) continue;
              }
            }

            const owned = Math.max(1, Number(card.count) || 1);
            const discardable = currentConfig.keepAtLeastOne ? Math.max(0, owned - 1) : owned;
            if (discardable <= 0) continue;

            const avg = getCardAveragePrice(card);
            if (avg == null) {
              unpricedList.push(card);
              unpricedCopies += discardable;
            }
          }

          if (currentConfig.ignoreUnpriced && unpricedList.length > 0) {
            unpricedNotice.classList.remove('is-hidden');
            unpricedNoticeText.innerHTML = `<span>ℹ️ <strong>${unpricedList.length} carte(s)</strong> (${unpricedCopies} exemplaire(s)) dans les raretés cochées sont ignorées car leur cote moyenne n'est pas encore en cache.</span>`;

            loadPricesBtn.disabled = false;
            loadPricesBtn.textContent = '⚡ Charger les prix manquants';
            loadPricesBtn.onclick = () => {
              loadPricesBtn.disabled = true;
              loadPricesBtn.textContent = 'Chargement en cours…';
              loadMissingPrices(unpricedList);
              showToast(`Chargement des prix lancé pour ${unpricedList.length} cartes…`, 'info');
            };

            includeUnpricedBtn.onclick = () => {
              currentConfig.ignoreUnpriced = false;
              unpricedInput.checked = false;
              unpricedOption.classList.remove('is-selected');
              refreshPreview();
            };
          } else {
            unpricedNotice.classList.add('is-hidden');
          }

          // Calcul des statistiques
          const activeCandidates = currentCandidates.filter((c) => c.isSelected);
          let totalDiscardCount = 0;
          let pageDiscardCount = 0;

          for (const cand of activeCandidates) {
            totalDiscardCount += cand.discardCount;
            if (cand.onCurrentPage) {
              pageDiscardCount += cand.discardCount;
            }
          }

          statsCount.textContent = `${totalDiscardCount} exemplaire(s) ciblé(s) (${activeCandidates.length} titre(s))`;
          statsGain.textContent = `Gain : +${totalDiscardCount} WB`;
          statsPage.textContent = `• ${pageDiscardCount} exemplaire(s) sur la page actuelle`;

          updateFooterButtons(totalDiscardCount, pageDiscardCount);

          // Mise à jour de l'état du bouton "Tout désélectionner / Tout sélectionner"
          const allSelected = activeCandidates.length === currentCandidates.length && currentCandidates.length > 0;
          toggleAllBtn.textContent = allSelected ? 'Tout désélectionner' : 'Tout sélectionner';

          // Rendu des cartes dans la liste
          previewList.replaceChildren();

          if (!currentCandidates.length) {
            const emptyNotice = document.createElement('div');
            emptyNotice.className = 'wm-discard-empty';
            emptyNotice.textContent = 'Aucune carte ne correspond à ces critères dans votre collection.';
            previewList.append(emptyNotice);
            return;
          }

          const fragment = typeof document.createDocumentFragment === 'function'
            ? document.createDocumentFragment()
            : { append: (...items) => previewList.append(...items) };

          for (const candidate of currentCandidates) {
            const row = document.createElement('div');
            row.className = `wm-discard-card-row wm-rarity-${candidate.rarity.toLowerCase()}`;
            if (!candidate.isSelected) row.classList.add('is-unselected');

            // Case à cocher individuelle
            const checkWrap = document.createElement('label');
            checkWrap.className = 'wm-discard-row-check';
            const rowCheckbox = document.createElement('input');
            rowCheckbox.type = 'checkbox';
            rowCheckbox.checked = candidate.isSelected;
            checkWrap.append(rowCheckbox);

            // Miniature image
            const thumb = document.createElement('div');
            thumb.className = 'wm-discard-row-thumb';
            if (candidate.imageUrl) {
              const img = document.createElement('img');
              img.src = candidate.imageUrl;
              img.alt = candidate.title;
              img.loading = 'lazy';
              img.onerror = () => {
                img.remove();
                thumb.textContent = '🃏';
              };
              thumb.append(img);
            } else {
              thumb.textContent = '🃏';
            }

            // Informations de la carte
            const info = document.createElement('div');
            info.className = 'wm-discard-row-info';

            const titleText = document.createElement('strong');
            titleText.className = 'wm-discard-row-title';
            titleText.textContent = candidate.title;

            const badgesWrap = document.createElement('div');
            badgesWrap.className = 'wm-discard-row-badges';

            const rarityBadge = document.createElement('span');
            rarityBadge.className = `wm-rarity-pill wm-rarity-${candidate.rarity.toLowerCase()}`;
            rarityBadge.textContent = candidate.rarity;

            const priceBadge = document.createElement('span');
            priceBadge.className = 'wm-discard-row-price';
            if (candidate.average != null) {
              priceBadge.textContent = `Moy. ${formatAverage(candidate.average)} W`;
            } else {
              priceBadge.textContent = 'Moy. —';
              priceBadge.classList.add('is-unpriced');
            }

            badgesWrap.append(rarityBadge, priceBadge);

            if (Array.isArray(candidate.tags) && candidate.tags.length > 0) {
              for (const tag of candidate.tags) {
                const tagBadge = document.createElement('span');
                tagBadge.className = 'wm-discard-tag-badge';
                tagBadge.textContent = `🏷️ ${tag}`;
                badgesWrap.append(tagBadge);
              }
            } else {
              const untaggedBadge = document.createElement('span');
              untaggedBadge.className = 'wm-discard-tag-badge is-untagged';
              untaggedBadge.textContent = 'Sans étiquette';
              badgesWrap.append(untaggedBadge);
            }

            if (candidate.onCurrentPage) {
              const pageBadge = document.createElement('span');
              pageBadge.className = 'wm-discard-page-badge';
              pageBadge.textContent = 'Sur la page';
              badgesWrap.append(pageBadge);
            }

            info.append(titleText, badgesWrap);

            // Quantité & Gain
            const countsWrap = document.createElement('div');
            countsWrap.className = 'wm-discard-row-counts';

            const countDetail = document.createElement('span');
            countDetail.className = 'wm-discard-count-detail';
            if (candidate.ownedCount > 1) {
              countDetail.textContent = `${candidate.discardCount} à défausser (${candidate.ownedCount} poss.)`;
            } else {
              countDetail.textContent = '1 exemplaire';
            }

            const gainBadge = document.createElement('strong');
            gainBadge.className = 'wm-discard-gain-badge';
            gainBadge.textContent = `+${candidate.discardCount} WB`;

            countsWrap.append(countDetail, gainBadge);

            // Gestion du clic pour cocher/décocher
            rowCheckbox.addEventListener('change', () => {
              if (rowCheckbox.checked) {
                currentConfig.excludedCardIds.delete(candidate.id);
              } else {
                currentConfig.excludedCardIds.add(candidate.id);
              }
              candidate.isSelected = rowCheckbox.checked;
              row.classList.toggle('is-unselected', !rowCheckbox.checked);

              // Mise à jour rapide des compteurs sans tout re-rendre
              const nowActive = currentCandidates.filter((c) => c.isSelected);
              let newTotal = 0;
              let newPage = 0;
              for (const cand of nowActive) {
                newTotal += cand.discardCount;
                if (cand.onCurrentPage) newPage += cand.discardCount;
              }
              statsCount.textContent = `${newTotal} exemplaire(s) ciblé(s) (${nowActive.length} titre(s))`;
              statsGain.textContent = `Gain : +${newTotal} WB`;
              statsPage.textContent = `• ${newPage} exemplaire(s) sur la page actuelle`;
              updateFooterButtons(newTotal, newPage);
            });

            row.append(checkWrap, thumb, info, countsWrap);
            fragment.append(row);
          }

          previewList.append(fragment);
        }

        // Écouteurs d'événements
        priceInput.addEventListener('input', () => {
          const val = Number(priceInput.value);
          currentConfig.maxPrice = Number.isFinite(val) ? Math.max(0, val) : 10;
          refreshPreview();
        });

        toggleAllBtn.addEventListener('click', () => {
          const anyActive = currentCandidates.some((c) => c.isSelected);
          if (anyActive) {
            // Tout désélectionner
            for (const cand of currentCandidates) {
              currentConfig.excludedCardIds.add(cand.id);
              cand.isSelected = false;
            }
          } else {
            // Tout sélectionner
            currentConfig.excludedCardIds.clear();
            for (const cand of currentCandidates) {
              cand.isSelected = true;
            }
          }
          refreshPreview();
        });

        const close = () => {
          overlay.remove();
          activeDiscardModal = null;
          activeDiscardModalRefresh = null;
        };

        closeBtn.addEventListener('click', close);
        cancelBtn.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) close();
        });

        selectPageBtn.addEventListener('click', async () => {
          close();
          await executeSelectionOnPage(currentCandidates);
        });

        discardNowBtn.addEventListener('click', async () => {
          close();
          await executeDiscardOnPage(currentCandidates);
        });

        bulkDiscardBtn.addEventListener('click', async () => {
          bulkDiscardBtn.disabled = true;
          bulkDiscardBtn.textContent = 'Défausse en cours…';
          try {
            const result = await executeDirectBulkDiscard(currentCandidates);
            if (result && result.success) {
              const refreshed = getKnownCollectionCards();
              cards = refreshed.cards;
              isComplete = refreshed.isComplete;
              currentRarityCounts = computeRarityCounts(cards);
              const refreshedTags = getTagsFromCards(cards);
              tagCounts = refreshedTags.tagCounts;
              untaggedCount = refreshedTags.untaggedCount;
              buildTagChips?.();
              updateRarityChips();
              refreshPreview();
              if (result.discardedCount >= totalDiscardCount) {
                close();
              }
            } else {
              refreshPreview();
            }
          } catch (e) {
            console.error('[WM Discard] Erreur lors de la défausse en masse', e);
            refreshPreview();
          }
        });

        // Initialisation de l'affichage
        updateRarityChips();
        refreshPreview();

        modal.append(header, body, footer);
        overlay.append(modal);
        document.body.append(overlay);
        activeDiscardModal = overlay;
        activeDiscardModalRefresh = refreshPreview;
      }

      function ensureToolbarButton() {
        if (!isCollectionPage() || !runtime.settings.isEnabled('discardByPrice')) {
          document.querySelectorAll('#wm-discard-button, [data-wm-discard-button], .wm-discard-button').forEach((b) => b.remove());
          discardButton = null;
          return;
        }

        const bar = document.getElementById('wm-tools-bar');
        if (!bar) return;

        // Nettoyage immédiat de tout doublon potentiel
        const existing = [...bar.querySelectorAll('#wm-discard-button, [data-wm-discard-button], .wm-discard-button')];
        for (const btn of bar.querySelectorAll('button')) {
          if (btn.textContent.trim().startsWith('Défausse') && !existing.includes(btn)) {
            existing.push(btn);
          }
        }

        if (existing.length > 1) {
          for (let i = 1; i < existing.length; i += 1) {
            existing[i].remove();
          }
        }

        if (existing.length > 0) {
          discardButton = existing[0];
          discardButton.id = 'wm-discard-button';
          discardButton.dataset.wmDiscardButton = '1';
          if (!discardButton.classList.contains('wm-discard-button')) {
            discardButton.classList.add('wm-discard-button');
          }
          return;
        }

        discardButton = document.createElement('button');
        discardButton.id = 'wm-discard-button';
        discardButton.dataset.wmDiscardButton = '1';
        discardButton.type = 'button';
        discardButton.className = 'wm-tool-button wm-discard-button';
        discardButton.textContent = 'Défausse par prix';
        discardButton.title = 'Défausser en masse les cartes sous un seuil de prix en WB';

        discardButton.addEventListener('click', () => {
          try {
            openDiscardModal();
          } catch (error) {
            reportError('modal défausse', error);
          }
        });

        // Insertion harmonieuse : après Cartes GIF ou avant Compact / Sponsor
        const gifBtn = bar.querySelector('#wm-gif-button, [data-wm-gif-button]');
        const compactBtn = bar.querySelector('[data-wm-compact-button]');
        const sponsor = bar.querySelector('.wm-sponsor-note');

        if (gifBtn && gifBtn.nextSibling) {
          bar.insertBefore(discardButton, gifBtn.nextSibling);
        } else if (compactBtn) {
          bar.insertBefore(discardButton, compactBtn);
        } else if (sponsor) {
          bar.insertBefore(discardButton, sponsor);
        } else {
          bar.append(discardButton);
        }
      }

      return {
        computeDiscardCandidates,
        getKnownCollectionCards,
        findNativeSelectButton,
        findNativeDiscardButton,
        isCardElementSelected,
        findCardElements,
        selectCardElement,
        activateNativeSelectionMode,
        filterWikiMastersPageByRarity,
        executeSelectionOnPage,
        executeDiscardOnPage,
        executeDirectBulkDiscard,
        getDiscardCardIds,
        resolveCardUuids,
        getTagsFromCards,
        normalizeTags,
        extractTagsFromCardElement,
        applyDiscardedCardsToStorage,
        openDiscardModal,
        ensureToolbarButton,
        onPriceUpdated,
        startCollectionScan,
        loadMissingPrices
      };
    }
  };

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('wm-average-cards-discarded', (event) => {
      const cardIds = event.detail?.cardIds;
      if (Array.isArray(cardIds) && cardIds.length > 0) {
        try {
          const core = window.__wmAverageBridgeRuntime?.core || global.__wmAverageBridgeRuntime?.core;
          const storageGet = core?.storageGet;
          const storageSet = core?.storageSet;
          const ALL_COLLECTION_KEY = core?.ALL_COLLECTION_KEY || 'wm_all_collection_v1';
          if (!storageGet || !storageSet) return;

          const stored = storageGet(ALL_COLLECTION_KEY) || {};
          const entry = stored[ALL_COLLECTION_KEY];
          if (!entry || !Array.isArray(entry.cards)) return;

          const idSet = new Set(cardIds);
          const updatedCards = [];
          for (const card of entry.cards) {
            let discardedCopies = 0;
            if (Array.isArray(card.ownedCardIds)) {
              const prevLen = card.ownedCardIds.length;
              card.ownedCardIds = card.ownedCardIds.filter((id) => !idSet.has(id));
              discardedCopies = prevLen - card.ownedCardIds.length;
            }
            if (idSet.has(card.ownedCardId)) {
              if (discardedCopies === 0) discardedCopies = 1;
              card.ownedCardId = card.ownedCardIds?.[0] || null;
            }
            if (idSet.has(card.id)) {
              if (discardedCopies === 0) discardedCopies = 1;
            }

            const currentCount = Math.max(0, Number(card.count) || 1);
            const newCount = Math.max(0, currentCount - discardedCopies);
            if (newCount > 0) {
              card.count = newCount;
              updatedCards.push(card);
            }
          }

          entry.cards = updatedCards;
          storageSet({
            [ALL_COLLECTION_KEY]: entry
          });
        } catch (_) {}
      }
    });
  }
})();
