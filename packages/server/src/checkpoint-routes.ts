import { stableStringify } from './stable-json.js';
import {
  CheckpointVerifier,
  hashSummary,
  parseCheckpointHeader,
  type CheckpointFailure,
} from './checkpoints.js';

export interface CheckpointRoutesOptions {
  verifier: CheckpointVerifier;
  /**
   * Identifies the caller from the request, so a fingerprint issued to one
   * subject cannot be verified by another. Returning null still allows
   * issuance; supply it in production.
   */
  identify?: (request: Request) => string | null | Promise<string | null>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const STALE_MESSAGE: Record<CheckpointFailure, string> = {
  not_found: 'No approval matches that fingerprint.',
  gate_mismatch: 'That approval was issued for a different gate.',
  subject_mismatch: 'That approval was issued for a different target.',
  mismatch: 'The plan changed since this approval was issued.',
  expired: 'This approval has expired.',
  consumed: 'This approval was already used.',
};

/** Maps a verification failure onto the 409 the client turns into exit 12. */
export function staleResponse(
  reason: CheckpointFailure,
  retryCommand?: string,
  detail?: string,
): Response {
  return json(
    {
      error: 'checkpoint_stale',
      code: 'checkpoint_stale',
      // The detail names a wiring mistake precisely; without it a subject
      // mismatch is indistinguishable from a forged fingerprint.
      message: detail ? `${STALE_MESSAGE[reason]} (${detail})` : STALE_MESSAGE[reason],
      reason,
      remediation: retryCommand ?? 'Re-run the command without --approve to get a fresh plan.',
    },
    409,
  );
}

/**
 * `POST /checkpoints` (issue) and `POST /checkpoints/verify` (non-consuming
 * check). Returns null for paths it does not own.
 *
 * Verification here is deliberately NOT consuming: the approval is burned by
 * `verifyCheckpoint` on the action request itself, so the approval is spent by
 * the operation it authorised rather than by a preflight call.
 */
export function checkpointRoutes(options: CheckpointRoutesOptions) {
  const { verifier, identify } = options;

  return async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    if (path.endsWith('/checkpoints') && method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const gate = String(body['gate'] ?? '');
      if (!gate) return json({ error: 'usage', message: '`gate` is required.' }, 400);

      const subject = String(body['subject'] ?? '');
      const issuedTo = (await identify?.(request)) ?? undefined;

      const record = await verifier.issue({
        gate,
        subject,
        summaryHash: hashSummary(stableStringify(body['summary'] ?? null)),
        ...(issuedTo !== undefined ? { issuedTo } : {}),
      });

      return json({
        fingerprint: record.fingerprint,
        gate: record.gate,
        expiresAt: new Date(record.expiresAt).toISOString(),
      });
    }

    if (path.endsWith('/checkpoints/verify') && method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const gate = String(body['gate'] ?? '');
      const subject = String(body['subject'] ?? '');
      const fingerprint = String(body['fingerprint'] ?? '');
      const expected = body['summaryHash'];

      const result = await verifier.verify({
        gate,
        subject,
        fingerprint,
        ...(typeof expected === 'string' ? { expectedSummaryHash: expected } : {}),
      });

      if (!result.ok) return staleResponse(result.reason ?? 'not_found', undefined, result.detail);
      return json({ valid: true, gate, expiresAt: new Date(result.record!.expiresAt).toISOString() });
    }

    return null;
  };
}

export interface VerifyCheckpointOptions {
  verifier: CheckpointVerifier;
  /**
   * Which requests require an approval. Defaults to every non-GET request,
   * which is safe-by-default but usually too broad — narrow it to the routes
   * that actually spend.
   */
  requiresApproval?: (request: Request) => boolean;
  /** Recomputes the subject for the incoming request, to bind gate to target. */
  subjectFor?: (request: Request) => string | Promise<string>;
}

/**
 * Middleware that performs steps 1-4 of spec 5.8 on the action request, burning
 * the approval as the action is authorised.
 *
 * Returns a 409 Response to reject, or null to let the request proceed.
 */
export function verifyCheckpoint(options: VerifyCheckpointOptions) {
  const {
    verifier,
    requiresApproval = (req: Request) => req.method.toUpperCase() !== 'GET',
    subjectFor,
  } = options;

  return async function check(request: Request): Promise<Response | null> {
    if (!requiresApproval(request)) return null;

    const header = parseCheckpointHeader(request.headers.get('x-invokable-checkpoint'));
    if (!header) {
      return json(
        {
          error: 'checkpoint_required',
          code: 'checkpoint_stale',
          message: 'This action requires an approval fingerprint.',
          remediation: 'Re-run the command without --approve to get a fresh plan.',
        },
        409,
      );
    }

    const subject = subjectFor ? await subjectFor(request) : '';
    const result = await verifier.consume({
      gate: header.gate,
      subject,
      fingerprint: header.fingerprint,
    });

    if (!result.ok) return staleResponse(result.reason ?? 'not_found', undefined, result.detail);
    return null;
  };
}
