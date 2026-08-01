import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_REPORT_PATH,
  REQUIRED_BACKLOG_IDS,
  REQUIRED_LEAVES,
  discoverRuntimeProviders,
  generateReport,
  loadCatalog,
  validateCatalog
} from '../scripts/provider-catalog-lib.mjs';

const catalog = await loadCatalog();
const clone = () => structuredClone(catalog);
const expectError = async (mutate, pattern) => {
  const candidate = clone();
  mutate(candidate);
  assert.match((await validateCatalog(candidate)).join('\n'), pattern);
};

test('loads and validates the JSON-compatible YAML catalog', async () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.equal((await validateCatalog(catalog)).length, 0);
});

test('rejects malformed and duplicate canonical IDs', async () => {
  await expectError((c) => { c.entries[0].id = 'Bad ID'; }, /malformed canonical ID/);
  await expectError((c) => { c.entries[1].id = c.entries[0].id; }, /duplicate ID/);
});

test('rejects ambiguous normalized aliases and unscoped leaf aliases', async () => {
  await expectError((c) => {
    c.entries.find((e) => e.id === 'vidfast').aliases.push({ value: 'shared_name', source: 'backlog-name' });
    c.entries.find((e) => e.id === 'soapertv').aliases.push({ value: 'shared name', source: 'backlog-name' });
  }, /alias "shared-name" is ambiguous/);
  await expectError((c) => {
    c.entries.find((e) => e.id === 'tulnex:moviebox').aliases.push({ value: 'moviebox', source: 'code-spelling' });
  }, /must be scoped to family/);
});

test('rejects invalid enum values', async () => {
  await expectError((c) => { c.entries[0].status = 'working'; }, /status: invalid enum/);
  await expectError((c) => { c.entries[0].relationships.push({ type: 'depends_on', target: '2embed' }); }, /relationships: invalid enum/);
});

test('executes the JSON Schema for nested shapes and unknown properties', async () => {
  await expectError((c) => { c.entries[0].unexpected = true; }, /schema.*additional properties/);
  await expectError((c) => { c.entries[0].runtime.healthCheck = 'yes'; }, /schema.*must be boolean/);
  await expectError((c) => {
    c.entries[0].aliases.push({ value: 'invalid-source', source: 'INVALID' });
  }, /schema.*allowed values/);
});

test('reserves canonical IDs against normalized alias collisions', async () => {
  await expectError((c) => {
    c.entries.find((e) => e.id === 'soapertv').aliases.push({
      value: 'vidfast',
      source: 'backlog-name'
    });
  }, /alias "vidfast" is ambiguous/);
});

test('rejects missing family and relationship targets', async () => {
  await expectError((c) => { c.entries.find((e) => e.id === 'tulnex:onion').familyId = 'missing'; }, /missing family target/);
  await expectError((c) => { c.entries[0].relationships.push({ type: 'embeds_on', target: 'missing' }); }, /missing relationship target/);
});

test('rejects alias cycles', async () => {
  await expectError((c) => {
    c.entries.find((e) => e.id === 'vidfast').relationships.push({ type: 'alias_of', target: 'soapertv' });
    c.entries.find((e) => e.id === 'soapertv').relationships.push({ type: 'alias_of', target: 'vidfast' });
  }, /invalid alias_of cycle/);
});

test('rejects missing rejection and defer reasons', async () => {
  await expectError((c) => { c.entries.find((e) => e.id === 'netflix').rejectionReason = null; }, /rejectionReason: required/);
  await expectError((c) => { c.entries.find((e) => e.id === 'raiplay').deferReason = null; }, /deferReason: required/);
});

