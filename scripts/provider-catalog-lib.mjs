import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CATALOG_PATH = path.join(ROOT, 'config/provider-catalog.yaml');
export const DEFAULT_SCHEMA_PATH = path.join(ROOT, 'config/provider-catalog.schema.json');
export const DEFAULT_REPORT_PATH = path.join(ROOT, 'docs/generated/provider-catalog-report.md');

export const ENUMS = Object.freeze({
  kind: ['provider', 'aggregator', 'upstream', 'embed_host', 'torrent_resolver'],
  status: [
    'discovered', 'researching', 'seed-needed', 'reproducible',
    'implementing', 'deterministic-pass', 'live-pass', 'saucy-pass',
    'browser-pass', 'canary', 'enabled', 'degraded', 'healing', 'broken',
    'disabled', 'deferred', 'rejected', 'retired'
  ],
  gate: [
    'reproducible', 'deterministic-pass', 'live-pass',
    'saucy-pass', 'browser-pass', 'canary'
  ],
  content: ['movie', 'tv', 'live'],
  output: ['hls', 'mp4', 'embed', 'direct-download', 'torrent', 'metadata', 'drm'],
  relationship: ['member_of', 'resolves_via', 'embeds_on', 'alias_of'],
  enabledDefault: ['true', 'false', 'environment', 'unknown']
});

export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

const REQUIRED_GATES_BY_STATUS = Object.freeze({
  reproducible: ['reproducible'],
  implementing: ['reproducible'],
  'deterministic-pass': ['reproducible', 'deterministic-pass'],
  'live-pass': ['reproducible', 'deterministic-pass', 'live-pass'],
  'saucy-pass': ['reproducible', 'deterministic-pass', 'live-pass', 'saucy-pass'],
  'browser-pass': ['reproducible', 'deterministic-pass', 'live-pass', 'saucy-pass', 'browser-pass'],
  canary: ['reproducible', 'deterministic-pass', 'live-pass', 'saucy-pass', 'browser-pass'],
  enabled: ENUMS.gate
});

export const REQUIRED_BACKLOG_IDS = Object.freeze([
  'vidfast','allmovieland','cinemm','soapertv','goatapi','goojara','lookmovie','nites','mp4hydra',
  'nakios','papadustream','streamzo','coflix','flemmix','wookafr','movix','anime-sama','voiranime',
  'streamingcommunity','guardoserie','altadefinizionestreaming','animeunity','animeworld','animesaturn','raiplay','mediaset',
  'cuevana-ubd','pelisplushd','pelispanda','vimeus','cinemitas','animeav1','embed69','tioplus',
  'pomfy','playerflix','doramogo','fshd','megaembed','redeflix',
  'filmmakinesi','filmekseni','filmmodu','diziyou','sinewix','hdfilmcehennemi','hdfilme','faselhd',
  'animepahe','animekai','hianime','allanime','anikototv','kisskh','onlykdrama','kurage','animetsu',
  'filemoon','voe','streamwish','dood','mixdrop','uqload','vidmoly','streamtape',
  'torrentio','torrastream','sktorrent',
  'moviesdrive','moviesmod','hdhub4u','uhdmovies','vegamovies','zinkmovies','cinefreak',
  'internet-archive','peertube','wikimedia-commons','youtube',
  'netflix','prime-video','disney-plus','max'
]);

export const REQUIRED_LEAVES = Object.freeze({
  tulnex: ['onion','vidzee','icefy','tik','vaplayer','vidfast-alpha','uniquestream','vidfast-mega','vidfast-vrapid','allmovies','vidlink','vidfast-vedge','vidfast-vfast','moviebox'],
  videasy: ['cuevana','mb-flix','1movies','cdn','superflix','lamovie','primesrcme','m4uhd','meine-de','meine-it','meine-fr','overflix','visioncine','hdmovie','primewire'],
  popr: ['default','catflix','hexa','gama','liligoon','sigma','prime','alfa','lamda','ynx-vidsrc'],
  vidnest: ['moviebox','allmovies','catflix','purstream','hollymoviehd','lamda','flixhq','vidlink','onehd','klikxxi','delta'],
  peachify: ['moviebox','holly','air','multi','net','bmb'],
  ezvidapi: ['vidsrc','vidrock','vidzee','icefy','vidlink','vidnest','vixsrc','popr'],
  vidking: ['yoru','cypher','breach','neon','vyse','killjoy','fade','omen','raze'],
  vidlove: ['moviebox','vidapi','ipcloud','tcloud','vixsrc','1embed','xpass','vidrift','lookmovie','vidnest']
});

