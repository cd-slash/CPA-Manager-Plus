import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { ClaudeQuotaState, CodexQuotaState, KimiQuotaState, XaiQuotaState } from '@/types';
import { buildUsageAccountRows, normalizeProviderKey } from './usageDashboardRows';
import type { ZaiQuotaWindow } from './zaiQuota';
import type { XaiRateLimitWindow } from './xaiRateLimit';

const t = ((key: string) => key) as TFunction;

const claudeState = (windows: ClaudeQuotaState['windows']): ClaudeQuotaState => ({
  status: 'success',
  windows,
});

const codexState = (windows: CodexQuotaState['windows']): CodexQuotaState => ({
  status: 'success',
  windows,
});

const kimiState = (rows: KimiQuotaState['rows']): KimiQuotaState => ({
  status: 'success',
  rows,
});

const xaiState = (billing: XaiQuotaState['billing']): XaiQuotaState => ({
  status: 'success',
  billing,
});

const zaiWindows = (overrides: Partial<ZaiQuotaWindow> = {}): ZaiQuotaWindow[] => [
  {
    id: 'zai-3-5',
    label: '5-hour limit',
    remainingPercent: 70,
    resetAtMs: Date.parse('2026-09-27T17:00:00Z'),
    limitWindowSeconds: 5 * 3600,
    ...overrides,
  },
];

describe('normalizeProviderKey', () => {
  it('maps aliases', () => {
    expect(normalizeProviderKey({ name: 'a', provider: 'x-ai' })).toBe('xai');
    expect(normalizeProviderKey({ name: 'a', provider: 'OpenAI' })).toBe('codex');
    expect(normalizeProviderKey({ name: 'a', provider: 'z.ai' })).toBe('zai');
    expect(normalizeProviderKey({ name: 'a' })).toBe('unknown');
  });
});

