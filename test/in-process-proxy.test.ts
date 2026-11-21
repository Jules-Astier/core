// The in-process /v1/proxy (src/in-process-proxy.ts) against the HTTP route
// of the same server: status, headers and body bytes must match for every
// kind of answer the relay sees (buffered segments, rewritten playlists,
// streamed ranges, 416, upstream failures, bad parameters, HEAD, Accept).
// The provider-less proxy of src/app.ts (createCineProProxy, CinePro's own
// configuration) must answer the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { OMSSServer } from '@omss/framework';
import { createInProcessProxy } from '../src/in-process-proxy.js';
import { createCineProProxy } from '../src/app.js';
import { streamPatterns } from '../src/streamPatterns.js';

// As deployed: error bodies without stacks.
process.env.NODE_ENV = 'production';

const SEGMENT = Buffer.alloc(300_000, 0);
for (let i = 0; i < SEGMENT.length; i++) SEGMENT[i] = (i * 31 + 7) & 0xff;
const MP4 = Buffer.alloc(200_000, 0);
for (let i = 0; i < MP4.length; i++) MP4[i] = (i * 13 + 1) & 0xff;

let upstreamClosedEarly = 0;
const upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/seg.ts') {
        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Content-Length': SEGMENT.length,
            'Cache-Control': 'max-age=60'
        });
        res.end(SEGMENT);
    } else if (url.pathname === '/index.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(
            '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\nseg.ts\n#EXT-X-ENDLIST\n'
        );
    } else if (url.pathname === '/movie.mp4') {
        const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
        if (range && Number(range[1]) >= MP4.length) {
            res.writeHead(416, { 'Content-Range': `bytes */${MP4.length}` });
            res.end();
            return;
        }
        const start = range ? Number(range[1]) : 0;
        const end = range && range[2] ? Number(range[2]) : MP4.length - 1;
        res.on('close', () => {
            if (!res.writableFinished) upstreamClosedEarly++;
        });
        res.writeHead(range ? 206 : 200, {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            ETag: '"mp4"',
            'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${MP4.length}` } : {})
        });
        // Slowly, so an abort lands mid-body.
        const body = MP4.subarray(start, end + 1);
        let at = 0;
        const timer = setInterval(() => {
            if (at >= body.length || res.destroyed) {
                clearInterval(timer);
                res.end();
                return;
            }
            res.write(body.subarray(at, (at += 16_384)));
        }, 2);
    } else if (url.pathname === '/reset.mp4') {
        // Headers, then the connection dies before the first body byte.
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 1000 });
        res.flushHeaders();
        setTimeout(() => res.socket?.destroy(), 20);
    } else if (url.pathname === '/broken') {
        res.writeHead(502);
        res.end('bad gateway');
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('nope');
    }
});

const cors = {
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
    preflightContinue: false,
    optionsSuccessStatus: 204
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const VOLATILE = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding']);

function viaHttp(
    port: number,
    method: string,
    target: string,
    headers: Record<string, string>
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            { host: '127.0.0.1', port, method, path: target, headers, agent: false },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const out: Record<string, string> = {};
                    for (const [k, v] of Object.entries(res.headers))
                        if (!VOLATILE.has(k)) out[k] = String(v);
                    resolve({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks) });
                });
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.end();
    });
}

async function bodyOf(body: Buffer | Readable | null): Promise<Buffer> {
    if (!body) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks);
}

