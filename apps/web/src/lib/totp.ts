// Formatting helpers for two-factor codes and secrets. Verification happens on
// the Worker; nothing here ever leaves the browser.

/** Strip spaces and lowercase so "123 456" and "ABCDE-FGHIJ" are accepted. */
export function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, "").toLowerCase();
}

/** "JBSWY3DPEHPK3PXP" -> "JBSW Y3DP EHPK 3PXP" for manual entry. */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

/** A 6-digit TOTP code or a recovery code (xxxxx-xxxxx). */
export function looksLikeCode(raw: string): boolean {
  const c = normalizeCode(raw);
  return /^\d{6}$/.test(c) || /^[a-z0-9]{5}-?[a-z0-9]{5}$/.test(c);
}
