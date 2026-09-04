import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * A minimal implementation of the five device-flow endpoints from spec 5.4.
 *
 * This exists so the client can be tested against the actual wire contract
 * rather than a hand-stubbed fetch. When `@invokable/server` lands it must make
 * these same tests pass — the endpoint behaviour asserted here IS the spec.
 */
export interface FakeAuthServer {
  url: string;
  close: () => Promise<void>;
  /** Approve the pending device code, as the web page would. */
  approve: (userCode: string) => void;
  deny: (userCode: string) => void;
  expire: (userCode: string) => void;
  /** Requests seen, for asserting on headers. */
  requests: Array<{ method: string; path: string; headers: Record<string, string> }>;
  /** Force the next N token polls to answer `slow_down`. */
  slowDownFor: (polls: number) => void;
  revoked: string[];
}

type DeviceState = 'pending' | 'approved' | 'denied' | 'expired';

interface Device {
  deviceCode: string;
  userCode: string;
  state: DeviceState;
}

export async function startFakeAuthServer(
  opts: { interval?: number } = {},
): Promise<FakeAuthServer> {
  const devices = new Map<string, Device>();
  const byUserCode = new Map<string, Device>();
  const tokens = new Map<string, { subject: string; orgId: string }>();
  const requests: FakeAuthServer['requests'] = [];
  const revoked: string[] = [];
  let slowDownRemaining = 0;
  let counter = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const body: Record<string, unknown> = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        : {};

      requests.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        headers: req.headers as Record<string, string>,
      });

      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');

      if (url.pathname === '/device/start' && req.method === 'POST') {
        counter += 1;
        const device: Device = {
          deviceCode: `dc_${counter}`,
          userCode: `CODE-${counter}`,
          state: 'pending',
        };
        devices.set(device.deviceCode, device);
        byUserCode.set(device.userCode, device);
        return send(200, {
          deviceCode: device.deviceCode,
          userCode: device.userCode,
          verificationUri: `${baseUrl()}/device`,
          verificationUriComplete: `${baseUrl()}/device?code=${device.userCode}`,
          interval: opts.interval ?? 1,
          expiresIn: 900,
        });
      }

      if (url.pathname === '/device/token' && req.method === 'POST') {
        const device = devices.get(String(body['deviceCode']));
        if (!device) return send(400, { error: 'expired_token' });
        if (slowDownRemaining > 0) {
          slowDownRemaining -= 1;
          return send(400, { error: 'slow_down', interval: 2 });
        }
        if (device.state === 'pending') return send(400, { error: 'authorization_pending' });
        if (device.state === 'denied') return send(400, { error: 'access_denied' });
        if (device.state === 'expired') return send(400, { error: 'expired_token' });

        const token = `tst_${device.deviceCode}_secret`;
        tokens.set(token, { subject: 'user_1', orgId: 'org_1' });
        return send(200, {
          token,
          tokenPrefix: 'tst',
          orgId: 'org_1',
          subject: 'user_1',
          webOrigin: baseUrl(),
        });
      }

      if (url.pathname === '/cli/whoami' && req.method === 'GET') {
        const identity = tokens.get(bearer);
        if (!identity) return send(401, { error: 'unauthorized', message: 'Token rejected.' });
        return send(200, { ...identity, tokenPrefix: 'tst' });
      }

      if (url.pathname === '/cli/logout' && req.method === 'POST') {
        if (!tokens.has(bearer)) return send(401, { error: 'unauthorized' });
        tokens.delete(bearer);
        revoked.push(bearer);
        return send(200, { revoked: true });
      }

      return send(404, { error: 'not_found', message: `No route ${url.pathname}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = (): string => `http://127.0.0.1:${port}`;

  const setState = (userCode: string, state: DeviceState): void => {
    const d = byUserCode.get(userCode);
    if (d) d.state = state;
  };

  return {
    url: baseUrl(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    approve: (userCode) => setState(userCode, 'approved'),
    deny: (userCode) => setState(userCode, 'denied'),
    expire: (userCode) => setState(userCode, 'expired'),
    slowDownFor: (polls) => {
      slowDownRemaining = polls;
    },
    requests,
    revoked,
  };
}
