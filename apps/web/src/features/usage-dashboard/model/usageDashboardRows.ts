/**
 * Usage dashboard view model: provider-grouped account rows with normalized
 * per-window usage rows (label, used %, reset timing) derived from the shared
 * per-provider quota states.
 */
import type { TFunction } from 'i18next';
import type {
  AntigravityQuotaState,
  AuthFileItem,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  KimiQuotaState,
  MetaQuotaState,
  XaiQuotaState,
} from '@/types';
import { isValidQuotaResetAtMs } from '@/utils/quota/formatters';
import { getQuotaCredentialStoreKey } from '@/utils/quota/credentialScope';
import { maskAuthFileName } from './maskFileName';
import type { XaiRateLimitWindow } from './xaiRateLimit';
import type { ZaiQuotaWindow } from './zaiQuota';

export type UsageAccountStatus = 'disabled' | 'loading' | 'error' | 'ok' | 'pending';

export interface UsageWindowRow {
  key: string;
  label: string;
  usedPercent: number | null;
  resetAtMs: number | null;
}

export interface UsageAccountRow {
  key: string;
  provider: string;
  maskedName: string;
  planLabel: string | null;
  status: UsageAccountStatus;
  statusDetail: string | null;
  windows: UsageWindowRow[];
  fetchedAtMs: number | null;
}

export interface UsageProviderGroup {
  provider: string;
  accounts: UsageAccountRow[];
}

export type UsageDashboardQuotaStates = {
  antigravityQuota: Record<string, AntigravityQuotaState>;
  claudeQuota: Record<string, ClaudeQuotaState>;
  codexQuota: Record<string, CodexQuotaState>;
  devinQuota: Record<string, DevinQuotaState>;
  kimiQuota: Record<string, KimiQuotaState>;
  metaQuota: Record<string, MetaQuotaState>;
  xaiQuota: Record<string, XaiQuotaState>;
};

const clamp = (value: number): number => Math.min(100, Math.max(0, value));

const finitePercent = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value) : null;

const toRow = (
  key: string,
  label: string,
  usedPercent: number | null,
  resetAtMs: number | null
): UsageWindowRow => ({
  key,
  label,
  usedPercent,
  resetAtMs: resetAtMs !== null && isValidQuotaResetAtMs(resetAtMs) ? resetAtMs : null,
});

const claudeRows = (state: ClaudeQuotaState | undefined): UsageWindowRow[] =>
  (state?.windows ?? []).map((window, index) =>
    toRow(`claude:${window.id}:${index}`, window.label, finitePercent(window.usedPercent), window.resetAtMs ?? null)
  );

const codexRows = (state: CodexQuotaState | undefined): UsageWindowRow[] =>
  (state?.windows ?? []).map((window, index) =>
    toRow(`codex:${window.id}:${index}`, window.label, finitePercent(window.usedPercent), window.resetAtMs ?? null)
  );

const devinRows = (state: DevinQuotaState | undefined): UsageWindowRow[] =>
  (state?.windows ?? []).map((window) =>
    toRow(
      `devin:${window.id}`,
      window.label || window.id,
      finitePercent(
        window.remainingPercent === null || window.remainingPercent === undefined
          ? null
          : 100 - window.remainingPercent
      ),
      window.resetAtMs
    )
  );

const metaRows = (state: MetaQuotaState | undefined): UsageWindowRow[] =>
  (state?.windows ?? []).map((window) =>
    toRow(`meta:${window.id}`, window.id, finitePercent(window.usedPercent), window.resetAtMs)
  );

const kimiRows = (state: KimiQuotaState | undefined): UsageWindowRow[] =>
  (state?.rows ?? []).map((row) => {
    const usedPercent =
      Number.isFinite(row.limit) && row.limit > 0 && Number.isFinite(row.used)
        ? clamp((row.used / row.limit) * 100)
        : null;
    return toRow(`kimi:${row.id}`, row.label || row.scope || row.id, usedPercent, row.resetAtMs ?? null);
  });

const antigravityRows = (state: AntigravityQuotaState | undefined): UsageWindowRow[] =>
  (state?.groups ?? []).flatMap((group) =>
    group.buckets.map((bucket) => {
      const remaining =
        typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)
          ? clamp(bucket.remainingFraction * 100)
          : null;
      const resetAtMs = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
      return toRow(
        `antigravity:${group.id}:${bucket.id}`,
        bucket.label,
        remaining === null ? null : clamp(100 - remaining),
        Number.isFinite(resetAtMs) ? resetAtMs : null
      );
    })
  );

