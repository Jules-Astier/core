import test from 'node:test';
import assert from 'node:assert/strict';
import type { LiveEventManifest } from '@omss/framework';
import { slapEventInPlay, slapTeamPage } from './slapstreams.js';

const event: LiveEventManifest = {
    id: 'nhl-ice-hockey-2026-11-18-edmonton-oilers-vs-florida-panthers',
    title: 'Edmonton Oilers vs Florida Panthers',
    league: 'nhl',
    sport: 'ice-hockey',
    // 19:00 New York time on 17 November.
    startsAt: '2026-11-18T00:00:00Z',
    status: 'live',
    teams: { away: 'Edmonton Oilers', home: 'Florida Panthers' },
    providers: [
        {
            providerId: 'nhlweb',
            internalEventId: 'nhl:2026020335',
            lastChecked: '2026-11-18T00:00:00Z',
            sourceCount: 0
        }
    ]
};

const row = (href: string, teams: string, date = 'November 17, 2026') =>
    `<tr><td class="teamvs"><a href="${href}">${teams}<span class="mtdate">${date}</span></a></td></tr>`;
const listing = (...rows: string[]) => `<table>${rows.join('')}</table>`;

test('SlapStreams matches one same-origin team page for the game date', () => {
    const html = listing(
        row('/oilers-live/', 'Oilers @ Panthers'),
        row('/bruins-live/', 'Bruins @ Rangers'),
        row('/oilers-live/', 'Oilers @ Panthers', 'November 19, 2026')
    );
    assert.equal(
        slapTeamPage(html, event),
        'https://slapstreams.com/oilers-live/'
    );
});

test('SlapStreams rejects off-site, ambiguous and mismatched pages', () => {
    assert.equal(
        slapTeamPage(
            listing(
                row('https://evil.example/oilers-live/', 'Oilers @ Panthers')
            ),
            event
        ),
        undefined
    );
    assert.equal(
        slapTeamPage(
            listing(
                row('/oilers-live/', 'Oilers @ Panthers'),
                row('/panthers-live/', 'Oilers @ Panthers')
            ),
            event
        ),
        undefined
    );
    // Home and away reversed.
    assert.equal(
        slapTeamPage(listing(row('/oilers-live/', 'Panthers @ Oilers')), event),
        undefined
    );
    assert.equal(
        slapTeamPage(listing(row('/oilers-live/?x=1', 'Oilers @ Panthers')), {
            ...event,
            startsAt: 'not a date'
        }),
        undefined
    );
});

test('SlapStreams treats a started game as in play despite a stale schedule status', () => {
    const now = Date.parse('2026-11-18T00:10:00Z');
    assert.equal(slapEventInPlay(event, now), true);
    assert.equal(slapEventInPlay({ ...event, status: 'scheduled' }, now), true);
    assert.equal(
        slapEventInPlay(
            { status: 'scheduled', startsAt: '2026-11-18T01:00:00Z' },
            now
        ),
        false
    );
    assert.equal(slapEventInPlay({ ...event, status: 'ended' }, now), false);
    assert.equal(
        slapEventInPlay({ ...event, status: 'postponed' }, now),
        false
    );
});

test('SlapStreams does nothing when disabled', async () => {
    const previous = process.env.SLAPSTREAMS_ENABLED;
    delete process.env.SLAPSTREAMS_ENABLED;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new Error('unexpected fetch');
    };
    try {
        const { SlapStreamsProvider } = await import('./slapstreams.js');
        const provider = new SlapStreamsProvider();
        assert.equal(provider.enabled, false);
        assert.equal(await provider.matchLiveEvent(event), undefined);
    } finally {
        globalThis.fetch = original;
        if (previous !== undefined) process.env.SLAPSTREAMS_ENABLED = previous;
    }
});
