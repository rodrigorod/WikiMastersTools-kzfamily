const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('manifest.json structure and cross-browser MV3 compliance', async (t) => {
  const manifestPath = path.resolve(__dirname, '../manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');

  const content = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(content);

  await t.test('has valid Manifest Version 3 and basic metadata', () => {
    assert.strictEqual(manifest.manifest_version, 3);
    assert.strictEqual(typeof manifest.name, 'string');
    assert.ok(manifest.name.length > 0);
    assert.strictEqual(typeof manifest.version, 'string');
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
    assert.strictEqual(typeof manifest.description, 'string');
  });

  await t.test('has valid host_permissions', () => {
    assert.ok(Array.isArray(manifest.host_permissions));
    assert.ok(manifest.host_permissions.includes('https://www.wiki-masters.com/*'));
  });

  await t.test('has Firefox browser_specific_settings with gecko id and data permissions', () => {
    assert.ok(manifest.browser_specific_settings, 'must declare browser_specific_settings');
    assert.ok(manifest.browser_specific_settings.gecko, 'must declare gecko settings');
    assert.strictEqual(typeof manifest.browser_specific_settings.gecko.id, 'string');
    assert.match(manifest.browser_specific_settings.gecko.id, /^.+@.+$/);

    const dataCollection = manifest.browser_specific_settings.gecko.data_collection_permissions;
    assert.ok(dataCollection, 'must declare data_collection_permissions');
    assert.deepStrictEqual(dataCollection.required, ['none']);
  });

  await t.test('declares valid content_scripts pointing to existing files', () => {
    assert.ok(Array.isArray(manifest.content_scripts));
    assert.ok(manifest.content_scripts.length > 0);

    for (const cs of manifest.content_scripts) {
      assert.ok(Array.isArray(cs.matches));
      assert.ok(cs.matches.includes('https://www.wiki-masters.com/*'));
      assert.strictEqual(cs.run_at, 'document_start');

      if (cs.js) {
        for (const file of cs.js) {
          const filePath = path.resolve(__dirname, '..', file);
          assert.ok(fs.existsSync(filePath), `content_scripts js file "${file}" must exist on disk`);
        }
      }

      if (cs.css) {
        for (const file of cs.css) {
          const filePath = path.resolve(__dirname, '..', file);
          assert.ok(fs.existsSync(filePath), `content_scripts css file "${file}" must exist on disk`);
        }
      }
    }
  });

  await t.test('declares web_accessible_resources pointing to existing files', () => {
    assert.ok(Array.isArray(manifest.web_accessible_resources));
    const allResources = [];

    for (const war of manifest.web_accessible_resources) {
      assert.ok(Array.isArray(war.resources));
      assert.ok(Array.isArray(war.matches));
      allResources.push(...war.resources);

      for (const file of war.resources) {
        const filePath = path.resolve(__dirname, '..', file);
        assert.ok(fs.existsSync(filePath), `web_accessible_resource "${file}" must exist on disk`);
      }
    }

    assert.ok(allResources.includes('page-bridge.js'));
    assert.ok(allResources.includes('content.js'));
  });
});
