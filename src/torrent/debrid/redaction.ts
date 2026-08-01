const URL = /\bhttps?:\/\/[^\s"'<>]+/gi;
const BEARER = /\bBearer\s+\S+/gi;
const TOKEN_FIELD = /\b(token|secret|api[_-]?key|authorization)=([^&\s]+)/gi;

/** Sanitizes untrusted transport errors for server-side diagnostic sinks. */
export function redactDebridDiagnostic(
    value: unknown,
    secrets: readonly string[] = []
): string {
    let text = value instanceof Error ? value.message : String(value);
    text = text.replace(URL, '[REDACTED_URL]');
    text = text.replace(BEARER, 'Bearer [REDACTED]');
    text = text.replace(TOKEN_FIELD, '$1=[REDACTED]');
    for (const secret of secrets) {
        if (secret) text = text.split(secret).join('[REDACTED]');
    }
    return text.slice(0, 256);
}
