/**
 * DeepSeek API account balance returned by the authenticated Manager Server
 * probe. The server-held API key (CPA_MANAGER_DEEPSEEK_API_KEY) and the
 * upstream response body never reach the browser.
 *
 * Server payload (GET https://api.deepseek.com/user/balance, USD entry of
 * balance_infos.total_balance, sanitized server-side):
 *   { currency: "USD", totalBalance: 12.34 }
 *
 * The fixed $20 reference limit is a display reference only: it is never a
 * measured spend, and no spending cap is enforced from it.
 */
import type { TFunction } from 'i18next';
import type { AuthFilesApiRequestScope } from '@/services/api/authFiles';
import { apiClient, createScopedApiRequestConfig } from '@/services/api/client';

export const DEEPSEEK_REFERENCE_LIMIT_USD = 20;

export interface DeepSeekBalanceData {
  currency: string;
  totalBalance: number;
}

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export const parseDeepSeekBalancePayload = (payload: unknown): DeepSeekBalanceData | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as { currency?: unknown; totalBalance?: unknown };
  const currency = typeof record.currency === 'string' ? record.currency.trim().toUpperCase() : '';
  if (!currency) return null;
  const totalBalance = toFiniteNumber(record.totalBalance);
  // Balance must be a real, nonnegative finite amount; anything else is
  // reported as unavailable instead of fabricated.
  if (totalBalance === null || totalBalance < 0) return null;
  return { currency, totalBalance };
};

/**
 * Balance progress against the fixed USD reference limit, bounded to 0..100.
 * Balances above the reference clamp visually at 100%.
 */
export const deepSeekReferencePercent = (totalBalance: number): number => {
  if (!Number.isFinite(totalBalance) || totalBalance <= 0) return 0;
  return Math.min(100, Math.max(0, (totalBalance / DEEPSEEK_REFERENCE_LIMIT_USD) * 100));
};

export const formatDeepSeekBalanceUsd = (totalBalance: number): string =>
  `$${totalBalance.toFixed(2)}`;

export const fetchDeepSeekBalance = async (
  t: TFunction,
  requestScope?: AuthFilesApiRequestScope
): Promise<DeepSeekBalanceData> => {
  try {
    const result = await apiClient.get<DeepSeekBalanceData>(
      '/usage-dashboard/deepseek',
      requestScope ? createScopedApiRequestConfig(requestScope) : undefined
    );
    const parsed = parseDeepSeekBalancePayload(result);
    if (!parsed) throw new Error(t('usage_dashboard.balance_unavailable'));
    return parsed;
  } catch (err) {
    if (err instanceof Error && err.name === 'ApiError') {
      const status = (err as { status?: number }).status;
      // 501: the server has no DeepSeek key configured.
      if (status === 501) throw new Error(t('usage_dashboard.balance_not_configured'));
    }
    throw err;
  }
};
