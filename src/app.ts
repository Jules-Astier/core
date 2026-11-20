// CinePro as a library: build the OMSS server, its providers, the provider
// health control and the optional internal recheck server without starting
// a process of its own. `src/server.ts` (the standalone service) and
// embedding hosts (for example Saucy Streams' unified backend, which serves
// CinePro's routes in-process) share this one construction path, so both
// run the same providers, catalog, health control and proxy.
//
// Nothing here installs signal handlers, calls process.exit, or listens on a
// port unless asked to: the host owns the process lifecycle.
import { OMSSServer } from '@omss/framework';
import type { Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { knownThirdPartyProxies } from './thirdPartyProxies.js';
import { streamPatterns } from './streamPatterns.js';
import {
    installProviderHealthControl,
    type ProviderHealthControl
} from './provider-health.js';
import {
    createInternalRecheckServer,
    validateInternalRecheckHost,
    validateInternalRecheckToken
} from './health/internal-recheck-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type CineProEnv = Record<string, string | undefined>;

export type CineProOptions = {
    /** Configuration source; defaults to process.env. */
    env?: CineProEnv;
    /** Listen address of the public routes when `listen()` is called. */
    host?: string;
    port?: number;
    /** Origin CinePro writes into its proxy URLs (PUBLIC_URL). */
    publicUrl?: string;
};

export type CineProApp = {
    /** The OMSS server (framework). */
    omss: OMSSServer;
    /**
     * CinePro's Node HTTP server (Fastify's), ready to route requests. An
     * embedding host can hand it connections itself (`server.emit(
     * 'connection', socket)`) without listening on a port.
     */
    httpServer: HttpServer;
    /** The internal recheck server, when a recheck token is configured. */
    recheckServer?: HttpServer;
    recheckPort: number;
    recheckHost: string;
    healthControl: ProviderHealthControl;
    /** Listen on `host:port` (and the recheck server on its own port). */
    listen(options?: { recheck?: boolean }): Promise<void>;
    /** Close listeners and caches. Idempotent. */
    stop(): Promise<void>;
};

/** Build CinePro: providers discovered, health control installed, routes ready. */
export async function createCinePro(
    options: CineProOptions = {}
): Promise<CineProApp> {
    const env = options.env ?? process.env;
    const host = options.host ?? env.HOST ?? 'localhost';
    const port = options.port ?? Number(env.PORT ?? 3000);
    const omss = new OMSSServer({
        name: 'CinePro',
        version: '1.0.0',

        // Network
        host,
        port,
        publicUrl: options.publicUrl ?? env.PUBLIC_URL,

        // Cache (memory for dev, Redis for prod)
        cache: {
            type: (env.CACHE_TYPE as 'memory' | 'redis') ?? 'memory',
            ttl: {
                sources: 60 * 60,
                subtitles: 60 * 60 * 24,
                liveManifest: Number(env.LIVE_MANIFEST_CACHE_TTL ?? 60),
                liveSources: Number(env.LIVE_SOURCE_CACHE_TTL ?? 30)
            },
            redis: {
                host: env.REDIS_HOST ?? 'localhost',
                port: Number(env.REDIS_PORT ?? 6379),
                password: env.REDIS_PASSWORD
            }
        },

        // TMDB
        tmdb: {
            apiKey: env.TMDB_API_KEY!,
            cacheTTL: 24 * 60 * 60 // 24h
        },

        // Third Party Proxy removal
        proxyConfig: {
            knownThirdPartyProxies: knownThirdPartyProxies,
            streamPatterns
        },

        cors: {
            origin: env.CORS_ORIGIN ?? '*',
            methods: ['GET', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
            preflightContinue: false,
            optionsSuccessStatus: 204
        },

        stremio: {
            // exposes a stremio addon on /stremio/manifest.json
            enableNativeAddon: env.STREMIO_ADDON === 'true',
            // you can your own custom stremio addons as sources into cinepro.
            stremioAddons: []
        },

        // MCP for AI agents
        mcp: {
            enabled: env.MCP_ENABLED === 'true'
        }
    });

    // Register providers
    const registry = omss.getRegistry();
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

    const fastify = omss.getInstance();
    // Routes, plugins and hooks are registered; requests can be routed.
    await fastify.ready();

    let recheckServer: HttpServer | undefined;
    let recheckPort = 3011;
    let recheckHost = env.CINEPRO_INTERNAL_RECHECK_HOST ?? '127.0.0.1';
    const internalToken = env.CINEPRO_INTERNAL_RECHECK_TOKEN;
    if (internalToken) {
        validateInternalRecheckToken(internalToken);
        recheckHost = validateInternalRecheckHost(recheckHost);
        recheckPort = boundedIntegerEnv(
            env.CINEPRO_INTERNAL_RECHECK_PORT,
            3011,
            1,
            65_535
        );
        recheckServer = createInternalRecheckServer({
            token: internalToken,
            control: healthControl,
            globalConcurrency: boundedIntegerEnv(
                env.CINEPRO_INTERNAL_RECHECK_CONCURRENCY,
                4,
                1,
                16
            )
        });
    }

    let listening = false;
    let stopped: Promise<void> | undefined;
    return {
        omss,
        httpServer: fastify.server,
        recheckServer,
        recheckPort,
        recheckHost,
        healthControl,
        async listen({ recheck = true } = {}) {
            if (listening) return;
            listening = true;
            await omss.start();
            if (recheck && recheckServer) {
                try {
                    await listen(recheckServer, recheckPort, recheckHost);
                } catch (error) {
                    await omss.stop();
                    throw error;
                }
            }
        },
        stop() {
            stopped ??= (async () => {
                if (recheckServer?.listening) {
                    await new Promise<void>((resolve) =>
                        recheckServer!.close(() => resolve())
                    );
                }
                await omss.stop();
            })();
            return stopped;
        }
    };
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
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
