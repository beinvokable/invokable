import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InvokableAuthHandler } from './handler.js';

/**
 * Adapts the fetch-style handler to Node's `http` and to Express, whose
 * req/res are Node's. Hono, Deno and workers can use the handler directly.
 */

function toRequest(req: IncomingMessage, body: Buffer): Request {
  const host = req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  const url = new URL(req.url ?? '/', `${proto}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.set(key, value);
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0;
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: new Uint8Array(body) } : {}),
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  // Express's json/urlencoded middleware may have consumed the stream already.
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined && parsed !== null) {
    if (Buffer.isBuffer(parsed)) return parsed;
    if (typeof parsed === 'string') return Buffer.from(parsed);
    return Buffer.from(JSON.stringify(parsed));
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Express-style middleware. Calls `next()` for paths the handler does not own,
 * so it composes with the host application's routes.
 */
export function expressMiddleware(handler: InvokableAuthHandler) {
  return function middleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): void {
    void (async () => {
      try {
        const body = await readBody(req);
        const response = await handler(toRequest(req, body));
        if (response === null) return next();
        await send(res, response);
      } catch (e) {
        next(e);
      }
    })();
  };
}

/** Plain `node:http` listener. Answers 404 for unowned paths. */
export function nodeListener(handler: InvokableAuthHandler) {
  return function listener(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      try {
        const body = await readBody(req);
        const response = await handler(toRequest(req, body));
        if (response === null) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        await send(res, response);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'internal', message: e instanceof Error ? e.message : String(e) }),
        );
      }
    })();
  };
}
