import { isIP } from 'node:net';
import {
    EMBED_HOST_CATALOG,
    validateEmbedHostCatalog,
    type EmbedHostCatalog
} from './catalog.js';
import type { HostClassification } from './types.js';

export function createHostClassifier(
    inputCatalog: EmbedHostCatalog = EMBED_HOST_CATALOG
): (input: URL | string) => HostClassification {
    const catalog = validateEmbedHostCatalog(inputCatalog);
    return (input) => classify(input, catalog);
}

function classify(
    input: URL | string,
    catalog: EmbedHostCatalog
): HostClassification {
    let url: URL;
    try {
        url = new URL(String(input));
    } catch {
        return unmatched('unknown', 'INVALID_URL');
    }
    if (url.protocol !== 'https:')
        return unmatched('unknown', 'UNSUPPORTED_SCHEME');
    if (url.username || url.password) {
        return unmatched('unknown', 'CREDENTIALS_PRESENT');
    }
    if (url.port || isIP(stripBrackets(url.hostname))) {
        return unmatched('unknown', 'IP_LITERAL');
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
        hostname.length > 253 ||
        /[\u0000-\u001f\u007f]/.test(url.href) ||
        !hostname
            .split('.')
            .every((label) =>
                /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
            )
    ) {
        return unmatched('unknown', 'INVALID_URL');
    }
    for (const host of catalog.hosts) {
        const block = host.blockedHostnames.find(
            (item) => item.hostname === hostname
        );
        if (block) return unmatched(block.role, 'BLOCKED_DOMAIN_CLASS');
    }
    for (const host of catalog.hosts) {
        if (host.redirectHostnames.includes(hostname)) {
            return {
                matched: true,
                hostId: host.id,
                canonicalHostname: host.domains.find(
                    (item) => item.kind === 'canonical'
                )!.hostname,
                aliasHostname: hostname,
                role: 'redirect',
                ruleVersion: catalog.ruleVersion
            };
        }
    }
    for (const host of catalog.hosts) {
        for (const domain of host.domains) {
            const exact =
                hostname === domain.hostname ||
                (domain.allowSubdomains !== false &&
                    domain.allowSubdomains.some(
                        (label) => hostname === `${label}.${domain.hostname}`
                    ));
            if (!exact) continue;
            let pathname: string;
            try {
                pathname = decodeURIComponent(url.pathname);
            } catch {
                return unmatched('unknown', 'INVALID_URL');
            }
            const rule = host.paths.find(
                (candidate) =>
                    candidate.pathname.test(pathname) &&
                    (candidate.requiredQueryKeys ?? []).every((key) =>
                        url.searchParams.has(key)
                    )
            );
            if (!rule) return unmatched('unknown', 'NON_EMBED_PATH');
            return {
                matched: true,
                hostId: host.id,
                canonicalHostname:
                    host.domains.find((item) => item.kind === 'canonical')
                        ?.hostname ?? domain.hostname,
                aliasHostname: hostname,
                role: rule.role,
                ruleVersion: catalog.ruleVersion
            };
        }
    }
    return unmatched('unknown', 'UNREGISTERED_DOMAIN');
}

function unmatched(
    role: 'cdn' | 'redirect' | 'ad' | 'tracker' | 'unknown',
    reason: Extract<HostClassification, { matched: false }>['reason']
): HostClassification {
    return { matched: false, role, reason };
}

function stripBrackets(value: string): string {
    return value.replace(/^\[|\]$/g, '');
}
