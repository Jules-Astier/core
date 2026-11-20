import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    LiveEventService,
    MemoryCacheService,
    ProviderRegistry
} from '@omss/framework';
import type { HealthCatalogEntry } from '../src/health/health-control.js';
import { installProviderHealthControl } from '../src/provider-health.js';
import { Nhl24AllProvider } from '../src/providers/nhl24all/nhl24all.js';
import { NhlWebProvider } from '../src/providers/nhlweb/nhlweb.js';
import { OpenF1Provider } from '../src/providers/openf1/openf1.js';

type CatalogEntry = HealthCatalogEntry & {
    content?: string[];
    outputs?: string[];
};

const catalog = JSON.parse(
    await readFile(
        new URL('../config/provider-catalog.yaml', import.meta.url),
        'utf8'
    )
) as { entries: CatalogEntry[] };

const liveScheduleIds = catalog.entries
    .filter(
        (entry) =>
            entry.content?.includes('live') &&
            entry.outputs?.includes('metadata') &&
            entry.runtime?.runtimeId
    )
    .map((entry) => entry.id)
    .sort();

test('the catalog does not veto the live schedule providers', () => {
    // Live events come only from these metadata providers. A catalog status
    // of disabled/deferred/rejected/retired turns them off before their own
    // environment flags are read, which emptied /v1/live/events.
    assert.deepEqual(liveScheduleIds, [
        'apisports',
        'nhlweb',
        'openf1'
    ]);
    for (const id of liveScheduleIds) {
        const entry = catalog.entries.find((e) => e.id === id)!;
        assert.ok(
            !['disabled', 'deferred', 'rejected', 'retired'].includes(
                String(entry.status)
            ),
            `${id} is catalog-disabled (status ${entry.status})`
        );
        assert.notEqual(entry.runtime?.enabledDefault, false);
    }
});

test('with the shipped catalog, NHL Web stays enabled and /v1/live/events is non-empty', async () => {
    const nhlweb = new NhlWebProvider();
    nhlweb.getLiveEvents = async () => [
        {
            providerId: 'nhlweb',
            internalEventId: 'nhl:2026020335',
            title: 'Edmonton Oilers vs Florida Panthers',
            league: 'NHL',
            sport: 'Ice Hockey',
            startsAt: new Date(Date.now() - 60_000).toISOString(),
            status: 'live',
            sourceCount: 0
        }
    ];
    const openf1 = new OpenF1Provider();
    openf1.getLiveEvents = async () => [];
    const nhl24all = new Nhl24AllProvider();
    nhl24all.getLiveEventSources = async () => ({
        sources: [],
        subtitles: [],
        diagnostics: []
    });

    const registry = new ProviderRegistry();
    registry.register(nhlweb);
    registry.register(openf1);
    registry.register(nhl24all);
    const control = await installProviderHealthControl(
        registry,
        catalog.entries,
        {},
        { createCheckId: () => 'live-catalog-check' }
    );

    for (const provider of [nhlweb, openf1, nhl24all]) {
        assert.equal(provider.enabled, true, `${provider.id} was disabled`);
        const result = control.results.find(
            ({ subject }) => subject.id === provider.id
        );
        assert.notEqual(result?.failureCode, 'DISABLED', provider.id);
    }

    const cache = new MemoryCacheService();
    try {
        const service = new LiveEventService(registry, cache, {
            manifest: 60,
            sources: 30
        });
        const events = await service.getEvents();
        assert.equal(events.length, 1);
        assert.equal(events[0].league, 'nhl');
        assert.ok(
            events[0].providers.some(
                (p) =>
                    p.providerId === 'nhlweb' &&
                    p.internalEventId === 'nhl:2026020335'
            )
        );
    } finally {
        cache.destroy();
    }
});
