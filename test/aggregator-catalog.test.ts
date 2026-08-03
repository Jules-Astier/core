import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PEACHIFY_LEAVES } from '../src/providers/peachify/peachify.config.js';
import { POPR_LEAVES } from '../src/providers/popr/popr.config.js';
import { TULNEX_LEAVES } from '../src/providers/tulnex/tulnex.identity.js';
import { VIDKING_LEAVES } from '../src/providers/vidking/vidking.identity.js';
import { VIDLOVE_LEAVES } from '../src/providers/vidlove/vidlove.identity.js';
import {
    VIDEASY_ACTIVE_SERVERS,
    VIDEASY_DISABLED_LEAVES
} from '../src/providers/videasy/videasy.config.js';
import {
    VIDNEST_DISABLED_LEAVES,
    VIDNEST_ELIGIBLE_LEAVES,
    VIDNEST_MISSING_HANDLERS
} from '../src/providers/vidnest/vidnest.config.js';

type CatalogEntry = {
    id: string;
    familyId: string;
    displayName: string;
    status?: string;
};

const catalog = JSON.parse(
    await readFile(
        new URL('../config/provider-catalog.yaml', import.meta.url),
        'utf8'
    )
) as { entries: CatalogEntry[] };

function catalogLeaves(familyId: string) {
    return catalog.entries
        .filter(
            (entry) =>
                entry.familyId === familyId && entry.id !== familyId
        )
        .sort((left, right) => left.id.localeCompare(right.id));
}

test('implemented aggregator leaf constants have exact catalog coverage', () => {
    const expected = new Map<string, readonly string[]>([
        ['tulnex', TULNEX_LEAVES.map((leaf) => `tulnex:${leaf}`)],
        [
            'videasy',
            [
                ...VIDEASY_ACTIVE_SERVERS.map(
                    ({ name }) => `videasy:${name}`
                ),
                ...VIDEASY_DISABLED_LEAVES.map(
                    ({ name }) => `videasy:${name}`
                )
            ]
        ],
        ['popr', POPR_LEAVES.map(({ id }) => id)],
        [
            'vidnest',
            [
                ...VIDNEST_ELIGIBLE_LEAVES.map(
                    (leaf) => `vidnest:${leaf}`
                ),
                ...VIDNEST_MISSING_HANDLERS.map(
                    ({ name }) => `vidnest:${name}`
                ),
                ...VIDNEST_DISABLED_LEAVES.map(
                    ({ name }) => `vidnest:${name}`
                )
            ]
        ],
        ['peachify', PEACHIFY_LEAVES.map(({ id }) => id)],
        ['vidking', VIDKING_LEAVES.map((leaf) => `vidking:${leaf}`)],
        ['vidlove', VIDLOVE_LEAVES.map((leaf) => `vidlove:${leaf}`)]
    ]);

    for (const [familyId, ids] of expected) {
        assert.deepEqual(
            catalogLeaves(familyId).map(({ id }) => id),
            [...ids].sort(),
            familyId
        );
    }
});

test('Popr emitted labels are the catalog display labels', () => {
    const labels = new Map(
        catalogLeaves('popr').map(({ id, displayName }) => [id, displayName])
    );
    assert.deepEqual(
        POPR_LEAVES.map(({ id, displayName }) => [id, displayName]),
        POPR_LEAVES.map(({ id }) => [id, labels.get(id)])
    );
});

test('seed-gated and disabled local leaves retain terminal catalog states', () => {
    const statuses = new Map(
        catalog.entries.map(({ id, status }) => [id, status])
    );
    for (const { name } of VIDEASY_DISABLED_LEAVES) {
        assert.equal(statuses.get(`videasy:${name}`), 'seed-needed');
    }
    for (const { name } of VIDNEST_MISSING_HANDLERS) {
        assert.equal(statuses.get(`vidnest:${name}`), 'seed-needed');
    }
    for (const { name, status } of VIDNEST_DISABLED_LEAVES) {
        assert.equal(statuses.get(`vidnest:${name}`), status);
    }
});
