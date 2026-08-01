import type {
    DebridObservation,
    DebridPrototypeConfig,
    DebridResolution,
    DebridTorrentCandidate,
    DebridTransport,
    DebridTransportResponse
} from './types.js';

export interface DebridPrototypeDependencies {
    transport: DebridTransport;
    /** Server-owned lookup. Do not pass a browser-derived object. */
    readSecret?: (name: string) => string | undefined;
    now?: () => number;
    observe?: (observation: DebridObservation) => void;
}

export class DebridPrototypeClient {
    readonly #config: Readonly<DebridPrototypeConfig>;
    readonly #transport: DebridTransport;
    readonly #readSecret: (name: string) => string | undefined;
    readonly #now: () => number;
    readonly #observe?: (observation: DebridObservation) => void;
    #consecutiveFailures = 0;
    #circuitOpenedAt: number | undefined;

    constructor(
        config: Readonly<DebridPrototypeConfig>,
        dependencies: DebridPrototypeDependencies
    ) {
        this.#config = config;
        this.#transport = dependencies.transport;
        this.#readSecret =
            dependencies.readSecret ?? ((name) => process.env[name]);
        this.#now = dependencies.now ?? Date.now;
        this.#observe = dependencies.observe;
    }

    async resolve(
        candidates: readonly DebridTorrentCandidate[]
    ): Promise<DebridResolution> {
        const counters = {
            attempts: 0,
            candidatesExamined: 0,
            rejectedLinks: 0,
            cacheMisses: 0
        };
        if (!this.#config.enabled)
            return this.#finish({ state: 'disabled', links: [] }, counters);

        const secret = this.#readSecret(this.#config.secretEnvName)?.trim();
        if (!secret)
            return this.#finish(
                { state: 'missing-secret', links: [] },
                counters
            );
        if (this.#isCircuitOpen())
            return this.#finish({ state: 'circuit-open', links: [] }, counters);

        let lastReason: 'timeout' | 'transport-error' | 'invalid-response' =
            'transport-error';
        for (const candidate of candidates.slice(
            0,
            this.#config.maxCandidates
        )) {
            counters.candidatesExamined++;
            for (
                let attempt = 0;
                attempt <= this.#config.maxRetries;
                attempt++
            ) {
                counters.attempts++;
                try {
                    const response = await this.#withTimeout(candidate, secret);
                    if (response.state === 'cache-miss') {
                        counters.cacheMisses++;
                        break;
                    }
                    const links = this.#validateLinks(response, counters);
                    if (links.length === 0) {
                        lastReason = 'invalid-response';
                        this.#recordFailure();
                        break;
                    }
                    this.#resetCircuit();
                    return this.#finish({ state: 'ready', links }, counters);
                } catch (error) {
                    lastReason =
                        error instanceof DebridTimeoutError
                            ? 'timeout'
                            : 'transport-error';
                    if (attempt === this.#config.maxRetries)
                        this.#recordFailure();
                }
            }
        }

        if (
            counters.cacheMisses === counters.candidatesExamined &&
            counters.candidatesExamined > 0
        ) {
            this.#resetCircuit();
            return this.#finish({ state: 'cache-miss', links: [] }, counters);
        }
        return this.#finish(
            { state: 'unavailable', links: [], reason: lastReason },
            counters
        );
    }

    async #withTimeout(
        candidate: DebridTorrentCandidate,
        secret: string
    ): Promise<DebridTransportResponse> {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                this.#transport.resolve({
                    candidate,
                    authorization: `Bearer ${secret}`,
                    signal: controller.signal
                }),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new DebridTimeoutError());
                    }, this.#config.timeoutMs);
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    #validateLinks(
        response: DebridTransportResponse,
        counters: { rejectedLinks: number }
    ) {
        const accepted = [];
        const seen = new Set<string>();
        for (const raw of response.links ?? []) {
            if (accepted.length >= this.#config.maxResults) break;
            try {
                const url = new URL(raw.url);
                if (
                    url.protocol !== 'https:' ||
                    url.username ||
                    url.password ||
                    seen.has(url.href)
                ) {
                    counters.rejectedLinks++;
                    continue;
                }
                seen.add(url.href);
                const contentLength =
                    Number.isSafeInteger(raw.contentLength) &&
                    (raw.contentLength ?? -1) >= 0
                        ? raw.contentLength
                        : undefined;
                accepted.push({
                    url: url.href,
                    capabilities: {
                        rangeRequests: raw.rangeSupported === true,
                        seekable: raw.rangeSupported === true,
                        ...(contentLength !== undefined && { contentLength })
                    }
                });
            } catch {
                counters.rejectedLinks++;
            }
        }
        return accepted;
    }

    #isCircuitOpen(): boolean {
        if (this.#circuitOpenedAt === undefined) return false;
        if (this.#now() - this.#circuitOpenedAt < this.#config.circuitResetMs)
            return true;
        this.#resetCircuit();
        return false;
    }

    #recordFailure(): void {
        this.#consecutiveFailures++;
        if (this.#consecutiveFailures >= this.#config.circuitFailureThreshold) {
            this.#circuitOpenedAt = this.#now();
        }
    }

    #resetCircuit(): void {
        this.#consecutiveFailures = 0;
        this.#circuitOpenedAt = undefined;
    }

    #finish(
        resolution: DebridResolution,
        counters: Omit<DebridObservation, 'outcome'>
    ): DebridResolution {
        this.#observe?.({ outcome: resolution.state, ...counters });
        return resolution;
    }
}

class DebridTimeoutError extends Error {}
