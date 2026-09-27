/**
 * Usage dashboard orchestration: lists the auth files through the existing
 * authenticated management API and refreshes every provider's quota through
 * the shared quota configs (proxied api-call; credentials stay server-side).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import type { AuthFileItem } from '@/types';
import { authFilesApi } from '@/services/api/authFiles';
import { useQuotaStore } from '@/stores/useQuotaStore';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_SUMMARY_CONFIG,
  DEVIN_CONFIG,
  KIMI_CONFIG,
  META_CONFIG,
  XAI_CONFIG,
  refreshQuotaWithConfig,
} from '@/components/quota';
import { resolveAuthFilePlanType, getPlanPresentation, getPlanLabel } from '@/utils/plans';
import { getQuotaCredentialStoreKey } from '@/utils/quota/credentialScope';
import { mapWithConcurrency } from '@/features/accounts/model/asyncPool';
import { useInterval } from '@/hooks/useInterval';
import { normalizeProviderKey } from '../model/usageDashboardRows';
import { fetchXaiRateLimits, type XaiRateLimitWindow } from '../model/xaiRateLimit';
import { fetchZaiQuota, isZaiAuthFile, type ZaiQuotaWindow } from '../model/zaiQuota';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const QUOTA_REFRESH_CONCURRENCY = 3;

type LoadStatus = 'loading' | 'success' | 'error';

interface ZaiState {
  windowsByFile: Record<string, ZaiQuotaWindow[]>;
  statusByFile: Record<string, LoadStatus>;
  errorByFile: Record<string, string>;
  planByFile: Record<string, string | null>;
}

interface XaiRateLimitState {
  windowsByFile: Record<string, XaiRateLimitWindow[]>;
  statusByFile: Record<string, LoadStatus>;
}

export const EMPTY_ZAI: ZaiState = {
  windowsByFile: {},
  statusByFile: {},
  errorByFile: {},
  planByFile: {},
};

export const EMPTY_XAI_RATE_LIMITS: XaiRateLimitState = {
  windowsByFile: {},
  statusByFile: {},
};

export interface UsageDashboardQuotaStates {
  antigravityQuota: ReturnType<typeof useQuotaStore.getState>['antigravityQuota'];
  claudeQuota: ReturnType<typeof useQuotaStore.getState>['claudeQuota'];
  codexQuota: ReturnType<typeof useQuotaStore.getState>['codexQuota'];
  devinQuota: ReturnType<typeof useQuotaStore.getState>['devinQuota'];
  kimiQuota: ReturnType<typeof useQuotaStore.getState>['kimiQuota'];
  metaQuota: ReturnType<typeof useQuotaStore.getState>['metaQuota'];
  xaiQuota: ReturnType<typeof useQuotaStore.getState>['xaiQuota'];
}

export interface UsageDashboardState {
  files: AuthFileItem[];
  loading: boolean;
  error: string | null;
  lastRefreshedAtMs: number | null;
  zai: ZaiState;
  xaiRateLimits: XaiRateLimitState;
  quotaStates: UsageDashboardQuotaStates;
  refresh: () => void;
}

export const useUsageDashboard = (t: TFunction): UsageDashboardState => {
  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedAtMs, setLastRefreshedAtMs] = useState<number | null>(null);
  const [zai, setZai] = useState<ZaiState>(EMPTY_ZAI);
  const [xaiRateLimits, setXaiRateLimits] = useState<XaiRateLimitState>(EMPTY_XAI_RATE_LIMITS);
  const [refreshTick, setRefreshTick] = useState(0);

  const setClaudeQuota = useQuotaStore((state) => state.setClaudeQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);
  const setAntigravityQuota = useQuotaStore((state) => state.setAntigravityQuota);
  const setKimiQuota = useQuotaStore((state) => state.setKimiQuota);
  const setXaiQuota = useQuotaStore((state) => state.setXaiQuota);
  const setDevinQuota = useQuotaStore((state) => state.setDevinQuota);
  const setMetaQuota = useQuotaStore((state) => state.setMetaQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);

  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);

  useEffect(() => {
    let cancelled = false;
    const isCurrent = () => !cancelled;

    const run = async () => {
      setLoading(true);
      try {
        const response = await authFilesApi.list();
        if (!isCurrent()) return;
        const listed = Array.isArray(response?.files) ? response.files : [];
        setFiles(listed);
        setError(null);
        setLastRefreshedAtMs(Date.now());

        const byProvider = new Map<string, AuthFileItem[]>();
        for (const file of listed) {
          const provider = normalizeProviderKey(file);
          const bucket = byProvider.get(provider) ?? [];
          bucket.push(file);
          byProvider.set(provider, bucket);
        }

        const runProviderRefresh = async (
          provider: string,
          runFile: (file: AuthFileItem) => Promise<unknown>
        ): Promise<void> => {
          const bucket = byProvider.get(provider) ?? [];
          await mapWithConcurrency(bucket, QUOTA_REFRESH_CONCURRENCY, async (file) => {
            if (!isCurrent()) return null;
            try {
              await runFile(file);
            } catch {
              // refreshQuotaWithConfig already committed the failure state.
            }
            return null;
          });
        };

        const refreshTokenQuota = async (file: AuthFileItem): Promise<void> => {
          const storeKey = getQuotaCredentialStoreKey(file);
          setXaiRateLimits((prev) => ({
            ...prev,
            statusByFile: { ...prev.statusByFile, [storeKey]: 'loading' },
          }));
          await refreshQuotaWithConfig({
            config: XAI_CONFIG,
            file,
            setQuota: setXaiQuota,
            t,
            isCurrent,
          });
          if (!isCurrent()) return;
          try {
            const windows = await fetchXaiRateLimits(file, t);
            if (!isCurrent()) return;
            setXaiRateLimits((prev) => ({
              windowsByFile: { ...prev.windowsByFile, [storeKey]: windows },
              statusByFile: { ...prev.statusByFile, [storeKey]: 'success' },
            }));
          } catch {
            if (!isCurrent()) return;
            setXaiRateLimits((prev) => ({
              ...prev,
              statusByFile: { ...prev.statusByFile, [storeKey]: 'error' },
            }));
          }
        };

        const refreshZaiQuota = async (file: AuthFileItem): Promise<void> => {
          const storeKey = getQuotaCredentialStoreKey(file);
          setZai((prev) => ({
            ...prev,
            statusByFile: { ...prev.statusByFile, [storeKey]: 'loading' },
          }));
          try {
            const data = await fetchZaiQuota(file, t);
            if (!isCurrent()) return;
            setZai((prev) => ({
              windowsByFile: { ...prev.windowsByFile, [storeKey]: data.windows },
              statusByFile: { ...prev.statusByFile, [storeKey]: 'success' },
              errorByFile: prev.errorByFile,
              planByFile: { ...prev.planByFile, [storeKey]: data.plan },
            }));
          } catch (err) {
            if (!isCurrent()) return;
            setZai((prev) => ({
              ...prev,
              statusByFile: { ...prev.statusByFile, [storeKey]: 'error' },
              errorByFile: {
                ...prev.errorByFile,
                [storeKey]: err instanceof Error ? err.message : '',
              },
            }));
          }
        };

        const zaiFiles = [
          ...(byProvider.get('zai') ?? []),
          ...listed.filter((file) => !byProvider.has(normalizeProviderKey(file)) && isZaiAuthFile(file)),
        ].filter((file, index, all) => all.findIndex((other) => other.name === file.name) === index);

        await Promise.all([
          runProviderRefresh('claude', (file) =>
            refreshQuotaWithConfig({
              config: CLAUDE_CONFIG,
              file,
              setQuota: setClaudeQuota,
              t,
              isCurrent,
            })
          ),
          runProviderRefresh('codex', (file) =>
            refreshQuotaWithConfig({
              config: CODEX_SUMMARY_CONFIG,
              file,
              setQuota: setCodexQuota,
              t,
              isCurrent,
            })
          ),
          runProviderRefresh('antigravity', (file) =>
            refreshQuotaWithConfig({
              config: ANTIGRAVITY_CONFIG,
              file,
              setQuota: setAntigravityQuota,
              t,
              isCurrent,
            })
          ),
          runProviderRefresh('kimi', (file) =>
            refreshQuotaWithConfig({
              config: KIMI_CONFIG,
              file,
              setQuota: setKimiQuota,
              t,
              isCurrent,
            })
          ),
          runProviderRefresh('devin', (file) =>
            refreshQuotaWithConfig({
              config: DEVIN_CONFIG,
              file,
              setQuota: setDevinQuota,
              t,
              isCurrent,
            })
          ),
          runProviderRefresh('meta', (file) =>
            refreshQuotaWithConfig({
              config: META_CONFIG,
              file,
              setQuota: setMetaQuota,
              t,
              isCurrent,
            })
          ),
          runProviderRefresh('xai', refreshTokenQuota),
          mapWithConcurrency(zaiFiles, QUOTA_REFRESH_CONCURRENCY, async (file) => {
            if (!isCurrent()) return;
            await refreshZaiQuota(file);
          }),
        ]);
      } catch (err) {
        if (!isCurrent()) return;
        setError(err instanceof Error ? err.message : t('common.unknown_error'));
      } finally {
        if (isCurrent()) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [refreshTick, t, setAntigravityQuota, setClaudeQuota, setCodexQuota, setDevinQuota, setKimiQuota, setMetaQuota, setXaiQuota]);

  // Periodic re-fetch.
  useInterval(() => {
    refresh();
  }, REFRESH_INTERVAL_MS);

  const quotaStates = useMemo(
    () => ({
      antigravityQuota,
      claudeQuota,
      codexQuota,
      devinQuota,
      kimiQuota,
      metaQuota,
      xaiQuota,
    }),
    [antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, metaQuota, xaiQuota]
  );

  return {
    files,
    loading,
    error,
    lastRefreshedAtMs,
    zai,
    xaiRateLimits,
    quotaStates,
    refresh,
  };
};

export const planLabelForFile =
  (t: TFunction) =>
  (file: AuthFileItem, planType: unknown): string | null => {
    const explicit = typeof planType === 'string' ? planType.trim() : '';
    const resolved = explicit || resolveAuthFilePlanType(file);
    const presentation = getPlanPresentation({
      provider: String(file.provider ?? file.type ?? ''),
      planType: resolved,
      t,
    });
    return getPlanLabel(presentation, 'compact');
  };
