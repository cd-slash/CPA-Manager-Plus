import { describe, expect, it } from 'vitest';
import {
  findMuseSubscriptionTokens,
  isMuseSubscriptionToken,
  museSubscriptionFingerprint,
  planMuseSubscriptionSync,
} from './museSubscription';

const CURRENT = 'LLM|current-token-value-1234567890';
const STALE = 'LLM|stale-token-value-0987654321';
const PLAIN_KEY = 'sk-plain-gateway-key';

describe('isMuseSubscriptionToken', () => {
  it('accepts the Muse subscription bearer shape', () => {
    expect(isMuseSubscriptionToken(CURRENT)).toBe(true);
    expect(isMuseSubscriptionToken(`  ${CURRENT}  `)).toBe(true);
  });

  it('rejects plain gateway keys and malformed values', () => {
    expect(isMuseSubscriptionToken(PLAIN_KEY)).toBe(false);
    expect(isMuseSubscriptionToken('LLM|')).toBe(false);
    expect(isMuseSubscriptionToken('LLM|short')).toBe(false);
    expect(isMuseSubscriptionToken('LLM|has space inside')).toBe(false);
    expect(isMuseSubscriptionToken('')).toBe(false);
  });
});

describe('findMuseSubscriptionTokens', () => {
  it('returns only subscription tokens, trimmed and de-duplicated', () => {
    expect(findMuseSubscriptionTokens([PLAIN_KEY, ` ${CURRENT} `, CURRENT, STALE])).toEqual([
      CURRENT,
      STALE,
    ]);
    expect(findMuseSubscriptionTokens([PLAIN_KEY])).toEqual([]);
    expect(findMuseSubscriptionTokens([])).toEqual([]);
  });
});

describe('planMuseSubscriptionSync', () => {
  it('creates when no subscription token is allowlisted yet', () => {
    expect(planMuseSubscriptionSync([PLAIN_KEY], CURRENT)).toEqual({
      ok: true,
      action: 'create',
      token: CURRENT,
    });
  });

  it('reports already-synced when the pasted token is allowlisted', () => {
    expect(planMuseSubscriptionSync([PLAIN_KEY, CURRENT], ` ${CURRENT} `)).toEqual({
      ok: true,
      action: 'already-synced',
      token: CURRENT,
    });
  });

  it('replaces the stale token when rotation produced a new one', () => {
    expect(planMuseSubscriptionSync([PLAIN_KEY, STALE], CURRENT)).toEqual({
      ok: true,
      action: 'replace',
      token: CURRENT,
      oldToken: STALE,
    });
  });

  it('rejects values that are not subscription tokens', () => {
    expect(planMuseSubscriptionSync([PLAIN_KEY], PLAIN_KEY)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(planMuseSubscriptionSync([PLAIN_KEY], '   ')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('museSubscriptionFingerprint', () => {
  it('is a stable 12-char prefix that never contains the token', () => {
    const fingerprint = museSubscriptionFingerprint(CURRENT);
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint).toBe(museSubscriptionFingerprint(` ${CURRENT} `));
    expect(CURRENT).not.toContain(fingerprint);
    expect(museSubscriptionFingerprint('')).toBe('');
  });
});
