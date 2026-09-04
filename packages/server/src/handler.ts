import {
  generateDeviceCode,
  generateToken,
  generateUserCode,
  hashToken,
} from './tokens.js';
import type { AuthStore, DeviceRecord, TokenRecord } from './store.js';

export interface SessionUser {
  subject: string;
  orgId?: string;
  displayName?: string;
}

export interface ApprovePageContext {
  userCode: string;
  /** Null when no device is pending for that code. */
  device: DeviceRecord | null;
  user: SessionUser | null;
}

export interface InvokableAuthOptions {
  store: AuthStore;
  /**
   * Resolves the browser session on the approval page. Return null for a signed
   * -out visitor; the handler will not approve anything without a user.
   */
  requireSession: (request: Request) => SessionUser | null | Promise<SessionUser | null>;
  /** Renders the branded approval page. A plain default is used when omitted. */
  approvePage?: (ctx: ApprovePageContext) => string | Promise<string>;
  /** Token prefix, e.g. `mtl`. Appears in the credential and in `doctor`. */
  tokenPrefix?: string;
  /** Milliseconds; `null` means long-lived with revocation only. */
  tokenTtl?: number | null;
  /** How long a device code stays valid. Default 15 minutes. */
  deviceCodeTtlMs?: number;
  /** Minimum seconds between polls before answering `slow_down`. Default 5. */
  pollIntervalSeconds?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

const DEFAULT_DEVICE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_S = 5;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const value = header.slice(7).trim();
  return value || null;
}

function defaultApprovePage(ctx: ApprovePageContext): string {
  const { device, user, userCode } = ctx;

  if (!user) {
    return `<!doctype html><meta charset="utf-8"><title>Sign in required</title>
<h1>Sign in required</h1>
<p>Sign in, then return to this page to approve the code <code>${escapeHtml(userCode)}</code>.</p>`;
  }
  if (!device) {
    return `<!doctype html><meta charset="utf-8"><title>Unknown code</title>
<h1>That code is not recognised</h1>
<p>It may have expired. Run the login command again to get a new one.</p>`;
  }

  // The device's self-reported details are shown so the user can tell a
  // legitimate request from a code someone else asked them to approve.
  return `<!doctype html><meta charset="utf-8"><title>Approve device</title>
<h1>Approve this device?</h1>
<dl>
  <dt>Tool</dt><dd>${escapeHtml(device.clientName)} ${escapeHtml(device.toolVersion)}</dd>
  <dt>Machine</dt><dd>${escapeHtml(device.hostname)}</dd>
  <dt>Code</dt><dd><code>${escapeHtml(device.userCode)}</code></dd>
  <dt>Signed in as</dt><dd>${escapeHtml(user.displayName ?? user.subject)}</dd>
</dl>
<p><strong>Only approve this if you just started a login on that machine.</strong></p>
<form method="post" action="./device/approve">
  <input type="hidden" name="userCode" value="${escapeHtml(device.userCode)}">
  <button type="submit" name="decision" value="approve">Approve</button>
  <button type="submit" name="decision" value="deny">Deny</button>
</form>`;
}

/**
 * The five device-flow endpoints of spec 5.4, as a fetch-style handler:
 *
 *   POST /device/start    → device + user code
 *   GET  /device?code=…   → approval page
 *   POST /device/approve  → records the user's decision (session required)
 *   POST /device/token    → polled by the CLI until approved
 *   POST /cli/logout      → revokes the bearer token
 *   GET  /cli/whoami      → identity behind the bearer token
 *
 * Returns null for paths it does not own, so a host application can mount it
 * alongside its own routes.
 */
