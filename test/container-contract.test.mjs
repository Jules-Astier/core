import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('runtime file permissions are normalized before switching to non-root', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  const copies = [
    'COPY package*.json ./',
    'COPY scripts/patch-framework-ranges.mjs ./scripts/patch-framework-ranges.mjs',
    'COPY --from=builder /app/dist ./dist',
    'COPY --from=builder /app/config ./config',
  ].map((line) => [line, runtimeStage.indexOf(line)]);
  const normalizeLine = runtimeStage
    .split('\n')
    .find((line) => line.startsWith('RUN chmod -R a+rX '));
  const normalize = normalizeLine ? runtimeStage.indexOf(normalizeLine) : -1;
  const nonRootUser = runtimeStage.indexOf('USER nodejs');

  assert.notEqual(normalize, -1, 'runtime permission normalization is missing');
  assert.notEqual(nonRootUser, -1, 'non-root runtime user is missing');
  for (const [line, index] of copies) {
    assert.notEqual(index, -1, `runtime copy is missing: ${line}`);
    assert.ok(index < normalize, `must be copied before normalization: ${line}`);
  }
  // The WCO provider spawns dist/providers/wco/public-page.py as nodejs, and
  // Node reads package.json to resolve the module type.
  const targets = normalizeLine.split(/\s+/).slice(4);
  for (const target of ['./dist', './config', './scripts', 'package.json', 'package-lock.json']) {
    assert.ok(targets.includes(target), `${target} must be made world-readable`);
  }
  assert.ok(normalize < nonRootUser, 'files must be normalized before USER nodejs');
});
