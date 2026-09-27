import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconRefreshCw } from '@/components/ui/icons';
import {
  buildUsageAccountRows,
  type UsageAccountRow,
  type UsageProviderGroup,
  type UsageWindowRow,
} from './model/usageDashboardRows';
import { planLabelForFile, useUsageDashboard } from './hooks/useUsageDashboard';
import {
  formatQuotaResetDisplay,
  getQuotaResetRemainingDuration,
} from '@/features/accounts/model/accountsPagePresentation';
import styles from './UsageDashboardPage.module.scss';

const PROVIDER_LABEL_KEYS: Record<string, string> = {
  codex: 'provider_codex',
  claude: 'provider_claude',
  zai: 'provider_zai',
  antigravity: 'provider_antigravity',
  kimi: 'provider_kimi',
  xai: 'provider_xai',
  devin: 'provider_devin',
  meta: 'provider_meta',
  gemini: 'provider_gemini',
  aistudio: 'provider_gemini',
  qwen: 'provider_qwen',
  iflow: 'provider_iflow',
  vertex: 'provider_vertex',
};

const formatPercentValue = (value: number | null): string =>
  value === null ? '-' : `${Math.round(value)}%`;

const formatRemaining = (
  resetAtMs: number | null,
  nowMs: number
): { unit: string; value: number } | null => {
  const duration = getQuotaResetRemainingDuration(resetAtMs, nowMs);
  if (!duration) return null;
  if (duration.unit === 'day') return { unit: 'reset_d', value: duration.value };
  if (duration.unit === 'hour') return { unit: 'reset_h', value: duration.value };
  if (duration.unit === 'minute') return { unit: 'reset_m', value: duration.value };
  return { unit: 'reset_now', value: 0 };
};

interface WindowBarProps {
  window: UsageWindowRow;
  nowMs: number;
}

