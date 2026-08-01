export type CanonicalHostId = string & { readonly __hostId: unique symbol };
export type CanonicalFamilyId = string & { readonly __familyId: unique symbol };
export type CanonicalUpstreamId = string & {
    readonly __upstreamId: unique symbol;
};

export type UrlRole =
    | 'embed'
    | 'cdn'
    | 'redirect'
    | 'ad'
    | 'tracker'
    | 'unknown';
export type PlaybackType = 'hls' | 'mp4' | 'embed';
export type EmbedStage =
    | 'classify'
    | 'eligibility'
    | 'fetch'
    | 'extract'
    | 'validate';
export type EmbedFailureClass =
    | 'invalid_input'
    | 'unsupported'
    | 'disabled'
    | 'dns'
    | 'tls'
    | 'redirect_drift'
    | 'http_4xx'
    | 'http_5xx'
    | 'rate_limited'
    | 'anti_bot'
    | 'auth_required'
    | 'geo_blocked'
    | 'drm'
    | 'parse'
    | 'no_sources'
    | 'proxy'
    | 'manifest'
    | 'embed_frame'
    | 'timeout'
    | 'internal';

export const EMBED_FAILURE_CODES = [
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
] as const;
export type EmbedFailureCode = (typeof EMBED_FAILURE_CODES)[number];

export interface ResolverIdentity {
    providerFamilyId: CanonicalFamilyId;
    upstreamId?: CanonicalUpstreamId;
    providerId: CanonicalFamilyId | CanonicalUpstreamId;
}

export interface EmbedInput {
    url: URL;
    identity: ResolverIdentity;
    purpose: 'resolve' | 'health';
    signal: AbortSignal;
    correlationId: string;
    providerContextHostnames?: readonly string[];
}

export type HostClassification =
    | {
          matched: true;
          hostId: CanonicalHostId;
          canonicalHostname: string;
          aliasHostname: string;
          role: UrlRole;
          ruleVersion: number;
      }
    | {
          matched: false;
          role: Exclude<UrlRole, 'embed'>;
          reason:
              | 'INVALID_URL'
              | 'UNSUPPORTED_SCHEME'
              | 'CREDENTIALS_PRESENT'
              | 'IP_LITERAL'
              | 'UNREGISTERED_DOMAIN'
              | 'NON_EMBED_PATH'
              | 'BLOCKED_DOMAIN_CLASS';
      };

export interface PlaybackHeaders {
    Accept?: string;
    Origin?: string;
    Referer?: string;
    'User-Agent'?: string;
}

export interface EmbedTarget {
    url: URL;
    type: PlaybackType;
    quality: string;
    requestHeaders: Readonly<PlaybackHeaders>;
    indicators?: readonly ('drm' | 'captcha' | 'anti_bot')[];
}

export interface EmbedDiagnostic {
    code: string;
    severity: 'info' | 'warning';
    stage: EmbedStage;
    count?: number;
}

export interface EmbedSuccess {
    ok: true;
    hostId: CanonicalHostId;
    identity: ResolverIdentity;
    targets: readonly EmbedTarget[];
    diagnostics: readonly EmbedDiagnostic[];
}

export interface EmbedFailure {
    ok: false;
    hostId?: CanonicalHostId;
    identity: ResolverIdentity;
    failure: {
        class: EmbedFailureClass;
        code: EmbedFailureCode;
        retryable: boolean;
        stage: EmbedStage;
        fingerprints?: { redirect?: string; response?: string };
    };
}

export type EmbedExtractionResult = EmbedSuccess | EmbedFailure;

export interface EmbedLimits {
    deadlineMs: number;
    maxResponseBytes: number;
    maxUrlLength: number;
    maxTargets: number;
    maxHeaderValueBytes: number;
    maxHeaderBytes: number;
}

export interface EmbedFetchRequest {
    url: URL;
    method: 'GET' | 'HEAD';
    headers: Readonly<PlaybackHeaders>;
    signal: AbortSignal;
    responseKind: 'html' | 'json' | 'text';
}

export interface EmbedFetchResponse {
    status: number;
    contentType: string;
    body: string;
    finalUrl: URL;
}

export interface BoundedEmbedFetch {
    fetch(request: EmbedFetchRequest): Promise<EmbedFetchResponse>;
}

export type HeadlessVidXResult =
    | {
          ok: true;
          targets: readonly EmbedTarget[];
      }
    | {
          ok: false;
          reason: 'ANTI_BOT' | 'NO_SOURCES' | 'PARSE_FAILED';
      };

export interface HeadlessVidXClient {
    resolve(request: {
        embedUrl: URL;
        headers: Readonly<PlaybackHeaders>;
        signal: AbortSignal;
    }): Promise<HeadlessVidXResult>;
}

export interface EmbedExecutionContext {
    fetch: BoundedEmbedFetch;
    headlessVidX?: HeadlessVidXClient;
    limits: Readonly<EmbedLimits>;
}

export interface EmbedHostAdapter {
    readonly id: CanonicalHostId;
    readonly release: Readonly<{ version: string; commit: string }>;
    readonly backend: 'direct' | 'headlessvidx';
    readonly outputHostnames: readonly string[];
    resolve(
        input: Readonly<EmbedInput>,
        context: Readonly<EmbedExecutionContext>
    ): Promise<EmbedExtractionResult>;
}
