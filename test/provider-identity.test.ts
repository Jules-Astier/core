import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Source } from '@omss/framework';
import {
    assertSourceIdentity,
    canonicalizeIdentityComponent,
    canonicalizeProviderId,
    createProviderIdentityCatalog,
    type ProviderCatalogIdentityEntry,
    type SourceWithoutProviderIdentity
} from '../src/provider-identity.js';

const catalogDocument = JSON.parse(
    await readFile(new URL('../config/provider-catalog.yaml', import.meta.url), 'utf8')
) as {
    entries: ProviderCatalogIdentityEntry[];
};
const identityCatalog = createProviderIdentityCatalog(catalogDocument.entries);

const baseSource: SourceWithoutProviderIdentity = {
    url: 'https://media.example.test/master.m3u8',
    type: 'hls',
    quality: '1080p',
    audioTracks: [{ language: 'eng', label: 'English' }]
};

test('canonicalizes components using the PE-003 Unicode and punctuation rules', () => {
    const cases = [
        [' Tulnex ', 'tulnex'],
        ['VidFast Alpha', 'vidfast-alpha'],
        ['  Víd.Fàst__Alpha  ', 'vid-fast-alpha'],
        ['１２ Stream—Host ', '12-stream-host']
    ] as const;

    for (const [input, expected] of cases) {
        assert.equal(canonicalizeIdentityComponent(input), expected);
    }
    assert.equal(canonicalizeProviderId(' Tulnex : VidFast Alpha '), 'tulnex:vidfast-alpha');
});

test('rejects empty components and malformed provider IDs', () => {
    for (const value of ['', ' \t ', '---', '🎬']) {
        assert.throws(() => canonicalizeIdentityComponent(value), /Cannot canonicalize/);
    }
    for (const value of [':leaf', 'family:', 'family::leaf']) {
        assert.throws(() => canonicalizeProviderId(value), /Invalid provider ID/);
    }
});

test('resolves canonical IDs and every explicit catalog alias', () => {
    assert.equal(identityCatalog.resolve('Tulnex'), 'tulnex');

    for (const entry of catalogDocument.entries) {
        assert.equal(identityCatalog.resolve(entry.id), entry.id);
        for (const alias of entry.aliases ?? []) {
            assert.equal(
                identityCatalog.resolve(alias.value, alias.scope),
                entry.id,
                `${entry.id} alias ${alias.value}`
            );
        }
    }
});

test('does not infer aliases from display names or unknown normalized values', () => {
    assert.throws(
        () => identityCatalog.resolve('Mafia Embed'),
        /Unknown catalog provider identity/
    );
    assert.throws(
        () => identityCatalog.resolve('definitely unknown'),
        /Unknown catalog provider identity/
    );
    assert.throws(
        () => identityCatalog.resolve('moviebox'),
        /Unknown catalog provider identity/
    );
});

test('constructs a family source and preserves its display name exactly', () => {
    const source = identityCatalog.identifySource(baseSource, {
        familyId: 'Tulnex',
        providerName: '  Tulnex Display  '
    });

    assert.deepEqual(source, {
        ...baseSource,
        provider: { id: 'tulnex', name: '  Tulnex Display  ' },
        providerFamilyId: 'tulnex'
    });
    assert.equal(source.upstreamId, undefined);
    assert.equal(source.embedHostId, undefined);
});

test('constructs a leaf source with orthogonal embed-host identity', () => {
    const source = identityCatalog.identifySource(baseSource, {
        familyId: 'tulnex',
        upstreamId: 'VidFast Alpha',
        providerName: 'VidFast Alpha',
        embedHostId: 'StreamWish'
    });

    assert.equal(source.provider.id, 'tulnex:vidfast-alpha');
    assert.equal(source.provider.name, 'VidFast Alpha');
    assert.equal(source.providerFamilyId, 'tulnex');
    assert.equal(source.upstreamId, 'tulnex:vidfast-alpha');
    assert.equal(source.embedHostId, 'streamwish');
});

test('resolves scoped leaf aliases only within their family', () => {
    assert.equal(identityCatalog.resolve('ynx_vidsrc', 'popr'), 'popr:ynx-vidsrc');
    assert.throws(
        () => identityCatalog.resolve('ynx_vidsrc', 'vidnest'),
        /Unknown catalog provider identity/
    );
});

test('rejects unknown leaves, cross-family leaves, and non-host embed IDs', () => {
    assert.throws(
        () =>
            identityCatalog.identifySource(baseSource, {
                familyId: 'tulnex',
                upstreamId: 'unknown',
                providerName: 'Unknown'
            }),
        /Unknown catalog provider identity/
    );
    assert.throws(
        () =>
            identityCatalog.identifySource(baseSource, {
                familyId: 'tulnex',
                upstreamId: 'popr:gama',
                providerName: 'Gama'
            }),
        /outside scope/
    );
    assert.throws(
        () =>
            identityCatalog.identifySource(baseSource, {
                familyId: 'tulnex',
                providerName: 'Tulnex',
                embedHostId: 'vidsrc'
            }),
        /is not an embed host/
    );
});

test('assertion rejects noncanonical and inconsistent emitted identities', () => {
    const invalid = [
        {
            provider: { id: 'Tulnex', name: 'Tulnex' },
            providerFamilyId: 'tulnex'
        },
        {
            provider: { id: 'tulnex:vidfast-alpha', name: 'VidFast Alpha' },
            providerFamilyId: 'tulnex'
        },
        {
            provider: { id: 'tulnex:vidfast-alpha', name: 'VidFast Alpha' },
            providerFamilyId: 'popr',
            upstreamId: 'tulnex:vidfast-alpha'
        },
        {
            provider: { id: 'tulnex:vidfast-alpha', name: 'VidFast Alpha' },
            providerFamilyId: 'tulnex',
            upstreamId: 'tulnex:other'
        },
        {
            provider: { id: 'tulnex', name: 'Tulnex' },
            providerFamilyId: 'tulnex',
            embedHostId: 'StreamWish'
        },
        {
            provider: { id: 'tulnex', name: '   ' },
            providerFamilyId: 'tulnex'
        }
    ];

    for (const identity of invalid) {
        assert.throws(() => assertSourceIdentity(identity), TypeError);
    }
});

test('catalog construction rejects ambiguous aliases and noncanonical IDs', () => {
    assert.throws(
        () =>
            createProviderIdentityCatalog([
                { id: 'one', aliases: [{ value: 'shared' }] },
                { id: 'two', aliases: [{ value: 'shared' }] }
            ]),
        /ambiguous/
    );
    assert.throws(
        () => createProviderIdentityCatalog([{ id: 'Not-Canonical' }]),
        /canonical provider ID/
    );
});

test('constructed identities satisfy both the local assertion and OMSS Source shape', () => {
    const identified = identityCatalog.identifySource(baseSource, {
        familyId: 'ezvidapi',
        upstreamId: 'vidsrc',
        providerName: 'VidSrc'
    });
    const publicSource: Source = identified;

    assert.doesNotThrow(() => identityCatalog.assertSourceIdentity(identified));
    assert.equal(publicSource.provider.id, 'ezvidapi:vidsrc');
});
