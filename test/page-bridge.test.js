const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isMarketplaceDetailApi,
  isPacksOpenApi,
  isTradesApi,
  getGlobalCollectionSummaryCardId,
  mapEntry,
  extractCards,
  mapPackCards,
  mapTrade,
  extractRarityCounts,
  RARITY_ORDER
} = require('../page-bridge.js');

test('page-bridge URL detection helpers', async (t) => {
  await t.test('isMarketplaceDetailApi detects valid UUID endpoints', () => {
    const validUuid = '12345678-1234-1234-1234-123456789abc';
    assert.strictEqual(isMarketplaceDetailApi(`/api/marketplace/${validUuid}`), true);
    assert.strictEqual(isMarketplaceDetailApi(`https://www.wiki-masters.com/api/marketplace/${validUuid}`), true);
    assert.strictEqual(isMarketplaceDetailApi('/api/marketplace/invalid-uuid'), false);
    assert.strictEqual(isMarketplaceDetailApi('/api/marketplace/mine'), false);
    assert.strictEqual(isMarketplaceDetailApi('/api/trades'), false);
    assert.strictEqual(isMarketplaceDetailApi(''), false);
  });

  await t.test('isPacksOpenApi detects packs open endpoint', () => {
    assert.strictEqual(isPacksOpenApi('/api/packs/open'), true);
    assert.strictEqual(isPacksOpenApi('https://www.wiki-masters.com/api/packs/open'), true);
    assert.strictEqual(isPacksOpenApi('/api/packs/summary'), false);
    assert.strictEqual(isPacksOpenApi('/api/packs'), false);
  });

  await t.test('isTradesApi detects trades endpoint', () => {
    assert.strictEqual(isTradesApi('/api/trades'), true);
    assert.strictEqual(isTradesApi('https://www.wiki-masters.com/api/trades?scope=all'), true);
    assert.strictEqual(isTradesApi('/api/trades/mine'), false);
  });

  await t.test('getGlobalCollectionSummaryCardId parses Supabase REST requests', () => {
    const cardId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const validUrl = `https://cyrxjeppjqsxxjayfrur.supabase.co/rest/v1/cards?select=id,title,summary&id=eq.${cardId}`;
    assert.strictEqual(getGlobalCollectionSummaryCardId(validUrl), cardId);

    // Host mismatch
    const badHost = `https://example.supabase.co/rest/v1/cards?select=id,summary&id=eq.${cardId}`;
    assert.strictEqual(getGlobalCollectionSummaryCardId(badHost), null);

    // Missing 'summary' in select
    const noSummary = `https://cyrxjeppjqsxxjayfrur.supabase.co/rest/v1/cards?select=id,title&id=eq.${cardId}`;
    assert.strictEqual(getGlobalCollectionSummaryCardId(noSummary), null);

    // Missing id filter
    const noId = 'https://cyrxjeppjqsxxjayfrur.supabase.co/rest/v1/cards?select=summary';
    assert.strictEqual(getGlobalCollectionSummaryCardId(noId), null);
  });
});

