const test = require('node:test');
const assert = require('node:assert/strict');
const { getExtensionRuntime } = require('../bootstrap.js');

test('bootstrap.js multi-browser extension runtime selection', async (t) => {
  await t.test('returns null when neither browser nor chrome is defined', () => {
    const origBrowser = globalThis.browser;
    const origChrome = globalThis.chrome;

    delete globalThis.browser;
    delete globalThis.chrome;

    try {
      assert.strictEqual(getExtensionRuntime(), null);
    } finally {
      if (origBrowser !== undefined) globalThis.browser = origBrowser;
      if (origChrome !== undefined) globalThis.chrome = origChrome;
    }
  });

  await t.test('detects chrome.runtime when only chrome is available (Chromium/Brave/Opera)', () => {
    const origBrowser = globalThis.browser;
    const origChrome = globalThis.chrome;

    delete globalThis.browser;
    const mockChromeRuntime = { getURL: (p) => `chrome-extension://xyz/${p}` };
    globalThis.chrome = { runtime: mockChromeRuntime };

    try {
      const runtime = getExtensionRuntime();
      assert.strictEqual(runtime, mockChromeRuntime);
      assert.strictEqual(runtime.getURL('test.js'), 'chrome-extension://xyz/test.js');
    } finally {
      if (origBrowser !== undefined) globalThis.browser = origBrowser;
      if (origChrome !== undefined) globalThis.chrome = origChrome;
      else delete globalThis.chrome;
    }
  });

  await t.test('prefers browser.runtime when available (Firefox WebExtensions)', () => {
    const origBrowser = globalThis.browser;
    const origChrome = globalThis.chrome;

    const mockBrowserRuntime = { getURL: (p) => `moz-extension://abc/${p}` };
    const mockChromeRuntime = { getURL: (p) => `chrome-extension://xyz/${p}` };

    globalThis.browser = { runtime: mockBrowserRuntime };
    globalThis.chrome = { runtime: mockChromeRuntime };

    try {
      const runtime = getExtensionRuntime();
      assert.strictEqual(runtime, mockBrowserRuntime);
      assert.strictEqual(runtime.getURL('test.js'), 'moz-extension://abc/test.js');
    } finally {
      if (origBrowser !== undefined) globalThis.browser = origBrowser;
      else delete globalThis.browser;
      if (origChrome !== undefined) globalThis.chrome = origChrome;
      else delete globalThis.chrome;
    }
  });
});
