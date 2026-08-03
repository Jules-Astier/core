const HASH_WORDS = [
    1116352408, 1899447441, 3049323471, 3921009573, 961987163,
    1508970993, 2453635748, 2870763221, 3624381080, 310598401,
    607225278, 1426881987, 1925078388, 2162078206, 2614888103,
    3248222580
] as const;
const INITIAL_HASH_WORD = 1732584193;
const STATE_SIZE = 61;
const STATE_ROUNDS = 8;
const GOLDEN_RATIO = 2654435769;
const PAYLOAD_MAGIC = Uint8Array.from([109, 118, 109, 49]);

type CipherState = {
    state: number[];
    accumulator: number;
};

export function decryptVidKingPayload(
    payload: string,
    seed: string,
    mediaId: number
): string {
    if (!payload || !seed || !Number.isSafeInteger(mediaId) || mediaId < 1) {
        throw new TypeError('VidKing encrypted payload input is invalid');
    }

    const bytes = decodeBase64Url(payload);
    const stream = createKeystream(seed, mediaId, bytes.length);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] ^= stream[index];
    }
    for (let index = 0; index < PAYLOAD_MAGIC.length; index += 1) {
        if (bytes[index] !== PAYLOAD_MAGIC[index]) {
            throw new TypeError('VidKing encrypted payload failed validation');
        }
    }
    return new TextDecoder().decode(bytes.subarray(PAYLOAD_MAGIC.length));
}

function createKeystream(
    seed: string,
    mediaId: number,
    length: number
): Uint8Array {
    const state = initializeCipher(seed, mediaId);
    const output = new Uint8Array(length);
    let offset = 0;
    for (let wordIndex = 0; offset < length; wordIndex += 1) {
        const word = nextWord(state, wordIndex);
        output[offset++] = word & 0xff;
        if (offset < length) output[offset++] = (word >>> 8) & 0xff;
        if (offset < length) output[offset++] = (word >>> 16) & 0xff;
        if (offset < length) output[offset++] = (word >>> 24) & 0xff;
    }
    return output;
}

function initializeCipher(seed: string, mediaId: number): CipherState {
    if (isOddTriangular(seed.length)) {
        return {
            state: initializePermutation(seed),
            accumulator: seedHash(seed)
        };
    }

    const state = new Array<number>(STATE_SIZE);
    let accumulator = mix32(
        fnvHash(seed) ^ mix32((mediaId >>> 0) ^ GOLDEN_RATIO)
    );
    for (let round = 0; round < STATE_ROUNDS; round += 1) {
        if (isEvenTriangular(round)) {
            const position = accumulator % STATE_SIZE;
            accumulator = rotateLeft(
                (accumulator + GOLDEN_RATIO) >>> 0,
                7 + (round & 7)
            );
            state[position] = (accumulator ^ mix32(accumulator)) >>> 0;
            accumulator = mix32((accumulator + position) >>> 0);
        } else {
            state[round] = HASH_WORDS[round & 15];
        }
    }
    return {
        state,
        accumulator: mix32(accumulator ^ 2779096485)
    };
}

function nextWord(cipher: CipherState, wordIndex: number): number {
    const position = cipher.accumulator % STATE_SIZE;
    const initializedMask = 0 - Number(position in cipher.state);
    const value = cipher.state[position] >>> 0;
    const increment = Math.imul(GOLDEN_RATIO, wordIndex + 1) >>> 0;
    let word = chooseWord(
        cipher.accumulator,
        (value ^ increment) >>> 0,
        initializedMask
    );
    word = (
        rotateLeft(
            (word + cipher.accumulator) >>> 0,
            position & 31
        ) ^
        rotateLeft(cipher.accumulator, Math.imul(position, 7) & 31)
    ) >>> 0;
    cipher.accumulator = mix32((word + GOLDEN_RATIO) >>> 0);
    cipher.state[position] = cipher.accumulator;
    return cipher.accumulator;
}

function decodeBase64Url(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new TypeError('VidKing encrypted payload encoding is invalid');
    }
    return Uint8Array.from(Buffer.from(value, 'base64url'));
}

function initializePermutation(seed: string): number[] {
    const state = Array.from({ length: 256 }, (_, index) => index);
    let position = 0;
    for (let index = 0; index < 256; index += 1) {
        position =
            (position + state[index] + seed.charCodeAt(index % seed.length)) &
            0xff;
        [state[index], state[position]] = [state[position], state[index]];
    }
    return state;
}

function seedHash(seed: string): number {
    let value = INITIAL_HASH_WORD >>> 0;
    for (let index = 0; index < seed.length; index += 1) {
        value = rotateLeft(
            (value ^
                Math.imul(seed.charCodeAt(index), HASH_WORDS[index & 15])) >>>
                0,
            5
        );
    }
    return mix32(value);
}

function fnvHash(seed: string): number {
    let value = 2166136261;
    for (let index = 0; index < seed.length; index += 1) {
        value = Math.imul(value ^ seed.charCodeAt(index), 16777619) >>> 0;
    }
    return mix32(value);
}

function mix32(input: number): number {
    let value = input >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 2246822507) >>> 0;
    value ^= value >>> 13;
    value = Math.imul(value, 3266489909) >>> 0;
    value ^= value >>> 16;
    return value >>> 0;
}

function rotateLeft(input: number, shift: number): number {
    const value = input >>> 0;
    const amount = shift & 31;
    return amount === 0
        ? value
        : ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function chooseWord(left: number, right: number, mask: number): number {
    return ((left ^ right) >>> 0 | ((left & right & mask) >>> 0)) >>> 0;
}

function isEvenTriangular(value: number): boolean {
    return ((value * (value + 1)) & 1) === 0;
}

function isOddTriangular(value: number): boolean {
    return ((value * (value + 1)) & 1) === 1;
}