const xaiBillingRows = (state: XaiQuotaState | undefined): UsageWindowRow[] => {
  const billing = state?.billing;
  if (!billing) return [];
  const rows: UsageWindowRow[] = [];
  const usagePercent = finitePercent(billing.usagePercent);
  if (usagePercent !== null) {
    const periodEndMs = billing.periodEnd ? Date.parse(billing.periodEnd) : NaN;
    rows.push(
      toRow(
        'xai:period',
        billing.periodType === 'unknown' ? 'Usage' : `${billing.periodType} usage`,
        usagePercent,
        Number.isFinite(periodEndMs) ? periodEndMs : null
      )
    );
  }
  const onDemandPercent = finitePercent(billing.onDemandUsedPercent);
  if (onDemandPercent !== null) {
    rows.push(toRow('xai:on-demand', 'On-demand', onDemandPercent, null));
  }
  billing.productUsage.forEach((product, index) => {
    const percent = finitePercent(product.usagePercent);
    if (percent !== null) {
      rows.push(toRow(`xai:product:${index}`, product.product, percent, null));
    }
  });
  return rows;
};

const xaiRateLimitRows = (windows: XaiRateLimitWindow[] | undefined): UsageWindowRow[] =>
  (windows ?? []).map((window) => toRow(window.id, window.label, finitePercent(window.usedPercent), null));

const zaiRows = (windows: ZaiQuotaWindow[] | undefined): UsageWindowRow[] =>
  (windows ?? []).map((window) =>
    toRow(window.id, window.label, finitePercent(window.usedPercent), window.resetAtMs)
  );

const firstFiniteTimestamp = (...values: Array<number | null | undefined>): number | null => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
};

type ProviderQuotaSnapshot = {
  status: 'idle' | 'loading' | 'success' | 'error' | undefined;
  error?: string;
  errorStatus?: number;
  fetchedAtMs?: number | null;
  failedAtMs?: number | null;
};

const buildAccountStatus = (
  file: AuthFileItem,
  snapshot: ProviderQuotaSnapshot | undefined,
  hasWindows: boolean
): { status: UsageAccountStatus; statusDetail: string | null } => {
  if (file.disabled === true || String(file.status ?? '').toLowerCase() === 'disabled') {
    return { status: 'disabled', statusDetail: null };
  }
  if (!snapshot || snapshot.status === undefined || snapshot.status === 'idle') {
    return { status: 'pending', statusDetail: null };
  }
  if (snapshot.status === 'loading') {
    return { status: 'loading', statusDetail: null };
  }
  if (snapshot.status === 'error') {
    const detail = snapshot.errorStatus ? `HTTP ${snapshot.errorStatus}` : snapshot.error || null;
    return { status: 'error', statusDetail: detail };
  }
  if (!hasWindows) {
    return { status: 'error', statusDetail: 'empty' };
  }
  return { status: 'ok', statusDetail: null };
};

export const PROVIDER_ORDER = [
  'codex',
  'claude',
  'zai',
  'antigravity',
  'kimi',
  'xai',
  'devin',
  'meta',
  'gemini',
  'qwen',
  'iflow',
  'vertex',
] as const;

export const normalizeProviderKey = (file: AuthFileItem): string => {
  const raw = String(file.provider ?? file.type ?? 'unknown').trim().toLowerCase();
  if (raw === 'x-ai' || raw === 'grok') return 'xai';
  if (['zai', 'z-ai', 'z_ai', 'z.ai', 'zhipu', 'glm', 'zai-coding-plan'].includes(raw)) return 'zai';
  if (raw === 'openai') return 'codex';
  if (raw === 'anthropic') return 'claude';
  return raw || 'unknown';
};

export interface UsageDashboardAccountInput {
  file: AuthFileItem;
  zaiWindows?: ZaiQuotaWindow[];
  zaiStatus?: 'loading' | 'success' | 'error';
  zaiError?: string;
  zaiPlan?: string | null;
  xaiRateLimitWindows?: XaiRateLimitWindow[];
  xaiRateLimitStatus?: 'loading' | 'success' | 'error';
}

