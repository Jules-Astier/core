// CinePro's `GET|HEAD /v1/proxy`, called in-process by an embedding host
// (Saucy Streams' unified backend: its media relay fetches every segment
// through this route). The answer is the one the HTTP route gives: the same
// controller (`ProxyController.proxy`), the same request logger, Accept
// check and error handler, the same CORS and HEAD handling, but no HTTP
// framing: the body comes back as the Buffer or Node stream the framework
// produced, so a segment crosses no socket, no parser and no extra copy.
//
// Kept deliberately thin: everything that decides bytes, status and the
// proxy's own headers is the framework's code, called as Fastify calls it.
// What this file reproduces is only Fastify's reply plumbing around it
// (lower-cased headers, CORS onRequest headers, JSON serialization of error
// payloads, Content-Length, HEAD). test/in-process-proxy.test.ts compares it
// with the HTTP route, case by case.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';
import type { OMSSServer } from '@omss/framework';

export type InProcessProxyRequest = {
    method?: string;
    /** The request target's query string (`?data=...`), as sent on the wire. */
    search: string;
    /** Request headers (any case); only Range and Accept matter to the route. */
    headers?: Record<string, string | undefined>;
};

export type InProcessProxyResponse = {
    status: number;
    /** Lower-cased names, as Fastify writes them. */
    headers: Record<string, string>;
    /**
     * Buffer (buffered answers: playlists, HLS segments, errors), a Node
     * stream (streamed answers: MP4 and other progressive files), or null
     * (HEAD). Destroy the stream to abort the upstream request.
     */
    body: Buffer | Readable | null;
    /** Call when the body was consumed or abandoned (the route's log line). */
    done(): void;
};

export type InProcessProxy = (
    request: InProcessProxyRequest
) => Promise<InProcessProxyResponse>;

type FrameworkReply = {
    statusCode: number;
    raw: EventEmitter;
    sent: boolean;
    code(status: number): FrameworkReply;
    status(status: number): FrameworkReply;
    header(name: string, value: unknown): FrameworkReply;
    headers(values: Record<string, unknown>): FrameworkReply;
    type(value: string): FrameworkReply;
    getHeader(name: string): unknown;
    send(payload?: unknown): FrameworkReply;
};

type Middleware = {
    errorHandler: (error: unknown, request: unknown, reply: unknown) => Promise<unknown>;
    requestLogger: (request: unknown, reply: unknown, done: () => void) => void;
    validateContentType: (request: unknown, reply: unknown) => Promise<unknown>;
};

const require = createRequire(import.meta.url);

async function frameworkMiddleware(): Promise<Middleware> {
    // Not in the framework's export map: loaded from its dist folder, the
    // same files Fastify runs (the pinned framework version is checked by
    // scripts/patch-framework-ranges.mjs and this module's test).
    const entry = pathToFileURL(require.resolve('@omss/framework'));
    const load = (file: string) => import(new URL(file, entry).href);
    const [errors, logger, validation] = await Promise.all([
        load('./middleware/error-handler.js'),
        load('./middleware/logger.js'),
        load('./middleware/validation.js')
    ]);
    return {
        errorHandler: errors.errorHandler,
        requestLogger: logger.requestLogger,
        validateContentType: validation.validateContentType
    };
}

function isStream(payload: unknown): payload is Readable {
    return (
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as Readable).pipe === 'function'
    );
}

/**
 * The in-process `/v1/proxy` of `omss`. `cors` is the server's CORS option
 * (CinePro's app passes the same object it gives the framework).
 */
