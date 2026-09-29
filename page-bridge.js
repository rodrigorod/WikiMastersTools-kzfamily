(() => {
  if (typeof window === 'undefined') {
    global.window = global;
    require('./bridge/core.js');
    require('./bridge/collection.js');
    const core = global.__wmBridgeFeatures?.bridgeCore?.create();
    const collection = global.__wmBridgeFeatures?.bridgeCollection?.create({ core });
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        ...core,
        ...collection
      };
    }
    return;
  }

  if (window.__wmAveragePriceBridgeInstalled) return;
  window.__wmAveragePriceBridgeInstalled = true;

  const registry = window.__wmBridgeFeatures || {};
  const runtime = {};
  window.__wmAverageBridgeRuntime = runtime;

  runtime.core = registry.bridgeCore.create();
  runtime.collection = registry.bridgeCollection.create(runtime);
  runtime.packs = registry.bridgePacks.create(runtime);
  runtime.intercept = registry.bridgeIntercept.create(runtime);
  runtime.marketplace = registry.bridgeMarketplace.create(runtime);
  runtime.prices = registry.bridgePrices.create(runtime);

  console.debug('[WM Average] bridge modulaire v4.2.0 installé');
})();
