/**
 * Structural subset of OMSS TorrentCandidate. Keeping this boundary structural
 * lets the disabled prototype compile before CinePro updates its framework pin.
 */
export interface DebridTorrentCandidate {
    kind: 'torrent';
    infoHash: string;
    fileIdx?: number;
    name?: string;
    filename?: string;
    size?: number;
    seeders?: number;
    provider: {
        id: string;
        name: string;
    };
}

export interface DebridPrototypeConfig {
    enabled: boolean;
    secretEnvName: string;
    timeoutMs: number;
    maxRetries: number;
    maxCandidates: number;
    maxResults: number;
    circuitFailureThreshold: number;
    circuitResetMs: number;
}

export interface DebridTransportRequest {
    candidate: DebridTorrentCandidate;
    authorization: string;
    signal: AbortSignal;
}

export interface DebridTransportResponse {
    state: 'cached' | 'cache-miss';
    links?: readonly {
        url: string;
        rangeSupported?: boolean;
        contentLength?: number;
    }[];
}

export interface DebridTransport {
    resolve(request: DebridTransportRequest): Promise<DebridTransportResponse>;
}

export interface DebridLink {
    url: string;
    capabilities: {
        rangeRequests: boolean;
        seekable: boolean;
        contentLength?: number;
    };
}

export type DebridResolution =
    | { state: 'disabled'; links: [] }
    | { state: 'missing-secret'; links: [] }
    | { state: 'cache-miss'; links: [] }
    | { state: 'circuit-open'; links: [] }
    | {
          state: 'unavailable';
          links: [];
          reason: 'timeout' | 'transport-error' | 'invalid-response';
      }
    | { state: 'ready'; links: DebridLink[] };

export interface DebridObservation {
    outcome: DebridResolution['state'];
    attempts: number;
    candidatesExamined: number;
    rejectedLinks: number;
    cacheMisses: number;
}
