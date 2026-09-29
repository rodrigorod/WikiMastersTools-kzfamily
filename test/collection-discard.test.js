const test = require('node:test');
const assert = require('node:assert/strict');

// Setup minimal browser-like environment for feature testing
global.window = global;
global.__wmAverageFeatures = {};

require('../features/collection-discard.js');
const collectionDiscardModule = global.__wmAverageFeatures.collectionDiscard;

test('collectionDiscard candidates computation and filtering rules', async (t) => {
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
      cacheKey: (id) => `wm_avg_v3_${id}`,
      cacheMemory: new Map(),
      isCacheEntryValid: () => true,
      reportError: () => {}
    },
    priceUi: {
      chooseAverage: () => 10,
      formatAverage: (val) => String(val),
      getRarityFromCard: () => 'C'
    },
    settings: {
      isEnabled: () => true
    }
  };

  const collectionDiscard = collectionDiscardModule.create(fakeRuntime);

  const sampleCards = [
    { id: 'c1', title: 'Tour Eiffel', rarity: 'C', count: 3 }, // Common, 3 copies
    { id: 'c2', title: 'Pomme', rarity: 'C', count: 1 },        // Common, 1 copy
    { id: 'pc1', title: 'Arc de Triomphe', rarity: 'PC', count: 2 }, // PC, 2 copies
    { id: 'r1', title: 'Notre-Dame', rarity: 'R', count: 4 },   // Rare, 4 copies
    { id: 'sr1', title: 'Château de Versailles', rarity: 'SR', count: 2 }, // SR, 2 copies
    { id: 'ur1', title: 'Mona Lisa', rarity: 'UR', count: 2 },  // UR, 2 copies
    { id: 'l1', title: 'Épée Excalibur', rarity: 'L', count: 2 }, // L, 2 copies
    { id: 'unpriced1', title: 'Carte Inconnue', rarity: 'C', count: 2 } // No price
  ];

  const priceMap = {
    c1: 5,
    c2: 2,
    pc1: 8,
    r1: 15,
    sr1: 25,
    ur1: 45,
    l1: 120,
    unpriced1: null
  };

  const priceResolver = (card) => priceMap[card.id] ?? null;

  await t.test('filters cards below price threshold with default settings', () => {
    // maxPrice = 10, selectedRarities = ['C', 'PC', 'R'], keepAtLeastOne = true, ignoreUnpriced = true
    const candidates = collectionDiscard.computeDiscardCandidates(sampleCards, {
      maxPrice: 10,
      selectedRarities: new Set(['C', 'PC', 'R']),
      keepAtLeastOne: true,
      ignoreUnpriced: true
    }, priceResolver);

    // Expected matches:
    // - c1 (C, count 3, price 5 <= 10 -> discard 2 copies)
    // - pc1 (PC, count 2, price 8 <= 10 -> discard 1 copy)
    // Non-matches:
    // - c2 (count 1 -> discard 0, kept)
    // - r1 (price 15 > 10)
    // - sr1, ur1, l1 (rarity excluded)
    // - unpriced1 (price null ignored)
    assert.strictEqual(candidates.length, 2);

    const c1Match = candidates.find((c) => c.id === 'c1');
    assert.ok(c1Match);
    assert.strictEqual(c1Match.discardCount, 2);
    assert.strictEqual(c1Match.average, 5);

    const pc1Match = candidates.find((c) => c.id === 'pc1');
    assert.ok(pc1Match);
    assert.strictEqual(pc1Match.discardCount, 1);
    assert.strictEqual(pc1Match.average, 8);
  });

  await t.test('includes higher price cards when threshold is raised', () => {
    const candidates = collectionDiscard.computeDiscardCandidates(sampleCards, {
      maxPrice: 20,
      selectedRarities: new Set(['C', 'PC', 'R']),
      keepAtLeastOne: true,
      ignoreUnpriced: true
    }, priceResolver);

    // r1 has price 15 <= 20, count 4 -> discard 3
    const r1Match = candidates.find((c) => c.id === 'r1');
    assert.ok(r1Match);
    assert.strictEqual(r1Match.discardCount, 3);
  });

  await t.test('excludes rarities when not selected', () => {
    const candidates = collectionDiscard.computeDiscardCandidates(sampleCards, {
      maxPrice: 50,
      selectedRarities: new Set(['C']), // only C
      keepAtLeastOne: true,
      ignoreUnpriced: true
    }, priceResolver);

    // Only c1 should match, pc1, r1, sr1 etc. are excluded
    assert.strictEqual(candidates.every((c) => c.rarity === 'C'), true);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].id, 'c1');
  });

  await t.test('allows SR/UR/L if user explicitly includes them', () => {
    const candidates = collectionDiscard.computeDiscardCandidates(sampleCards, {
      maxPrice: 150,
      selectedRarities: new Set(['UR', 'L']),
      keepAtLeastOne: true,
      ignoreUnpriced: true
    }, priceResolver);

    const ur1Match = candidates.find((c) => c.id === 'ur1');
    assert.ok(ur1Match);
    assert.strictEqual(ur1Match.discardCount, 1);

    const l1Match = candidates.find((c) => c.id === 'l1');
    assert.ok(l1Match);
    assert.strictEqual(l1Match.discardCount, 1);
  });

  await t.test('keepAtLeastOne = false targets even singleton cards', () => {
    const candidates = collectionDiscard.computeDiscardCandidates(sampleCards, {
      maxPrice: 10,
      selectedRarities: new Set(['C']),
      keepAtLeastOne: false, // discard all copies
      ignoreUnpriced: true
    }, priceResolver);

    // c1 (count 3 -> discard 3)
    // c2 (count 1 -> discard 1)
    assert.strictEqual(candidates.length, 2);
    const c2Match = candidates.find((c) => c.id === 'c2');
    assert.ok(c2Match);
    assert.strictEqual(c2Match.discardCount, 1);

    const c1Match = candidates.find((c) => c.id === 'c1');
    assert.strictEqual(c1Match.discardCount, 3);
  });

  await t.test('ignoreUnpriced = false includes unpriced cards', () => {
    const candidates = collectionDiscard.computeDiscardCandidates(sampleCards, {
      maxPrice: 10,
      selectedRarities: new Set(['C']),
      keepAtLeastOne: true,
      ignoreUnpriced: false // include unpriced
    }, priceResolver);

    const unpricedMatch = candidates.find((c) => c.id === 'unpriced1');
    assert.ok(unpricedMatch);
    assert.strictEqual(unpricedMatch.average, null);
    assert.strictEqual(unpricedMatch.discardCount, 1);
  });

  await t.test('excludedCardIds marks specific card as not selected', () => {
    const candidates = collectionDiscard.computeDiscardCandidates(sampleCards, {
      maxPrice: 10,
      selectedRarities: new Set(['C', 'PC']),
      keepAtLeastOne: true,
      ignoreUnpriced: true,
      excludedCardIds: new Set(['c1'])
    }, priceResolver);

    const c1Match = candidates.find((c) => c.id === 'c1');
    assert.ok(c1Match);
    assert.strictEqual(c1Match.isSelected, false);

    const pc1Match = candidates.find((c) => c.id === 'pc1');
    assert.ok(pc1Match);
    assert.strictEqual(pc1Match.isSelected, true);
  });

  await t.test('searchQuery filters cards by title', () => {
    const candidates = collectionDiscard.computeDiscardCandidates(sampleCards, {
      maxPrice: 50,
      selectedRarities: new Set(['C', 'PC', 'R']),
      keepAtLeastOne: true,
      ignoreUnpriced: true,
      searchQuery: 'eiffel'
    }, priceResolver);

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].id, 'c1');
  });

  await t.test('tagFilterMode = untagged targets ONLY cards without tags', () => {
    const taggedCards = [
      { id: 'c1', title: 'Tour Eiffel', rarity: 'C', count: 3, tags: [] },
      { id: 'pc1', title: 'Arc de Triomphe', rarity: 'PC', count: 2, tags: ['Monuments'] },
      { id: 'c3', title: 'Baguette', rarity: 'C', count: 2 }
    ];

    const priceResolverLocal = () => 5;

    const untaggedOnly = collectionDiscard.computeDiscardCandidates(taggedCards, {
      maxPrice: 10,
      selectedRarities: new Set(['C', 'PC']),
      tagFilterMode: 'untagged'
    }, priceResolverLocal);

    assert.strictEqual(untaggedOnly.length, 2);
    assert.ok(untaggedOnly.some((c) => c.id === 'c1'));
    assert.ok(untaggedOnly.some((c) => c.id === 'c3'));
    assert.strictEqual(untaggedOnly.some((c) => c.id === 'pc1'), false, 'Tagged card pc1 must be excluded');
  });

  await t.test('tagFilterMode = tagged targets ONLY cards with tags', () => {
    const taggedCards = [
      { id: 'c1', title: 'Tour Eiffel', rarity: 'C', count: 3, tags: [] },
      { id: 'pc1', title: 'Arc de Triomphe', rarity: 'PC', count: 2, tags: ['Monuments'] },
      { id: 'c3', title: 'Baguette', rarity: 'C', count: 2 }
    ];

    const priceResolverLocal = () => 5;

    const taggedOnly = collectionDiscard.computeDiscardCandidates(taggedCards, {
      maxPrice: 10,
      selectedRarities: new Set(['C', 'PC']),
      tagFilterMode: 'tagged'
    }, priceResolverLocal);

    assert.strictEqual(taggedOnly.length, 1);
    assert.strictEqual(taggedOnly[0].id, 'pc1');
  });

  await t.test('tagFilterMode = custom filters by selectedTags set', () => {
    const taggedCards = [
      { id: 'c1', title: 'Tour Eiffel', rarity: 'C', count: 3, tags: ['Monuments', 'Paris'] },
      { id: 'pc1', title: 'Zidane', rarity: 'PC', count: 2, tags: ['Sport', 'Football'] },
      { id: 'c3', title: 'Baguette', rarity: 'C', count: 2, tags: [] }
    ];

    const priceResolverLocal = () => 5;

    // Filter only 'Sport'
    const sportCandidates = collectionDiscard.computeDiscardCandidates(taggedCards, {
      maxPrice: 10,
      selectedRarities: new Set(['C', 'PC']),
      tagFilterMode: 'custom',
      selectedTags: new Set(['Sport'])
    }, priceResolverLocal);

    assert.strictEqual(sportCandidates.length, 1);
    assert.strictEqual(sportCandidates[0].id, 'pc1');

    // Filter '__UNTAGGED__' and 'Monuments'
    const multiCandidates = collectionDiscard.computeDiscardCandidates(taggedCards, {
      maxPrice: 10,
      selectedRarities: new Set(['C', 'PC']),
      tagFilterMode: 'custom',
      selectedTags: new Set(['__UNTAGGED__', 'Monuments'])
    }, priceResolverLocal);

    assert.strictEqual(multiCandidates.length, 2);
    assert.ok(multiCandidates.some((c) => c.id === 'c1'));
    assert.ok(multiCandidates.some((c) => c.id === 'c3'));
  });
});

