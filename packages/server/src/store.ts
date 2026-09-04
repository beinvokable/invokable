export type DeviceState = 'pending' | 'approved' | 'denied' | 'consumed';

export interface DeviceRecord {
  deviceCode: string;
  userCode: string;
  state: DeviceState;
  /** What the CLI reported about itself at /device/start. */
  clientName: string;
  hostname: string;
  toolVersion: string;
  createdAt: number;
  expiresAt: number;
  /** Set when a signed-in user approves. */
  subject?: string;
  orgId?: string;
  /** Enforces the polling interval. */
  lastPolledAt?: number;
}

export interface TokenRecord {
  tokenHash: string;
  tokenPrefix: string;
  subject: string;
  orgId?: string;
  clientName: string;
  hostname: string;
  createdAt: number;
  /** Null means long-lived: revocation only (spec 5.5 `tokenTtl: null`). */
  expiresAt: number | null;
  revokedAt?: number;
}

/**
 * Persistence boundary. `memoryStore()` is for development and tests; a Postgres
 * implementation is P1 in the spec. Everything is async so a real database drops
 * in without changing the handlers.
 */
export interface AuthStore {
  createDevice(record: DeviceRecord): Promise<void>;
  findDeviceByDeviceCode(deviceCode: string): Promise<DeviceRecord | null>;
  findDeviceByUserCode(userCode: string): Promise<DeviceRecord | null>;
  updateDevice(deviceCode: string, patch: Partial<DeviceRecord>): Promise<void>;

  createToken(record: TokenRecord): Promise<void>;
  findTokenByHash(tokenHash: string): Promise<TokenRecord | null>;
  revokeToken(tokenHash: string, at: number): Promise<void>;
}

export function memoryStore(): AuthStore & { _devices: Map<string, DeviceRecord>; _tokens: Map<string, TokenRecord> } {
  const devices = new Map<string, DeviceRecord>();
  const tokens = new Map<string, TokenRecord>();

  return {
    _devices: devices,
    _tokens: tokens,

    async createDevice(record) {
      devices.set(record.deviceCode, record);
    },
    async findDeviceByDeviceCode(deviceCode) {
      return devices.get(deviceCode) ?? null;
    },
    async findDeviceByUserCode(userCode) {
      for (const d of devices.values()) {
        if (d.userCode === userCode) return d;
      }
      return null;
    },
    async updateDevice(deviceCode, patch) {
      const existing = devices.get(deviceCode);
      if (existing) devices.set(deviceCode, { ...existing, ...patch });
    },

    async createToken(record) {
      tokens.set(record.tokenHash, record);
    },
    async findTokenByHash(tokenHash) {
      return tokens.get(tokenHash) ?? null;
    },
    async revokeToken(tokenHash, at) {
      const existing = tokens.get(tokenHash);
      if (existing) tokens.set(tokenHash, { ...existing, revokedAt: at });
    },
  };
}
