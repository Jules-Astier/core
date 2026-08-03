export type VidKingSeedResponse = {
    seed?: string;
    ttlMs?: number;
};

export type VidKingSource = {
    url?: string;
    quality?: string;
    type?: string;
};

export type VidKingSubtitle = {
    url?: string;
    label?: string;
    display?: string;
    language?: string;
    type?: string;
    format?: string;
};

export type VidKingSourceResponse = {
    sources?: VidKingSource[];
    subtitles?: VidKingSubtitle[];
};
