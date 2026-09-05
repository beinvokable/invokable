export { invokableAuth } from './handler.js';
export type {
  InvokableAuthOptions,
  InvokableAuthHandler,
  SessionUser,
  ApprovePageContext,
} from './handler.js';

export { memoryStore } from './store.js';
export type { AuthStore, DeviceRecord, TokenRecord, DeviceState } from './store.js';

export {
  generateToken,
  hashToken,
  generateUserCode,
  generateDeviceCode,
  safeEqual,
} from './tokens.js';

export { checkpointRoutes, verifyCheckpoint, staleResponse } from './checkpoint-routes.js';
export type { CheckpointRoutesOptions, VerifyCheckpointOptions } from './checkpoint-routes.js';

export {
  CheckpointVerifier,
  computeFingerprint,
  hashSummary,
  memoryCheckpointStore,
  parseCheckpointHeader,
} from './checkpoints.js';
export type {
  CheckpointRecord,
  CheckpointStore,
  CheckpointVerifierOptions,
  CheckpointFailure,
  VerifyResult,
} from './checkpoints.js';

export { stableStringify } from './stable-json.js';

export { invokableOAuth, isAcceptableRedirectUri } from './oauth.js';
export type {
  InvokableOAuthOptions,
  InvokableOAuthHandler,
  ConsentPageContext,
  AuthorizeOutcome,
  StaticOAuthClient,
} from './oauth.js';

export { memoryOAuthStore } from './oauth-store.js';
export type {
  OAuthStore,
  OAuthClientRecord,
  OAuthClientAuthMethod,
  OAuthGrantRecord,
  OAuthGrantStatus,
  OAuthRefreshRecord,
} from './oauth-store.js';

export { oauthProtectedResource } from './resource.js';
export type { ProtectedResourceOptions, ProtectedResource } from './resource.js';

export {
  postgresAuthStore,
  postgresCheckpointStore,
  postgresOAuthStore,
  purgeExpired,
  createSchema,
} from './postgres-store.js';
export type { PostgresStoreOptions, PurgeResult } from './postgres-store.js';

export { SCHEMA_SQL, SCHEMA_STATEMENTS } from './sql.js';
export type { SqlExecutor } from './sql.js';
