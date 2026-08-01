import { OMSSServer } from '@omss/framework';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { knownThirdPartyProxies } from './thirdPartyProxies.js';
import { streamPatterns } from './streamPatterns.js';
import { installProviderHealthControl } from './provider-health.js';
import {
    createInternalRecheckServer,
    validateInternalRecheckHost,
    validateInternalRecheckToken
} from './health/internal-recheck-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    const server = new OMSSServer({
        name: 'CinePro',
        version: '1.0.0',

        // Network
        host: process.env.HOST ?? 'localhost',
        port: Number(process.env.PORT ?? 3000),
        publicUrl: process.env.PUBLIC_URL,

        // Cache (memory for dev, Redis for prod)
        cache: {
            type: (process.env.CACHE_TYPE as 'memory' | 'redis') ?? 'memory',
            ttl: {
                sources: 60 * 60,
                subtitles: 60 * 60 * 24,
                liveManifest: Number(
                    process.env.LIVE_MANIFEST_CACHE_TTL ??
                        process.env.APISPORTS_CACHE_TTL_SECONDS ??
                        6 * 60 * 60
                ),
                liveSources: Number(process.env.LIVE_SOURCE_CACHE_TTL ?? 30)
            },
            redis: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
                password: process.env.REDIS_PASSWORD
            }
        },

        // TMDB
        tmdb: {
            apiKey: process.env.TMDB_API_KEY!,
            cacheTTL: 24 * 60 * 60 // 24h
        },

        // Third Party Proxy removal
        proxyConfig: {
            knownThirdPartyProxies: knownThirdPartyProxies,
            streamPatterns
        },

        cors: {
            origin: process.env.CORS_ORIGIN ?? '*',
            methods: ['GET', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
            preflightContinue: false,
            optionsSuccessStatus: 204
        },

        stremio: {
            // exposes a stremio addon on /stremio/manifest.json
            enableNativeAddon: process.env.STREMIO_ADDON === 'true',
            // you can your own custom stremio addons as sources into cinepro.
            stremioAddons: []
            /*
            stremioAddons: [
                {
                    id: 'some-unique-id',
                    url: 'https://example.com/manifest.json',
                    enabled: true
                }
            ]
            */
        },

        // MCP for AI agents
        mcp: {
            enabled: process.env.MCP_ENABLED === 'true'
        }
    });

    // Register providers
    const registry = server.getRegistry();
    await registry.discoverProviders(path.join(__dirname, './providers/'));
    const catalog = JSON.parse(
        await readFile(
            path.join(__dirname, '../config/provider-catalog.yaml'),
            'utf8'
        )
    );
    const healthControl = await installProviderHealthControl(
        registry,
        catalog.entries
    );

    await server.start();
    let internalServer:
        | ReturnType<typeof createInternalRecheckServer>
        | undefined;
    const internalToken = process.env.CINEPRO_INTERNAL_RECHECK_TOKEN;
    if (internalToken) {
        try {
            validateInternalRecheckToken(internalToken);
            internalServer = createInternalRecheckServer({
                token: internalToken,
                control: healthControl,
                globalConcurrency: boundedIntegerEnv(
                    process.env.CINEPRO_INTERNAL_RECHECK_CONCURRENCY,
                    4,
                    1,
                    16
                )
            });
            await listen(
                internalServer,
                boundedIntegerEnv(
                    process.env.CINEPRO_INTERNAL_RECHECK_PORT,
                    3011,
                    1,
                    65_535
                ),
                boundedHost(
                    process.env.CINEPRO_INTERNAL_RECHECK_HOST ?? '127.0.0.1'
                )
            );
        } catch (error) {
            await server.stop();
            throw error;
        }
    }

    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        if (internalServer) {
            await new Promise<void>((resolve) =>
                internalServer!.close(() => resolve())
            );
        }
        await server.stop();
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
            void stop().finally(() => process.exit(0));
        });
    }

    const publicUrl =
        process.env.PUBLIC_URL ??
        `http://${process.env.HOST ?? 'localhost'}:${process.env.PORT ?? 3000}`;

    const uiUrl = `https://ui.cinepro.cc/?omssurl=${encodeURIComponent(publicUrl)}`;

    const title = '🚀 CinePro/ui is in public testing';
    const contrib =
        '🤝 We are looking for contributors to improve and develop!';
    const repo = 'Contribute: https://github.com/cinepro-org/ui';
    const tryIt = `🌐 Try it out: ${uiUrl} !`;
    const note =
        'You will need to give the website "access to local applications" that it works.';

    const lines = [title, '', repo, '', contrib, '', tryIt, '', note];

    // compute box width based on longest line
    const width = Math.max(...lines.map((l) => l.length)) + 2;

    const borderTop = '╭' + '─'.repeat(width) + '╮';
    const borderBottom = '╰' + '─'.repeat(width) + '╯';

    const pad = (line: string) => '│ ' + line.padEnd(width - 2, ' ') + ' │';

    console.log(`
================== CINEPRO BETA ANNOUNCEMENT ==================

${borderTop}
${lines.map(pad).join('\n')}
${borderBottom}
`);
}

function listen(
    server: ReturnType<typeof createInternalRecheckServer>,
    port: number,
    host: string
): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function boundedIntegerEnv(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number
): number {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new TypeError(
            'Internal recheck numeric configuration is invalid'
        );
    }
    return parsed;
}

function boundedHost(value: string): string {
    return validateInternalRecheckHost(value);
}

main().catch(() => {
    process.exit(1);
});
