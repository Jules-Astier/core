import test from 'node:test';
import {
    LiveEventService,
    MemoryCacheService,
    ProviderRegistry
} from '@omss/framework';
import { NhlWebProvider } from '../nhlweb/nhlweb.js';
import assert from 'node:assert/strict';
import type { LiveEventManifest, ProviderResult } from '@omss/framework';
import {
    Nhl24AllProvider,
    parseNhl24AllSnapshot,
    publicLiveFeeds,
    nhl24AllMediaUrl,
    validateNhl24AllPlaylist
} from './nhl24all.js';
const contractModulePath = '../../../test/support/provider-contract.js';
const { assertProviderResultContract } = (await import(contractModulePath)) as {
    assertProviderResultContract: (
        result: ProviderResult,
        options: { providerId: string }
    ) => void;
};

const event: LiveEventManifest = {
    id: 'nhl-ice-hockey-2026-11-18-edmonton-oilers-vs-florida-panthers',
    title: 'Edmonton Oilers vs Florida Panthers',
    league: 'nhl',
    sport: 'ice-hockey',
    startsAt: '2026-11-18T00:00:00Z',
    status: 'live',
    providers: [
        {
            providerId: 'nhlweb',
            internalEventId: 'nhl:2026020335',
            lastChecked: '2026-11-18T00:00:00Z',
            sourceCount: 0
        }
    ]
};
function snapshot(status = 'L') {
    return {
        games: [{ id: 7805, external_id: '2026020335', status }],
        media_events: [
            { id: 1, game_id: 7805, title: 'Home', status: 'L' },
            { id: 2, game_id: 7805, title: 'Premium', status: 'L' },
            { id: 3, game_id: 7805, title: 'Replay', status: 'R' },
            { id: 4, game_id: 7805, title: 'Planned', status: 'P' },
            { id: 5, game_id: 7806, title: 'Other game', status: 'L' }
        ],
        flavors: [
            {
                id: 'public.live',
                entitlements: null,
                media_event_ids: [1, 3, 4, 5]
            },
            {
                id: 'premium.live',
                entitlements: [['NHL']],
                media_event_ids: [2]
            }
        ]
    };
}
const html = (data: unknown) =>
    `<script>var stateshot = ${JSON.stringify(data)};</script>`;
async function mocked(
    run: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>,
    options: {
        status?: string;
        wait?: boolean;
        invalid?: boolean;
        failFeed?: boolean;
        huge?: boolean;
    } = {}
) {
    const original = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let issuance = 0;
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === 'https://nhl24all.ir/')
            return new Response(
                options.huge
                    ? 'x'.repeat(1024 * 1024 + 1)
                    : html(snapshot(options.status))
            );
        if (url.includes('generate_stream_info')) {
            if (options.failFeed) throw new Error('do-not-leak-secret-url');
            return Response.json({
                url: `https://node.mlb9.com/session-${++issuance}/master.m3u8`,
                wait: options.wait ?? false
            });
        }
        if (url.endsWith('master.m3u8'))
            return new Response(
                options.invalid
                    ? '<html>challenge</html>'
                    : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=488000,CODECS="avc1.4D4020,mp4a.40.2"\nvariant.m3u8\n'
            );
        if (url.endsWith('variant.m3u8'))
            return new Response(
                '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.6,\nsegment.ts\n'
            );
        throw new Error('Unexpected request');
    };
    try {
        await run(calls);
    } finally {
        globalThis.fetch = original;
    }
}

test('schedule extraction parses JSON without evaluating scripts; rejects SPA fallback', () => {
    assert.equal(
        parseNhl24AllSnapshot(html(snapshot())).games[0].external_id,
        '2026020335'
    );
    assert.throws(() => parseNhl24AllSnapshot('<html>Please enable JS</html>'));
    assert.throws(() =>
        parseNhl24AllSnapshot('<script>var stateshot = alert("no");</script>')
    );
    assert.throws(() =>
        parseNhl24AllSnapshot(html({ games: [], media_events: [] }))
    );
});

test('only exact-game explicitly public LIVE feeds qualify; replay/planned/premium never do', () => {
    assert.deepEqual(
        publicLiveFeeds(snapshot(), 7805).map((f) => f.feed.id),
        [1]
    );
    assert.equal(publicLiveFeeds(snapshot(), 123).length, 0);
    const data = snapshot();
    data.flavors[0].entitlements = [];
    assert.equal(publicLiveFeeds(data, 7805).length, 0);
});

