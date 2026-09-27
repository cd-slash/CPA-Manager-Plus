import { describe, expect, it } from 'vitest';
import { buildXaiRateLimitWindow, parseRateLimitHeaders } from './xaiRateLimit';

describe('parseRateLimitHeaders', () => {
  it('reads limit and remaining token headers', () => {
    expect(
      parseRateLimitHeaders({
        'x-ratelimit-limit-tokens': ['1000'],
        'x-ratelimit-remaining-tokens': ['250'],
      })
    ).toEqual({ limitTokens: 1000, remainingTokens: 250 });
  });

  it('tolerates missing headers', () => {
    expect(parseRateLimitHeaders(undefined)).toEqual({ limitTokens: null, remainingTokens: null });
    expect(parseRateLimitHeaders({})).toEqual({ limitTokens: null, remainingTokens: null });
  });

  it('rejects non-numeric values', () => {
    expect(
      parseRateLimitHeaders({
        'x-ratelimit-limit-tokens': ['abc'],
        'x-ratelimit-remaining-tokens': ['-5'],
      })
    ).toEqual({ limitTokens: null, remainingTokens: null });
  });
});

describe('buildXaiRateLimitWindow', () => {
  it('derives used percent from the headers', () => {
    const window = buildXaiRateLimitWindow('grok-4.7', {
      'x-ratelimit-limit-tokens': ['1000'],
      'x-ratelimit-remaining-tokens': ['250'],
    });
    expect(window).toEqual({
      id: 'xai-ratelimit-grok-4.7',
      label: 'grok-4.7 token rate limit',
      remainingPercent: 25,
      limitTokens: 1000,
      remainingTokens: 250,
    });
  });

  it('clamps used percent to 100', () => {
    const window = buildXaiRateLimitWindow('grok-4.7', {
      'x-ratelimit-limit-tokens': ['100'],
      'x-ratelimit-remaining-tokens': ['0'],
    });
    expect(window?.remainingPercent).toBe(0);
  });

  it('returns null without a positive limit', () => {
    expect(
      buildXaiRateLimitWindow('grok-4.7', {
        'x-ratelimit-limit-tokens': ['0'],
        'x-ratelimit-remaining-tokens': ['0'],
      })
    ).toBeNull();
    expect(
      buildXaiRateLimitWindow('grok-4.7', { 'x-ratelimit-remaining-tokens': ['10'] })
    ).toBeNull();
  });
});
