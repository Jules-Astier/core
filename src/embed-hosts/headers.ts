import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { EmbedLimits, PlaybackHeaders } from './types.js';

const CANONICAL_NAMES = new Map([
    ['accept', 'Accept'],
    ['origin', 'Origin'],
    ['referer', 'Referer'],
    ['user-agent', 'User-Agent']
] as const);

export function validatePlaybackHeaders(
    input: Readonly<Record<string, string>>,
    options: {
        allowedRefererHostnames: ReadonlySet<string>;
        fixedUserAgent?: string;
        limits: Pick<EmbedLimits, 'maxHeaderValueBytes' | 'maxHeaderBytes'>;
    }
): Readonly<PlaybackHeaders> {
    const output: Record<string, string> = {};
    let bytes = 0;
    for (const [rawName, rawValue] of Object.entries(input)) {
        const name = CANONICAL_NAMES.get(
            rawName.toLowerCase() as
                | 'accept'
                | 'origin'
                | 'referer'
                | 'user-agent'
        );
        if (
            !name ||
            output[name] !== undefined ||
            typeof rawValue !== 'string'
        ) {
            throw new TypeError('UNSAFE_HEADER');
        }
        const value = rawValue.trim();
        if (
            !value ||
            /[\u0000-\u001f\u007f]/.test(value) ||
            Buffer.byteLength(value) > options.limits.maxHeaderValueBytes
        ) {
            throw new TypeError('UNSAFE_HEADER');
        }
        if (name === 'Origin')
            assertOrigin(value, options.allowedRefererHostnames);
        if (name === 'Referer')
            assertReferer(value, options.allowedRefererHostnames);
        if (
            name === 'User-Agent' &&
            (options.fixedUserAgent === undefined ||
                value !== options.fixedUserAgent)
        ) {
            throw new TypeError('UNSAFE_HEADER');
        }
        bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
        output[name] = value;
    }
    if (bytes > options.limits.maxHeaderBytes)
        throw new TypeError('UNSAFE_HEADER');
    return Object.freeze(output) as Readonly<PlaybackHeaders>;
}

export function fingerprintPlaybackHeaders(headers: PlaybackHeaders): string {
    const normalized = Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), value?.trim()] as const)
        .filter((item): item is readonly [string, string] => Boolean(item[1]))
        .sort(([left], [right]) => left.localeCompare(right));
    return createHash('sha256')
        .update(JSON.stringify(normalized))
        .digest('hex');
}

function assertOrigin(value: string, allowed: ReadonlySet<string>): void {
    const url = safeUrl(value);
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        url.port ||
        isUnsafeHostname(url.hostname) ||
        !allowed.has(url.hostname)
    ) {
        throw new TypeError('UNSAFE_HEADER');
    }
}

function assertReferer(value: string, allowed: ReadonlySet<string>): void {
    const url = safeUrl(value);
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        isUnsafeHostname(url.hostname) ||
        !allowed.has(url.hostname)
    ) {
        throw new TypeError('UNSAFE_HEADER');
    }
}

function isUnsafeHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    return (
        normalized !== hostname ||
        isIP(normalized.replace(/^\[|\]$/g, '')) !== 0 ||
        normalized === 'localhost' ||
        normalized.endsWith('.localhost') ||
        normalized.endsWith('.local') ||
        !normalized
            .split('.')
            .every((label) =>
                /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
            )
    );
}

function safeUrl(value: string): URL {
    try {
        return new URL(value);
    } catch {
        throw new TypeError('UNSAFE_HEADER');
    }
}