export function invokableAuth(options: InvokableAuthOptions) {
  const {
    store,
    requireSession,
    approvePage = defaultApprovePage,
    tokenPrefix = 'ivk',
    tokenTtl = null,
    deviceCodeTtlMs = DEFAULT_DEVICE_TTL_MS,
    pollIntervalSeconds = DEFAULT_POLL_INTERVAL_S,
    now = () => Date.now(),
  } = options;

  async function authenticate(request: Request): Promise<TokenRecord | null> {
    const token = bearerToken(request);
    if (!token) return null;
    const record = await store.findTokenByHash(hashToken(token));
    if (!record) return null;
    if (record.revokedAt) return null;
    if (record.expiresAt !== null && record.expiresAt <= now()) return null;
    return record;
  }

  return async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    // ---- POST /device/start -------------------------------------------------
    if (path.endsWith('/device/start') && method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const at = now();

      const record: DeviceRecord = {
        deviceCode: generateDeviceCode(),
        userCode: generateUserCode(),
        state: 'pending',
        clientName: String(body['clientName'] ?? 'unknown'),
        hostname: String(body['hostname'] ?? 'unknown'),
        toolVersion: String(body['toolVersion'] ?? 'unknown'),
        createdAt: at,
        expiresAt: at + deviceCodeTtlMs,
      };
      await store.createDevice(record);

      const verificationUri = `${url.origin}${url.pathname.replace(/\/start$/, '')}`;
      return json({
        deviceCode: record.deviceCode,
        userCode: record.userCode,
        verificationUri,
        verificationUriComplete: `${verificationUri}?code=${record.userCode}`,
        interval: pollIntervalSeconds,
        expiresIn: Math.floor(deviceCodeTtlMs / 1000),
      });
    }

    // ---- POST /device/token -------------------------------------------------
    if (path.endsWith('/device/token') && method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const deviceCode = String(body['deviceCode'] ?? '');
      const device = await store.findDeviceByDeviceCode(deviceCode);
      const at = now();

      if (!device) return json({ error: 'expired_token' }, 400);
      if (device.expiresAt <= at) return json({ error: 'expired_token' }, 400);

      // Polling faster than the advertised interval earns a back-off rather
      // than a token; this is the only rate limit the flow needs.
      if (device.lastPolledAt && at - device.lastPolledAt < pollIntervalSeconds * 1000) {
        await store.updateDevice(deviceCode, { lastPolledAt: at });
        return json({ error: 'slow_down', interval: pollIntervalSeconds * 2 }, 400);
      }
      await store.updateDevice(deviceCode, { lastPolledAt: at });

      if (device.state === 'denied') return json({ error: 'access_denied' }, 400);
      if (device.state === 'consumed') return json({ error: 'expired_token' }, 400);
      if (device.state === 'pending') return json({ error: 'authorization_pending' }, 400);

      // Approved: issue once, then burn the device code so a leaked code cannot
      // be replayed into a second credential.
      const { token, tokenHash } = generateToken(tokenPrefix);
      const record: TokenRecord = {
        tokenHash,
        tokenPrefix,
        subject: device.subject ?? 'unknown',
        ...(device.orgId !== undefined ? { orgId: device.orgId } : {}),
        clientName: device.clientName,
        hostname: device.hostname,
        createdAt: at,
        expiresAt: tokenTtl === null ? null : at + tokenTtl,
      };
      await store.createToken(record);
      await store.updateDevice(deviceCode, { state: 'consumed' });

      return json({
        token,
        tokenPrefix,
        orgId: record.orgId ?? null,
        subject: record.subject,
        webOrigin: url.origin,
      });
    }

    // ---- POST /device/approve ----------------------------------------------
    if (path.endsWith('/device/approve') && method === 'POST') {
      const user = await requireSession(request);
      if (!user) return json({ error: 'unauthorized', message: 'Sign in first.' }, 401);

      const contentType = request.headers.get('content-type') ?? '';
      let userCode = '';
      let decision = 'approve';
      if (contentType.includes('application/json')) {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        userCode = String(body['userCode'] ?? '');
        decision = String(body['decision'] ?? 'approve');
      } else {
        const form = await request.formData().catch(() => null);
        userCode = String(form?.get('userCode') ?? '');
        decision = String(form?.get('decision') ?? 'approve');
      }

      const device = await store.findDeviceByUserCode(userCode.trim().toUpperCase());
      if (!device) return json({ error: 'not_found', message: 'Unknown code.' }, 404);
      if (device.expiresAt <= now()) return json({ error: 'expired', message: 'Code expired.' }, 410);
      if (device.state !== 'pending') {
        return json({ error: 'conflict', message: 'That code was already used.' }, 409);
      }

      await store.updateDevice(device.deviceCode, {
        state: decision === 'deny' ? 'denied' : 'approved',
        subject: user.subject,
        ...(user.orgId !== undefined ? { orgId: user.orgId } : {}),
      });

      return json({ ok: true, decision: decision === 'deny' ? 'denied' : 'approved' });
    }

    // ---- GET /device --------------------------------------------------------
    if (path.endsWith('/device') && method === 'GET') {
      const userCode = (url.searchParams.get('code') ?? '').trim().toUpperCase();
      const user = await requireSession(request);
      const device = userCode ? await store.findDeviceByUserCode(userCode) : null;
      return html(await approvePage({ userCode, device, user }));
    }

    // ---- GET /cli/whoami ----------------------------------------------------
    if (path.endsWith('/cli/whoami') && method === 'GET') {
      const record = await authenticate(request);
      if (!record) {
        return json({ error: 'unauthorized', message: 'Token rejected.' }, 401);
      }
      return json({
        subject: record.subject,
        orgId: record.orgId ?? null,
        tokenPrefix: record.tokenPrefix,
        clientName: record.clientName,
        hostname: record.hostname,
        createdAt: new Date(record.createdAt).toISOString(),
      });
    }

    // ---- POST /cli/logout ---------------------------------------------------
    if (path.endsWith('/cli/logout') && method === 'POST') {
      const record = await authenticate(request);
      if (!record) return json({ error: 'unauthorized', message: 'Token rejected.' }, 401);
      await store.revokeToken(record.tokenHash, now());
      return json({ revoked: true });
    }

    return null;
  };
}

export type InvokableAuthHandler = ReturnType<typeof invokableAuth>;
