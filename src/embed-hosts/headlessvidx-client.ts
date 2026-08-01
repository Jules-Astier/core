import type {
    EmbedLimits,
    HeadlessVidXClient,
    HeadlessVidXResult,
    PlaybackHeaders
} from './types.js';

export interface HeadlessVidXTransport {
    request(input: {
        origin: URL;
        path: '/resolve';
        body: string;
        headers: Readonly<{ 'Content-Type': 'application/json' }>;
        redirect: 'error';
        signal: AbortSignal;
        maxResponseBytes: number;
    }): Promise<{ status: number; contentType: string; body: string }>;
}

export function createHeadlessVidXClient(options: {
    serviceOrigin: URL;
    transport: HeadlessVidXTransport;
    limits: Pick<
        EmbedLimits,
        'deadlineMs' | 'maxResponseBytes' | 'maxTargets' | 'maxUrlLength'
    >;
    authorize: (url: URL) => boolean;
}): HeadlessVidXClient {
    const originText = validatePrivateOrigin(options.serviceOrigin);
    return Object.freeze({
        async resolve(request: {
            embedUrl: URL;
            headers: Readonly<PlaybackHeaders>;
            signal: AbortSignal;
        }): Promise<HeadlessVidXResult> {
            if (
                request.signal.aborted ||
                request.embedUrl.href.length > options.limits.maxUrlLength
            ) {
                throw new TypeError('HeadlessVidX request is not bounded');
            }
            if (!options.authorize(request.embedUrl)) {
                throw new TypeError(
                    'HeadlessVidX URL was not registry-authorized'
                );
            }
            const body = JSON.stringify({
                url: request.embedUrl.toString(),
                headers: request.headers
            });
            if (Buffer.byteLength(body) > options.limits.maxResponseBytes) {
                throw new TypeError('HeadlessVidX request is not bounded');
            }
            const controller = new AbortController();
            const forwardAbort = () => controller.abort();
            request.signal.addEventListener('abort', forwardAbort, {
                once: true
            });
            const timer = setTimeout(
                () => controller.abort(),
                options.limits.deadlineMs
            );
            const transport = options.transport.request({
                origin: new URL(originText),
                path: '/resolve',
                body,
                headers: { 'Content-Type': 'application/json' },
                redirect: 'error',
                signal: controller.signal,
                maxResponseBytes: options.limits.maxResponseBytes
            });
            let response: Awaited<typeof transport>;
            try {
                response = await Promise.race([
                    transport,
                    aborted(controller.signal)
                ]);
            } finally {
                clearTimeout(timer);
                request.signal.removeEventListener('abort', forwardAbort);
            }
            if (
                response.status < 200 ||
                response.status >= 300 ||
                response.contentType.split(';')[0].trim() !==
                    'application/json' ||
                Buffer.byteLength(response.body) >
                    options.limits.maxResponseBytes
            ) {
                return { ok: false, reason: 'PARSE_FAILED' };
            }
            let value: unknown;
            try {
                value = JSON.parse(response.body);
            } catch {
                return { ok: false, reason: 'PARSE_FAILED' };
            }
            if (isFailure(value)) return value;
            if (
                !isSuccess(value) ||
                value.targets.length > options.limits.maxTargets
            ) {
                return { ok: false, reason: 'PARSE_FAILED' };
            }
            return {
                ok: true,
                targets: value.targets.map((target) => ({
                    url: new URL(target.url),
                    type: target.type,
                    quality: target.quality,
                    requestHeaders: target.requestHeaders ?? {}
                }))
            };
        }
    });
}

function validatePrivateOrigin(input: URL): string {
    const origin = new URL(input);
    if (
        origin.protocol !== 'http:' ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        origin.port === '' ||
        !isPrivateIp(origin.hostname)
    ) {
        throw new TypeError(
            'HeadlessVidX origin must be a fixed private HTTP origin'
        );
    }
    return origin.origin;
}

function isPrivateIp(hostname: string): boolean {
    const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const family = isIP(value);
    if (family === 4) {
        const octets = value.split('.').map(Number);
        return (
            octets[0] === 10 ||
            octets[0] === 127 ||
            (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
            (octets[0] === 192 && octets[1] === 168)
        );
    }
    return (
        family === 6 &&
        (value === '::1' ||
            value.startsWith('fc') ||
            value.startsWith('fd') ||
            /^fe[89ab]/.test(value))
    );
}

function aborted(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
        const fail = () =>
            reject(new TypeError('HeadlessVidX deadline exceeded'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
    });
}

function isFailure(
    value: unknown
): value is { ok: false; reason: 'ANTI_BOT' | 'NO_SOURCES' | 'PARSE_FAILED' } {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { ok?: unknown }).ok === false &&
        ['ANTI_BOT', 'NO_SOURCES', 'PARSE_FAILED'].includes(
            String((value as { reason?: unknown }).reason)
        )
    );
}

function isSuccess(value: unknown): value is {
    ok: true;
    targets: {
        url: string;
        type: 'hls' | 'mp4' | 'embed';
        quality: string;
        requestHeaders?: PlaybackHeaders;
    }[];
} {
    if (
        typeof value !== 'object' ||
        value === null ||
        (value as { ok?: unknown }).ok !== true ||
        !Array.isArray((value as { targets?: unknown }).targets)
    ) {
        return false;
    }
    return (value as { targets: unknown[] }).targets.every(
        (target) =>
            typeof target === 'object' &&
            target !== null &&
            typeof (target as { url?: unknown }).url === 'string' &&
            ['hls', 'mp4', 'embed'].includes(
                String((target as { type?: unknown }).type)
            ) &&
            typeof (target as { quality?: unknown }).quality === 'string'
    );
}
import { isIP } from 'node:net';
