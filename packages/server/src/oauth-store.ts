/**
 * Persistence for the OAuth 2.1 authorization server (`invokableOAuth`).
 *
 * Deliberately a separate interface from `AuthStore`: the *tokens* an OAuth
 * grant ends in are ordinary `TokenRecord`s written to the same `AuthStore` the
 * device flow uses, so `/cli/whoami`, revocation and every resource server that
 * verifies bearer tokens keep working unchanged. What lives here is only the
 * machinery that gets a remote client to that token: registered clients, the
 * pending authorization requests, and refresh tokens.
 */

export type OAuthClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface OAuthClientRecord {
  clientId: string;
  /** SHA-256 of the secret. Absent for public clients (`none`). */
  clientSecretHash?: string;
  clientName: string;
  /** Exact-match set. A redirect that is not in it is never followed. */
  redirectUris: string[];
  tokenEndpointAuthMethod: OAuthClientAuthMethod;
  createdAt: number;
  clientUri?: string;
  logoUri?: string;
}

export type OAuthGrantStatus = 'pending' | 'approved' | 'denied' | 'consumed';

/**
 * One authorization request, from the moment the client sends the user to
 * `/oauth/authorize` until the code it produced has been exchanged.
 */
export interface OAuthGrantRecord {
  /** Random, unguessable. Carried by the consent form, never by the client. */
  id: string;
  clientId: string;
  redirectUri: string;
  /** Space-separated; may be empty. */
  scope: string;
  /** The client's `state`, echoed back untouched. */
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  /** RFC 8707 resource indicator, when the client sent one. */
  resource?: string;
  status: OAuthGrantStatus;
  /** Set when a signed-in user approves. */
  subject?: string;
  orgId?: string;
  /** SHA-256 of the authorization code. Set on approval; the code is single-use. */
  codeHash?: string;
  createdAt: number;
  expiresAt: number;
}

export interface OAuthRefreshRecord {
  refreshHash: string;
  /** The access token this refresh token can replace. Revoked on rotation. */
  tokenHash: string;
  clientId: string;
  subject: string;
  orgId?: string;
  scope: string;
  createdAt: number;
  /** Null means long-lived: revocation only. */
  expiresAt: number | null;
  revokedAt?: number;
}

export interface OAuthStore {
  createClient(record: OAuthClientRecord): Promise<void>;
  findClient(clientId: string): Promise<OAuthClientRecord | null>;

  createGrant(record: OAuthGrantRecord): Promise<void>;
  findGrant(id: string): Promise<OAuthGrantRecord | null>;
  findGrantByCodeHash(codeHash: string): Promise<OAuthGrantRecord | null>;
  updateGrant(id: string, patch: Partial<OAuthGrantRecord>): Promise<void>;

  createRefresh(record: OAuthRefreshRecord): Promise<void>;
  findRefreshByHash(refreshHash: string): Promise<OAuthRefreshRecord | null>;
  revokeRefresh(refreshHash: string, at: number): Promise<void>;
}

export function memoryOAuthStore(): OAuthStore & {
  _clients: Map<string, OAuthClientRecord>;
  _grants: Map<string, OAuthGrantRecord>;
  _refresh: Map<string, OAuthRefreshRecord>;
} {
  const clients = new Map<string, OAuthClientRecord>();
  const grants = new Map<string, OAuthGrantRecord>();
  const refresh = new Map<string, OAuthRefreshRecord>();

  return {
    _clients: clients,
    _grants: grants,
    _refresh: refresh,

    async createClient(record) {
      clients.set(record.clientId, { ...record, redirectUris: [...record.redirectUris] });
    },
    async findClient(clientId) {
      return clients.get(clientId) ?? null;
    },

    async createGrant(record) {
      grants.set(record.id, record);
    },
    async findGrant(id) {
      return grants.get(id) ?? null;
    },
    async findGrantByCodeHash(codeHash) {
      for (const g of grants.values()) {
        if (g.codeHash === codeHash) return g;
      }
      return null;
    },
    async updateGrant(id, patch) {
      const existing = grants.get(id);
      if (existing) grants.set(id, { ...existing, ...patch });
    },

    async createRefresh(record) {
      refresh.set(record.refreshHash, record);
    },
    async findRefreshByHash(refreshHash) {
      return refresh.get(refreshHash) ?? null;
    },
    async revokeRefresh(refreshHash, at) {
      const existing = refresh.get(refreshHash);
      // First revocation wins, as with access tokens.
      if (existing && existing.revokedAt === undefined) {
        refresh.set(refreshHash, { ...existing, revokedAt: at });
      }
    },
  };
}
