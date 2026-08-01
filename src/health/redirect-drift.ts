import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import { ProviderHealthFailure } from './provider-health.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SHA256 = /^[a-f0-9]{64}$/;

export const REDIRECT_DRIFT_REASONS = [
    'INITIAL_ORIGIN',
    'CROSS_ORIGIN',
    'DOWNGRADE',
    'CREDENTIALS',
    'IP_LITERAL',
    'INVALID_LOCATION',
    'LOOP',
    'MAX_HOPS',
    'FINGERPRINT_MISMATCH'
] as const;

export type RedirectDriftReason = (typeof REDIRECT_DRIFT_REASONS)[number];

export class RedirectDriftFailure extends ProviderHealthFailure {
    constructor(readonly reason: RedirectDriftReason) {
        super('redirect_drift', 'REDIRECT_DRIFT');
        this.name = 'RedirectDriftFailure';
    }
}

export type RedirectDriftConfig = {
    canonicalOrigin: string;
    reviewedRedirectOrigins?: readonly string[];
    maxHops?: number;
    timeoutMs?: number;
    expectedContentSha256?: string;
    maxFingerprintBytes?: number;
};

export type RedirectFetchResponse = {
    status: number;
    headers: { get(name: string): string | null };
    body?: ReadableStream<Uint8Array> | null;
};

export type RedirectFetch = (
    input: string,
    init: { redirect: 'manual'; signal: AbortSignal }
) => Promise<RedirectFetchResponse>;

export type RedirectGuardResult = Readonly<{
    hopCount: number;
    finalOriginClass: 'canonical' | 'reviewed';
    contentSha256?: string;
}>;

type ValidatedConfig = Readonly<{
    canonicalOrigin: string;
    reviewedRedirectOrigins: readonly string[];
    maxHops: number;
    timeoutMs: number;
    expectedContentSha256?: string;
    maxFingerprintBytes: number;
}>;

/**
 * A manually-followed redirect guard for provider-controlled URL seams.
 * The injected fetch must not follow redirects itself.
 */
export class RedirectDriftGuard {
    readonly config: ValidatedConfig;
    private readonly allowedOrigins: ReadonlySet<string>;

    constructor(
        config: RedirectDriftConfig,
        private readonly fetch: RedirectFetch
    ) {
        if (typeof fetch !== 'function') {
            throw new TypeError('Redirect guard fetch must be a function');
        }
        this.config = validateConfig(config);
        this.allowedOrigins = new Set([
            this.config.canonicalOrigin,
            ...this.config.reviewedRedirectOrigins
        ]);
        Object.freeze(this);
    }

