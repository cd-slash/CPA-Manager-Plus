/**
 * Z.AI coding-plan quota, read via the proxied management api-call so the
 * stored credential never leaves the server side.
 *
 * Payload shape (api.z.ai/api/monitor/usage/quota/limit):
 *   { data: { level: "Pro", limits: [{ unit, number, percentage, nextResetTime }] } }
 *   unit 3 => rolling N-hour window, unit 6 => weekly window.
 */
import type { TFunction } from 'i18next';
import type { AuthFileItem } from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api/apiCall';
import type { AuthFilesApiRequestScope } from '@/services/api/authFiles';
import { createScopedApiRequestConfig } from '@/services/api/client';
import { normalizeAuthIndex } from '@/utils/authIndex';

export const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

const ZAI_TOKEN_HEADER = {
  Authorization: 'Bearer $TOKEN$',
} as const;

export interface ZaiQuotaWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  resetAtMs: number | null;
  limitWindowSeconds: number | null;
}

export interface ZaiQuotaData {
  plan: string | null;
  windows: ZaiQuotaWindow[];
}

export const normalizeZaiProvider = (value: unknown): string => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_.]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (['z-ai', 'z-dot-ai', 'zhipu', 'glm', 'zai-coding-plan'].includes(normalized)) return 'zai';
  return normalized;
};

export const isZaiAuthFile = (file: Pick<AuthFileItem, 'name'> & Record<string, unknown>): boolean => {
  const provider = normalizeZaiProvider(file.provider ?? file.type);
  if (provider === 'zai') return true;
  return String(file.name ?? '')
    .toLowerCase()
    .startsWith('zai-');
};

type ZaiLimitEntry = {
  unit?: unknown;
  number?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseResetAtMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export const buildZaiQuotaWindows = (payload: unknown, _nowMs = Date.now()): ZaiQuotaWindow[] => {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return [];
  const limits = (data as { limits?: unknown }).limits;
  if (!Array.isArray(limits)) return [];

  return limits.flatMap((entry: ZaiLimitEntry, index: number) => {
    const unit = toFiniteNumber(entry?.unit);
    const number = toFiniteNumber(entry?.number);
    const percentage = toFiniteNumber(entry?.percentage);
    const resetAtMs = parseResetAtMs(entry?.nextResetTime);
    let label = '';
    let limitWindowSeconds: number | null = null;
    if (unit === 3) {
      label = number !== null ? `${number}-hour limit` : 'Rolling limit';
      limitWindowSeconds = number !== null ? number * 3600 : null;
    } else if (unit === 6) {
      label = 'Weekly limit';
      limitWindowSeconds = 7 * 24 * 3600;
    } else if (unit !== null) {
      label = `Window ${index + 1}`;
    } else {
      return [];
    }
    return [
      {
        id: `zai-${unit ?? 'unknown'}-${number ?? index}`,
        label,
        usedPercent: percentage,
        resetAtMs,
        limitWindowSeconds,
      },
    ].filter((window) => window.usedPercent !== null || window.resetAtMs !== null);
  })
};

export const parseZaiQuotaPayload = (payload: unknown, nowMs = Date.now()): ZaiQuotaData | null => {
  const windows = buildZaiQuotaWindows(payload, nowMs);
  if (windows.length === 0) return null;
  const data =
    typeof payload === 'object' && payload !== null
      ? (payload as { data?: { level?: unknown } }).data
      : undefined;
  const level = typeof data?.level === 'string' ? data.level.trim() : '';
  return { plan: level || null, windows };
};

export const fetchZaiQuota = async (
  file: AuthFileItem,
  t: TFunction,
  requestScope?: AuthFilesApiRequestScope
): Promise<ZaiQuotaData> => {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  if (!authIndex) {
    throw new Error(t('usage_dashboard.missing_auth_index'));
  }

  const result = await apiCallApi.request(
    {
      authIndex,
      method: 'GET',
      url: ZAI_QUOTA_URL,
      header: { ...ZAI_TOKEN_HEADER },
    },
    requestScope ? createScopedApiRequestConfig(requestScope) : undefined
  );

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw Object.assign(
      new Error(getApiCallErrorMessage(result) || t('usage_dashboard.quota_error')),
      { status: result.statusCode }
    );
  }

  let body: unknown = result.body;
  if (body === null || body === undefined) {
    const text = (result.bodyText ?? '').trim();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
  }

  const parsed = parseZaiQuotaPayload(body);
  if (!parsed) {
    throw new Error(t('usage_dashboard.no_usage_windows'));
  }
  return parsed;
};
