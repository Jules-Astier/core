#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { assertValidCatalog, DEFAULT_REPORT_PATH, generateReport, loadCatalog } from './provider-catalog-lib.mjs';

const check = process.argv.includes('--check');
try {
  const catalog = await assertValidCatalog(await loadCatalog());
  const report = await generateReport(catalog);
  if (check) {
    const current = await readFile(DEFAULT_REPORT_PATH, 'utf8');
    if (current !== report) throw new Error('Generated provider report is stale. Run node scripts/generate-provider-report.mjs');
    console.log('Provider catalog report is up to date.');
  } else {
    await writeFile(DEFAULT_REPORT_PATH, report);
    console.log(`Wrote ${DEFAULT_REPORT_PATH}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
