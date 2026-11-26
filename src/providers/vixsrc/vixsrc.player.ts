import type { ProviderMediaObject } from '@omss/framework';
import { parseHeadlessVidXOrigin } from '../headlessvidx-origin.js';

const MAX_PLAYLIST_URL_LENGTH = 4_096;
const MAX_RESPONSE_BYTES = 16 * 1024;
const PLAYER_TIMEOUT_MS = 15_000;

export class VixSrcPlayerError extends Error {}

export async function fetchPublicPlayerPlaylist(
    baseUrl: string | undefined,
    media: ProviderMediaObject,
    fetchImpl: typeof fetch,
    now: () => number
): Promise<string | null> {
    const service = parseHeadlessVidXOrigin(baseUrl);
    if (!service) {
        throw new VixSrcPlayerError(
            'public-player mode requires a valid VIXSRC_HEADLESSVIDX_BASE_URL origin'
        );
    }

    if (!/^[1-9]\d{0,11}$/.test(media.tmdbId)) {
        throw new VixSrcPlayerError('public player requires a TMDB ID');
    }
    const identity: { tmdbId: string; season?: number; episode?: number } = {
        tmdbId: media.tmdbId
    };
    if (media.type === 'tv') {
        if (
            media.s === undefined ||
            media.e === undefined ||
            !Number.isSafeInteger(media.s) ||
            !Number.isSafeInteger(media.e) ||
            media.s < 0 ||
            media.e < 1
        ) {
            throw new VixSrcPlayerError(
                'public player requires a valid season and episode'
            );
        }
        identity.season = media.s;
        identity.episode = media.e;
    }

    let response: Response;
    try {
        response = await fetchImpl(new URL('/public-player/vixsrc', service), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(identity),
            redirect: 'error',
            signal: AbortSignal.timeout(PLAYER_TIMEOUT_MS)
        });
    } catch {
        throw new VixSrcPlayerError('public player service was unavailable');
    }

    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if ([401, 403, 429].includes(response.status)) {
            throw new VixSrcPlayerError(
                `public player request was blocked (${response.status})`
            );
        }
        throw new VixSrcPlayerError('public player service was unavailable');
    }

    const body = await readPlayerResponse(response);
    if (body?.status === 'not-found') return null;
    if (body?.status === 'blocked') {
        throw new VixSrcPlayerError('public player request was blocked');
    }
    if (body?.status === 'unavailable') {
        throw new VixSrcPlayerError('public player service was unavailable');
    }
    if (body?.status !== 'resolved' || typeof body.playlistUrl !== 'string') {
        throw new VixSrcPlayerError('public player response was malformed');
    }
    const value = body.playlistUrl;
    const url =
        value.length <= MAX_PLAYLIST_URL_LENGTH && /^[\x21-\x7e]+$/.test(value)
            ? URL.parse(value)
            : null;
    if (
        !url ||
        url.origin !== 'https://vixsrc.to' ||
        url.username ||
        url.password ||
        url.hash ||
        !/^\/playlist\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    ) {
        throw new VixSrcPlayerError(
            'public player returned an invalid playlist URL'
        );
    }
    const expires = url.searchParams.getAll('expires');
    if (
        expires.length !== 1 ||
        !/^\d{1,12}$/.test(expires[0]) ||
        Number(expires[0]) * 1_000 <= now()
    ) {
        throw new VixSrcPlayerError(
            'public player playlist was expired or missing expiry'
        );
    }
    // Preserve the URL issued by the player. Its query parameters are opaque.
    return value;
}

async function readPlayerResponse(
    response: Response
): Promise<{ status?: unknown; playlistUrl?: unknown } | null> {
    const contentType = response.headers.get('content-type')?.split(';')[0];
    if (
        contentType?.trim().toLowerCase() !== 'application/json' ||
        !response.body ||
        Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES
    ) {
        await response.body?.cancel().catch(() => undefined);
        throw new VixSrcPlayerError('public player response was malformed');
    }

    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
                throw new VixSrcPlayerError(
                    'public player response was too large'
                );
            }
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch (error) {
        if (error instanceof VixSrcPlayerError) throw error;
        throw new VixSrcPlayerError('public player response was malformed');
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}
