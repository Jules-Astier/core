import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimeAv1Provider } from '../src/providers/animeav1/animeav1.js';
import { CineSuProvider } from '../src/providers/cinesu/cinesu.js';
import { FramexProvider } from '../src/providers/framex/framex.js';
import { HiAnimeProvider } from '../src/providers/hianime/hianime.js';
import { PapadustreamProvider } from '../src/providers/papadustream/papadustream.js';
import { PeachifyProvider } from '../src/providers/peachify/peachify.js';
import { PoprProvider } from '../src/providers/popr/popr.js';
import { TulnexProvider } from '../src/providers/tulnex/tulnex.js';
import { VidApiProvider } from '../src/providers/vidapi/vidapi.js';
import { VidKingProvider } from '../src/providers/vidking/vidking.js';
import { VidRockProvider } from '../src/providers/vidrock/vidrock.js';
import { VidSrcProvider } from '../src/providers/vidsrc/vidsrc.js';

const providerFlags = {
    ANIMEAV1_ENABLED: AnimeAv1Provider,
    CINESU_ENABLED: CineSuProvider,
    FRAMEX_ENABLED: FramexProvider,
    HIANIME_ENABLED: HiAnimeProvider,
    PAPADUSTREAM_ENABLED: PapadustreamProvider,
    PEACHIFY_ENABLED: PeachifyProvider,
    POPR_ENABLED: PoprProvider,
    TULNEX_ENABLED: TulnexProvider,
    VIDAPI_ENABLED: VidApiProvider,
    VIDKING_ENABLED: VidKingProvider,
    VIDROCK_ENABLED: VidRockProvider,
    VIDSRC_ENABLED: VidSrcProvider
};

for (const [flag, Provider] of Object.entries(providerFlags)) {
    test(`${flag} defaults on and honors false`, () => {
        const previous = process.env[flag];
        try {
            delete process.env[flag];
            assert.equal(new Provider().enabled, true);
            process.env[flag] = 'false';
            assert.equal(new Provider().enabled, false);
        } finally {
            if (previous === undefined) delete process.env[flag];
            else process.env[flag] = previous;
        }
    });
}
