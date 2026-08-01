import { createHash, timingSafeEqual } from 'node:crypto';
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse
} from 'node:http';
import type { HealthResult } from './provider-health.js';
import { providerRecheckSettlement } from '../provider-health.js';

const MAX_BODY_BYTES = 1024;
const MAX_URL_BYTES = 256;
const ID = '[a-z0-9]+(?:-[a-z0-9]+)*';
const RECHECK_PATH = new RegExp(`^/internal/provider-health/recheck/(${ID})$`);

export type RecheckControl = {
    recheck(id: string): Promise<HealthResult>;
};

export type InternalRecheckServerOptions = {
    token: string;
    control: RecheckControl;
    globalConcurrency?: number;
};

export function validateInternalRecheckToken(token: string): string {
    if (
        Buffer.byteLength(token) < 32 ||
        Buffer.byteLength(token) > 256 ||
        /[\s\0]/.test(token)
    ) {
        throw new TypeError(
            'Internal recheck token must be a strong bounded secret'
        );
    }
    return token;
}

const INTERNAL_RECHECK_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);

export function validateInternalRecheckHost(host: string): string {
    if (!INTERNAL_RECHECK_HOSTS.has(host)) {
        throw new TypeError(
            'Internal recheck host must be an explicit loopback or container wildcard literal'
        );
    }
    return host;
}

export function createInternalRecheckServer(
    options: InternalRecheckServerOptions
): Server {
    const expectedToken = validateInternalRecheckToken(options.token);
    const globalConcurrency = boundedInteger(
        options.globalConcurrency ?? 4,
        1,
        16,
        'Internal recheck concurrency'
    );
    const inFlight = new Map<string, Promise<HealthResult>>();
    let active = 0;

    return createServer(
        {
            headersTimeout: 5_000,
            requestTimeout: 5_000,
            keepAliveTimeout: 5_000,
            maxHeaderSize: 8 * 1024
        },
        (request, response) => {
            void handle(request, response).catch(() => {
                send(response, 500, { error: 'INTERNAL_ERROR' });
            });
        }
    );

    async function handle(
        request: IncomingMessage,
        response: ServerResponse
    ): Promise<void> {
        secureHeaders(response);
        if (!authorized(request.headers.authorization, expectedToken)) {
            send(response, 401, { error: 'UNAUTHORIZED' });
            return;
        }
        if (request.method !== 'POST') {
            response.setHeader('Allow', 'POST');
            send(response, 405, { error: 'METHOD_NOT_ALLOWED' });
            return;
        }
        const rawUrl = request.url ?? '';
        if (Buffer.byteLength(rawUrl) > MAX_URL_BYTES) {
            send(response, 414, { error: 'INVALID_PATH' });
            return;
        }
        const match = RECHECK_PATH.exec(rawUrl);
        if (!match) {
            send(response, 404, { error: 'NOT_FOUND' });
            return;
        }
        if (request.headers['content-type'] !== 'application/json') {
            send(response, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
            return;
        }
        const contentLength = request.headers['content-length'];
        if (
            contentLength !== undefined &&
            (!/^(?:0|[1-9][0-9]{0,3})$/.test(contentLength) ||
                Number(contentLength) > MAX_BODY_BYTES)
        ) {
            request.resume();
            send(response, 413, { error: 'BODY_TOO_LARGE' });
            return;
        }
        const body = await readBody(request);
        if (body === undefined) {
            send(response, 413, { error: 'BODY_TOO_LARGE' });
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch {
            send(response, 400, { error: 'INVALID_BODY' });
            return;
        }
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed) ||
            Object.keys(parsed).length !== 0
        ) {
            send(response, 400, { error: 'INVALID_BODY' });
            return;
        }

        const id = match[1];
        let work = inFlight.get(id);
        if (!work) {
            if (active >= globalConcurrency) {
                send(response, 429, { error: 'RECHECK_BUSY' });
                return;
            }
            active++;
            work = options.control.recheck(id);
            void providerRecheckSettlement(work).finally(() => {
                active--;
                if (inFlight.get(id) === work) inFlight.delete(id);
            });
            inFlight.set(id, work);
        }
        try {
            send(response, 200, { result: await work });
        } catch (error) {
            const code = recheckErrorCode(error);
            send(
                response,
                code === 'UNKNOWN_PROVIDER'
                    ? 404
                    : code === 'RECHECK_BUSY'
                      ? 429
                      : 400,
                { error: code }
            );
        }
    }
}

function authorized(header: string | undefined, token: string): boolean {
    const candidate =
        typeof header === 'string' && header.startsWith('Bearer ')
            ? header.slice(7)
            : '';
    const expected = createHash('sha256').update(token).digest();
    const actual = createHash('sha256').update(candidate).digest();
    return timingSafeEqual(expected, actual) && candidate.length > 0;
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        length += chunk.length;
        if (length > MAX_BODY_BYTES) return undefined;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function secureHeaders(response: ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
}

function send(
    response: ServerResponse,
    status: number,
    body: Record<string, unknown>
): void {
    if (response.headersSent || response.destroyed) return;
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.end(`${JSON.stringify(body)}\n`);
}

function recheckErrorCode(error: unknown): string {
    if (
        error instanceof Error &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
    ) {
        return error.message;
    }
    return 'RECHECK_FAILED';
}

function boundedInteger(
    value: number,
    minimum: number,
    maximum: number,
    label: string
): number {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
