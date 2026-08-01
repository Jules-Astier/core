import { isIP } from 'node:net';
import {
    validateEmbedHostCatalog,
    type EmbedHostCatalog,
    type EmbedHostDefinition
} from './catalog.js';
import { createHostClassifier } from './classifier.js';
import { dedupeEmbedTargets } from './dedupe.js';
import { validatePlaybackHeaders } from './headers.js';
import { createEmbedLimits } from './limits.js';
import { embedFailure } from './redact.js';
import type { ProviderComponentEligibility } from '../health/health-control.js';
import type {
    BoundedEmbedFetch,
    EmbedExtractionResult,
    EmbedHostAdapter,
    EmbedInput,
    EmbedLimits,
    EmbedTarget,
    HeadlessVidXClient,
    HostClassification,
    ResolverIdentity
} from './types.js';

export interface EmbedHostRegistryOptions {
    catalog: EmbedHostCatalog;
    adapters: readonly EmbedHostAdapter[];
    fetch: BoundedEmbedFetch;
    headlessVidX?: HeadlessVidXClient;
    limits?: Partial<EmbedLimits>;
    eligibility: ProviderComponentEligibility;
    fixedUserAgent?: string;
}

export class EmbedHostRegistry {
    private readonly catalog: EmbedHostCatalog;
    private readonly byId: ReadonlyMap<string, EmbedHostAdapter>;
    private readonly classifier: (url: URL | string) => HostClassification;
    private readonly eligibility: ProviderComponentEligibility;
    private readonly limits: Readonly<EmbedLimits>;
    private readonly activeAdapters = new Set<string>();

    constructor(private readonly options: EmbedHostRegistryOptions) {
        this.catalog = validateEmbedHostCatalog(options.catalog);
        this.limits = createEmbedLimits(options.limits);
        const byId = new Map<string, EmbedHostAdapter>();
        const known = new Set(this.catalog.hosts.map((host) => host.id));
        for (const adapter of options.adapters) {
            if (!known.has(adapter.id) || byId.has(adapter.id)) {
                throw new TypeError('Adapter/catalog registration mismatch');
            }
            if (adapter.backend === 'headlessvidx' && !options.headlessVidX) {
                throw new TypeError(
                    'HeadlessVidX adapter requires its backend'
                );
            }
            const outputHostnames = adapter.outputHostnames.map((hostname) =>
                validateContextHostname(hostname)
            );
            if (new Set(outputHostnames).size !== outputHostnames.length) {
                throw new TypeError('Duplicate adapter output hostname');
            }
            if (
                !['direct', 'headlessvidx'].includes(adapter.backend) ||
                !adapter.release ||
                typeof adapter.release.version !== 'string' ||
                typeof adapter.release.commit !== 'string' ||
                typeof adapter.resolve !== 'function'
            ) {
                throw new TypeError('Invalid embed-host adapter');
            }
            byId.set(
                adapter.id,
                Object.freeze({
                    id: adapter.id,
                    backend: adapter.backend,
                    release: Object.freeze({
                        version: adapter.release.version,
                        commit: adapter.release.commit
                    }),
                    outputHostnames: Object.freeze(outputHostnames),
                    resolve: adapter.resolve.bind(adapter)
                })
            );
        }
        this.byId = byId;
        this.classifier = createHostClassifier(this.catalog);
        this.eligibility = options.eligibility;
    }

    classify(url: URL | string): HostClassification {
        return this.classifier(url);
    }

    inventory() {
        return [...this.byId.values()]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((adapter) => ({
                id: adapter.id,
                backend: adapter.backend,
                ...(this.eligibility.get(adapter.id) ?? {
                    enabled: false,
                    disabledReason: 'catalog' as const
                }),
                release: Object.freeze({ ...adapter.release })
            }));
    }

