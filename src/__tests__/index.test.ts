import { test } from 'node:test';
import assert from 'node:assert';
import { checkUpdates } from '../index.js';

test('checkUpdates fetches and compares versions correctly', async (t) => {
  const originalFetch = globalThis.fetch;
  
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Mock global fetch
  globalThis.fetch = async (url) => {
    const urlStr = url.toString();
    if (urlStr.includes('typescript/latest')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: '5.3.3' })
      } as Response;
    }
    if (urlStr.includes('semver/latest')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: '7.8.5' })
      } as Response;
    }
    return {
      ok: false,
      status: 404
    } as Response;
  };

  const dependencies = {
    'typescript': '^5.0.0',
    'semver': '^7.0.0',
    'nonexistent-pkg': '^1.0.0'
  };

  const result = await checkUpdates(dependencies, { useCache: false });

  assert.strictEqual(result.stats.total, 3);
  assert.strictEqual(result.stats.upgradedCount, 2);
  
  assert.strictEqual(result.upgraded['typescript'], '^5.3.3');
  assert.strictEqual(result.upgraded['semver'], '^7.8.5');
  assert.strictEqual(result.upgraded['nonexistent-pkg'], undefined);
  
  const nonexistent = result.details.find(d => d.name === 'nonexistent-pkg');
  assert.ok(nonexistent?.error);
});