    async check(
        input: string | URL,
        signal?: AbortSignal
    ): Promise<RedirectGuardResult> {
        const initial = parseRuntimeUrl(input, 'INITIAL_ORIGIN');
        if (initial.origin !== this.config.canonicalOrigin) {
            throw new RedirectDriftFailure('INITIAL_ORIGIN');
        }

        const timeoutController = new AbortController();
        const timeoutHandle = setTimeout(
            () =>
                timeoutController.abort(
                    new DOMException(
                        'Redirect guard deadline exceeded',
                        'TimeoutError'
                    )
                ),
            this.config.timeoutMs
        );
        const requestSignal = signal
            ? AbortSignal.any([signal, timeoutController.signal])
            : timeoutController.signal;
        let current = initial;
        const visited = new Set<string>();
        let hopCount = 0;

        try {
            for (;;) {
                throwIfAborted(requestSignal);
                const key = current.href;
                if (visited.has(key)) throw new RedirectDriftFailure('LOOP');
                visited.add(key);

                let response: RedirectFetchResponse;
                try {
                    response = await fetchWithAbort(
                        this.fetch(current.href, {
                            redirect: 'manual',
                            signal: requestSignal
                        }),
                        requestSignal
                    );
                } catch {
                    throwIfAborted(requestSignal);
                    throw new ProviderHealthFailure(
                        'internal',
                        'REDIRECT_CHECK_FAILED'
                    );
                }

                try {
                    throwIfAborted(requestSignal);
                    if (!REDIRECT_STATUSES.has(response.status)) {
                        const contentSha256 = this.config.expectedContentSha256
                            ? await fingerprint(
                                  response.body,
                                  this.config.maxFingerprintBytes,
                                  requestSignal
                              )
                            : undefined;
                        if (
                            contentSha256 !== undefined &&
                            contentSha256 !== this.config.expectedContentSha256
                        ) {
                            throw new RedirectDriftFailure(
                                'FINGERPRINT_MISMATCH'
                            );
                        }
                        if (!this.config.expectedContentSha256) {
                            await cancelBody(response.body, requestSignal);
                        }
                        throwIfAborted(requestSignal);
                        return Object.freeze({
                            hopCount,
                            finalOriginClass:
                                current.origin === this.config.canonicalOrigin
                                    ? 'canonical'
                                    : 'reviewed',
                            ...(contentSha256 ? { contentSha256 } : {})
                        });
                    }

                    const location = response.headers.get('location');
                    await cancelBody(response.body, requestSignal);
                    if (!location)
                        throw new RedirectDriftFailure('INVALID_LOCATION');
                    if (hopCount >= this.config.maxHops) {
                        throw new RedirectDriftFailure('MAX_HOPS');
                    }

                    let next: URL;
                    try {
                        next = new URL(location, current);
                    } catch {
                        throw new RedirectDriftFailure('INVALID_LOCATION');
                    }
                    assertRuntimeUrl(next);
                    if (next.protocol !== 'https:') {
                        throw new RedirectDriftFailure('DOWNGRADE');
                    }
                    if (!this.allowedOrigins.has(next.origin)) {
                        throw new RedirectDriftFailure('CROSS_ORIGIN');
                    }
                    current = next;
                    hopCount += 1;
                } catch (error) {
                    await cancelBody(response.body, requestSignal, true);
                    if (error instanceof ProviderHealthFailure) throw error;
                    if (
                        requestSignal.aborted &&
                        error === requestSignal.reason
                    ) {
                        throw error;
                    }
                    throw new ProviderHealthFailure(
                        'internal',
                        'REDIRECT_CHECK_FAILED'
                    );
                }
            }
        } finally {
            clearTimeout(timeoutHandle);
        }
    }
}

function validateConfig(config: RedirectDriftConfig): ValidatedConfig {
    if (!config || typeof config !== 'object') {
        throw new TypeError('Invalid redirect guard configuration');
    }
    const canonicalOrigin = validateOrigin(config.canonicalOrigin);
    const reviewed = config.reviewedRedirectOrigins ?? [];
    if (!Array.isArray(reviewed)) {
        throw new TypeError('Invalid redirect guard configuration');
    }
    const reviewedRedirectOrigins = reviewed.map(validateOrigin);
    const unique = new Set(reviewedRedirectOrigins);
    if (
        unique.size !== reviewedRedirectOrigins.length ||
        unique.has(canonicalOrigin)
    ) {
        throw new TypeError('Invalid redirect guard configuration');
    }
    const maxHops = boundedInteger(config.maxHops ?? 3, 0, 10);
    const timeoutMs = boundedInteger(config.timeoutMs ?? 8_000, 1, 60_000);
    const maxFingerprintBytes = boundedInteger(
        config.maxFingerprintBytes ?? 16_384,
        1,
        65_536
    );
    if (
        config.expectedContentSha256 !== undefined &&
        !SHA256.test(config.expectedContentSha256)
    ) {
        throw new TypeError('Invalid redirect guard configuration');
    }
    return Object.freeze({
        canonicalOrigin,
        reviewedRedirectOrigins: Object.freeze([...reviewedRedirectOrigins]),
        maxHops,
        timeoutMs,
        expectedContentSha256: config.expectedContentSha256,
        maxFingerprintBytes
    });
}

function validateOrigin(raw: string): string {
    if (typeof raw !== 'string') {
        throw new TypeError('Invalid redirect guard configuration');
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new TypeError('Invalid redirect guard configuration');
    }
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        isIpLiteral(url.hostname) ||
        url.href !== url.origin + '/'
    ) {
        throw new TypeError('Invalid redirect guard configuration');
    }
    return url.origin;
}

