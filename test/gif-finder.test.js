const test = require('node:test');
const assert = require('node:assert/strict');

// Setup minimal browser-like environment for feature testing
global.window = global;
global.__wmAverageFeatures = {};

require('../features/gif-finder.js');
const gifFinderModule = global.__wmAverageFeatures.gifFinder;

test('gifFinder URL detection and animation extraction', async (t) => {
  const fakeRuntime = {
    core: {
      ALL_COLLECTION_KEY: 'wm_all_collection_v1',
      RARITIES: ['L', 'UR', 'SR', 'R', 'PC', 'C'],
      cardMetaById: new Map(),
      idByTitle: new Map(),
      isCollectionPage: () => true,
      normalizeTitle: (s) => String(s || '').trim(),
      readLocalValue: () => null,
      storageGet: () => ({}),
      MISSING_IMAGE_CACHE_PREFIX: 'wm_missing_img_v2_',
      cacheKey: (id) => `wm_avg_v3_${id}`
    },
    priceUi: {
      chooseAverage: () => 100,
      formatAverage: (val) => String(val)
    },
    settings: {
      isEnabled: () => true
    }
  };

  const gifFinder = gifFinderModule.create(fakeRuntime);

  await t.test('isGifUrl accurately detects GIF files across various formats', () => {
    // Direct GIF extensions
    assert.strictEqual(gifFinder.isGifUrl('https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth.gif'), true);
    assert.strictEqual(gifFinder.isGifUrl('https://example.com/animations/fire.GIF'), true);
    assert.strictEqual(gifFinder.isGifUrl('https://example.com/cards/123.gif?width=300&version=2'), true);
    assert.strictEqual(gifFinder.isGifUrl('https://example.com/cards/123.gif#preview'), true);

    // Data URIs
    assert.strictEqual(gifFinder.isGifUrl('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), true);

    // Wikimedia thumbnail URLs of animated GIFs
    assert.strictEqual(
      gifFinder.isGifUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Rotating_earth.gif/400px-Rotating_earth.gif.png'),
      true
    );
    assert.strictEqual(
      gifFinder.isGifUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Cat_jumping.gif/320px-Cat_jumping.gif'),
      true
    );

    // Negative tests - non-GIF images
    assert.strictEqual(gifFinder.isGifUrl('https://example.com/cards/charizard.png'), false);
    assert.strictEqual(gifFinder.isGifUrl('https://example.com/cards/charizard.jpg'), false);
    assert.strictEqual(gifFinder.isGifUrl('https://example.com/cards/charizard.webp'), false);
    assert.strictEqual(gifFinder.isGifUrl('https://example.com/gift/banner.jpg'), false);
    assert.strictEqual(gifFinder.isGifUrl(''), false);
    assert.strictEqual(gifFinder.isGifUrl(null), false);
    assert.strictEqual(gifFinder.isGifUrl(undefined), false);
  });

  await t.test('getAnimatedGifUrl converts Wikimedia thumbnail URLs to animated full GIFs', () => {
    const wmThumb = 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Rotating_earth.gif/400px-Rotating_earth.gif.png';
    const expectedFullGif = 'https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth.gif';
    assert.strictEqual(gifFinder.getAnimatedGifUrl(wmThumb), expectedFullGif);

    // Direct GIF is left unchanged
    const directUrl = 'https://example.com/animation.gif';
    assert.strictEqual(gifFinder.getAnimatedGifUrl(directUrl), directUrl);
  });

  await t.test('isCardGif identifies cards with GIF images from card properties', () => {
    assert.strictEqual(gifFinder.isCardGif({ title: 'Terre', imageUrl: 'https://example.com/earth.gif' }), true);
    assert.strictEqual(gifFinder.isCardGif({ title: 'Feu', image_url: 'https://example.com/fire.GIF' }), true);
    assert.strictEqual(gifFinder.isCardGif({ title: 'Eau', imageUrl: 'https://example.com/water.png' }), false);
    assert.strictEqual(gifFinder.isCardGif(null), false);
  });

  await t.test('findCardElement locates corresponding card in DOM', () => {
    const fakeCard = {
      classList: { add: () => {}, remove: () => {} },
      scrollIntoView: () => {},
      click: () => {}
    };

    global.document = {
      querySelectorAll: (sel) => {
        if (sel === 'h3') {
          return [
            {
              textContent: 'Albert Einstein',
              closest: (c) => fakeCard
            }
          ];
        }
        return [];
      }
    };

    assert.strictEqual(gifFinder.findCardElement({ title: 'Albert Einstein' }), fakeCard);
    assert.strictEqual(gifFinder.findCardElement({ title: 'Inconnue' }), null);
  });
});

test('gifFinder price resolution, status calculation and loader triggers', async (t) => {
  const cacheMemory = new Map();
  const loadedCardsQueue = [];
  const pendingSet = new Set();

  const fakeRuntime = {
    core: {
      ALL_COLLECTION_KEY: 'wm_all_collection_v1',
      RARITIES: ['L', 'UR', 'SR', 'R', 'PC', 'C'],
      cardMetaById: new Map([
        ['card-1', { id: 'card-1', title: 'Planète Bleue', rarity: 'UR' }],
        ['card-2', { id: 'card-2', title: 'Soleil Ardent', rarity: 'L' }]
      ]),
      idByTitle: new Map([
        ['planete bleue', 'card-1'],
        ['soleil ardent', 'card-2']
      ]),
      isCollectionPage: () => true,
      normalizeTitle: (s) => String(s || '').trim().toLowerCase(),
      readLocalValue: () => null,
      storageGet: () => ({}),
      MISSING_IMAGE_CACHE_PREFIX: 'wm_missing_img_v2_',
      cacheKey: (id) => `wm_avg_v3_${id}`,
      cacheMemory,
      isCacheEntryValid: (entry) => Boolean(entry && (entry.ok !== false || Date.now() - entry.fetchedAt < 60000))
    },
    priceUi: {
      chooseAverage: (entry, _el, rarity) => {
        if (!entry || !entry.averages) return null;
        return entry.averages[rarity] ?? null;
      },
      formatAverage: (val) => String(val),
      getRarityFromCard: () => null
    },
    priceLoader: {
      isPending: (id) => pendingSet.has(id),
      loadCacheForCards: (cards) => {
        loadedCardsQueue.push(...cards);
        for (const c of cards) pendingSet.add(c.id);
      }
    },
    settings: {
      isEnabled: () => true
    }
  };

  const gifFinder = gifFinderModule.create(fakeRuntime);

  await t.test('getCardPriceInfo detects missing, loading, ready, error and empty states', () => {
    // 1. Missing: not in cache, not in pending
    const card1 = { id: 'card-1', title: 'Planète Bleue', rarity: 'UR' };
    assert.deepStrictEqual(gifFinder.getCardPriceInfo(card1), {
      status: 'missing',
      average: null,
      rawPrice: null
    });

    // 2. Loading: when marked as pending in priceLoader
    pendingSet.add('card-1');
    assert.deepStrictEqual(gifFinder.getCardPriceInfo(card1), {
      status: 'loading',
      average: null,
      rawPrice: null
    });
    pendingSet.delete('card-1');

    // 3. Ready: valid price entry with matching rarity average
    const validEntry = {
      ok: true,
      fetchedAt: Date.now(),
      averages: { UR: 1250 }
    };
    cacheMemory.set('card-1', validEntry);
    assert.deepStrictEqual(gifFinder.getCardPriceInfo(card1), {
      status: 'ready',
      average: 1250,
      rawPrice: validEntry
    });

    // 4. Empty: valid price entry but no sales for this card's rarity
    const emptyEntry = {
      ok: true,
      fetchedAt: Date.now(),
      averages: { L: 5000 }
    };
    cacheMemory.set('card-1', emptyEntry);
    assert.deepStrictEqual(gifFinder.getCardPriceInfo(card1), {
      status: 'empty',
      average: null,
      rawPrice: emptyEntry
    });

    // 5. Error: entry marked ok: false
    const errorEntry = {
      ok: false,
      fetchedAt: Date.now(),
      averages: {}
    };
    cacheMemory.set('card-1', errorEntry);
    assert.deepStrictEqual(gifFinder.getCardPriceInfo(card1), {
      status: 'error',
      average: null,
      rawPrice: errorEntry
    });

    // 6. No real ID
    const domCard = { id: 'dom-unknown', title: 'Inconnue' };
    assert.deepStrictEqual(gifFinder.getCardPriceInfo(domCard), {
      status: 'no_id',
      average: null,
      rawPrice: null
    });
  });

  await t.test('loadMissingPricesForGifCards requests prices only for uncached valid cards', () => {
    cacheMemory.clear();
    pendingSet.clear();
    loadedCardsQueue.length = 0;

    // card-1 is missing
    // card-2 is already in cache
    cacheMemory.set('card-2', { ok: true, fetchedAt: Date.now(), averages: { L: 2000 } });

    const cards = [
      { id: 'card-1', title: 'Planète Bleue', rarity: 'UR' },
      { id: 'card-2', title: 'Soleil Ardent', rarity: 'L' },
      { id: 'dom-unknown', title: 'Inconnue' }
    ];

    gifFinder.loadMissingPricesForGifCards(cards);

    assert.strictEqual(loadedCardsQueue.length, 1);
    assert.strictEqual(loadedCardsQueue[0].id, 'card-1');
  });

  await t.test('onPriceUpdated updates memory and resolves price without throwing', () => {
    cacheMemory.set('card-1', { ok: true, fetchedAt: Date.now(), averages: { UR: 3000 } });
    assert.doesNotThrow(() => {
      gifFinder.onPriceUpdated('card-1');
    });
  });
});

