import { mkdir, copyFile } from 'node:fs/promises';
await mkdir(new URL('../dist/providers/wco/', import.meta.url), {
    recursive: true
});
await copyFile(
    new URL('../src/providers/wco/public-page.py', import.meta.url),
    new URL('../dist/providers/wco/public-page.py', import.meta.url)
);
