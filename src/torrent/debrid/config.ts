import type { DebridPrototypeConfig } from './types.js';

export const DEFAULT_DEBRID_PROTOTYPE_CONFIG: Readonly<DebridPrototypeConfig> =
    Object.freeze({
        enabled: false,
        secretEnvName: 'CINEPRO_DEBRID_PROTOTYPE_TOKEN',
        timeoutMs: 2_000,
        maxRetries: 1,
        maxCandidates: 4,
        maxResults: 3,
        circuitFailureThreshold: 3,
        circuitResetMs: 30_000
    });

export function createDebridPrototypeConfig(
    overrides: Partial<DebridPrototypeConfig> = {}
): Readonly<DebridPrototypeConfig> {
    const config = { ...DEFAULT_DEBRID_PROTOTYPE_CONFIG, ...overrides };
    assertInteger(config.timeoutMs, 1, 10_000, 'timeoutMs');
    assertInteger(config.maxRetries, 0, 2, 'maxRetries');
    assertInteger(config.maxCandidates, 1, 20, 'maxCandidates');
    assertInteger(config.maxResults, 1, 10, 'maxResults');
    assertInteger(
        config.circuitFailureThreshold,
        1,
        20,
        'circuitFailureThreshold'
    );
    assertInteger(config.circuitResetMs, 1, 300_000, 'circuitResetMs');
    if (!/^[A-Z][A-Z0-9_]*$/.test(config.secretEnvName)) {
        throw new Error('secretEnvName must be an environment variable name');
    }
    return Object.freeze(config);
}

function assertInteger(
    value: number,
    minimum: number,
    maximum: number,
    field: string
): void {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(
            `${field} must be an integer from ${minimum} to ${maximum}`
        );
    }
}