    async resolve(input: EmbedInput): Promise<EmbedExtractionResult> {
        const identity = validateIdentity(input.identity);
        if (input.url.href.length > this.limits.maxUrlLength) {
            return embedFailure(
                identity,
                'invalid_input',
                'INVALID_URL',
                'classify'
            );
        }
        const classification = this.classify(input.url);
        if (!classification.matched || classification.role !== 'embed') {
            return embedFailure(
                identity,
                classification.matched ? 'unsupported' : 'invalid_input',
                classification.matched
                    ? 'NON_EMBED_URL'
                    : classificationCode(classification.reason),
                'classify',
                classification.matched ? classification.hostId : undefined
            );
        }
        const adapter = this.byId.get(classification.hostId);
        if (!adapter) {
            return embedFailure(
                identity,
                'unsupported',
                'UNCLASSIFIED',
                'classify',
                classification.hostId
            );
        }
        const eligibility = this.eligibility.get(classification.hostId) ?? {
            enabled: false,
            disabledReason: 'catalog' as const
        };
        if (!eligibility.enabled) {
            return embedFailure(
                identity,
                'disabled',
                eligibility.disabledReason === 'host_not_allowed'
                    ? 'HOST_NOT_ALLOWED'
                    : 'HOST_DISABLED',
                'eligibility',
                classification.hostId
            );
        }

        let providerContextHostnames: readonly string[];
        try {
            providerContextHostnames = validateProviderContextHostnames(
                input.providerContextHostnames
            );
        } catch {
            return embedFailure(
                identity,
                'invalid_input',
                'UNSAFE_HEADER',
                'validate',
                classification.hostId
            );
        }
        const controller = new AbortController();
        const forwardAbort = () => controller.abort();
        input.signal.addEventListener('abort', forwardAbort, { once: true });
        if (input.signal.aborted) controller.abort();
        const timer = setTimeout(
            () => controller.abort(),
            this.limits.deadlineMs
        );
        const adapterInput: EmbedInput = Object.freeze({
            ...input,
            identity,
            signal: controller.signal,
            providerContextHostnames
        });
        if (this.activeAdapters.has(classification.hostId)) {
            clearTimeout(timer);
            input.signal.removeEventListener('abort', forwardAbort);
            return embedFailure(
                identity,
                'timeout',
                'TIMEOUT',
                'extract',
                classification.hostId
            );
        }
        this.activeAdapters.add(classification.hostId);
        const work = Promise.resolve().then(() =>
            adapter.resolve(adapterInput, {
                fetch: this.options.fetch,
                headlessVidX: this.options.headlessVidX,
                limits: this.limits
            })
        );
        void work.then(
            () => this.activeAdapters.delete(classification.hostId),
            () => this.activeAdapters.delete(classification.hostId)
        );
        try {
            const result = await Promise.race([
                work,
                abortResult(controller.signal, identity, classification.hostId)
            ]);
            if (!result.ok) {
                return closedAdapterFailure(
                    result,
                    identity,
                    classification.hostId
                );
            }
            if (
                result.hostId !== classification.hostId ||
                !sameIdentity(result.identity, identity)
            ) {
                return embedFailure(
                    identity,
                    'internal',
                    'UNCLASSIFIED',
                    'validate',
                    classification.hostId
                );
            }
            const definition = this.catalog.hosts.find(
                (host) => host.id === classification.hostId
            )!;
            const targets = result.targets.map((target) =>
                this.validateTarget(
                    target,
                    definition,
                    adapter,
                    providerContextHostnames
                )
            );
            if (!targets.length) {
                return embedFailure(
                    identity,
                    'no_sources',
                    'NO_SOURCES',
                    'validate',
                    classification.hostId
                );
            }
            if (targets.length > this.limits.maxTargets) {
                return embedFailure(
                    identity,
                    'parse',
                    'OUTPUT_LIMIT',
                    'validate',
                    classification.hostId
                );
            }
            return Object.freeze({
                ok: true,
                hostId: classification.hostId,
                identity,
                targets: Object.freeze(dedupeEmbedTargets(targets, identity)),
                diagnostics: Object.freeze(
                    result.diagnostics.slice(0, 16).map((item) =>
                        Object.freeze({
                            code: item.code
                                .replace(/[^A-Z0-9_]/g, '')
                                .slice(0, 64),
                            severity: item.severity,
                            stage: item.stage,
                            ...(item.count === undefined
                                ? {}
                                : {
                                      count: Math.max(
                                          0,
                                          Math.min(999, item.count)
                                      )
                                  })
                        })
                    )
                )
            });
        } catch (error) {
            const validation = mapValidationError(error);
            if (validation) {
                return embedFailure(
                    identity,
                    validation.failureClass,
                    validation.code,
                    'validate',
                    classification.hostId
                );
            }
            return controller.signal.aborted
                ? embedFailure(
                      identity,
                      'timeout',
                      'TIMEOUT',
                      'extract',
                      classification.hostId
                  )
                : embedFailure(
                      identity,
                      'internal',
                      'ADAPTER_THROW',
                      'extract',
                      classification.hostId
                  );
        } finally {
            clearTimeout(timer);
            input.signal.removeEventListener('abort', forwardAbort);
        }
    }

