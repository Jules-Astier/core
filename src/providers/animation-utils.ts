import type { ProviderMediaObject } from '@omss/framework';
import { absoluteEpisode } from './hianime/hianime.js';

export const ANIMATION_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
export const titleKey = (s: string) =>
    s
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^\p{L}\p{N}]/gu, '');
export const titleSlug = (s: string) =>
    s
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
export function publicHost(url: URL, hosts: readonly string[]) {
    return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        hosts.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))
    );
}
export async function boundedText(
    fetchImpl: typeof fetch,
    url: URL,
    hosts: readonly string[],
    signal: AbortSignal,
    headers: Record<string, string> = {}
) {
    if (!publicHost(url, hosts)) throw new Error('Unrecognized host');
    const r = await fetchImpl(url.href, {
        headers: { 'User-Agent': ANIMATION_UA, ...headers },
        signal,
        redirect: 'manual'
    });
    if (!r.ok || !r.body) {
        await r.body?.cancel();
        throw new Error('Upstream HTTP failure');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = r.body.getReader();
    try {
        for (;;) {
            const v = await reader.read();
            if (v.done) break;
            size += v.value.byteLength;
            if (size > 4 * 1024 * 1024)
                throw new Error('Upstream body too large');
            chunks.push(v.value);
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).toString('utf8');
}
export async function animationMetadata(
    media: ProviderMediaObject,
    key: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal
) {
    if (!key || !/^\d+$/.test(media.tmdbId))
        throw new Error('Missing identity');
    const d = JSON.parse(
        await boundedText(
            fetchImpl,
            new URL(
                `https://api.themoviedb.org/3/${media.type}/${media.tmdbId}?api_key=${encodeURIComponent(key)}`
            ),
            ['api.themoviedb.org'],
            signal
        )
    );
    if (!d.genres?.some((g: { id: number }) => g.id === 16)) return null;
    if (media.type === 'movie')
        return {
            title: media.title,
            seriesTitle: null,
            absolute: null,
            language:
                typeof d.original_language === 'string'
                    ? d.original_language
                    : 'und'
        };
    const absolute = absoluteEpisode(d, media.s!, media.e!);
    if (!absolute) return null;
    const ep = JSON.parse(
        await boundedText(
            fetchImpl,
            new URL(
                `https://api.themoviedb.org/3/tv/${media.tmdbId}/season/${media.s}/episode/${media.e}?api_key=${encodeURIComponent(key)}`
            ),
            ['api.themoviedb.org'],
            signal
        )
    );
    if (typeof ep.name !== 'string' || !ep.name.trim()) return null;
    return {
        title: ep.name,
        seriesTitle: media.title,
        absolute,
        language:
            typeof d.original_language === 'string'
                ? d.original_language
                : 'und'
    };
}
export async function verifiedMp4(
    fetchImpl: typeof fetch,
    url: URL,
    hosts: readonly string[],
    signal: AbortSignal,
    headers: Record<string, string>
) {
    for (let i = 0; i < 4; i++) {
        if (!publicHost(url, hosts) || /\/error\.mp4$/i.test(url.pathname))
            return false;
        const r = await fetchImpl(url.href, {
            headers: { ...headers, Range: 'bytes=0-4095' },
            signal,
            redirect: 'manual'
        });
        if (r.status >= 300 && r.status < 400) {
            await r.body?.cancel();
            const next = r.headers.get('location');
            if (!next) return false;
            url = new URL(next, url);
            continue;
        }
        if (!r.ok || !r.body) {
            await r.body?.cancel();
            return false;
        }
        const reader = r.body.getReader();
        let bytes = Buffer.alloc(0);
        try {
            while (bytes.length < 12) {
                const v = await reader.read();
                if (v.done) break;
                bytes = Buffer.concat([bytes, Buffer.from(v.value)]);
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
    }
    return false;
}
