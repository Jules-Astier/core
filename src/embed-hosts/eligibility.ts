import type { HealthEligibility } from '../health/health-control.js';
import type { CanonicalHostId } from './types.js';

export type EmbedHostEligibility = Pick<
    HealthEligibility,
    'enabled' | 'disabledReason'
>;

export function createEmbedHostEligibility(
    knownHostIds: ReadonlySet<string>,
    options: {
        allow?: readonly string[];
        deny?: readonly string[];
        catalogDisabled?: ReadonlySet<string>;
    } = {}
): (hostId: CanonicalHostId) => EmbedHostEligibility {
    const allow = validateList(options.allow ?? [], knownHostIds);
    const deny = validateList(options.deny ?? [], knownHostIds);
    const catalogDisabled = options.catalogDisabled ?? new Set();
    return (hostId) => {
        if (catalogDisabled.has(hostId)) {
            return { enabled: false, disabledReason: 'catalog' };
        }
        if (deny.has(hostId)) {
            return { enabled: false, disabledReason: 'host_deny' };
        }
        if (allow.size && !allow.has(hostId)) {
            return { enabled: false, disabledReason: 'host_not_allowed' };
        }
        return { enabled: true };
    };
}

function validateList(
    values: readonly string[],
    known: ReadonlySet<string>
): ReadonlySet<string> {
    const result = new Set<string>();
    for (const value of values) {
        if (
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ||
            !known.has(value) ||
            result.has(value)
        ) {
            throw new TypeError('Invalid embed-host eligibility identity');
        }
        result.add(value);
    }
    return result;
}