export async function createInProcessProxy(
    omss: OMSSServer,
    cors: { origin?: unknown; exposedHeaders?: string[] | string | null } = {}
): Promise<InProcessProxy> {
    const middleware = await frameworkMiddleware();
    // Fastify's default query-string parser.
    const fastifyRequire = createRequire(require.resolve('fastify'));
    const parseQuery: (query: string) => Record<string, unknown> =
        fastifyRequire('fast-querystring').parse;
    const controller = (
        omss as unknown as {
            proxyController: {
                proxy(request: unknown, reply: unknown): Promise<unknown>;
            };
        }
    ).proxyController;
    if (typeof controller?.proxy !== 'function') {
        throw new Error('The framework has no proxy controller to call in-process');
    }
    const corsHeaders: Record<string, string> = {};
    if (typeof cors.origin === 'string')
        corsHeaders['access-control-allow-origin'] = cors.origin;
    if (cors.exposedHeaders != null) {
        corsHeaders['access-control-expose-headers'] = Array.isArray(
            cors.exposedHeaders
        )
            ? cors.exposedHeaders.join(', ')
            : cors.exposedHeaders;
    }

    return async function proxyInProcess({
        method = 'GET',
        search,
        headers = {}
    }) {
        method = method.toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
            throw new TypeError('The in-process proxy answers GET and HEAD only');
        }
        const query = search.startsWith('?') ? search.slice(1) : search;
        const requestHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(headers)) {
            if (value !== undefined) requestHeaders[name.toLowerCase()] = String(value);
        }
        const request = {
            id: randomUUID(),
            method,
            url: `/v1/proxy${query ? `?${query}` : ''}`,
            headers: requestHeaders,
            query: parseQuery(query)
        };

        let payload: unknown;
        const raw = new EventEmitter();
        const replyHeaders: Record<string, string> = { ...corsHeaders };
        const reply: FrameworkReply = {
            statusCode: 200,
            raw,
            sent: false,
            code(status) {
                reply.statusCode = status;
                return reply;
            },
            status(status) {
                return reply.code(status);
            },
            header(name, value) {
                replyHeaders[name.toLowerCase()] = String(value);
                return reply;
            },
            headers(values) {
                for (const [name, value] of Object.entries(values ?? {}))
                    reply.header(name, value);
                return reply;
            },
            type(value) {
                return reply.header('content-type', value);
            },
            getHeader(name) {
                return replyHeaders[name.toLowerCase()];
            },
            send(value) {
                payload = value;
                reply.sent = true;
                return reply;
            }
        };

        // onRequest (logger), preHandler (Accept), handler, error handler:
        // Fastify's order for this route.
        middleware.requestLogger(request, reply, () => {});
        await middleware.validateContentType(request, reply);
        if (!reply.sent) {
            try {
                const returned = await controller.proxy(request, reply);
                if (!reply.sent && returned !== undefined && returned !== reply)
                    reply.send(returned);
            } catch (error) {
                payload = undefined;
                reply.sent = false;
                await middleware.errorHandler(error, request, reply);
            }
        }

        // Fastify sends a stream with setHeader + pipe: the head leaves with
        // the first chunk. A stream that ends empty becomes Node's implicit
        // `Content-Length: 0`; one that fails before its first chunk goes to
        // the error handler (Fastify's onErrorHook), as over HTTP.
        if (isStream(payload) && method !== 'HEAD') {
            const stream = payload;
            const first = await new Promise<{ error?: unknown }>((resolve) => {
                const onReadable = () => {
                    stream.off('error', onError);
                    resolve({});
                };
                const onError = (error: unknown) => {
                    stream.off('readable', onReadable);
                    resolve({ error });
                };
                stream.once('readable', onReadable);
                stream.once('error', onError);
            });
            if (first.error !== undefined) {
                stream.destroy();
                payload = undefined;
                reply.sent = false;
                delete replyHeaders['content-length'];
                await middleware.errorHandler(first.error, request, reply);
            } else if (stream.readableLength === 0) {
                // 'readable' at the end of the stream: nothing came.
                payload = Buffer.alloc(0);
            }
        }

        // Fastify's serialization of what the handler sent.
        let body: Buffer | Readable | null;
        if (isStream(payload)) {
            body = payload;
        } else if (Buffer.isBuffer(payload)) {
            body = payload;
            replyHeaders['content-length'] ??= String(payload.byteLength);
        } else if (payload === undefined || payload === null) {
            body = Buffer.alloc(0);
            replyHeaders['content-length'] ??= '0';
        } else if (typeof payload === 'string') {
            replyHeaders['content-type'] ??= 'text/plain; charset=utf-8';
            body = Buffer.from(payload);
            replyHeaders['content-length'] ??= String(body.byteLength);
        } else if (
            replyHeaders['content-type'] !== undefined &&
            !replyHeaders['content-type'].includes('json')
        ) {
            // An object under a non-JSON type (an error after a stream's
            // headers were set): Fastify refuses it and answers with its
            // fallback error.
            reply.statusCode = 500;
            replyHeaders['content-type'] = 'application/json; charset=utf-8';
            body = Buffer.from(
                JSON.stringify({
                    statusCode: 500,
                    code: 'FST_ERR_REP_INVALID_PAYLOAD_TYPE',
                    error: 'Internal Server Error',
                    message: `Attempted to send payload of invalid type '${typeof payload}'. Expected a string or Buffer.`
                })
            );
            replyHeaders['content-length'] = String(body.byteLength);
        } else {
            replyHeaders['content-type'] ??= 'application/json; charset=utf-8';
            body = Buffer.from(JSON.stringify(payload));
            replyHeaders['content-length'] ??= String(body.byteLength);
        }
        if (method === 'HEAD') {
            // Fastify's HEAD route: a stream is drained (not aborted),
            // anything else keeps its Content-Length.
            if (isStream(body)) {
                body.on('error', () => {});
                body.resume();
            } else if (body) {
                replyHeaders['content-length'] = String(body.byteLength);
            }
            body = null;
        }
        let finished = false;
        return {
            status: reply.statusCode,
            headers: replyHeaders,
            body,
            done() {
                if (finished) return;
                finished = true;
                raw.emit('finish');
            }
        };
    };
}
