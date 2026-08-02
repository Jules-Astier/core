import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('runtime config permissions are normalized before switching to non-root', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const copyConfig = dockerfile.indexOf('COPY --from=builder /app/config ./config');
  const normalizeConfig = dockerfile.indexOf('RUN chmod -R a+rX ./config');
  const nonRootUser = dockerfile.indexOf('USER nodejs');

  assert.notEqual(copyConfig, -1, 'runtime config copy is missing');
  assert.notEqual(normalizeConfig, -1, 'runtime config permission normalization is missing');
  assert.notEqual(nonRootUser, -1, 'non-root runtime user is missing');
  assert.ok(copyConfig < normalizeConfig, 'config must be copied before normalization');
  assert.ok(normalizeConfig < nonRootUser, 'config must be normalized before USER nodejs');
});