function WindowBar({ window: usageWindow, nowMs }: WindowBarProps) {
  const { t, i18n } = useTranslation();
  const remainingPercent = usageWindow.remainingPercent;
  const width = remainingPercent === null ? 0 : Math.min(100, Math.max(0, remainingPercent));
  const barClass =
    remainingPercent === null
      ? styles.barNeutral
      : remainingPercent <= 10
        ? styles.barHigh
        : remainingPercent <= 30
          ? styles.barMid
          : styles.barLow;
  const remaining = remainingPercent === 100 ? null : formatRemaining(usageWindow.resetAtMs, nowMs);
  const resetDisplay =
    remainingPercent === 100
      ? '-'
      : formatQuotaResetDisplay(usageWindow.resetAtMs, '-', i18n.language);

  return (
    <div className={styles.window} data-usage-window={usageWindow.key}>
      <div className={styles.windowMeta}>
        <span className={styles.windowLabel} title={usageWindow.label}>
          {usageWindow.label}
        </span>
        <span className={styles.windowPercent}>
          {formatPercentValue(remainingPercent)} {t('usage_dashboard.remaining')}
        </span>
      </div>
      <div
        className={styles.track}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remainingPercent === null ? undefined : Math.round(remainingPercent)}
        aria-label={usageWindow.label}
      >
        <div className={`${styles.bar} ${barClass}`} style={{ width: `${width}%` }} />
      </div>
      <div className={styles.windowReset}>
        {resetDisplay !== '-' ? <span>{resetDisplay}</span> : null}
        {remaining ? (
          <span className={styles.windowResetIn}>
            {remaining.unit === 'reset_now'
              ? t('usage_dashboard.reset_now')
              : t(`usage_dashboard.${remaining.unit}`, { count: remaining.value })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

interface AccountRowProps {
  account: UsageAccountRow;
  nowMs: number;
}

function AccountRow({ account, nowMs }: AccountRowProps) {
  const { t } = useTranslation();
  const statusKey =
    account.status === 'ok'
      ? 'status_ok'
      : account.status === 'disabled'
        ? 'status_disabled'
        : account.status === 'error'
          ? 'status_error'
          : account.status === 'loading'
            ? 'status_loading'
            : 'status_pending';

  return (
    <article
      className={styles.row}
      data-usage-account={account.key}
      data-provider={account.provider}
    >
      <div className={styles.rowHead}>
        <span className={styles.rowName} title={account.maskedName}>
          {account.maskedName}
        </span>
        {account.planLabel ? <span className={styles.planChip}>{account.planLabel}</span> : null}
        <span
          className={`${styles.statusChip} ${styles[account.status]}`}
          data-usage-status={account.status}
        >
          {t(`usage_dashboard.${statusKey}`)}
        </span>
        {account.status === 'error' && account.statusDetail ? (
          <span className={styles.errorDetail}>{account.statusDetail}</span>
        ) : null}
      </div>
      {account.windows.length > 0 ? (
        <div className={styles.rowWindows}>
          {account.windows.map((usageWindow) => (
            <WindowBar key={usageWindow.key} window={usageWindow} nowMs={nowMs} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ProviderGroup({ group, nowMs }: { group: UsageProviderGroup; nowMs: number }) {
  const { t } = useTranslation();
  const labelKey = PROVIDER_LABEL_KEYS[group.provider];

  return (
    <section className={styles.group} data-usage-provider={group.provider}>
      <h2 className={styles.groupTitle}>
        <span>{labelKey ? t(`usage_dashboard.${labelKey}`) : group.provider}</span>
        <span className={styles.groupCount}>{group.accounts.length}</span>
      </h2>
      <div className={styles.rows}>
        {group.accounts.map((account) => (
          <AccountRow key={account.key} account={account} nowMs={nowMs} />
        ))}
      </div>
    </section>
  );
}

export function UsageDashboardPage() {
  const { t } = useTranslation();
  const dashboard = useUsageDashboard(t);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Keep reset countdowns current without extra re-render churn.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const groups = useMemo(
    () =>
      buildUsageAccountRows({
        ...dashboard.quotaStates,
        files: dashboard.files,
        t,
        planLabel: planLabelForFile(t),
        zai: {
          windowsByFile: dashboard.zai.windowsByFile,
          statusByFile: dashboard.zai.statusByFile,
          errorByFile: dashboard.zai.errorByFile,
          planByFile: dashboard.zai.planByFile,
        },
        xaiRateLimits: {
          windowsByFile: dashboard.xaiRateLimits.windowsByFile,
          statusByFile: dashboard.xaiRateLimits.statusByFile,
        },
      }),
    [dashboard.files, dashboard.quotaStates, dashboard.zai, dashboard.xaiRateLimits, t]
  );

  const isEmpty = !dashboard.loading && !dashboard.error && groups.length === 0;

  return (
    <div className={styles.page} data-usage-dashboard-page="true">
      <header className={styles.header}>
        <h1 className={styles.title}>{t('usage_dashboard.title')}</h1>
        <div className={styles.headerActions}>
          {dashboard.lastRefreshedAtMs ? (
            <span className={styles.updatedAt}>
              {t('usage_dashboard.updated')}{' '}
              {formatQuotaResetDisplay(dashboard.lastRefreshedAtMs, '-', undefined)}
            </span>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={dashboard.refresh}
            disabled={dashboard.loading}
            aria-label={t('common.refresh')}
          >
            <IconRefreshCw size={15} />
            {t('common.refresh')}
          </Button>
        </div>
      </header>

      {dashboard.error ? (
        <div className={styles.errorBox} role="alert">
          {dashboard.error}
        </div>
      ) : null}

      {dashboard.loading && groups.length === 0 ? (
        <div className={styles.loading}>
          <LoadingSpinner />
        </div>
      ) : null}

      {isEmpty ? <p className={styles.emptyState}>{t('usage_dashboard.no_accounts')}</p> : null}

      <div className={styles.groups}>
        {groups.map((group) => (
          <ProviderGroup key={group.provider} group={group} nowMs={nowMs} />
        ))}
      </div>
    </div>
  );
}