test('collectionDiscard native DOM helpers and button detection', async (t) => {
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
      cacheKey: (id) => `wm_avg_v3_${id}`,
      cacheMemory: new Map(),
      isCacheEntryValid: () => true,
      reportError: () => {}
    },
    priceUi: {
      chooseAverage: () => 10,
      formatAverage: (val) => String(val),
      getRarityFromCard: () => 'C'
    },
    settings: {
      isEnabled: () => true
    }
  };

  const collectionDiscard = collectionDiscardModule.create(fakeRuntime);

  await t.test('findNativeSelectButton detects button with Sélectionner', () => {
    const mockSelectBtn = {
      textContent: 'Sélectionner',
      closest: () => null
    };
    const otherBtn = {
      textContent: 'Filtres',
      closest: () => null
    };

    global.document = {
      querySelectorAll: (sel) => {
        if (sel === 'button') return [otherBtn, mockSelectBtn];
        return [];
      }
    };

    const found = collectionDiscard.findNativeSelectButton();
    assert.strictEqual(found, mockSelectBtn);
  });

  await t.test('findNativeDiscardButton detects button with Défausser and ignores tools bar', () => {
    const extensionBtn = {
      textContent: 'Défausse par prix',
      closest: (sel) => sel === '#wm-tools-bar' ? {} : null
    };
    const nativeDiscardBtn = {
      textContent: 'Défausser (3)',
      closest: () => null
    };

    global.document = {
      querySelectorAll: (sel) => {
        if (sel === 'button') return [extensionBtn, nativeDiscardBtn];
        return [];
      }
    };

    const found = collectionDiscard.findNativeDiscardButton();
    assert.strictEqual(found, nativeDiscardBtn);
  });

  await t.test('isCardElementSelected detects selection from checkbox or classes', () => {
    const unselectedCard = {
      querySelector: () => ({ checked: false }),
      getAttribute: () => null,
      className: 'glow-card rounded-2xl'
    };
    assert.strictEqual(collectionDiscard.isCardElementSelected(unselectedCard), false);

    const checkedCard = {
      querySelector: (sel) => sel === 'input[type="checkbox"]' ? { checked: true } : null,
      getAttribute: () => null,
      className: 'glow-card rounded-2xl'
    };
    assert.strictEqual(collectionDiscard.isCardElementSelected(checkedCard), true);

    const ringCard = {
      querySelector: () => null,
      getAttribute: (attr) => attr === 'aria-selected' ? 'true' : null,
      className: 'glow-card rounded-2xl ring-2'
    };
    assert.strictEqual(collectionDiscard.isCardElementSelected(ringCard), true);
  });

  await t.test('ensureToolbarButton avoids duplicate button injection', () => {
    let buttonCount = 0;
    const existingButtons = [];
    const fakeToolbar = {
      id: 'wm-tools-bar',
      querySelectorAll: (sel) => {
        if (sel === 'button') return existingButtons;
        return existingButtons.filter((b) => b.id === 'wm-discard-button');
      },
      querySelector: () => null,
      append: (btn) => {
        existingButtons.push(btn);
        buttonCount += 1;
      }
    };

    global.document = {
      getElementById: (id) => id === 'wm-tools-bar' ? fakeToolbar : null,
      querySelectorAll: () => [],
      createElement: (tag) => {
        const el = {
          tagName: tag.toUpperCase(),
          dataset: {},
          classList: {
            add: (c) => { el.className = (el.className || '') + ' ' + c; },
            contains: (c) => Boolean(el.className && el.className.includes(c))
          },
          addEventListener: () => {}
        };
        return el;
      }
    };

    collectionDiscard.ensureToolbarButton();
    assert.strictEqual(existingButtons.length, 1);
    assert.strictEqual(existingButtons[0].id, 'wm-discard-button');

    // Calling ensureToolbarButton a second time should NOT append another button
    collectionDiscard.ensureToolbarButton();
    assert.strictEqual(existingButtons.length, 1);
  });

  await t.test('openDiscardModal constructs modal with non-empty body containing config, stats, and preview', () => {
    let appendedOverlay = null;
    const mockDocumentBody = {
      append: (el) => { appendedOverlay = el; },
      querySelectorAll: () => []
    };

    function createMockElement(tag) {
      const children = [];
      const el = {
        tagName: tag.toUpperCase(),
        children,
        classList: {
          add: (c) => { el.className = (el.className || '') + ' ' + c; },
          contains: (c) => Boolean(el.className && el.className.includes(c)),
          toggle: () => {}
        },
        dataset: {},
        append: (...items) => children.push(...items),
        replaceChildren: (...items) => { children.length = 0; children.push(...items); },
        addEventListener: () => {},
        setAttribute: () => {},
        remove: () => {}
      };
      return el;
    }

    global.document = {
      body: mockDocumentBody,
      createElement: createMockElement,
      querySelectorAll: () => [],
      getElementById: () => null
    };

    // Provide cards so modal can open
    fakeRuntime.core.storageGet = () => ({
      wm_all_collection_v1: {
        complete: true,
        cards: [
          { id: 'c1', title: 'Tour Eiffel', rarity: 'C', count: 3 }
        ]
      }
    });

    collectionDiscard.openDiscardModal();

    assert.ok(appendedOverlay, 'Overlay should have been appended to document.body');
    const modal = appendedOverlay.children[0];
    assert.ok(modal, 'Modal should be child of overlay');

    // Header, Body, Footer
    assert.strictEqual(modal.children.length, 3, 'Modal must contain header, body and footer');
    const [header, body, footer] = modal.children;
    assert.ok(header.className.includes('wm-discard-header'));
    assert.ok(body.className.includes('wm-discard-body'));
    assert.ok(footer.className.includes('wm-discard-footer'));

    // Body MUST have children (configCard, statsBar, previewWrap)
    assert.strictEqual(body.children.length, 3, 'Body must contain configCard, statsBar, and previewWrap');
    const [configCard, statsBar, previewWrap] = body.children;
    assert.ok(configCard.className.includes('wm-discard-config-card'));
    assert.ok(statsBar.className.includes('wm-discard-stats-bar'));
    assert.ok(previewWrap.className.includes('wm-discard-preview-wrap'));
  });

  await t.test('filterWikiMastersPageByRarity detects rarity buttons, tabs or full names', () => {
    let clicked = null;
    const cBtn = {
      textContent: ' C (42) ',
      closest: () => null,
      click: () => { clicked = 'C'; }
    };
    const urBtn = {
      textContent: 'Ultra Rare',
      closest: () => null,
      click: () => { clicked = 'UR'; }
    };

    global.document = {
      querySelectorAll: (sel) => {
        if (sel.includes('button')) return [cBtn, urBtn];
        return [];
      }
    };

    const resC = collectionDiscard.filterWikiMastersPageByRarity('C');
    assert.strictEqual(resC, true);
    assert.strictEqual(clicked, 'C');

    const resUR = collectionDiscard.filterWikiMastersPageByRarity('UR');
    assert.strictEqual(resUR, true);
    assert.strictEqual(clicked, 'UR');

    const resNone = collectionDiscard.filterWikiMastersPageByRarity('ZZ');
    assert.strictEqual(resNone, false);
  });

  await t.test('openDiscardModal keeps discard button enabled with total count when page has 0 visible candidates', () => {
    let appendedOverlay = null;
    const mockDocumentBody = {
      append: (el) => { appendedOverlay = el; },
      querySelectorAll: () => []
    };

    function createMockElement(tag) {
      const children = [];
      const el = {
        tagName: tag.toUpperCase(),
        children,
        classList: {
          add: (c) => { el.className = (el.className || '') + ' ' + c; },
          contains: (c) => Boolean(el.className && el.className.includes(c)),
          toggle: () => {},
          remove: () => {}
        },
        dataset: {},
        append: (...items) => children.push(...items),
        prepend: (...items) => children.unshift(...items),
        replaceChildren: (...items) => { children.length = 0; children.push(...items); },
        addEventListener: () => {},
        setAttribute: () => {},
        remove: () => {}
      };
      return el;
    }

    global.document = {
      body: mockDocumentBody,
      createElement: createMockElement,
      querySelectorAll: () => [], // No cards visible on current page DOM
      getElementById: () => null
    };

    // Card in collection with price in cache
    fakeRuntime.core.storageGet = () => ({
      wm_all_collection_v1: {
        complete: true,
        cards: [
          { id: 'c1', title: 'Tour Eiffel', rarity: 'C', count: 3 }
        ]
      }
    });
    fakeRuntime.core.cacheMemory.set('c1', { ok: true, average: 5 });

    collectionDiscard.openDiscardModal();

    assert.ok(appendedOverlay);
    const modal = appendedOverlay.children[0];
    const footer = modal.children[2];
    const footerActions = footer.children[1];
    const [selectBtn, discardBtn] = footerActions.children;

    // Both buttons should NOT be disabled, even though 0 cards are on current page
    assert.strictEqual(discardBtn.disabled, false, 'Discard button should remain enabled');
    assert.ok(discardBtn.textContent.includes('Aller aux cartes & Défausser (2)'), 'Button text should direct to go to cards with count');
    assert.strictEqual(selectBtn.disabled, false, 'Select button should remain enabled');
  });

  await t.test('openDiscardModal shows sync notice when collection is incomplete', () => {
    let appendedOverlay = null;
    const mockDocumentBody = {
      append: (el) => { appendedOverlay = el; },
      querySelectorAll: () => []
    };

    function createMockElement(tag) {
      const children = [];
      const el = {
        tagName: tag.toUpperCase(),
        children,
        classList: {
          add: (c) => { el.className = (el.className || '') + ' ' + c; },
          contains: (c) => Boolean(el.className && el.className.includes(c)),
          toggle: () => {},
          remove: () => {}
        },
        dataset: {},
        append: (...items) => children.push(...items),
        prepend: (...items) => children.unshift(...items),
        replaceChildren: (...items) => { children.length = 0; children.push(...items); },
        addEventListener: () => {},
        setAttribute: () => {},
        remove: () => {}
      };
      return el;
    }

    global.document = {
      body: mockDocumentBody,
      createElement: createMockElement,
      querySelectorAll: () => [],
      getElementById: () => null
    };

    // Incomplete collection
    fakeRuntime.core.storageGet = () => ({
      wm_all_collection_v1: {
        complete: false,
        cards: [
          { id: 'c1', title: 'Tour Eiffel', rarity: 'C', count: 2 }
        ]
      }
    });

    collectionDiscard.openDiscardModal();

    assert.ok(appendedOverlay);
    const modal = appendedOverlay.children[0];
    const body = modal.children[1];
    const syncNotice = body.children[0];
    assert.ok(syncNotice.className.includes('wm-discard-sync-notice'), 'Incomplete collection must display sync notice banner');
  });
});

