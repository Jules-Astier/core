import { createHash } from 'node:crypto';
import type {
    EmbedFailure,
    EmbedFailureClass,
    EmbedFailureCode,
    EmbedStage,
    ResolverIdentity
} from './types.js';

export function embedFailure(
    identity: ResolverIdentity,
    failureClass: EmbedFailureClass,
    code: EmbedFailureCode,
    stage: EmbedStage,
    hostId?: EmbedFailure['hostId']
): EmbedFailure {
    return {
        ok: false,
        ...(hostId ? { hostId } : {}),
        identity: Object.freeze({ ...identity }),
        failure: Object.freeze({
            class: failureClass,
            code,
            retryable: isRetryable(failureClass),
            stage
        })
    };
}

export function stableFingerprint(...shape: readonly string[]): string {
    return createHash('sha256')
        .update(shape.map(sanitizeLabel).join('\0'))
        .digest('hex');
}

export function sanitizeAdapterError(_error: unknown): {
    class: 'internal';
    code: 'ADAPTER_THROW';
} {
    return { class: 'internal', code: 'ADAPTER_THROW' };
}

function sanitizeLabel(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64);
}

function isRetryable(value: EmbedFailureClass): boolean {
    return [
        'dns',
        'tls',
        'http_5xx',
        'rate_limited',
        'proxy',
        'timeout',
        'internal'
    ].includes(value);
}