export interface BuildUsageRowsInput extends UsageDashboardQuotaStates {
  files: AuthFileItem[];
  t: TFunction;
  planLabel: (file: AuthFileItem, planType: unknown) => string | null;
  zai?: {
    windowsByFile: Record<string, ZaiQuotaWindow[]>;
    statusByFile: Record<string, 'loading' | 'success' | 'error'>;
    errorByFile: Record<string, string>;
    planByFile: Record<string, string | null>;
  };
  xaiRateLimits?: {
    windowsByFile: Record<string, XaiRateLimitWindow[]>;
    statusByFile: Record<string, 'loading' | 'success' | 'error'>;
  };
}

const getStoreKey = (file: AuthFileItem): string => getQuotaCredentialStoreKey(file);

const readState = <T>(
  states: Record<string, T> | undefined,
  file: AuthFileItem,
  storeKey: string
): T | undefined => {
  if (!states) return undefined;
  return states[storeKey] ?? states[file.name];
};

export const buildUsageAccountRows = (input: BuildUsageRowsInput): UsageProviderGroup[] => {
  const accounts = input.files.map<UsageAccountRow>((file) => {
    const provider = normalizeProviderKey(file);
    const storeKey = getStoreKey(file);
    let windows: UsageWindowRow[] = [];
    let snapshot: ProviderQuotaSnapshot | undefined;

    switch (provider) {
      case 'claude': {
        const state = readState(input.claudeQuota, file, storeKey);
        snapshot = state;
        windows = claudeRows(state);
        break;
      }
      case 'codex': {
        const state = readState(input.codexQuota, file, storeKey);
        snapshot = state;
        windows = codexRows(state);
        break;
      }
      case 'antigravity': {
        const state = readState(input.antigravityQuota, file, storeKey);
        snapshot = state;
        windows = antigravityRows(state);
        break;
      }
      case 'kimi': {
        const state = readState(input.kimiQuota, file, storeKey);
        snapshot = state;
        windows = kimiRows(state);
        break;
      }
      case 'devin': {
        const state = readState(input.devinQuota, file, storeKey);
        snapshot = state;
        windows = devinRows(state);
        break;
      }
      case 'meta': {
        const state = readState(input.metaQuota, file, storeKey);
        snapshot = state;
        windows = metaRows(state);
        break;
      }
      case 'xai': {
        const billingState = readState(input.xaiQuota, file, storeKey);
        snapshot = billingState;
        windows = [
          ...xaiBillingRows(billingState),
          ...xaiRateLimitRows(readState(input.xaiRateLimits?.windowsByFile, file, storeKey)),
        ];
        break;
      }
      case 'zai': {
        const store = input.zai;
        const status = readState(store?.statusByFile, file, storeKey);
        const zaiError = readState(store?.errorByFile, file, storeKey);
        snapshot = {
          status: status ?? 'loading',
          error: zaiError,
          fetchedAtMs: null,
        };
        windows = zaiRows(readState(store?.windowsByFile, file, storeKey));
        break;
      }
      default:
        snapshot = undefined;
    }

    const { status, statusDetail } = buildAccountStatus(file, snapshot, windows.length > 0);
    const planType =
      provider === 'zai'
        ? readState(input.zai?.planByFile, file, storeKey)
        : ((snapshot as Partial<CodexQuotaState & ClaudeQuotaState> | undefined)?.planType ??
          null);
    const planLabel = input.planLabel(file, planType);

    return {
      key: storeKey,
      provider,
      maskedName: maskAuthFileName(file.name),
      planLabel,
      status,
      statusDetail,
      windows,
      fetchedAtMs: firstFiniteTimestamp(
        snapshot?.fetchedAtMs ?? null,
        snapshot?.failedAtMs ?? null
      ),
    };
  });

  const groups = new Map<string, UsageAccountRow[]>();
  for (const account of accounts) {
    const list = groups.get(account.provider) ?? [];
    list.push(account);
    groups.set(account.provider, list);
  }

  const ordered = [...groups.entries()].sort((left, right) => {
    const leftIndex = PROVIDER_ORDER.indexOf(left[0] as (typeof PROVIDER_ORDER)[number]);
    const rightIndex = PROVIDER_ORDER.indexOf(right[0] as (typeof PROVIDER_ORDER)[number]);
    const leftRank = leftIndex === -1 ? PROVIDER_ORDER.length : leftIndex;
    const rightRank = rightIndex === -1 ? PROVIDER_ORDER.length : rightIndex;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left[0].localeCompare(right[0]);
  });

  return ordered.map(([provider, groupAccounts]) => ({ provider, accounts: groupAccounts }));
};
