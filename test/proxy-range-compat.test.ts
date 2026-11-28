import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchFrameworkRanges } from '../scripts/patch-framework-ranges.mjs';
import { streamPatterns } from '../src/streamPatterns.js';
const modulePath = resolve(
    'node_modules/@omss/framework/dist/services/proxy.service.js'
);
test('guarded overlay is idempotent and rejects unrelated dependency bytes', async () => {
    const source = await readFile(modulePath, 'utf8');
    assert.equal(patchFrameworkRanges(source), source);
    assert.throws(() => patchFrameworkRanges(source + '\n// drift'), /refused/);
});
test('actual streaming proxy forwards exactly one caller Range header', async () => {
    const { ProxyService } = await import(pathToFileURL(modulePath).href);
    let seen: string | undefined;
    const server = createServer((req, res) => {
        seen = req.headers.range;
        if (seen === 'bytes=10-19') {
            res.writeHead(206, {
                'Content-Type': 'video/mp4',
                'Content-Range': 'bytes 10-19/100',
                'Content-Length': '10'
            });
            res.end('0123456789');
        } else {
            res.writeHead(416);
            res.end('invalid range');
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        const proxy = new ProxyService();
        const response = await proxy.proxyRequest(
            encodeURIComponent(
                JSON.stringify({
                    url: `http://127.0.0.1:${address.port}/video.mp4`,
                    headers: { Range: 'bytes=0-', range: 'bytes=10-19' }
                })
            )
        );
        assert.equal(response.statusCode, 206);
        assert.equal(seen, 'bytes=10-19');
        assert.ok('stream' in response);
        let content = '';
        for await (const chunk of response.stream) content += chunk.toString();
        assert.equal(content, '0123456789');
        assert.equal(response.headers['Content-Range'], 'bytes 10-19/100');
    } finally {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
    }
});
test('extensionless WCO MP4 is streamed without matching lookalike hosts', async () => {
    const { ProxyService } = await import(pathToFileURL(modulePath).href);
    const proxy = new ProxyService(streamPatterns);
    assert.equal(
        proxy.shouldStream(
            'https://neptun.wcostream.com/getvid?evid=synthetic'
        ),
        true
    );
    assert.equal(
        proxy.shouldStream(
            'https://neptun.wcostream.com.evil.invalid/getvid?evid=synthetic'
        ),
        false
    );
});

test('NHL24ALL delivers segment bytes early and still buffers playlists for rewriting', async (t) => {
    const { ProxyService } = await import(pathToFileURL(modulePath).href);
    const proxy = new ProxyService(streamPatterns);
    const segment = 'https://node-example.mlb9.com/live/media-123.ts?fixture=1';
    assert.equal(proxy.shouldStream(segment), true);
    for (const url of [
        'https://node-example.mlb9.com/live/media.m3u8',
        'https://node-example.mlb9.com/live/media.m3u8?name=chunk.ts',
        'https://node-example.mlb9.com.example.invalid/live/media-123.ts'
    ]) assert.equal(proxy.shouldStream(url), false);

    let finishSegment = () => {};
    t.mock.method(proxy, 'fetchWithTimeout', async () => new Response(new ReadableStream({
        start(body) {
            body.enqueue(Uint8Array.of(0x47));
            finishSegment = () => {
                body.enqueue(Uint8Array.of(0x17));
                body.close();
            };
        }
    }), { headers: { 'Content-Type': 'video/mp2t' } }));

    const response = await proxy.proxyRequest(encodeURIComponent(JSON.stringify({ url: segment })));
    assert.ok('stream' in response);
    const reader = response.stream[Symbol.asyncIterator]();
    try {
        const first = await reader.next();
        assert.deepEqual([...first.value], [0x47]);
    } finally {
        finishSegment();
    }
    const last = await reader.next();
    assert.deepEqual([...last.value], [0x17]);
    assert.equal((await reader.next()).done, true);
});
