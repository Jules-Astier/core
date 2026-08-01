import { isIP } from 'node:net';
import type { CanonicalHostId, UrlRole } from './types.js';

export interface EmbedHostDefinition {
    id: CanonicalHostId;
    catalogStatus?: string;
    domains: readonly {
        hostname: string;
        kind: 'canonical' | 'alias';
        allowSubdomains: false | readonly string[];
    }[];
    paths: readonly {
        role: 'embed' | 'redirect';
        pathname: RegExp;
        requiredQueryKeys?: readonly string[];
    }[];
    redirectHostnames: readonly string[];
    blockedHostnames: readonly {
        hostname: string;
        role: Extract<UrlRole, 'cdn' | 'ad' | 'tracker'>;
    }[];
}

export interface EmbedHostCatalog {
    schemaVersion: 1;
    ruleVersion: number;
    hosts: readonly EmbedHostDefinition[];
}

// PE-017 is intentionally inert. Reviewed domains and adapters are PE-018 work.
export const EMBED_HOST_CATALOG: EmbedHostCatalog = deepFreeze({
    schemaVersion: 1,
    ruleVersion: 1,
    hosts: []
});

export function validateEmbedHostCatalog(
    catalog: EmbedHostCatalog
): EmbedHostCatalog {
    if (
        catalog.schemaVersion !== 1 ||
        !Number.isSafeInteger(catalog.ruleVersion)
    ) {
        throw new TypeError('Unsupported embed-host catalog version');
    }
    const ids = new Set<string>();
    const hostnames = new Set<string>();
    const redirects = new Set<string>();
    const blocked = new Set<string>();
    const hosts: EmbedHostDefinition[] = [];
    for (const host of catalog.hosts) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(host.id)) {
            throw new TypeError('Embed-host ID must be canonical');
        }
        if (ids.has(host.id)) throw new TypeError('Duplicate embed-host ID');
        ids.add(host.id);
        if (
            host.domains.filter((domain) => domain.kind === 'canonical')
                .length !== 1
        ) {
            throw new TypeError('Embed host must have one canonical domain');
        }
        const domains = host.domains.map((domain) => {
            assertHostname(domain.hostname);
            return {
                hostname: domain.hostname,
                kind: domain.kind,
                allowSubdomains:
                    domain.allowSubdomains === false
                        ? false
                        : [...domain.allowSubdomains]
            } as const;
        });
        for (const domain of host.domains) {
            assertHostname(domain.hostname);
            if (hostnames.has(domain.hostname)) {
                throw new TypeError('Ambiguous embed-host hostname');
            }
            hostnames.add(domain.hostname);
            for (const label of domain.allowSubdomains || []) {
                if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
                    throw new TypeError('Invalid explicit subdomain label');
                }
                const hostname = `${label}.${domain.hostname}`;
                if (hostnames.has(hostname)) {
                    throw new TypeError('Ambiguous embed-host hostname');
                }
                hostnames.add(hostname);
            }
        }
        const paths = host.paths.map((rule) => {
            if (rule.pathname.global || rule.pathname.sticky) {
                throw new TypeError('Embed-host path rules must be stateless');
            }
            const requiredQueryKeys = rule.requiredQueryKeys
                ? [...rule.requiredQueryKeys]
                : undefined;
            if (
                requiredQueryKeys?.some(
                    (key, index) =>
                        !/^[A-Za-z0-9_.~-]{1,64}$/.test(key) ||
                        requiredQueryKeys.indexOf(key) !== index
                )
            ) {
                throw new TypeError('Invalid required query key');
            }
            return {
                role: rule.role,
                pathname: new RegExp(rule.pathname.source, rule.pathname.flags),
                ...(requiredQueryKeys ? { requiredQueryKeys } : {})
            };
        });
        for (const rule of host.paths) {
            if (
                !rule.pathname.source.startsWith('^') ||
                !rule.pathname.source.endsWith('$')
            ) {
                throw new TypeError('Embed-host path rules must be anchored');
            }
        }
        const redirectHostnames = [...host.redirectHostnames];
        if (new Set(redirectHostnames).size !== redirectHostnames.length) {
            throw new TypeError('Duplicate redirect hostname');
        }
        for (const hostname of redirectHostnames) assertHostname(hostname);
        for (const hostname of redirectHostnames) {
            if (
                redirects.has(hostname) ||
                hostnames.has(hostname) ||
                blocked.has(hostname)
            ) {
                throw new TypeError('Ambiguous redirect hostname');
            }
            redirects.add(hostname);
        }
        const blockedHostnames = host.blockedHostnames.map((item) => ({
            hostname: item.hostname,
            role: item.role
        }));
        for (const item of host.blockedHostnames) {
            assertHostname(item.hostname);
            blocked.add(item.hostname);
        }
        hosts.push({
            id: host.id,
            ...(host.catalogStatus === undefined
                ? {}
                : { catalogStatus: host.catalogStatus }),
            domains,
            paths,
            redirectHostnames,
            blockedHostnames
        });
    }
    for (const hostname of blocked) {
        if (hostnames.has(hostname) || redirects.has(hostname)) {
            throw new TypeError('Blocked hostname overlaps embed-host alias');
        }
    }
    for (const hostname of redirects) {
        if (hostnames.has(hostname)) {
            throw new TypeError('Redirect hostname overlaps embed-host alias');
        }
    }
    return deepFreeze({
        schemaVersion: 1,
        ruleVersion: catalog.ruleVersion,
        hosts
    });
}

function assertHostname(hostname: string): void {
    if (
        typeof hostname !== 'string' ||
        hostname !== hostname.toLowerCase() ||
        hostname.endsWith('.') ||
        hostname.includes(':') ||
        hostname.length > 253 ||
        isIP(hostname.replace(/^\[|\]$/g, '')) !== 0 ||
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        !hostname
            .split('.')
            .every((label) =>
                /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
            )
    ) {
        throw new TypeError(
            'Embed-host hostname must be exact lower-case ASCII'
        );
    }
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}