test('the in-process proxy answers exactly as the HTTP route', async (t) => {
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const previousKey = process.env.TMDB_API_KEY;
    process.env.TMDB_API_KEY ??= 'in-process-proxy-test';
    const omss = new OMSSServer({
        name: 'CinePro',
        version: '1.0.0',
        host: '127.0.0.1',
        port: 0,
        publicUrl: 'http://cinepro.test:3000',
        cache: { type: 'memory' },
        tmdb: { apiKey: 'test', cacheTTL: 60 },
        proxyConfig: { knownThirdPartyProxies: [], streamPatterns },
        cors
    } as ConstructorParameters<typeof OMSSServer>[0]);
    const fastify = omss.getInstance();
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    const port = (fastify.server.address() as AddressInfo).port;
    const proxy = await createInProcessProxy(omss, cors);
    const quietStart = t.mock.method(console, 'log', () => {});
    const alone = await createCineProProxy({
        env: { NODE_ENV: 'production' },
        publicUrl: 'http://cinepro.test:3000'
    });
    quietStart.mock.restore();
    t.after(async () => {
        await omss.stop();
        await alone.stop();
        upstream.closeAllConnections();
        upstream.close();
        if (previousKey === undefined) delete process.env.TMDB_API_KEY;
    });

    const data = (url: string, extra: Record<string, unknown> = {}) =>
        '?data=' + encodeURIComponent(JSON.stringify({ url, headers: { Referer: 'https://x.test/' }, ...extra }));
    const base = { accept: '*/*', 'user-agent': 'node', 'accept-encoding': 'identity' };
    const cases: [string, string, string, Record<string, string>][] = [
        ['segment', 'GET', data(`${upstreamUrl}/seg.ts`), base],
        ['segment HEAD', 'HEAD', data(`${upstreamUrl}/seg.ts`), base],
        ['playlist (rewritten)', 'GET', data(`${upstreamUrl}/index.m3u8`), base],
        ['mp4 whole (streamed)', 'GET', data(`${upstreamUrl}/movie.mp4`), base],
        ['mp4 range', 'GET', data(`${upstreamUrl}/movie.mp4`), { ...base, range: 'bytes=1000-50999' }],
        ['mp4 open range', 'GET', data(`${upstreamUrl}/movie.mp4`), { ...base, range: 'bytes=199000-' }],
        ['mp4 416', 'GET', data(`${upstreamUrl}/movie.mp4`), { ...base, range: 'bytes=999999-' }],
        ['mp4 HEAD', 'HEAD', data(`${upstreamUrl}/movie.mp4`), base],
        ['upstream 502', 'GET', data(`${upstreamUrl}/broken`), base],
        ['upstream 404', 'GET', data(`${upstreamUrl}/missing.ts`), base],
        ['upstream refused', 'GET', data('http://127.0.0.1:9/seg.ts'), base],
        ['missing data', 'GET', '', base],
        ['invalid data', 'GET', '?data=%7Bnot-json', base],
        ['unsupported transform', 'GET', data(`${upstreamUrl}/seg.ts`, { responseTransform: 'x' }), base],
        ['Accept refused', 'GET', data(`${upstreamUrl}/seg.ts`), { ...base, accept: 'text/html' }],
        ['error HEAD', 'HEAD', data(`${upstreamUrl}/broken`), base],
        ['upstream reset mid-stream', 'GET', data(`${upstreamUrl}/reset.mp4`), base]
    ];
    const quiet = t.mock.method(console, 'log', () => {});
    const quietErrors = t.mock.method(console, 'error', () => {});
    try {
        for (const [name, method, search, headers] of cases) {
            const http = await viaHttp(port, method, `/v1/proxy${search}`, headers);
            for (const [kind, call] of [
                ['in-process', proxy],
                ['createCineProProxy', alone.proxy]
            ] as const) {
                const local = await call({ method, search, headers });
                const localBody = await bodyOf(local.body);
                local.done();
                const label = `${name} (${kind})`;
                const normalize = (s: string) => s.replace(UUID, '<uuid>');
                assert.equal(local.status, http.status, `${label}: status`);
                assert.deepEqual(
                    JSON.parse(normalize(JSON.stringify(local.headers))),
                    JSON.parse(normalize(JSON.stringify(http.headers))),
                    `${label}: headers`
                );
                if (http.headers['content-type']?.startsWith('application/json'))
                    assert.equal(normalize(localBody.toString()), normalize(http.body.toString()), `${label}: body`);
                else assert.ok(localBody.equals(http.body), `${label}: body bytes`);
            }
        }
    } finally {
        quiet.mock.restore();
        quietErrors.mock.restore();
    }
});

test('destroying a streamed body aborts the upstream request', async (t) => {
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    process.env.TMDB_API_KEY ??= 'in-process-proxy-test';
    const omss = new OMSSServer({
        name: 'CinePro',
        version: '1.0.0',
        host: '127.0.0.1',
        port: 0,
        publicUrl: 'http://cinepro.test:3000',
        cache: { type: 'memory' },
        tmdb: { apiKey: 'test', cacheTTL: 60 },
        proxyConfig: { knownThirdPartyProxies: [], streamPatterns },
        cors
    } as ConstructorParameters<typeof OMSSServer>[0]);
    const proxy = await createInProcessProxy(omss, cors);
    t.after(async () => {
        await omss.stop();
        upstream.closeAllConnections();
        upstream.close();
    });
    const quiet = t.mock.method(console, 'log', () => {});
    try {
        const before = upstreamClosedEarly;
        const answer = await proxy({
            search: '?data=' + encodeURIComponent(JSON.stringify({ url: `${upstreamUrl}/movie.mp4` })),
            headers: { accept: '*/*' }
        });
        assert.equal(answer.status, 200);
        assert.ok(answer.body instanceof Readable);
        const stream = answer.body as Readable;
        await once(stream, 'readable');
        stream.destroy();
        answer.done();
        for (let i = 0; i < 100 && upstreamClosedEarly === before; i++)
            await new Promise((r) => setTimeout(r, 10));
        assert.equal(upstreamClosedEarly, before + 1, 'the upstream response was cut');
    } finally {
        quiet.mock.restore();
    }
});