function parseRuntimeUrl(
    input: string | URL,
    fallback: RedirectDriftReason
): URL {
    let url: URL;
    try {
        url = new URL(input.toString());
    } catch {
        throw new RedirectDriftFailure(fallback);
    }
    assertRuntimeUrl(url);
    return url;
}

function assertRuntimeUrl(url: URL): void {
    if (url.username || url.password) {
        throw new RedirectDriftFailure('CREDENTIALS');
    }
    if (isIpLiteral(url.hostname)) {
        throw new RedirectDriftFailure('IP_LITERAL');
    }
    if (url.protocol !== 'https:') {
        throw new RedirectDriftFailure('DOWNGRADE');
    }
}

function boundedInteger(value: number, min: number, max: number): number {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new TypeError('Invalid redirect guard configuration');
    }
    return value;
}

async function fingerprint(
    body: ReadableStream<Uint8Array> | null | undefined,
    maxBytes: number,
    signal: AbortSignal
): Promise<string> {
    const hash = createHash('sha256');
    if (!body) return hash.digest('hex');
    const reader = body.getReader();
    let consumed = 0;
    try {
        for (;;) {
            throwIfAborted(signal);
            const { done, value } = await readWithAbort(reader, signal);
            throwIfAborted(signal);
            if (done) break;
            const remaining = maxBytes - consumed;
            if (remaining > 0) hash.update(value.subarray(0, remaining));
            consumed += Math.min(value.byteLength, Math.max(remaining, 0));
            if (consumed >= maxBytes) {
                await cancelReader(reader, signal);
                break;
            }
        }
    } finally {
        reader.releaseLock();
    }
    return hash.digest('hex');
}

function readWithAbort(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal
): Promise<
    { done: true; value?: Uint8Array } | { done: false; value: Uint8Array }
> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const abort = () => {
            void reader.cancel().catch(() => undefined);
            reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        reader.read().then(
            (result) => {
                signal.removeEventListener('abort', abort);
                resolve(result);
            },
            (error) => {
                signal.removeEventListener('abort', abort);
                reject(error);
            }
        );
    });
}

async function cancelBody(
    body: ReadableStream<Uint8Array> | null | undefined,
    signal: AbortSignal,
    allowAborted = false
): Promise<void> {
    if (!body) return;
    if (!allowAborted) throwIfAborted(signal);
    let onAbort: (() => void) | undefined;
    const aborted = signal.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
              onAbort = () => resolve();
              signal.addEventListener('abort', onAbort, { once: true });
          });
    const cancellation = Promise.resolve()
        .then(() => body.cancel())
        .catch(() => undefined);
    try {
        await Promise.race([cancellation, aborted]);
        if (!allowAborted) throwIfAborted(signal);
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
    }
}

async function cancelReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal
): Promise<void> {
    throwIfAborted(signal);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
        onAbort = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
    });
    const cancellation = Promise.resolve()
        .then(() => reader.cancel())
        .catch(() => undefined);
    try {
        await Promise.race([cancellation, aborted]);
        throwIfAborted(signal);
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
    }
}

function fetchWithAbort(
    pending: Promise<RedirectFetchResponse>,
    signal: AbortSignal
): Promise<RedirectFetchResponse> {
    if (signal.aborted) {
        observeLateResponse(pending, signal);
        return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const abort = () => {
            if (settled) return;
            settled = true;
            reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        pending.then(
            (response) => {
                if (settled) {
                    void cancelBody(response.body, signal, true);
                    return;
                }
                settled = true;
                signal.removeEventListener('abort', abort);
                resolve(response);
            },
            (error) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', abort);
                reject(error);
            }
        );
    });
}

function observeLateResponse(
    pending: Promise<RedirectFetchResponse>,
    signal: AbortSignal
): void {
    pending.then(
        (response) => void cancelBody(response.body, signal, true),
        () => undefined
    );
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
}

function isIpLiteral(hostname: string): boolean {
    const unwrapped =
        hostname.startsWith('[') && hostname.endsWith(']')
            ? hostname.slice(1, -1)
            : hostname;
    return isIP(unwrapped) !== 0;
}
