const ROUND_CONSTANTS = [
    1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993,
    2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987,
    1925078388, 2162078206, 2614888103, 3248222580
] as const;

const MAGIC = Uint8Array.from([109, 118, 109, 49]);

export interface DecryptedPayload {
    sources: Array<{ quality?: string; url: string; type?: string }>;
    subtitles: Array<{ url: string; lang?: string; language?: string }>;
}

type DecoderState = {
    S: number[];
    acc: number;
};

function mix(value: number): number {
    value >>>= 0;
    value ^= value >>> 16;
    value = Math.imul(value, 2246822507) >>> 0;
    value ^= value >>> 13;
    value = Math.imul(value, 3266489909) >>> 0;
    return (value ^ (value >>> 16)) >>> 0;
}

function rotateLeft(value: number, count: number): number {
    value >>>= 0;
    count &= 31;
    return count === 0
        ? value >>> 0
        : ((value << count) | (value >>> (32 - count))) >>> 0;
}

function triangularIsEven(value: number): boolean {
    return ((value * (value + 1)) & 1) === 0;
}

function triangularIsOdd(value: number): boolean {
    return ((value * (value + 1)) & 1) === 1;
}

function seedHash(seed: string): number {
    let hash = 2166136261;
    for (let index = 0; index < seed.length; index += 1) {
        hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619) >>> 0;
    }
    return mix(hash);
}

function createPermutation(seed: string): number[] {
    const permutation = Array.from({ length: 256 }, (_, index) => index);
    let cursor = 0;
    for (let index = 0; index < 256; index += 1) {
        cursor =
            (cursor +
                permutation[index] +
                seed.charCodeAt(index % seed.length)) &
            255;
        [permutation[index], permutation[cursor]] = [
            permutation[cursor],
            permutation[index]
        ];
    }
    return permutation;
}

function permutationAccumulator(seed: string): number {
    let accumulator = 1732584193;
    for (let index = 0; index < seed.length; index += 1) {
        accumulator = rotateLeft(
            (accumulator ^
                Math.imul(
                    seed.charCodeAt(index),
                    ROUND_CONSTANTS[index & 15]
                )) >>>
                0,
            5
        );
    }
    return mix(accumulator);
}

function createDecoderState(seed: string, mediaId: number): DecoderState {
    if (seed.length === 0) {
        throw new TypeError('Videasy seed must not be empty');
    }

    if (triangularIsOdd(seed.length)) {
        return {
            S: createPermutation(seed),
            acc: permutationAccumulator(seed)
        };
    }

    const state = Array<number>(61);
    let accumulator =
        mix(seedHash(seed) ^ mix((mediaId >>> 0) ^ 2654435769)) >>> 0;
    for (let index = 0; index < 8; index += 1) {
        if (triangularIsEven(index)) {
            const slot = accumulator % 61;
            accumulator = rotateLeft(
                (accumulator + 2654435769) >>> 0,
                7 + (index & 7)
            );
            state[slot] = (accumulator ^ mix(accumulator)) >>> 0;
            accumulator = mix((accumulator + slot) >>> 0);
        } else {
            state[index] = ROUND_CONSTANTS[index & 15];
        }
    }
    return { S: state, acc: mix(2779096485 ^ accumulator) >>> 0 };
}

function nextWord(state: DecoderState, wordIndex: number): number {
    const slot = state.acc % 61;
    const presentMask = 0 - Number(slot in state.S);
    const slotValue = state.S[slot] >>> 0;
    const mixedWord = (slotValue ^ Math.imul(2654435769, wordIndex + 1)) >>> 0;
    let value =
        ((state.acc ^ mixedWord) | (state.acc & mixedWord & presentMask)) >>> 0;
    value =
        (rotateLeft((value + state.acc) >>> 0, slot & 31) ^
            rotateLeft(state.acc, Math.imul(slot, 7) & 31)) >>>
        0;
    state.acc = mix((value + 2654435769) >>> 0);
    state.S[slot] = state.acc;
    return state.acc;
}

function keystream(seed: string, mediaId: number, length: number): Uint8Array {
    const state = createDecoderState(seed, mediaId);
    const output = new Uint8Array(length);
    let outputIndex = 0;
    let wordIndex = 0;
    while (outputIndex < length) {
        const word = nextWord(state, wordIndex++);
        output[outputIndex++] = word & 255;
        if (outputIndex < length) output[outputIndex++] = (word >>> 8) & 255;
        if (outputIndex < length) output[outputIndex++] = (word >>> 16) & 255;
        if (outputIndex < length) output[outputIndex++] = (word >>> 24) & 255;
    }
    return output;
}

function decodeBase64Url(value: string): Uint8Array {
    const normalized = value
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(4 * Math.ceil(value.length / 4), '=');
    return Uint8Array.from(Buffer.from(normalized, 'base64'));
}

export function decodeVideasyResponse(
    blob: string,
    seed: string,
    tmdbId: string
): string {
    if (!/^\d+$/.test(tmdbId)) {
        throw new TypeError('Videasy requires a numeric TMDB ID');
    }
    const encrypted = decodeBase64Url(blob);
    const mask = keystream(seed, Number(tmdbId), encrypted.length);
    for (let index = 0; index < encrypted.length; index += 1) {
        encrypted[index] ^= mask[index];
    }
    for (let index = 0; index < MAGIC.length; index += 1) {
        if (encrypted[index] !== MAGIC[index]) {
            throw new Error('Videasy payload failed integrity validation');
        }
    }
    return new TextDecoder().decode(encrypted.subarray(MAGIC.length));
}

export function decryptResponse(
    blob: string,
    seed: string,
    tmdbId: string
): DecryptedPayload | null {
    if (!blob || !seed) return null;
    try {
        const parsed = JSON.parse(
            decodeVideasyResponse(blob, seed, tmdbId)
        ) as Partial<DecryptedPayload>;
        if (!Array.isArray(parsed.sources)) return null;
        return {
            sources: parsed.sources.filter(
                (source): source is DecryptedPayload['sources'][number] =>
                    !!source && typeof source.url === 'string'
            ),
            subtitles: Array.isArray(parsed.subtitles)
                ? parsed.subtitles.filter(
                      (
                          subtitle
                      ): subtitle is DecryptedPayload['subtitles'][number] =>
                          !!subtitle && typeof subtitle.url === 'string'
                  )
                : []
        };
    } catch {
        return null;
    }
}

// Test-only helper for deterministic synthetic fixtures. The transform is
// symmetric, so applying the same keystream produces a valid encoded payload.
export function encodeVideasyFixture(
    payload: unknown,
    seed: string,
    tmdbId: string
): string {
    const plain = Buffer.concat([
        Buffer.from(MAGIC),
        Buffer.from(JSON.stringify(payload), 'utf8')
    ]);
    const mask = keystream(seed, Number(tmdbId), plain.length);
    const encrypted = Buffer.from(
        plain.map((value, index) => value ^ mask[index])
    );
    return encrypted
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}
