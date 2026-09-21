/** Closed pre-release setup credential grammar, distinct from ordinary project service keys. */
const SETUP_KEY = /^hue_setup_(live|test)_setup-([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/u;

/** Validates both the bearer namespace and its exact stored key identity. */
export function validSetupCredentialIdentity(apiKey: unknown, keyId: unknown): apiKey is string {
  if (typeof apiKey !== "string" || typeof keyId !== "string") return false;
  const match = SETUP_KEY.exec(apiKey);
  return match !== null && keyId === `setup-${match[2]}`;
}
