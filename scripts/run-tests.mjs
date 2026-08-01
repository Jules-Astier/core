import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const searchRoots = ['test', path.join('src', 'providers')];

async function collectTests(relativeDirectory) {
    const absoluteDirectory = path.join(root, relativeDirectory);
    let entries;
    try {
        entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }

    const files = [];
    for (const entry of entries) {
        const relativePath = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectTests(relativePath)));
        } else if (entry.isFile() && /\.test\.ts$/i.test(entry.name)) {
            files.push(relativePath);
        }
    }
    return files;
}

const testFiles = (
    await Promise.all(searchRoots.map((directory) => collectTests(directory)))
)
    .flat()
    .sort();

if (!testFiles.length) {
    console.error('No .test.ts files found in test/ or src/providers/.');
    process.exit(1);
}

const executable =
    process.platform === 'win32'
        ? path.join(root, 'node_modules', '.bin', 'tsx.cmd')
        : path.join(root, 'node_modules', '.bin', 'tsx');

const child = spawn(executable, ['--test', ...testFiles], {
    cwd: root,
    stdio: 'inherit'
});

child.on('error', (error) => {
    console.error(error);
    process.exit(1);
});

child.on('exit', (code, signal) => {
    if (signal) {
        console.error(`Test runner exited from signal ${signal}.`);
        process.exit(1);
    }
    process.exit(code ?? 1);
});

