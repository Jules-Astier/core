export function parseHeadlessVidXOrigin(value: string | undefined): URL | null {
    const url = value ? URL.parse(value) : null;
    if (
        !url ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    ) {
        return null;
    }
    return url;
}
