export interface IdentityRecord {
  id: string;
  credentialHash: string;
  dataSpaceId: string;
  dataSpaceVersion: number;
  publicDeviceId: string;
  deviceLabel: string;
  recoveryNamespace: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export type AppBindings = {
  Bindings: Env;
  Variables: { identity: IdentityRecord | null };
};
