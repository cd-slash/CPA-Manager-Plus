import { sha256Hex } from './apiKeyHash';
import { isValidApiKeyCharset } from './validation';

/**
 * Muse subscription bearer ("wire token"): the credential Muse sends to
 * api.meta.ai after exchanging its browser/device login. Allowlisting it as a
 * client API key lets Muse reach CPA providers with its own subscription
 * session instead of a separately issued gateway key.
 */
export const MUSE_SUBSCRIPTION_TOKEN_PREFIX = 'LLM|';
const MIN_TOKEN_BODY_LENGTH = 8;

export function isMuseSubscriptionToken(value: string): boolean {
  const trimmed = String(value || '').trim();
  if (!trimmed.startsWith(MUSE_SUBSCRIPTION_TOKEN_PREFIX)) return false;
  if (trimmed.length < MUSE_SUBSCRIPTION_TOKEN_PREFIX.length + MIN_TOKEN_BODY_LENGTH) {
    return false;
  }
  return isValidApiKeyCharset(trimmed);
}

export function findMuseSubscriptionTokens(keys: string[]): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const key of keys) {
    const trimmed = String(key || '').trim();
    if (!trimmed || seen.has(trimmed) || !isMuseSubscriptionToken(trimmed)) continue;
    seen.add(trimmed);
    tokens.push(trimmed);
  }
  return tokens;
}

export type MuseSubscriptionSyncPlan =
  | { ok: true; action: 'create'; token: string }
  | { ok: true; action: 'already-synced'; token: string }
  | { ok: true; action: 'replace'; token: string; oldToken: string }
  | { ok: false; reason: 'invalid' };

export function planMuseSubscriptionSync(
  currentKeys: string[],
  pastedValue: string
): MuseSubscriptionSyncPlan {
  const token = String(pastedValue || '').trim();
  if (!isMuseSubscriptionToken(token)) {
    return { ok: false, reason: 'invalid' };
  }
  const existing = findMuseSubscriptionTokens(currentKeys);
  if (existing.includes(token)) {
    return { ok: true, action: 'already-synced', token };
  }
  if (existing.length > 0) {
    return { ok: true, action: 'replace', token, oldToken: existing[0] };
  }
  return { ok: true, action: 'create', token };
}

export function museSubscriptionFingerprint(token: string): string {
  const hash = sha256Hex(token);
  return hash ? hash.slice(0, 12) : '';
}
