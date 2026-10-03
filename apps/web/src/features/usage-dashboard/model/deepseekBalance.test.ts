import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import {
  DEEPSEEK_REFERENCE_LIMIT_USD,
  deepSeekReferencePercent,
  fetchDeepSeekBalance,
  formatDeepSeekBalanceUsd,
  parseDeepSeekBalancePayload,
} from './deepseekBalance';

const t = ((key: string) => key) as TFunction;

describe('parseDeepSeekBalancePayload', () => {
  it('accepts a valid numeric balance', () => {
    expect(parseDeepSeekBalancePayload({ currency: 'USD', totalBalance: 12.34 })).toEqual({
      currency: 'USD',
      totalBalance: 12.34,
    });
  });

  it('accepts a numeric-string balance and normalizes the currency', () => {
    expect(parseDeepSeekBalancePayload({ currency: 'usd', totalBalance: '0.00' })).toEqual({
      currency: 'USD',
      totalBalance: 0,
    });
  });

  it('accepts zero balance truthfully', () => {
    expect(parseDeepSeekBalancePayload({ currency: 'USD', totalBalance: 0 })).toEqual({
      currency: 'USD',
      totalBalance: 0,
    });
  });

  it('rejects negative, non-finite, and missing balances', () => {
    expect(parseDeepSeekBalancePayload({ currency: 'USD', totalBalance: -1 })).toBeNull();
    expect(parseDeepSeekBalancePayload({ currency: 'USD', totalBalance: 'abc' })).toBeNull();
    expect(parseDeepSeekBalancePayload({ currency: 'USD', totalBalance: Number.NaN })).toBeNull();
    expect(
      parseDeepSeekBalancePayload({ currency: 'USD', totalBalance: Number.POSITIVE_INFINITY })
    ).toBeNull();
    expect(parseDeepSeekBalancePayload({ currency: 'USD' })).toBeNull();
    expect(parseDeepSeekBalancePayload({ totalBalance: 5 })).toBeNull();
    expect(parseDeepSeekBalancePayload(null)).toBeNull();
    expect(parseDeepSeekBalancePayload('12.34')).toBeNull();
  });
});

describe('deepSeekReferencePercent', () => {
  it('maps the balance onto the fixed reference limit', () => {
    expect(DEEPSEEK_REFERENCE_LIMIT_USD).toBe(20);
    expect(deepSeekReferencePercent(10)).toBe(50);
    expect(deepSeekReferencePercent(0)).toBe(0);
    expect(deepSeekReferencePercent(-5)).toBe(0);
  });

  it('bounds the visual progress to 0..100', () => {
    expect(deepSeekReferencePercent(26)).toBe(100);
    expect(deepSeekReferencePercent(1000)).toBe(100);
    expect(deepSeekReferencePercent(Number.NaN)).toBe(0);
  });
});

describe('formatDeepSeekBalanceUsd', () => {
  it('formats the balance as USD', () => {
    expect(formatDeepSeekBalanceUsd(12.34)).toBe('$12.34');
    expect(formatDeepSeekBalanceUsd(0)).toBe('$0.00');
  });
});

describe('fetchDeepSeekBalance', () => {
  it('returns the parsed balance from the manager server probe', async () => {
    const { apiClient } = await import('@/services/api/client');
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      currency: 'USD',
      totalBalance: 12.5,
    });
    await expect(fetchDeepSeekBalance(t)).resolves.toEqual({
      currency: 'USD',
      totalBalance: 12.5,
    });
    getSpy.mockRestore();
  });

  it('throws a factual error for a malformed payload', async () => {
    const { apiClient } = await import('@/services/api/client');
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ windows: [] } as never);
    await expect(fetchDeepSeekBalance(t)).rejects.toThrow('usage_dashboard.balance_unavailable');
    getSpy.mockRestore();
  });

  it('translates a not-configured server (501) into a factual label', async () => {
    const { apiClient } = await import('@/services/api/client');
    const error = new Error('DeepSeek balance is not configured') as Error & { status?: number };
    error.name = 'ApiError';
    error.status = 501;
    const getSpy = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(error);
    await expect(fetchDeepSeekBalance(t)).rejects.toThrow('usage_dashboard.balance_not_configured');
    getSpy.mockRestore();
  });

  it('keeps upstream and network errors as-is', async () => {
    const { apiClient } = await import('@/services/api/client');
    const error = new Error('DeepSeek balance returned HTTP 401') as Error & { status?: number };
    error.name = 'ApiError';
    error.status = 502;
    const getSpy = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(error);
    await expect(fetchDeepSeekBalance(t)).rejects.toThrow('DeepSeek balance returned HTTP 401');
    getSpy.mockRestore();
  });
});
