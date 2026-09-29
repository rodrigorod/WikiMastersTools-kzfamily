const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTitle,
  cacheKey,
  isCacheEntryValid,
  formatAverage,
  chooseAverage,
  getRarityFromCard,
  tradeMatchScore,
  isCollectionPage,
  isMarketplaceDetailPage,
  isPullsPage,
  isTradesPage,
  isGlobalCollectionPage,
  isContextInvalidatedError,
  CACHE_TTL,
  ERROR_CACHE_TTL,
  RARITIES
} = require('../content.js');

test('content.js string and cache formatting utilities', async (t) => {
  await t.test('normalizeTitle trims, standardizes spaces and NFC normalizes', () => {
    assert.strictEqual(normalizeTitle('   Albert   Einstein  '), 'Albert Einstein');
    assert.strictEqual(normalizeTitle('Tour\nEiffel\t'), 'Tour Eiffel');
    assert.strictEqual(normalizeTitle(null), '');
    assert.strictEqual(normalizeTitle(undefined), '');
    assert.strictEqual(normalizeTitle(''), '');
  });

  await t.test('cacheKey prefixes card id correctly', () => {
    assert.strictEqual(cacheKey('xyz-123'), 'wm_avg_v3_xyz-123');
  });

  await t.test('isCacheEntryValid evaluates TTLs for standard and error responses', () => {
    const now = 1000000;

    // Fresh valid entry (< 24h)
    const freshEntry = { fetchedAt: now - 3600 * 1000, ok: true, averages: { UR: 100 } };
    assert.strictEqual(isCacheEntryValid(freshEntry, now), true);

    // Stale valid entry (> 24h)
    const staleEntry = { fetchedAt: now - (CACHE_TTL + 1000), ok: true };
    assert.strictEqual(isCacheEntryValid(staleEntry, now), false);

    // Fresh error entry (< 60s)
    const freshError = { fetchedAt: now - 30 * 1000, ok: false };
    assert.strictEqual(isCacheEntryValid(freshError, now), true);

    // Stale error entry (> 60s)
    const staleError = { fetchedAt: now - (ERROR_CACHE_TTL + 1000), ok: false };
    assert.strictEqual(isCacheEntryValid(staleError, now), false);

    // Invalid entries
    assert.strictEqual(isCacheEntryValid(null, now), false);
    assert.strictEqual(isCacheEntryValid({}, now), false);
    assert.strictEqual(isCacheEntryValid({ fetchedAt: 'not-a-number' }, now), false);
  });

  await t.test('formatAverage formats values with fr-FR locale rules', () => {
    assert.strictEqual(formatAverage(150), '150');
    // In fr-FR, decimals use comma
    assert.strictEqual(formatAverage(123.45), '123,45');
    assert.strictEqual(formatAverage('250.5'), '250,5');
    assert.strictEqual(formatAverage(null), '—');
    assert.strictEqual(formatAverage(undefined), '—');
    assert.strictEqual(formatAverage(NaN), '—');
    assert.strictEqual(formatAverage('invalid'), '—');
  });
});

test('content.js price selection and DOM helpers', async (t) => {
  await t.test('chooseAverage prioritizes matching rarity or unique price fallback', () => {
    const multiEntry = {
      averages: {
        UR: 500,
        SR: 150,
        R: 30
      }
    };

    // Explicit rarity match
    assert.strictEqual(chooseAverage(multiEntry, null, 'UR'), 500);
    assert.strictEqual(chooseAverage(multiEntry, null, 'SR'), 150);

    // Unknown rarity with multiple averages cannot be decided -> null
    assert.strictEqual(chooseAverage(multiEntry, null, 'C'), null);

    // Single average fallback
    const singleEntry = {
      averages: {
        UR: 750
      }
    };
    assert.strictEqual(chooseAverage(singleEntry, null, null), 750);

    // Empty or null entry
    assert.strictEqual(chooseAverage(null, null, 'UR'), null);
    assert.strictEqual(chooseAverage({ averages: {} }, null, null), null);
  });

  await t.test('getRarityFromCard extracts rarity badge from card element', () => {
    const mockCard = {
      querySelectorAll: () => [
        { textContent: 'Tour Eiffel' },
        { textContent: 'Monument' },
        { textContent: 'UR' }
      ]
    };
    assert.strictEqual(getRarityFromCard(mockCard), 'UR');

    const mockCardNoRarity = {
      querySelectorAll: () => [
        { textContent: 'Some text' }
      ]
    };
    assert.strictEqual(getRarityFromCard(mockCardNoRarity), null);
    assert.strictEqual(getRarityFromCard(null), null);
  });

  await t.test('tradeMatchScore computes relevance score between trade and card element', () => {
    const trade = {
      id: 'trade-1',
      items: [
        { card: { title: 'Léonard de Vinci' } },
        { card: { title: 'Mona Lisa' } }
      ],
      initiator: { username: 'ArtCollector' },
      recipient: { username: 'HistoryBuff' }
    };

    const mockCardEl = {
      querySelectorAll: (sel) => {
        if (sel === '[title]') {
          return [
            { getAttribute: () => 'Léonard de Vinci' },
            { getAttribute: () => 'Mona Lisa' }
          ];
        }
        return [];
      },
      textContent: 'Échange proposé par ArtCollector pour Mona Lisa et Léonard de Vinci'
    };

    const score = tradeMatchScore(mockCardEl, trade, new Set());
    assert.ok(score > 100, `Score should be high for full match (actual: ${score})`);

    // Already used trade id gives -Infinity
    assert.strictEqual(tradeMatchScore(mockCardEl, trade, new Set(['trade-1'])), -Infinity);
  });
});

test('content.js route checkers and error detection', async (t) => {
  await t.test('route checker functions match WikiMasters URL paths', () => {
    assert.strictEqual(isCollectionPage('/collection'), true);
    assert.strictEqual(isCollectionPage('/collection/sets'), true);
    assert.strictEqual(isCollectionPage('/marketplace'), false);

    assert.strictEqual(
      isMarketplaceDetailPage('/marketplace/12345678-1234-1234-1234-123456789abc'),
      true
    );
    assert.strictEqual(isMarketplaceDetailPage('/marketplace/mine'), false);

    assert.strictEqual(isPullsPage('/pulls'), true);
    assert.strictEqual(isPullsPage('/pulls/history'), true);
    assert.strictEqual(isPullsPage('/collection'), false);

    assert.strictEqual(isTradesPage('/trades'), true);
    assert.strictEqual(isTradesPage('/trades/archive'), true);

    assert.strictEqual(isGlobalCollectionPage('/global-collection'), true);
  });

  await t.test('isContextInvalidatedError identifies extension reload errors', () => {
    const extError = new Error('Extension context invalidated.');
    assert.strictEqual(isContextInvalidatedError(extError), true);

    const normalError = new Error('Network error 500');
    assert.strictEqual(isContextInvalidatedError(normalError), false);
  });
});
