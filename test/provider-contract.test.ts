import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderResult } from '@omss/framework';
import { assertProviderResultContract } from './support/provider-contract.js';

function validResult(): ProviderResult {
    const data = Buffer.from(
        JSON.stringify({
            url: 'https://media.example.test/master.m3u8',
            headers: { Referer: 'https://provider.example.test/' }
        })
    ).toString('base64url');

    return {
        sources: [
            {
                url: `http://127.0.0.1:3000/v1/proxy?data=${data}`,
                type: 'hls',
                quality: '1080p',
                audioTracks: [{ language: 'eng', label: 'English' }],
                provider: { id: 'example', name: 'Example' }
            }
        ],
        subtitles: [],
        diagnostics: []
    };
}

test('provider contract accepts a valid proxied HLS result', () => {
    assert.doesNotThrow(() =>
        assertProviderResultContract(validResult(), {
            providerId: 'example'
        })
    );
});

test('provider contract rejects a raw remote HLS URL', () => {
    const result = validResult();
    result.sources[0].url = 'https://media.example.test/master.m3u8';

    assert.throws(
        () =>
            assertProviderResultContract(result, {
                providerId: 'example'
            }),
        /must use CinePro \/v1\/proxy/
    );
});

test('provider contract rejects a Saucy-incompatible source type', () => {
    const result = validResult();
    result.sources[0].type = 'dash';

    assert.throws(
        () =>
            assertProviderResultContract(result, {
                providerId: 'example'
            }),
        /is not allowed/
    );
});

