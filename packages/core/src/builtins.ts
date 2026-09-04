import { EXIT } from './exit-codes.js';
import { InvokableError } from './errors.js';
import { tokenEnvVar } from './config.js';
import { deviceLogin, revokeToken, whoami, type DeviceStartResponse } from './device-flow.js';
import { detectAgent } from './agent.js';
import type { ApiClient } from './http.js';
import type { CommandSpec, ToolSpec } from './schema.js';

/**
 * Commands every invokable tool gets for free (spec 5.3). A tool may override
 * any of them by declaring a command of the same name.
 */

function authClient(tool: ToolSpec, client: ApiClient): ApiClient {
  const authUrl = tool.api?.authUrl ?? tool.api?.baseUrl;
  if (!authUrl) {
    throw new InvokableError({
      code: 'error',
      message:
        `${tool.name} declared no \`api.authUrl\` or \`api.baseUrl\`, so it cannot authenticate. ` +
        'Add one to defineTool().',
      retryable: false,
    });
  }
  return client.withBaseUrl(authUrl);
}

function renderLoginPrompt(start: DeviceStartResponse, toolName: string): string {
  const url = start.verificationUriComplete ?? start.verificationUri;
  return [
    '',
    `  To finish signing in to ${toolName}, open:`,
    '',
    `    ${url}`,
    '',
    `  and confirm this code:  ${start.userCode}`,
    '',
    '  Waiting for approval…',
    '',
  ].join('\n');
}

export const loginCommand: CommandSpec = {
  description: 'Sign in and store a token for this machine.',
  run: async ({ client, ctx }) => {
    const auth = authClient(ctx.tool, client);

    const result = await deviceLogin({
      client: auth,
      toolName: ctx.tool.name,
      toolVersion: ctx.tool.version,
      hooks: {
        onPrompt: (start) => ctx.io.note(renderLoginPrompt(start, ctx.tool.name)),
      },
    });

    ctx.config.write({
      token: result.token,
      ...(result.tokenPrefix !== undefined ? { tokenPrefix: result.tokenPrefix } : {}),
      ...(result.orgId !== undefined ? { orgId: result.orgId } : {}),
      ...(result.subject !== undefined ? { subject: result.subject } : {}),
      ...(result.webOrigin !== undefined ? { webOrigin: result.webOrigin } : {}),
    });

    ctx.io.note(`Signed in. Token stored in ${ctx.config.path} (mode 0600).`);

    return {
      signedIn: true,
      subject: result.subject ?? null,
      orgId: result.orgId ?? null,
      configPath: ctx.config.path,
    };
  },
};

export const logoutCommand: CommandSpec = {
  description: 'Revoke the stored token and delete it from this machine.',
  run: async ({ client, ctx }) => {
    let revoked = false;
    let revokeError: string | null = null;

    if (ctx.config.read().token) {
      try {
        await revokeToken(authClient(ctx.tool, client));
        revoked = true;
      } catch (e) {
        // The local token must be removed even when the server is unreachable,
        // otherwise `logout` leaves a credential behind on a flaky network.
        revokeError = e instanceof Error ? e.message : String(e);
      }
    }

    ctx.config.write({ token: undefined, tokenPrefix: undefined, subject: undefined, orgId: undefined });

    if (revokeError) {
      ctx.io.warn(`Local token deleted, but the server could not be reached: ${revokeError}`);
    }
    return { revoked, localTokenCleared: true, revokeError };
  },
};

export const whoamiCommand: CommandSpec = {
  description: 'Show the identity behind the stored token.',
  run: async ({ client, ctx }) => {
    if (ctx.tokenSource === 'none') {
      throw new InvokableError({
        code: 'auth',
        message: 'Not signed in.',
        remediation: `${ctx.tool.name} login`,
        retryable: false,
      });
    }
    return whoami(authClient(ctx.tool, client));
  },
};

export const doctorCommand: CommandSpec = {
  description: 'Diagnose configuration, connectivity and auth.',
  run: async ({ client, ctx }) => {
    const cfg = ctx.config.read();

    const api: Record<string, unknown> = {
      baseUrl: ctx.tool.api?.baseUrl ?? null,
      authUrl: ctx.tool.api?.authUrl ?? ctx.tool.api?.baseUrl ?? null,
      reachable: false,
      latencyMs: null,
      error: null,
    };
    const auth: Record<string, unknown> = {
      ok: false,
      source: ctx.tokenSource,
      tokenPrefix: cfg.tokenPrefix ?? null,
      subject: null,
      error: null,
    };

    if (ctx.tool.api?.baseUrl || ctx.tool.api?.authUrl) {
      // Probed even without a token: a 401 still proves the server is up, which
      // is the more useful signal when diagnosing "nothing works".
      const started = Date.now();
      try {
        const who = await whoami(authClient(ctx.tool, client));
        api.reachable = true;
        api.latencyMs = Date.now() - started;
        auth.ok = true;
        auth.subject = who.subject ?? null;
      } catch (e) {
        api.latencyMs = Date.now() - started;
        if (e instanceof InvokableError) {
          // Reaching the server and being told "unauthenticated" still proves
          // connectivity — only network/timeout failures mean unreachable.
          const networkish = e.code === 'network' || e.code === 'timeout';
          api.reachable = !networkish;
          if (networkish) {
            api.error = e.message;
          } else {
            // Reporting the server's "token rejected" when no token was sent
            // sends the reader chasing the wrong problem.
            auth.error = ctx.tokenSource === 'none' ? 'No token stored.' : e.message;
          }
        } else {
          api.error = e instanceof Error ? e.message : String(e);
        }
      }
    } else {
      api.error = 'No api.baseUrl configured.';
    }

    const report = {
      tool: { name: ctx.tool.name, version: ctx.tool.version },
      api,
      auth,
      config: {
        path: ctx.config.path,
        exists: ctx.config.exists(),
        source: ctx.tokenSource,
        worldReadable: ctx.config.isWorldReadable(),
        envVar: tokenEnvVar(ctx.tool.name),
      },
      // The skills generator does not exist yet; report that honestly rather
      // than claiming a clean result for a check that never ran.
      skills: { checked: false, installed: null },
      agent: detectAgent(),
    };

    if (report.config.worldReadable) {
      ctx.io.warn(
        `warning: ${ctx.config.path} is readable by other users. Run: chmod 600 ${ctx.config.path}`,
      );
    }

    if (!(api.reachable && auth.ok && !report.config.worldReadable)) {
      ctx.io.note('Some checks failed; see the report.');
    }
    return report;
  },
};

export const BUILTIN_COMMANDS: Readonly<Record<string, CommandSpec>> = Object.freeze({
  login: loginCommand,
  logout: logoutCommand,
  whoami: whoamiCommand,
  doctor: doctorCommand,
});

/** Built-ins merged with the tool's own commands; the tool's definition wins. */
export function resolveCommands(tool: ToolSpec): Record<string, CommandSpec> {
  return { ...BUILTIN_COMMANDS, ...tool.commands };
}

export { EXIT as _EXIT };
