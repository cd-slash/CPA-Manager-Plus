/**
 * xAI per-model rate-limit windows from response headers.
 *
 * xAI publishes quota as per-model rate-limit headers
 * (x-ratelimit-limit-tokens / x-ratelimit-remaining-tokens) instead of a
 * status endpoint. A tiny 1-token completion probe per configured model makes
 * those headers observable; the request is proxied through the management
 * api-call so the credential stays server-side.
 */
import type { TFunction } from 'i18next';
import type { AuthFileItem } from '@/types';
import { apiCallApi } from '@/services/api/apiCall';
import type { AuthFilesApiRequestScope } from '@/services/api/authFiles';
import { createScopedApiRequestConfig } from '@/services/api/client';
import { normalizeAuthIndex } from '@/utils/authIndex';

export const XAI_COMPLETIONS_URL = 'https://api.x.ai/v1/chat/completions';

export const DEFAULT_XAI_RATE_LIMIT_PROBE_MODELS = ['grok-4.5', 'grok-4-fast'] as const;

export const XAI_RATE_LIMIT_HEADER_KEYS = {
  limit: ['x-ratelimit-limit-tokens', 'x-ratelimit-limit-tokens-remaining'],
  remaining: ['x-ratelimit-remaining-tokens'],
  reset: ['x-ratelimit-reset-tokens', 'x-ratelimit-reset'],
} as const;

export interface XaiRateLimitWindow {
  id: string;
  label: string;
  usedPercent: number | null;
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
  const usedPercent = Math.min(100, Math.max(0, (1 - remainingTokens / limitTokens) * 100));
  return {
    id: `xai-ratelimit-${model}`,
    label: `${model} tokens`,
    usedPercent: Math.round(usedPercent * 10) / 10,
    limitTokens,
    remainingTokens,
  };
};

export const fetchXaiRateLimits = async (
  file: AuthFileItem,
  t: TFunction,
  requestScope?: AuthFilesApiRequestScope,
  probeModels: readonly string[] = DEFAULT_XAI_RATE_LIMIT_PROBE_MODELS
): Promise<XaiRateLimitWindow[]> => {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  if (!authIndex) {
    throw new Error(t('usage_dashboard.missing_auth_index'));
  }

  const windows = await Promise.all(
    probeModels.map(async (model) => {
      try {
        const result = await apiCallApi.request(
          {
            authIndex,
            method: 'POST',
            url: XAI_COMPLETIONS_URL,
            header: { Authorization: 'Bearer $TOKEN$' },
            data: JSON.stringify({
              model,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
            }),
          },
          requestScope ? createScopedApiRequestConfig(requestScope) : undefined
        );
        if (result.statusCode < 200 || result.statusCode >= 300) return null;
        return buildXaiRateLimitWindow(model, result.header);
      } catch {
        // A bad or unavailable model must not hide healthy probes.
        return null;
      }
    })
  );

  const resolved = windows.filter((window): window is XaiRateLimitWindow => window !== null);
  if (resolved.length === 0) {
    throw new Error(t('usage_dashboard.no_usage_windows'));
  }
  return resolved;
};