    private validateTarget(
        target: EmbedTarget,
        definition: EmbedHostDefinition,
        adapter: EmbedHostAdapter,
        providerContextHostnames: readonly string[]
    ) {
        const url = new URL(target.url);
        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
            url.hostname.endsWith('.local') ||
            url.href.length > this.limits.maxUrlLength
        ) {
            throw new TypeError('INVALID_OUTPUT_URL');
        }
        if (!['hls', 'mp4', 'embed'].includes(target.type)) {
            throw new TypeError('UNSUPPORTED_OUTPUT_TYPE');
        }
        if (/\.mpd(?:$|\?)/i.test(url.href))
            throw new TypeError('DRM_DETECTED');
        if (target.type === 'embed') {
            const classified = this.classify(url);
            if (
                !classified.matched ||
                classified.hostId !== definition.id ||
                classified.role !== 'embed'
            ) {
                throw new TypeError('EMBED_FRAME_INVALID');
            }
        } else if (!adapter.outputHostnames.includes(url.hostname)) {
            throw new TypeError('INVALID_OUTPUT_URL');
        }
        const allowed = new Set([
            ...definition.domains.flatMap((domain) => [
                domain.hostname,
                ...(domain.allowSubdomains || []).map(
                    (label) => `${label}.${domain.hostname}`
                )
            ]),
            ...providerContextHostnames
        ]);
        const indicators = target.indicators;
        if (
            indicators !== undefined &&
            (!Array.isArray(indicators) ||
                indicators.some(
                    (item) => !['drm', 'captcha', 'anti_bot'].includes(item)
                ))
        ) {
            throw new TypeError('UNCLASSIFIED');
        }
        if (indicators?.includes('drm')) throw new TypeError('DRM_DETECTED');
        if (indicators?.includes('captcha') || indicators?.includes('anti_bot'))
            throw new TypeError('ANTI_BOT');
        return Object.freeze({
            url,
            type: target.type,
            quality: String(target.quality).slice(0, 64),
            requestHeaders: validatePlaybackHeaders(
                target.requestHeaders as Record<string, string>,
                {
                    allowedRefererHostnames: allowed,
                    fixedUserAgent: this.options.fixedUserAgent,
                    limits: this.limits
                }
            )
        });
    }
}

function validateContextHostname(value: string): string {
    if (
        typeof value !== 'string' ||
        value !== value.toLowerCase() ||
        value.endsWith('.') ||
        value.includes(':') ||
        isIP(value.replace(/^\[|\]$/g, '')) ||
        value === 'localhost' ||
        value.endsWith('.localhost') ||
        value.endsWith('.local') ||
        !value
            .split('.')
            .every((label) =>
                /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
            )
    ) {
        throw new TypeError('UNSAFE_HEADER');
    }
    return value;
}

function validateProviderContextHostnames(
    values: readonly string[] | undefined
): readonly string[] {
    if (values === undefined) return Object.freeze([]);
    if (!Array.isArray(values) || values.length > 16) {
        throw new TypeError('UNSAFE_HEADER');
    }
    const snapshot = values.map(validateContextHostname);
    if (new Set(snapshot).size !== snapshot.length) {
        throw new TypeError('UNSAFE_HEADER');
    }
    return Object.freeze(snapshot);
}

function closedAdapterFailure(
    result: Extract<EmbedExtractionResult, { ok: false }>,
    identity: ResolverIdentity,
    hostId: EmbedFailureHost
): EmbedExtractionResult {
    const failure = result.failure;
    const classes = new Set([
        'invalid_input',
        'unsupported',
        'disabled',
        'dns',
        'tls',
        'redirect_drift',
        'http_4xx',
        'http_5xx',
        'rate_limited',
        'anti_bot',
        'auth_required',
        'geo_blocked',
        'drm',
        'parse',
        'no_sources',
        'proxy',
        'manifest',
        'embed_frame',
        'timeout',
        'internal'
    ]);
    const codes = new Set([
        'INVALID_URL',
        'UNSUPPORTED_SCHEME',
        'CREDENTIALS_PRESENT',
        'IP_LITERAL',
        'UNREGISTERED_DOMAIN',
        'NON_EMBED_URL',
        'HOST_DISABLED',
        'HOST_NOT_ALLOWED',
        'REDIRECT_OUTSIDE_ALLOWLIST',
        'REDIRECT_LIMIT',
        'RESPONSE_TOO_LARGE',
        'CONTENT_TYPE_MISMATCH',
        'OUTPUT_LIMIT',
        'INVALID_OUTPUT_URL',
        'UNSUPPORTED_OUTPUT_TYPE',
        'UNSAFE_HEADER',
        'DNS_ERROR',
        'TLS_ERROR',
        'HTTP_4XX',
        'HTTP_5XX',
        'RATE_LIMITED',
        'ANTI_BOT',
        'AUTH_REQUIRED',
        'GEO_BLOCKED',
        'DRM_DETECTED',
        'PARSE_FAILED',
        'NO_SOURCES',
        'PROXY_FAILED',
        'MANIFEST_INVALID',
        'EMBED_FRAME_INVALID',
        'TIMEOUT',
        'ADAPTER_THROW',
        'UNCLASSIFIED'
    ]);
    const stages = new Set([
        'classify',
        'eligibility',
        'fetch',
        'extract',
        'validate'
    ]);
    if (
        !failure ||
        !classes.has(failure.class) ||
        !codes.has(failure.code) ||
        !stages.has(failure.stage)
    ) {
        return embedFailure(
            identity,
            'internal',
            'UNCLASSIFIED',
            'validate',
            hostId
        );
    }
    return embedFailure(
        identity,
        failure.class,
        failure.code,
        failure.stage,
        hostId
    );
}

