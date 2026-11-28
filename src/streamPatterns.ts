// These regex patterns are used that the proxy can identify which urls should be streamed.
// by default the most common video files are included in the @omss/framework

export const streamPatterns: RegExp[] = [
    // NHL24ALL MPEG-TS segments can stream immediately. Its playlists still need URI rewriting.
    /^https:\/\/(?:[a-z0-9-]+\.)*mlb9\.com\/[^?#]*\.ts(?:\?|$)/i,
    /^https:\/\/(?:[a-z0-9-]+\.)?wcostream\.com\/getvid(?:\?|$)/,
    /pixeldrain\.dev|pixeldra\.in/,
    /hub\.(raj\.lat|toxix\.buzz|oreao-cdn\.buzz)/,
    /wasabisys\.com/,
    /hakunaymatata\.com/,
    /streamflixserver\.site|tripplestream\.online/,
    /illimitableinkwell\.site/,
    /frostcomet5\.pro/,
    /(epimetheus63|earth14|pandora20)\.workers\.dev/, // streammafia's workers.dev proxy domains
    /tiktokcdn\.com/,
    /\/content\/(.)*\/page\-(.)*\.html/,
    /trendimovies\.com\/tgstream\/stream/
];
