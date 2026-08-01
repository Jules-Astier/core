import { fingerprintPlaybackHeaders } from './headers.js';
import type { EmbedTarget, ResolverIdentity } from './types.js';

export function dedupeEmbedTargets(
    targets: readonly EmbedTarget[],
    identity: ResolverIdentity
): EmbedTarget[] {
    const seen = new Set<string>();
    return targets.filter((target) => {
        const key = [
            canonicalUrl(target.url),
            identity.upstreamId ?? identity.providerId,
            target.type,
            fingerprintPlaybackHeaders(target.requestHeaders)
        ].join('\0');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function canonicalUrl(input: URL): string {
    const url = new URL(input);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (url.port === '443') url.port = '';
    return url.toString();
}
