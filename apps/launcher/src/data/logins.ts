// Player logins as used in guest / blacklist / admin lists.
// TMNF/TMUF/TM2: letters, digits, _ . - (up to 64 chars). TM2020: account id (UUID) or the 22 char base64url login.
const CLASSIC = /^[A-Za-z0-9_.\-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64_22 = /^[A-Za-z0-9_-]{22}$/;

export function isValidLogin(s: string): boolean {
  return CLASSIC.test(s) || UUID.test(s) || B64_22.test(s);
}

/** Splits pasted text at commas, whitespace and semicolons. */
export function splitLogins(text: string): string[] {
  return text.split(/[\s,;]+/).filter(Boolean);
}