function validateIdentity(identity: ResolverIdentity): ResolverIdentity {
    const family = identity.providerFamilyId;
    const canonical = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (!canonical.test(family))
        throw new TypeError('Invalid resolver identity');
    if (identity.upstreamId === undefined) {
        if (identity.providerId !== family)
            throw new TypeError('Invalid family identity');
    } else if (
        identity.providerId !== identity.upstreamId ||
        !identity.upstreamId.startsWith(`${family}:`) ||
        !/^[a-z0-9-]+:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identity.upstreamId)
    ) {
        throw new TypeError('Invalid upstream identity');
    }
    return Object.freeze({ ...identity });
}

function sameIdentity(
    left: ResolverIdentity,
    right: ResolverIdentity
): boolean {
    return (
        left.providerId === right.providerId &&
        left.providerFamilyId === right.providerFamilyId &&
        left.upstreamId === right.upstreamId
    );
}

function classificationCode(
    reason: Extract<HostClassification, { matched: false }>['reason']
) {
    if (reason === 'NON_EMBED_PATH') return 'NON_EMBED_URL' as const;
    if (reason === 'BLOCKED_DOMAIN_CLASS')
        return 'UNREGISTERED_DOMAIN' as const;
    return reason;
}

function abortResult(
    signal: AbortSignal,
    identity: ResolverIdentity,
    hostId: EmbedFailureHost
): Promise<EmbedExtractionResult> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve(
                embedFailure(identity, 'timeout', 'TIMEOUT', 'extract', hostId)
            );
            return;
        }
        signal.addEventListener(
            'abort',
            () =>
                resolve(
                    embedFailure(
                        identity,
                        'timeout',
                        'TIMEOUT',
                        'extract',
                        hostId
                    )
                ),
            { once: true }
        );
    });
}

type EmbedFailureHost = Extract<
    HostClassification,
    { matched: true }
>['hostId'];

function mapValidationError(error: unknown):
    | {
          failureClass:
              | 'drm'
              | 'anti_bot'
              | 'parse'
              | 'embed_frame'
              | 'internal';
          code:
              | 'DRM_DETECTED'
              | 'INVALID_OUTPUT_URL'
              | 'UNSUPPORTED_OUTPUT_TYPE'
              | 'UNSAFE_HEADER'
              | 'EMBED_FRAME_INVALID'
              | 'ANTI_BOT'
              | 'UNCLASSIFIED';
      }
    | undefined {
    if (!(error instanceof TypeError)) return undefined;
    switch (error.message) {
        case 'DRM_DETECTED':
            return { failureClass: 'drm', code: 'DRM_DETECTED' };
        case 'ANTI_BOT':
            return { failureClass: 'anti_bot', code: 'ANTI_BOT' };
        case 'UNCLASSIFIED':
            return { failureClass: 'internal', code: 'UNCLASSIFIED' };
        case 'EMBED_FRAME_INVALID':
            return {
                failureClass: 'embed_frame',
                code: 'EMBED_FRAME_INVALID'
            };
        case 'INVALID_OUTPUT_URL':
        case 'UNSUPPORTED_OUTPUT_TYPE':
        case 'UNSAFE_HEADER':
            return { failureClass: 'parse', code: error.message };
        default:
            return undefined;
    }
}
