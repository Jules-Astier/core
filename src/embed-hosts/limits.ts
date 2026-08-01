import type { EmbedLimits } from './types.js';

const DEFAULTS: EmbedLimits = {
    deadlineMs: 15_000,
    maxResponseBytes: 1_048_576,
    maxUrlLength: 4_096,
    maxTargets: 8,
    maxHeaderValueBytes: 1_024,
    maxHeaderBytes: 2_048
};
const CEILINGS: EmbedLimits = {
    deadlineMs: 30_000,
    maxResponseBytes: 2_097_152,
    maxUrlLength: 8_192,
    maxTargets: 16,
    maxHeaderValueBytes: 2_048,
    maxHeaderBytes: 4_096
};

export function createEmbedLimits(
    values: Partial<EmbedLimits> = {}
): Readonly<EmbedLimits> {
    const result = { ...DEFAULTS, ...values };
    for (const key of Object.keys(result) as (keyof EmbedLimits)[]) {
        if (
            !Number.isSafeInteger(result[key]) ||
            result[key] < 1 ||
            result[key] > CEILINGS[key]
        ) {
            throw new TypeError(`Invalid embed-host limit: ${key}`);
        }
    }
    return Object.freeze(result);
}