export function normalizeAlias(value) {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

let compiledSchema;

async function validateJsonSchema(catalog, schemaPath = DEFAULT_SCHEMA_PATH) {
  if (!compiledSchema || schemaPath !== DEFAULT_SCHEMA_PATH) {
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
    addFormats(ajv);
    compiledSchema = schemaPath === DEFAULT_SCHEMA_PATH ? ajv.compile(schema) : compiledSchema;
    if (schemaPath !== DEFAULT_SCHEMA_PATH) {
      const validator = ajv.compile(schema);
      validator(catalog);
      return (validator.errors ?? []).map((error) =>
        `schema${error.instancePath || '/'}: ${error.message}`
      );
    }
  }
  compiledSchema(catalog);
  return (compiledSchema.errors ?? []).map((error) =>
    `schema${error.instancePath || '/'}: ${error.message}`
  );
}

export async function loadCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  let value;
  try {
    value = JSON.parse(await readFile(catalogPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse catalog as JSON-compatible YAML: ${error.message}`);
  }
  if (value.entryDefaults) {
    value.entries = value.entries.map((entry) => ({
      ...structuredClone(value.entryDefaults),
      ...entry,
      familyId: entry.familyId ?? entry.id,
      aliases: entry.aliases ?? structuredClone(value.entryDefaults.aliases),
      regions: entry.regions ?? structuredClone(value.entryDefaults.regions),
      languages: entry.languages ?? structuredClone(value.entryDefaults.languages),
      content: entry.content ?? structuredClone(value.entryDefaults.content),
      outputs: entry.outputs ?? structuredClone(value.entryDefaults.outputs),
      runtime: { ...structuredClone(value.entryDefaults.runtime), ...entry.runtime },
      evidence: { ...structuredClone(value.entryDefaults.evidence), ...entry.evidence },
      relationships: entry.relationships ?? structuredClone(value.entryDefaults.relationships),
      risks: entry.risks ?? structuredClone(value.entryDefaults.risks),
      capabilities: { content: entry.content ?? structuredClone(value.entryDefaults.content) }
    }));
  }
  return value;
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(target));
    else if (
      entry.isFile() &&
      target.endsWith('.ts') &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('.spec.') &&
      !entry.name.endsWith('.d.ts')
    ) result.push(target);
  }
  return result.sort();
}

export async function discoverRuntimeProviders(root = ROOT) {
  const candidates = [];
  for (const filename of await walk(path.join(root, 'src'))) {
    const source = await readFile(filename, 'utf8');
    const classes = [...source.matchAll(/(export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)(?:\s+extends\s+([A-Za-z0-9_.]+))?[^{]*\{/g)];
    for (let index = 0; index < classes.length; index++) {
      const start = classes[index].index;
      const end = classes[index + 1]?.index ?? source.length;
      const body = source.slice(start, end);
      const id = body.match(/readonly\s+id\s*=\s*['"]([^'"]+)['"]/);
      candidates.push({
        runtimeId: id?.[1] ?? null,
        className: classes[index][2],
        parentClass: classes[index][3] ?? null,
        exported: Boolean(classes[index][1]),
        sourceFile: path.relative(root, filename).split(path.sep).join('/')
      });
    }
  }
  const byClass = new Map(candidates.map((candidate) => [candidate.className, candidate]));
  const isProviderClass = (candidate, seen = new Set()) => {
    if (!candidate.parentClass || seen.has(candidate.className)) return false;
    if (candidate.parentClass === 'BaseProvider') return true;
    seen.add(candidate.className);
    const parent = byClass.get(candidate.parentClass);
    return parent ? isProviderClass(parent, seen) : false;
  };
  const discovered = candidates
    .filter((candidate) =>
      candidate.exported &&
      candidate.sourceFile.startsWith('src/providers/') &&
      candidate.runtimeId &&
      isProviderClass(candidate)
    )
    .map(({ parentClass: _parentClass, exported: _exported, ...candidate }) => candidate);
  return discovered.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
}

function addEnumErrors(entry, index, errors) {
  for (const [field, enumName] of [['kind','kind'],['status','status']]) {
    if (!ENUMS[enumName].includes(entry[field])) errors.push(`entries[${index}].${field}: invalid enum "${entry[field]}"`);
  }
  for (const [field, enumName] of [['content','content'],['outputs','output']]) {
    if (!Array.isArray(entry[field]) || entry[field].some((value) => !ENUMS[enumName].includes(value))) {
      errors.push(`entries[${index}].${field}: invalid enum value`);
    }
  }
  if (!ENUMS.enabledDefault.includes(String(entry.runtime?.enabledDefault))) {
    errors.push(`entries[${index}].runtime.enabledDefault: invalid enum "${entry.runtime?.enabledDefault}"`);
  }
  for (const relationship of entry.relationships ?? []) {
    if (!ENUMS.relationship.includes(relationship.type)) errors.push(`entries[${index}].relationships: invalid enum "${relationship.type}"`);
  }
}

export async function validateCatalog(catalog, options = {}) {
  const root = options.root ?? ROOT;
  const errors = await validateJsonSchema(catalog, options.schemaPath ?? DEFAULT_SCHEMA_PATH);
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog?.entries)) {
    return [...new Set([...errors, 'catalog: expected schemaVersion 1 and entries array'])].sort();
  }
  const byId = new Map();
  for (const [index, entry] of catalog.entries.entries()) {
    if (!ID_PATTERN.test(entry.id ?? '')) errors.push(`entries[${index}].id: malformed canonical ID "${entry.id}"`);
    if (byId.has(entry.id)) errors.push(`entries[${index}].id: duplicate ID "${entry.id}"`);
    byId.set(entry.id, entry);
    addEnumErrors(entry, index, errors);
    for (const field of ['displayName','familyId','priority']) if (typeof entry[field] !== 'string' || !entry[field]) errors.push(`entries[${index}].${field}: required string`);
    for (const field of ['aliases','regions','languages','risks','relationships']) if (!Array.isArray(entry[field])) errors.push(`entries[${index}].${field}: required array`);
    if (!entry.capabilities || !Array.isArray(entry.capabilities.content)) errors.push(`entries[${index}].capabilities: required object`);
    if (!entry.evidence || !Array.isArray(entry.evidence.sourceFiles) || !Array.isArray(entry.evidence.seedUrls)) errors.push(`entries[${index}].evidence: required object`);
    if (entry.status === 'rejected' && !entry.rejectionReason) errors.push(`entries[${index}].rejectionReason: required for rejected entry`);
    if (entry.status === 'deferred' && !entry.deferReason) errors.push(`entries[${index}].deferReason: required for deferred entry`);
    const requiredGates = REQUIRED_GATES_BY_STATUS[entry.status] ?? [];
    const actualGates = entry.evidence?.gates ?? [];
    if (requiredGates.some((gate) => !actualGates.includes(gate))) {
      errors.push(`entries[${index}].evidence.gates: status "${entry.status}" requires ${requiredGates.join(', ')}`);
    }
    if (entry.status === 'enabled' && (!entry.evidence.fixture || (entry.evidence.seedUrls?.length ?? 0) < 2)) {
      errors.push(`entries[${index}].evidence: enabled entry requires fixture and two seed URLs`);
    }
    if (entry.kind === 'upstream' && (!entry.id.includes(':') || entry.familyId === entry.id)) errors.push(`entries[${index}]: upstream must have a scoped ID and parent family`);
  }

  const aliases = new Map(catalog.entries.map((entry) => [entry.id, entry.id]));
  for (const entry of catalog.entries) {
    for (const alias of entry.aliases ?? []) {
      const normalized = normalizeAlias(alias.value ?? '');
      if (!normalized) errors.push(`${entry.id}: empty alias`);
      const key = entry.kind === 'upstream' && alias.scope === entry.familyId ? `${entry.familyId}:${normalized}` : normalized;
      if (entry.kind === 'upstream' && alias.scope !== entry.familyId) errors.push(`${entry.id}: upstream alias "${alias.value}" must be scoped to family "${entry.familyId}"`);
      const previous = aliases.get(key);
      if (previous && previous !== entry.id) errors.push(`alias "${key}" is ambiguous between "${previous}" and "${entry.id}"`);
      aliases.set(key, entry.id);
    }
  }

  for (const entry of catalog.entries) {
    if (!byId.has(entry.familyId)) errors.push(`${entry.id}: missing family target "${entry.familyId}"`);
    for (const relationship of entry.relationships ?? []) if (!byId.has(relationship.target)) errors.push(`${entry.id}: missing relationship target "${relationship.target}"`);
  }
  for (const entry of catalog.entries) {
    const seen = new Set([entry.id]);
    let cursor = entry;
    while (true) {
      const aliasTarget = cursor.relationships?.find((item) => item.type === 'alias_of')?.target;
      if (!aliasTarget) break;
      if (seen.has(aliasTarget)) { errors.push(`${entry.id}: invalid alias_of cycle`); break; }
      seen.add(aliasTarget);
      cursor = byId.get(aliasTarget);
      if (!cursor) break;
    }
  }

  const runtime = await discoverRuntimeProviders(root);
  for (const item of runtime) {
    const matches = catalog.entries.filter((entry) => entry.runtime?.discoverable && entry.runtime.runtimeId === item.runtimeId);
    if (matches.length !== 1) errors.push(`runtime coverage: "${item.runtimeId}" has ${matches.length} catalog entries`);
    else {
      const entry = matches[0];
      if (entry.runtime.className !== item.className || !entry.evidence.sourceFiles.includes(item.sourceFile)) errors.push(`runtime coverage: "${item.runtimeId}" metadata does not match discovery`);
      if (item.runtimeId !== entry.id && !(entry.aliases ?? []).some((alias) => alias.value === item.runtimeId && alias.source === 'runtime-id')) errors.push(`runtime coverage: "${item.runtimeId}" exact alias is missing`);
    }
  }
  for (const entry of catalog.entries.filter((item) => item.runtime?.discoverable)) {
    if (!runtime.some((item) => item.runtimeId === entry.runtime.runtimeId)) errors.push(`runtime coverage: catalog entry "${entry.id}" is not discoverable`);
  }
  for (const id of REQUIRED_BACKLOG_IDS) if (!byId.has(id)) errors.push(`backlog coverage: missing "${id}"`);
  for (const [family, leaves] of Object.entries(REQUIRED_LEAVES)) {
    for (const leaf of leaves) if (!byId.has(`${family}:${leaf}`)) errors.push(`leaf coverage: missing "${family}:${leaf}"`);
  }
  return [...new Set(errors)].sort();
}

export async function assertValidCatalog(catalog, options) {
  const errors = await validateCatalog(catalog, options);
  if (errors.length) throw new Error(`Provider catalog validation failed:\n- ${errors.join('\n- ')}`);
  return catalog;
}

function tableCounts(entries, values) {
  const counts = new Map(values.map((value) => [value, 0]));
  for (const entry of entries) for (const value of (Array.isArray(entry) ? entry : [entry])) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].filter(([, count]) => count).sort(([a], [b]) => a.localeCompare(b));
}

function renderCountTable(title, rows) {
  return `### ${title}\n\n| Value | Count |\n| --- | ---: |\n${rows.map(([value,count]) => `| ${value} | ${count} |`).join('\n')}\n`;
}

export async function generateReport(catalog, options = {}) {
  const entries = [...catalog.entries].sort((a,b) => a.id.localeCompare(b.id));
  const runtime = await discoverRuntimeProviders(options.root ?? ROOT);
  const runtimeIds = new Set(runtime.map((item) => item.runtimeId));
  const missingRuntime = runtime.filter((item) => !entries.some((entry) => entry.runtime?.runtimeId === item.runtimeId));
  const absentFromCode = entries.filter((entry) => !entry.id.includes(':') && !entry.runtime?.discoverable);
  const orphanLeaves = entries.filter((entry) => entry.kind === 'upstream' && !entries.some((parent) => parent.id === entry.familyId));
  const risks = entries.filter((entry) => entry.risks.length || entry.status === 'seed-needed');
  const familyRows = entries.filter((entry) => entry.kind === 'aggregator').map((family) => [family.id, entries.filter((entry) => entry.familyId === family.id && entry.kind === 'upstream').length]);
  const lines = [
    '# Provider catalog report','',
    '> Generated by `node scripts/generate-provider-report.mjs`. Do not edit by hand.','',
    `Catalog schema version: ${catalog.schemaVersion}<br>`,
    `Entries: ${entries.length}<br>`,
    `Runtime providers discovered: ${runtime.length}`,'',
    '## Totals','',
    renderCountTable('Lifecycle', tableCounts(entries.map((e)=>e.status), ENUMS.status)),
    renderCountTable('Kind', tableCounts(entries.map((e)=>e.kind), ENUMS.kind)),
    renderCountTable('Region', tableCounts(entries.flatMap((e)=>e.regions), [])),
    renderCountTable('Language', tableCounts(entries.flatMap((e)=>e.languages), [])),
    renderCountTable('Priority', tableCounts(entries.map((e)=>e.priority), [])),
    renderCountTable('Content capability', tableCounts(entries.flatMap((e)=>e.content), ENUMS.content)),
    renderCountTable('Runtime discovery', [['discoverable', entries.filter((e)=>e.runtime.discoverable).length],['catalog-only', entries.filter((e)=>!e.runtime.discoverable).length]]),
    renderCountTable('Enabled default', tableCounts(entries.map((e)=>String(e.runtime.enabledDefault)), ENUMS.enabledDefault)),
    renderCountTable('Health check', [['available', entries.filter((e)=>e.runtime.discoverable && e.runtime.healthCheck).length],['missing', entries.filter((e)=>e.runtime.discoverable && !e.runtime.healthCheck).length]]),
    '### Family / leaf totals','',
    '| Family | Scoped leaves |','| --- | ---: |',...familyRows.map(([id,count])=>`| ${id} | ${count} |`),'',
    '## Actionable review','',
    '### Unresolved aliases, classification risks, and seeds','',
    ...(risks.length ? risks.map((e)=>`- \`${e.id}\` — ${[...e.risks, e.status === 'seed-needed' ? 'authorized seed URLs needed' : null].filter(Boolean).join('; ')}`) : ['None.']),'',
    '### Uncataloged runtime registry entries','',
    ...(missingRuntime.length ? missingRuntime.map((e)=>`- \`${e.runtimeId}\``) : ['None.']),'',
    '### Orphan leaves','',
    ...(orphanLeaves.length ? orphanLeaves.map((e)=>`- \`${e.id}\``) : ['None.']),'',
    '### Backlog coverage','',
    `- Required named candidates: ${REQUIRED_BACKLOG_IDS.length}`,
    `- Cataloged named candidates: ${REQUIRED_BACKLOG_IDS.filter((id)=>entries.some((e)=>e.id===id)).length}`,
    `- Required code-visible leaves: ${Object.values(REQUIRED_LEAVES).flat().length}`,
    `- Cataloged code-visible leaves: ${Object.entries(REQUIRED_LEAVES).flatMap(([f,ls])=>ls.map((l)=>entries.some((e)=>e.id===`${f}:${l}`))).filter(Boolean).length}`,'',
    '### Catalog entries absent from runtime code','',
    ...(absentFromCode.length ? absentFromCode.map((e)=>`- \`${e.id}\` (${e.status}, ${e.priority})`) : ['None.']),'',
    '## Canonical entries','',
    '| ID | Kind | Status | Family | Runtime ID | Content | Output |','| --- | --- | --- | --- | --- | --- | --- |',
    ...entries.map((e)=>`| \`${e.id}\` | ${e.kind} | ${e.status} | \`${e.familyId}\` | ${e.runtime.runtimeId ? `\`${e.runtime.runtimeId}\`` : '—'} | ${e.content.join(', ')} | ${e.outputs.join(', ') || '—'} |`),''
  ];
  void runtimeIds;
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
