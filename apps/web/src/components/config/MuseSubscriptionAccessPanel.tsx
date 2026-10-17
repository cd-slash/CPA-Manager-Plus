import { memo, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { useNotificationStore } from '@/stores';
import { maskApiKey } from '@/utils/format';
import {
  findMuseSubscriptionTokens,
  museSubscriptionFingerprint,
  planMuseSubscriptionSync,
} from '@/utils/museSubscription';
import type { ApiKeyMutation } from './ApiKeysCardEditor';
import styles from './VisualConfigEditor.module.scss';

export const MuseSubscriptionAccessPanel = memo(function MuseSubscriptionAccessPanel({
  apiKeys,
  disabled,
  onPersistApiKeyMutation,
  onApiKeyOperationStart,
  onApiKeyOperationEnd,
}: {
  apiKeys: string[];
  disabled?: boolean;
  onPersistApiKeyMutation: (mutation: ApiKeyMutation) => Promise<string[]>;
  onApiKeyOperationStart: () => void;
  onApiKeyOperationEnd: () => void;
}) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const [inputValue, setInputValue] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlightRef = useRef(false);

  const syncedTokens = useMemo(() => findMuseSubscriptionTokens(apiKeys), [apiKeys]);
  const hasSyncedToken = syncedTokens.length > 0;

  const begin = (onError: (message: string) => void): boolean => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setSaving(true);
    try {
      onApiKeyOperationStart();
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      inFlightRef.current = false;
      setSaving(false);
      return false;
    }
  };

  const end = () => {
    if (!inFlightRef.current) return;
    inFlightRef.current = false;
    setSaving(false);
    onApiKeyOperationEnd();
  };

  const handleSync = async () => {
    if (inFlightRef.current) return;
    const plan = planMuseSubscriptionSync(apiKeys, inputValue);
    if (!plan.ok) {
      setFormError(t('config_management.visual.api_keys.muse_subscription_error_invalid'));
      return;
    }
    if (plan.action === 'already-synced') {
      setFormError('');
      showNotification(t('config_management.visual.api_keys.muse_subscription_already'), 'success');
      return;
    }
    if (!begin(setFormError)) return;
    try {
      await onPersistApiKeyMutation(
        plan.action === 'replace'
          ? { type: 'replace', oldApiKey: plan.oldToken, newApiKey: plan.token }
          : { type: 'create', apiKey: plan.token }
      );
      setInputValue('');
      setFormError('');
      showNotification(
        t(
          plan.action === 'replace'
            ? 'config_management.visual.api_keys.muse_subscription_replaced'
            : 'config_management.visual.api_keys.muse_subscription_added'
        ),
        'success'
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      end();
    }
  };

  const handleRemove = (token: string) => {
    if (disabled || inFlightRef.current) return;
    showConfirmation({
      title: t('config_management.visual.api_keys.muse_subscription_remove_title'),
      message: t('config_management.visual.api_keys.muse_subscription_remove_confirm', {
        fingerprint: museSubscriptionFingerprint(token),
      }),
      confirmText: t('config_management.visual.common.delete'),
      cancelText: t('config_management.visual.common.cancel'),
      variant: 'danger',
      onConfirm: async () => {
        if (!begin(() => undefined)) return;
        try {
          await onPersistApiKeyMutation({ type: 'delete', apiKey: token });
          showNotification(
            t('config_management.visual.api_keys.muse_subscription_removed'),
            'success'
          );
        } catch (error) {
          showNotification(error instanceof Error ? error.message : String(error), 'error');
        } finally {
          end();
        }
      },
    });
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div className={styles.blockHeaderRow}>
        <label style={{ margin: 0 }}>
          {t('config_management.visual.api_keys.muse_subscription_title')}
        </label>
      </div>
      <div className="hint" style={{ marginTop: 4 }}>
        {t('config_management.visual.api_keys.muse_subscription_description')}
      </div>

      {hasSyncedToken ? (
        <div className="item-list" style={{ marginTop: 4 }}>
          {syncedTokens.map((token) => (
            <div key={token} className="item-row">
              <div className="item-meta">
                <div className="item-title">
                  {t('config_management.visual.api_keys.muse_subscription_active')}
                </div>
                <div className="item-subtitle">
                  {maskApiKey(token)} · sha256:{museSubscriptionFingerprint(token)}
                </div>
              </div>
              <div className="item-actions">
                <Button
                  variant="danger"
                  size="xs"
                  onClick={() => handleRemove(token)}
                  disabled={disabled || saving}
                >
                  {t('config_management.visual.common.delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.emptyState}>
          {t('config_management.visual.api_keys.muse_subscription_none')}
        </div>
      )}

      <div className="form-group" style={{ marginTop: 12 }}>
        <label htmlFor={inputId}>
          {t('config_management.visual.api_keys.muse_subscription_input_label')}
        </label>
        <div className={styles.apiKeyModalInputRow}>
          <input
            id={inputId}
            className="input"
            type="password"
            autoComplete="off"
            placeholder={t('config_management.visual.api_keys.muse_subscription_placeholder')}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={disabled || saving}
            aria-describedby={formError ? `${errorId} ${hintId}` : hintId}
            aria-invalid={Boolean(formError)}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSync()}
            disabled={disabled || saving || !inputValue.trim()}
            loading={saving}
          >
            {t(
              hasSyncedToken
                ? 'config_management.visual.api_keys.muse_subscription_resync'
                : 'config_management.visual.api_keys.muse_subscription_sync'
            )}
          </Button>
        </div>
        <div id={hintId} className="hint">
          {t('config_management.visual.api_keys.muse_subscription_hint')}
        </div>
        {formError && (
          <div id={errorId} className="error-box">
            {formError}
          </div>
        )}
      </div>
    </div>
  );
});
