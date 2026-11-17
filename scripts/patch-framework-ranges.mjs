import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const known = new Set([
    'fda715cf5e8c64cd6ecb38976d8b31146b9f3e3741e5b2b09665fd666d14b321',
    '6dff12989f807652d38632bee8e013529d8a6e557de2dc53adf126988358933e'
]);
const original = `        const rangeHeader = proxyData.headers?.['range'] ?? proxyData.headers?.['Range'];
        const headers = {
            ...(proxyData.headers ?? {}),
            ...(rangeHeader ? { Range: rangeHeader } : {}),
        };`;
const replacement = `        // Saucy: normalize Range once; Fetch otherwise joins case-variant keys.
        const suppliedHeaders = proxyData.headers ?? {};
        const rangeHeader = suppliedHeaders['range'] ?? suppliedHeaders['Range'] ?? Object.entries(suppliedHeaders).find(([key]) => key.toLowerCase() === 'range')?.[1];
        const headers = Object.fromEntries(Object.entries(suppliedHeaders).filter(([key]) => key.toLowerCase() !== 'range'));
        if (rangeHeader) headers.Range = rangeHeader;`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
export function patchFrameworkRanges(source) {
    if (known.has(sha(source)) && source.split(original).length === 2)
        return source.replace(original, replacement);
    if (
        source.split(replacement).length === 2 &&
        known.has(sha(source.replace(replacement, original)))
    )
        return source;
    throw new Error(
        'Unrecognized pinned framework proxy bytes; Range overlay refused'
    );
}
if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
    const target = resolve(
        'node_modules/@omss/framework/dist/services/proxy.service.js'
    );
    const source = await readFile(target, 'utf8');
    const patched = patchFrameworkRanges(source);
    if (patched !== source) await writeFile(target, patched);
    console.log('Pinned framework Range compatibility verified.');
}