test('page-bridge data extraction and transformation helpers', async (t) => {
  await t.test('mapEntry maps valid card entry and filters invalid', () => {
    const raw = {
      id: 'owned-123',
      count: 3,
      card: {
        id: 'card-456',
        wikipedia_title: 'Albert Einstein',
        rarity: 'UR',
        image_url: 'https://example.com/einstein.jpg'
      }
    };

    const mapped = mapEntry(raw);
    assert.deepStrictEqual(mapped, {
      id: 'card-456',
      ownedCardId: 'owned-123',
      ownedCardIds: ['owned-123'],
      title: 'Albert Einstein',
      rarity: 'UR',
      imageUrl: 'https://example.com/einstein.jpg',
      wikipediaUrl: null,
      count: 3,
      tags: []
    });

    assert.strictEqual(mapEntry(null), null);
    assert.strictEqual(mapEntry({}), null);
    assert.strictEqual(mapEntry({ card: { id: 'only-id' } }), null);
  });

  await t.test('mapEntry parses tags from array, objects and comma-delimited strings', () => {
    // Array of strings
    const entryStrings = {
      id: 'o-1',
      tags: ['Physique', 'Nobel'],
      card: { id: 'c-1', wikipedia_title: 'Einstein' }
    };
    assert.deepStrictEqual(mapEntry(entryStrings).tags, ['Physique', 'Nobel']);

    // Array of objects
    const entryObjects = {
      id: 'o-2',
      labels: [{ name: 'Histoire' }, { title: 'France' }],
      card: { id: 'c-2', wikipedia_title: 'Napoléon' }
    };
    assert.deepStrictEqual(mapEntry(entryObjects).tags, ['Histoire', 'France']);

    // Comma-separated string
    const entryStringComma = {
      id: 'o-3',
      tags: 'Sport, Football , Mondial',
      card: { id: 'c-3', wikipedia_title: 'Zidane' }
    };
    assert.deepStrictEqual(mapEntry(entryStringComma).tags, ['Sport', 'Football', 'Mondial']);

    // Empty / null tags
    const entryNoTags = {
      id: 'o-4',
      card: { id: 'c-4', wikipedia_title: 'Sans étiquette' }
    };
    assert.deepStrictEqual(mapEntry(entryNoTags).tags, []);
  });

  await t.test('extractCards maps collections safely', () => {
    const json = {
      collection: [
        { id: 'o-1', card: { id: 'c-1', wikipedia_title: 'Card 1', rarity: 'R' } },
        { id: 'o-2', card: null },
        { id: 'o-3', card: { id: 'c-3', wikipedia_title: 'Card 3', rarity: 'SR' } }
      ]
    };

    const cards = extractCards(json);
    assert.strictEqual(cards.length, 2);
    assert.strictEqual(cards[0].id, 'c-1');
    assert.strictEqual(cards[1].id, 'c-3');
    assert.deepStrictEqual(extractCards(null), []);
    assert.deepStrictEqual(extractCards({}), []);
  });

  await t.test('mapPackCards extracts card list from packs response', () => {
    const json = {
      cards: [
        { id: 'pack-1', wikipedia_title: 'Supernova', rarity: 'L', image_url: 'https://img/1.png' },
        { id: null, wikipedia_title: 'No Id' }
      ]
    };

    const cards = mapPackCards(json);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].id, 'pack-1');
    assert.strictEqual(cards[0].title, 'Supernova');
    assert.strictEqual(cards[0].count, 1);
  });

  await t.test('mapTrade transforms raw trade structure with cards and participants', () => {
    const rawTrade = {
      id: 'trade-999',
      status: 'pending',
      initiator_id: 'user-1',
      recipient_id: 'user-2',
      initiator_wikibidous: 100,
      recipient_wikibidous: 50,
      initiator: { id: 'user-1', username: 'Alice' },
      recipient: { id: 'user-2', username: 'Bob' },
      items: [
        {
          id: 'item-1',
          offered_by: 'user-1',
          snapshot_rarity: 'UR',
          card: {
            id: 'card-10',
            wikipedia_title: 'Quantum Physics',
            rarity: 'UR'
          }
        }
      ]
    };

    const trade = mapTrade(rawTrade);
    assert.strictEqual(trade.id, 'trade-999');
    assert.strictEqual(trade.initiator.username, 'Alice');
    assert.strictEqual(trade.recipient.username, 'Bob');
    assert.strictEqual(trade.items.length, 1);
    assert.strictEqual(trade.items[0].card.title, 'Quantum Physics');

    assert.strictEqual(mapTrade(null), null);
    assert.strictEqual(mapTrade({ id: 'incomplete' }), null);
  });

  await t.test('extractRarityCounts parses counts from various server formats', () => {
    // Format 1: rarityCounts direct
    const res1 = extractRarityCounts({
      rarityCounts: { L: 2, UR: 5, SR: 10, R: 20, PC: 30, C: 40 }
    });
    assert.strictEqual(res1.L, 2);
    assert.strictEqual(res1.UR, 5);

    // Format 2: stats.rarity_counts
    const res2 = extractRarityCounts({
      stats: { rarity_counts: { L: 1, UR: 3, SR: 7, R: 12, PC: 15, C: 25 } }
    });
    assert.strictEqual(res2.L, 1);
    assert.strictEqual(res2.SR, 7);

    // Format 3: rarities array
    const res3 = extractRarityCounts({
      rarities: [
        { name: 'L', count: 4 },
        { name: 'UR', count: 8 }
      ]
    });
    assert.strictEqual(res3.L, 4);
    assert.strictEqual(res3.UR, 8);

    assert.strictEqual(extractRarityCounts(null), null);
    assert.strictEqual(extractRarityCounts({}), null);
  });
});
