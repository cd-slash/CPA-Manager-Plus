/**
 * xAI per-model rate-limit windows from response headers.
 *
 * The Manager Server performs fixed-origin probes and returns only sanitized
 * rate-limit windows. Tokens and completion response bodies never reach the
 * browser.
 */
import type { TFunction } from 'i18next';
import type { AuthFileItem } from '@/types';
import type { AuthFilesApiRequestScope } from '@/services/api/authFiles';
import { apiClient, createScopedApiRequestConfig } from '@/services/api/client';
import { normalizeAuthIndex } from '@/utils/authIndex';

export const XAI_RATE_LIMIT_HEADER_KEYS = {
  limit: ['x-ratelimit-limit-tokens', 'x-ratelimit-limit-tokens-remaining'],
  remaining: ['x-ratelimit-remaining-tokens'],
  reset: ['x-ratelimit-reset-tokens', 'x-ratelimit-reset'],
} as const;

export interface XaiRateLimitWindow {
  id: string;
  label: string;
  remainingPercent: number | null;
  limitTokens: number | null;
  remainingTokens: number | null;
}

const readHeader = (
  header: Record<string, string[]> | undefined,
  keys: readonly string[]
): string | null => {
  if (!header) return null;
  for (const key of keys) {
    const values = header[key] ?? header[key.toLowerCase()];
    const first = Array.isArray(values) ? values.find((value) => String(value).trim()) : undefined;
    if (first !== undefined) return String(first).trim();
  }
  return null;
};

export const parseRateLimitHeaders = (
  header: Record<string, string[]> | undefined
): { limitTokens: number | null; remainingTokens: number | null } => {
  const parse = (raw: string | null): number | null => {
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  return {
    limitTokens: parse(readHeader(header, XAI_RATE_LIMIT_HEADER_KEYS.limit)),
    remainingTokens: parse(readHeader(header, XAI_RATE_LIMIT_HEADER_KEYS.remaining)),
  };
};

export const buildXaiRateLimitWindow = (
  model: string,
  header: Record<string, string[]> | undefined
): XaiRateLimitWindow | null => {
  const { limitTokens, remainingTokens } = parseRateLimitHeaders(header);
  if (limitTokens === null || limitTokens <= 0 || remainingTokens === null) return null;
  const remainingPercent = Math.min(100, Math.max(0, (remainingTokens / limitTokens) * 100));
  return {
    id: `xai-ratelimit-${model}`,
    label: `${model} tokens`,
    remainingPercent: Math.round(remainingPercent * 10) / 10,
    limitTokens,
    remainingTokens,
  };
};

export const fetchXaiRateLimits = async (
  file: AuthFileItem,
  t: TFunction,
  requestScope?: AuthFilesApiRequestScope
): Promise<XaiRateLimitWindow[]> => {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  if (!authIndex) {
    throw new Error(t('usage_dashboard.missing_auth_index'));
  }

  const response = await apiClient.post<{ windows?: XaiRateLimitWindow[] }>(
    '/usage-dashboard/xai',
    { auth_index: authIndex },
    requestScope ? createScopedApiRequestConfig(requestScope) : undefined
  );
  const resolved = Array.isArray(response?.windows) ? response.windows : [];
  if (resolved.length === 0) {
    throw new Error(t('usage_dashboard.no_usage_windows'));
  }
  return resolved;
};
