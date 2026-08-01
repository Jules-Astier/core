#!/usr/bin/env node
import { assertValidCatalog, loadCatalog } from './provider-catalog-lib.mjs';

try {
  const catalog = await loadCatalog(process.argv[2]);
  await assertValidCatalog(catalog);
  console.log(`Provider catalog is valid (${catalog.entries.length} entries).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
