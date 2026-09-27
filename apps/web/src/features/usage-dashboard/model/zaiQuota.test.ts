import { describe, expect, it } from 'vitest';
import {
  buildZaiQuotaWindows,
  isZaiAuthFile,
  normalizeZaiProvider,
  parseZaiQuotaPayload,
} from './zaiQuota';

const NOW = Date.parse('2026-09-27T12:00:00Z');

describe('normalizeZaiProvider', () => {
  it('maps common spellings to zai', () => {
    expect(normalizeZaiProvider('zai')).toBe('zai');
    expect(normalizeZaiProvider('Z.AI')).toBe('zai');
    expect(normalizeZaiProvider('z_ai')).toBe('zai');
    expect(normalizeZaiProvider('Zhipu')).toBe('zai');
    expect(normalizeZaiProvider('GLM')).toBe('zai');
  });

  it('leaves other providers untouched', () => {
    expect(normalizeZaiProvider('claude')).toBe('claude');
    expect(normalizeZaiProvider('')).toBe('');
  });
});

describe('isZaiAuthFile', () => {
  it('detects provider fields', () => {
    expect(isZaiAuthFile({ name: 'a.json', provider: 'zai' })).toBe(true);
    expect(isZaiAuthFile({ name: 'a.json', type: 'z.ai' })).toBe(true);
  });

  it('detects the zai- filename prefix', () => {
    expect(isZaiAuthFile({ name: 'zai-coding-plan.json' })).toBe(true);
    expect(isZaiAuthFile({ name: 'claude-user@example.dev.json' })).toBe(false);
  });
});

describe('buildZaiQuotaWindows', () => {
  it('maps unit 3 to an N-hour window and unit 6 to weekly', () => {
    const windows = buildZaiQuotaWindows(
      {
        data: {
          level: 'GLM Coding Pro',
          limits: [
            { unit: 3, number: 5, percentage: 42.5, nextResetTime: '2026-09-27T17:00:00Z' },
            { unit: 6, number: 1, percentage: 10, nextResetTime: '2026-09-28T00:00:00Z' },
          ],
        },
      },
      NOW
    );
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      id: 'zai-3-5',
      label: '5-hour limit',
      remainingPercent: 57.5,
      resetAtMs: Date.parse('2026-09-27T17:00:00Z'),
      limitWindowSeconds: 5 * 3600,
    });
    expect(windows[1]).toMatchObject({
      id: 'zai-6-1',
      label: 'Weekly limit',
      remainingPercent: 90,
      limitWindowSeconds: 7 * 24 * 3600,
    });
  });

  it('drops entries without any usable evidence', () => {
    expect(
      buildZaiQuotaWindows({ data: { limits: [{ unit: 9 }, { unit: 3, percentage: 1 }] } }, NOW)
    ).toEqual([expect.objectContaining({ label: 'Rolling limit', remainingPercent: 99 })]);
  });

  it('returns empty for malformed payloads', () => {
    expect(buildZaiQuotaWindows(null, NOW)).toEqual([]);
    expect(buildZaiQuotaWindows({}, NOW)).toEqual([]);
    expect(buildZaiQuotaWindows({ data: {} }, NOW)).toEqual([]);
  });
});

describe('parseZaiQuotaPayload', () => {
  it('extracts the plan level', () => {
    const parsed = parseZaiQuotaPayload(
      { data: { level: 'GLM Coding Pro', limits: [{ unit: 3, number: 5, percentage: 1 }] } },
      NOW
    );
    expect(parsed?.plan).toBe('GLM Coding Pro');
    expect(parsed?.windows).toHaveLength(1);
  });

  it('returns null without windows', () => {
    expect(parseZaiQuotaPayload({ data: { level: 'X', limits: [] } }, NOW)).toBeNull();
  });
});