describe('buildUsageAccountRows', () => {
  it('groups accounts by provider in canonical order', () => {
    const groups = buildUsageAccountRows({
      files: [
        { name: 'kimi-a.json', provider: 'kimi' },
        { name: 'claude-b@x.dev.json', provider: 'claude' },
        { name: 'codex-c.json', provider: 'codex' },
      ],
      claudeQuota: {
        'claude-b@x.dev.json': claudeState([
          {
            id: 'five-hour',
            label: '5-hour limit',
            usedPercent: 40,
            resetLabel: '-',
            resetAtMs: Date.parse('2026-09-27T17:00:00Z'),
          },
        ]),
      },
      codexQuota: {},
      antigravityQuota: {},
      kimiQuota: {},
      devinQuota: {},
      metaQuota: {},
      xaiQuota: {},
      t,
      planLabel: () => null,
    });

    expect(groups.map((group) => group.provider)).toEqual(['codex', 'claude', 'kimi']);
    expect(groups[1].accounts[0].maskedName).toBe(
      'claude-b\u2022\u2022\u2022@x\u2022\u2022\u2022.dev.json'
    );
    expect(groups[1].accounts[0].windows).toHaveLength(1);
    expect(groups[1].accounts[0].windows[0].remainingPercent).toBe(60);
    expect(groups[1].accounts[0].status).toBe('ok');
  });

  it('marks disabled accounts and still lists them', () => {
    const groups = buildUsageAccountRows({
      files: [{ name: 'codex-d.json', provider: 'codex', disabled: true }],
      claudeQuota: {},
      codexQuota: {},
      antigravityQuota: {},
      kimiQuota: {},
      devinQuota: {},
      metaQuota: {},
      xaiQuota: {},
      t,
      planLabel: () => null,
    });
    expect(groups[0].accounts[0].status).toBe('disabled');
  });

  it('surfaces provider errors', () => {
    const groups = buildUsageAccountRows({
      files: [{ name: 'claude-e@x.dev.json', provider: 'claude' }],
      claudeQuota: {
        'claude-e@x.dev.json': {
          status: 'error',
          windows: [],
          error: 'HTTP 401',
          errorStatus: 401,
        },
      },
      codexQuota: {},
      antigravityQuota: {},
      kimiQuota: {},
      devinQuota: {},
      metaQuota: {},
      xaiQuota: {},
      t,
      planLabel: () => null,
    });
    expect(groups[0].accounts[0].status).toBe('error');
    expect(groups[0].accounts[0].statusDetail).toBe('HTTP 401');
  });

  it('merges xAI billing and per-model rate-limit windows', () => {
    const rateLimitWindow: XaiRateLimitWindow = {
      id: 'xai-ratelimit-grok-4.7',
      label: 'grok-4.7 token rate limit',
      remainingPercent: 88,
      limitTokens: 1000,
      remainingTokens: 880,
    };
    const groups = buildUsageAccountRows({
      files: [{ name: 'xai-f.json', provider: 'xai' }],
      claudeQuota: {},
      codexQuota: {},
      antigravityQuota: {},
      kimiQuota: {},
      devinQuota: {},
      metaQuota: {},
      xaiQuota: {
        'xai-f.json': xaiState({
          periodType: 'weekly',
          usagePercent: 55,
          productUsage: [],
          monthlyLimitCents: null,
          usedCents: null,
          includedUsedCents: null,
          onDemandCapCents: null,
          onDemandUsedCents: null,
          onDemandUsedPercent: null,
          usedPercent: null,
        }),
      },
      xaiRateLimits: {
        windowsByFile: { 'xai-f.json': [rateLimitWindow] },
        statusByFile: { 'xai-f.json': 'success' },
      },
      t,
      planLabel: () => null,
    });
    const windows = groups[0].accounts[0].windows;
    expect(windows.map((window) => window.label)).toEqual([
      'weekly usage',
      'grok-4.7 token rate limit',
    ]);
    expect(windows[0].remainingPercent).toBe(45);
  });

  it('renders zai windows and plan for zai auth files', () => {
    const groups = buildUsageAccountRows({
      files: [{ name: 'zai-plan.json', provider: 'zai' }],
      claudeQuota: {},
      codexQuota: {},
      antigravityQuota: {},
      kimiQuota: {},
      devinQuota: {},
      metaQuota: {},
      xaiQuota: {},
      zai: {
        windowsByFile: { 'zai-plan.json': zaiWindows() },
        statusByFile: { 'zai-plan.json': 'success' },
        errorByFile: {},
        planByFile: { 'zai-plan.json': 'GLM Coding Pro' },
      },
      t,
      planLabel: (_file, planType) => (typeof planType === 'string' ? planType : null),
    });
    expect(groups[0].provider).toBe('zai');
    expect(groups[0].accounts[0].planLabel).toBe('GLM Coding Pro');
    expect(groups[0].accounts[0].windows[0].label).toBe('5-hour limit');
    expect(groups[0].accounts[0].status).toBe('ok');
  });

  it('derives kimi used percent from used/limit', () => {
    const groups = buildUsageAccountRows({
      files: [{ name: 'kimi-g.json', provider: 'kimi' }],
      claudeQuota: {},
      codexQuota: {},
      antigravityQuota: {},
      kimiQuota: {
        'kimi-g.json': kimiState([
          { id: 'k1', label: 'Prompt', used: 250, limit: 1000, resetAtMs: null },
        ]),
      },
      devinQuota: {},
      metaQuota: {},
      xaiQuota: {},
      t,
      planLabel: () => null,
    });
    expect(groups[0].accounts[0].windows[0].remainingPercent).toBe(75);
  });

  it('maps codex plan data through the plan label callback', () => {
    const groups = buildUsageAccountRows({
      files: [{ name: 'codex-h.json', provider: 'codex' }],
      claudeQuota: {},
      codexQuota: {
        'codex-h.json': codexState([]),
      },
      antigravityQuota: {},
      kimiQuota: {},
      devinQuota: {},
      metaQuota: {},
      xaiQuota: {},
      t,
      planLabel: () => 'Pro',
    });
    expect(groups[0].accounts[0].planLabel).toBe('Pro');
  });
});
