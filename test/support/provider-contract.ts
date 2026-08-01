import assert from 'node:assert/strict';
import type {
    ProviderResult,
    Source,
    SourceType
} from '@omss/framework';

export type ProviderContractOptions = {
    providerId: string;
    allowedTypes?: readonly SourceType[];
    minimumSources?: number;
};

function providerIdMatches(actual: string, expected: string): boolean {
    return actual === expected || actual.startsWith(`${expected}:`);
}

function assertSourceContract(
    source: Source,
    options: Required<ProviderContractOptions>,
    index: number
): void {
    assert.ok(source.url, `source ${index} must have a URL`);
    assert.ok(
        options.allowedTypes.includes(source.type),
        `source ${index} type "${source.type}" is not allowed`
    );
    assert.ok(source.quality, `source ${index} must have a quality label`);
    assert.ok(source.provider?.id, `source ${index} must have a provider ID`);
    assert.ok(
        providerIdMatches(source.provider.id, options.providerId),
        `source ${index} provider "${source.provider.id}" does not match "${options.providerId}"`
    );
    assert.ok(
        source.provider.name,
        `source ${index} must have a provider name`
    );
    assert.ok(
        Array.isArray(source.audioTracks) && source.audioTracks.length > 0,
        `source ${index} must describe at least one audio track`
    );

    for (const [trackIndex, track] of source.audioTracks.entries()) {
        assert.ok(
            track.label,
            `source ${index} audio track ${trackIndex} must have a label`
        );
        assert.ok(
            track.language,
            `source ${index} audio track ${trackIndex} must have a language`
        );
    }

    const parsed = new URL(source.url, 'http://127.0.0.1:3000');
    if (source.type === 'hls' || source.type === 'mp4') {
        assert.ok(
            parsed.pathname.startsWith('/v1/proxy'),
            `source ${index} ${source.type} URL must use CinePro /v1/proxy`
        );
        assert.ok(
            parsed.searchParams.has('data'),
            `source ${index} proxy URL must contain encoded proxy data`
        );
    }
}

export function assertProviderResultContract(
    result: ProviderResult,
    providedOptions: ProviderContractOptions
): void {
    const options: Required<ProviderContractOptions> = {
        providerId: providedOptions.providerId,
        allowedTypes: providedOptions.allowedTypes ?? [
            'hls',
            'mp4',
            'embed'
        ],
        minimumSources: providedOptions.minimumSources ?? 1
    };

    assert.ok(Array.isArray(result.sources), 'result.sources must be an array');
    assert.ok(
        Array.isArray(result.subtitles),
        'result.subtitles must be an array'
    );
    assert.ok(
        Array.isArray(result.diagnostics),
        'result.diagnostics must be an array'
    );
    assert.ok(
        result.sources.length >= options.minimumSources,
        `expected at least ${options.minimumSources} source(s)`
    );

    result.sources.forEach((source, index) =>
        assertSourceContract(source, options, index)
    );

    for (const [index, subtitle] of result.subtitles.entries()) {
        assert.ok(subtitle.url, `subtitle ${index} must have a URL`);
        assert.ok(subtitle.label, `subtitle ${index} must have a label`);
        assert.ok(subtitle.format, `subtitle ${index} must have a format`);
    }

    for (const [index, diagnostic] of result.diagnostics.entries()) {
        assert.ok(diagnostic.code, `diagnostic ${index} must have a code`);
        assert.ok(diagnostic.message, `diagnostic ${index} must have a message`);
        assert.ok(diagnostic.severity, `diagnostic ${index} needs a severity`);
    }
}

