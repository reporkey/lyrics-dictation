export interface IdentityRecord {
  id: string;
  credentialHash: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export type AppBindings = {
  Bindings: Env;
  Variables: { identity: IdentityRecord | null };
};