test('collectionDiscard tag statistics, UUIDs and direct bulk discard API', async (t) => {
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
      cacheKey: (id) => `wm_avg_v3_${id}`,
      cacheMemory: new Map(),
      isCacheEntryValid: () => true,
      reportError: () => {}
    },
    priceUi: {
      chooseAverage: () => 10,
      formatAverage: (val) => String(val),
      getRarityFromCard: () => 'C'
    },
    settings: {
      isEnabled: () => true
    }
  };

  const collectionDiscard = collectionDiscardModule.create(fakeRuntime);

  await t.test('getTagsFromCards aggregates tag counts and untagged cards', () => {
    const cards = [
      { id: '1', title: 'A', count: 3, tags: ['Sport', 'France'] },
      { id: '2', title: 'B', count: 2, tags: ['France'] },
      { id: '3', title: 'C', count: 4, tags: [] },
      { id: '4', title: 'D', count: 1 } // no tags
    ];

    const stats = collectionDiscard.getTagsFromCards(cards);
    assert.strictEqual(stats.untaggedCount, 5); // 4 + 1
    assert.strictEqual(stats.tagCounts.get('Sport'), 3);
    assert.strictEqual(stats.tagCounts.get('France'), 5); // 3 + 2
  });

  await t.test('getDiscardCardIds extracts valid UUIDs up to discardCount', () => {
    const candidate = {
      card: {
        id: '11111111-1111-1111-1111-111111111111',
        ownedCardId: '22222222-2222-2222-2222-222222222222',
        ownedCardIds: [
          '22222222-2222-2222-2222-222222222222',
          '33333333-3333-3333-3333-333333333333',
          '44444444-4444-4444-4444-444444444444'
        ]
      },
      discardCount: 2
    };

    const ids = collectionDiscard.getDiscardCardIds(candidate);
    assert.strictEqual(ids.length, 2);
    assert.strictEqual(ids[0], '22222222-2222-2222-2222-222222222222');
    assert.strictEqual(ids[1], '33333333-3333-3333-3333-333333333333');
  });

  await t.test('executeDirectBulkDiscard sends POST request with card_ids payload and updates collection', async () => {
    let requestedUrl = null;
    let requestOptions = null;

    global.window = {
      confirm: () => true,
      dispatchEvent: () => {},
      fetch: async (url, options) => {
        requestedUrl = url;
        requestOptions = options;
        return { ok: true, status: 200, json: async () => ({}) };
      }
    };

    let savedStorage = null;
    const runtime = {
      core: {
        ALL_COLLECTION_KEY: 'wm_all_collection_v1',
        RARITIES: ['L', 'UR', 'SR', 'R', 'PC', 'C'],
        cardMetaById: new Map(),
        idByTitle: new Map(),
        isCollectionPage: () => true,
        normalizeTitle: (s) => String(s || '').trim(),
        storageGet: () => ({
          wm_all_collection_v1: {
            complete: true,
            cards: [
              {
                id: 'card-1',
                ownedCardId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                ownedCardIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
                count: 2
              }
            ]
          }
        }),
        storageSet: (val) => { savedStorage = val; }
      },
      priceUi: {
        chooseAverage: () => 10,
        formatAverage: (val) => String(val),
        getRarityFromCard: () => 'C'
      },
      settings: {
        isEnabled: () => true
      }
    };

    const discardInstance = collectionDiscardModule.create(runtime);

    const candidates = [
      {
        isSelected: true,
        discardCount: 1,
        card: {
          id: 'card-1',
          ownedCardId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          ownedCardIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']
        }
      }
    ];

    const result = await discardInstance.executeDirectBulkDiscard(candidates);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.discardedCount, 1);
    assert.strictEqual(requestedUrl, '/api/user-cards/bulk-discard');
    assert.strictEqual(requestOptions.method, 'POST');

    const body = JSON.parse(requestOptions.body);
    assert.deepStrictEqual(body, {
      card_ids: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']
    });

    // Check storage was updated
    assert.ok(savedStorage);
    const updatedCards = savedStorage.wm_all_collection_v1.cards;
    assert.strictEqual(updatedCards[0].count, 1, 'Card count should be decremented');
  });
});