test('accepted lifecycle and enablement evidence gates are enforced', async () => {
  const expected = [
    'discovered', 'researching', 'seed-needed', 'reproducible',
    'implementing', 'deterministic-pass', 'live-pass', 'saucy-pass',
    'browser-pass', 'canary', 'enabled', 'degraded', 'healing', 'broken',
    'disabled', 'deferred', 'rejected', 'retired'
  ];
  for (const status of expected) {
    const candidate = clone();
    const entry = candidate.entries.find((e) => e.id === 'cinesu');
    entry.status = status;
    if (['deferred', 'rejected'].includes(status)) {
      entry[status === 'deferred' ? 'deferReason' : 'rejectionReason'] = 'test disposition';
    }
    if (['reproducible', 'implementing', 'deterministic-pass', 'live-pass', 'saucy-pass', 'browser-pass', 'canary', 'enabled'].includes(status)) {
      entry.evidence.gates = [
        'reproducible', 'deterministic-pass', 'live-pass',
        'saucy-pass', 'browser-pass', 'canary'
      ];
    }
    if (status === 'enabled') {
      entry.evidence.fixture = 'test/fixtures/cinesu.json';
      entry.evidence.seedUrls = ['https://example.test/one', 'https://example.test/two'];
    }
    assert.equal((await validateCatalog(candidate)).length, 0, status);
  }
  assert.equal(catalog.entries.find((e) => e.id === 'cinesu').runtime.enabledDefault, true);
  assert.notEqual(catalog.entries.find((e) => e.id === 'cinesu').status, 'enabled');
  await expectError((c) => {
    c.entries.find((e) => e.id === 'cinesu').status = 'enabled';
  }, /enabled entry requires fixture and two seed URLs|requires reproducible/);
});

test('filesystem discovery has exact one-to-one catalog coverage', async () => {
  const runtime = await discoverRuntimeProviders();
  assert.equal(runtime.length, 30);
  assert.equal(new Set(runtime.map((e) => e.runtimeId)).size, 30);
  assert.deepEqual(
    runtime.map((e) => e.runtimeId).sort(),
    catalog.entries.filter((e) => e.runtime.discoverable).map((e) => e.runtime.runtimeId).sort()
  );
  await expectError((c) => { c.entries.find((e) => e.id === 'cinesu').runtime.runtimeId = 'cinesu'; }, /runtime coverage/);
});

test('filesystem discovery excludes tests and non-provider classes while following provider inheritance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cinepro-catalog-'));
  try {
    const providers = path.join(root, 'src/providers/example');
    await mkdir(providers, { recursive: true });
    await writeFile(path.join(providers, 'base.ts'), "export abstract class FamilyBase extends BaseProvider {}\\n");
    await writeFile(path.join(providers, 'real.ts'), "export class RealProvider extends FamilyBase { readonly id = 'real' }\\n");
    await writeFile(path.join(providers, 'helper.ts'), "export class Helper { readonly id = 'helper' }\\n");
    await writeFile(path.join(providers, 'fake.test.ts'), "export class FakeProvider extends BaseProvider { readonly id = 'fake' }\\n");
    assert.deepEqual(await discoverRuntimeProviders(root), [{
      runtimeId: 'real',
      className: 'RealProvider',
      sourceFile: 'src/providers/example/real.ts'
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('rejects missing backlog and code-visible leaf coverage', async () => {
  assert.ok(REQUIRED_BACKLOG_IDS.every((id) => catalog.entries.some((e) => e.id === id)));
  assert.ok(Object.entries(REQUIRED_LEAVES).every(([family, leaves]) => leaves.every((leaf) => catalog.entries.some((e) => e.id === `${family}:${leaf}`))));
  await expectError((c) => { c.entries = c.entries.filter((e) => e.id !== 'netflix'); }, /backlog coverage: missing "netflix"/);
  await expectError((c) => { c.entries = c.entries.filter((e) => e.id !== 'videasy:primewire'); }, /leaf coverage: missing "videasy:primewire"/);
});

test('generated report is deterministic and byte-for-byte current', async () => {
  const first = await generateReport(catalog);
  const second = await generateReport(catalog);
  assert.equal(first, second);
  assert.equal(await readFile(DEFAULT_REPORT_PATH, 'utf8'), first);
});
