export type VidLoveSource = {
    source?: string;
    label?: string;
    url?: string;
    manifest?: string;
    type?: string;
    quality?: string;
    headers?: Record<string, unknown>;
};

export type VidLoveSubtitle = {
    file?: string;
    url?: string;
    label?: string;
    display?: string;
    language?: string;
    type?: string;
    format?: string;
};

export type VidLoveResponse = {
    source?: VidLoveSource | null;
    subtitles?: VidLoveSubtitle[];
};