test('media boundaries reject credentials, IPs, deceptive hosts, HTTP and encryption', () => {
    for (const url of [
        'https://127.0.0.1/x',
        'http://node.mlb9.com/x',
        'https://mlb9.com.evil.test/x',
        'https://user:password@node.mlb9.com/x',
        'https://node.mlb9.com:444/x'
    ])
        assert.throws(() => nhl24AllMediaUrl(url));
    assert.equal(
        nhl24AllMediaUrl('variant.m3u8', 'https://node.mlb9.com/master.m3u8'),
        'https://node.mlb9.com/variant.m3u8'
    );
    assert.throws(() =>
        validateNhl24AllPlaylist(
            '#EXTM3U\nhttps://other.test/segment.ts',
            'https://node.mlb9.com/variant.m3u8'
        )
    );
    assert.throws(() =>
        validateNhl24AllPlaylist(
            '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"',
            'https://node.mlb9.com/variant.m3u8'
        )
    );
});

test('NHL Web event is enriched by exact NHL ID, with a shared snapshot and no title guessing', async () => {
    await mocked(async (calls) => {
        const provider = new Nhl24AllProvider();
        const [a, b] = await Promise.all([
            provider.matchLiveEvent(event),
            provider.matchLiveEvent({ ...event, title: 'Localized title' })
        ]);
        assert.equal(a?.internalEventId, 'nhl:2026020335');
        assert.equal(b?.internalEventId, a?.internalEventId);
        assert.equal(a?.sourceCount, 1);
        assert.equal(calls.length, 1);
        assert.equal(
            await provider.matchLiveEvent({ ...event, providers: [] }),
            undefined
        );
    });
});

test('source resolution validates HLS, proxies it, preserves feed identity and reissues URL on refresh', async () => {
    await mocked(async (calls) => {
        const provider = new Nhl24AllProvider();
        const first = await provider.getLiveEventSources(event);
        const second = await provider.getLiveEventSources(event);
        assertProviderResultContract(first, { providerId: 'nhl24all' });
        assert.equal(first.sources.length, 1);
        assert.notEqual(first.sources[0].url, second.sources[0].url);
        assert.equal(first.sources[0].quality, second.sources[0].quality);
        const posts = calls.filter((c) => c.init?.method === 'POST');
        assert.equal(posts.length, 2);
        for (const post of posts) {
            assert.deepEqual(JSON.parse(String(post.init?.body)), {
                media_event_id: 1,
                flavor_id: 'public.live'
            });
            assert.equal(post.init?.redirect, 'error');
            assert.equal(new Headers(post.init?.headers).has('Cookie'), false);
        }
        assert.equal(
            calls.some((c) => c.url.endsWith('segment.ts')),
            false
        );
    });
});

test('scheduled/final/canceled games never trigger stream issuance', async () => {
    for (const status of ['S', 'W', 'F', 'P', 'C'])
        await mocked(
            async (calls) => {
                const result = await new Nhl24AllProvider().getLiveEventSources(
                    event
                );
                assert.equal(result.sources.length, 0);
                assert.equal(
                    calls.some((c) => c.init?.method === 'POST'),
                    false
                );
            },
            { status }
        );
});

test('warm-up, invalid manifests, upstream failure and oversized responses fail without secret logging', async () => {
    for (const options of [
        { wait: true },
        { invalid: true },
        { failFeed: true },
        { huge: true }
    ])
        await mocked(async () => {
            const result = await new Nhl24AllProvider().getLiveEventSources(
                event
            );
            assert.equal(result.sources.length, 0);
            assert.doesNotMatch(JSON.stringify(result), /do-not-leak|session-/);
            assert.ok(result.diagnostics.length);
        }, options);
});

test('existing live service discovers one NHL event, attaches the source and renews through refresh', async () => {
    await mocked(async (calls) => {
        const cache = new MemoryCacheService();
        try {
            const schedule = new NhlWebProvider();
            schedule.getLiveEvents = async () => [
                {
                    providerId: 'nhlweb',
                    internalEventId: 'nhl:2026020335',
                    title: event.title,
                    league: 'NHL',
                    sport: 'Ice Hockey',
                    startsAt: new Date(Date.now() - 60_000).toISOString(),
                    status: 'live',
                    sourceCount: 0
                }
            ];
            schedule.getLiveEventSources = async () => ({
                sources: [],
                subtitles: [],
                diagnostics: []
            });
            const registry = new ProviderRegistry();
            registry.register(schedule);
            registry.register(new Nhl24AllProvider());
            const service = new LiveEventService(registry, cache, {
                manifest: 60,
                sources: 30
            });
            const events = await service.getEvents();
            assert.equal(events.length, 1);
            assert.equal(
                events[0].providers.find((p) => p.providerId === 'nhl24all')
                    ?.internalEventId,
                'nhl:2026020335'
            );
            const first = await service.getLiveEventSources(events[0].id);
            const cached = await service.getLiveEventSources(events[0].id);
            assert.equal(cached.sources[0].url, first.sources[0].url);
            const fresh = await service.getLiveEventSources(events[0].id, {
                refresh: true
            });
            assert.notEqual(fresh.sources[0].url, first.sources[0].url);
            assert.equal(fresh.sources[0].quality, first.sources[0].quality);
            assert.equal(
                calls.filter((c) => c.init?.method === 'POST').length,
                2
            );
        } finally {
            cache.destroy();
        }
    });
});
