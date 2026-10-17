import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { sha256Hex } from '@/utils/apiKeyHash';
import { MuseSubscriptionAccessPanel } from './MuseSubscriptionAccessPanel';
import type { ApiKeyMutation } from './ApiKeysCardEditor';

const mocks = vi.hoisted(() => ({
  showNotification: vi.fn(),
  showConfirmation: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/stores', () => ({
  useNotificationStore: (
    selector: (state: {
      showNotification: typeof mocks.showNotification;
      showConfirmation: typeof mocks.showConfirmation;
    }) => unknown
  ) =>
    selector({
      showNotification: mocks.showNotification,
      showConfirmation: mocks.showConfirmation,
    }),
}));

const CURRENT = 'LLM|current-token-value-1234567890';
const STALE = 'LLM|stale-token-value-0987654321';
const PLAIN_KEY = 'sk-plain-gateway-key';
const PLACEHOLDER = 'config_management.visual.api_keys.muse_subscription_placeholder';
const SYNC_LABEL = 'config_management.visual.api_keys.muse_subscription_sync';
const RESYNC_LABEL = 'config_management.visual.api_keys.muse_subscription_resync';

const mounted: ReactTestRenderer[] = [];

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

function mount(apiKeys: string[]) {
  const persist = vi.fn(async (mutation: ApiKeyMutation): Promise<string[]> => {
    if (mutation.type === 'create') return [...apiKeys, mutation.apiKey];
    if (mutation.type === 'replace')
      return apiKeys.map((k) => (k === mutation.oldApiKey ? mutation.newApiKey : k));
    return apiKeys.filter((k) => k !== mutation.apiKey);
  });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MuseSubscriptionAccessPanel
        apiKeys={apiKeys}
        onPersistApiKeyMutation={persist}
        onApiKeyOperationStart={() => undefined}
        onApiKeyOperationEnd={() => undefined}
      />
    );
  });
  mounted.push(renderer);
  return { renderer, persist };
}

function setInput(renderer: ReactTestRenderer, value: string) {
  const input = renderer.root.findByProps({ placeholder: PLACEHOLDER });
  act(() => {
    input.props.onChange({ target: { value } });
  });
}

async function click(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType(Button)
    .find((candidate) => candidate.props.children === label);
  expect(button, `button ${label}`).toBeTruthy();
  await act(async () => {
    await button!.props.onClick();
  });
  await flush();
}

const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  vi.clearAllMocks();
});

describe('MuseSubscriptionAccessPanel', () => {
  it('creates the allowlist entry for a pasted subscription bearer', async () => {
    const { renderer, persist } = mount([PLAIN_KEY]);
    expect(text(renderer)).toContain('muse_subscription_none');
    setInput(renderer, CURRENT);
    await click(renderer, SYNC_LABEL);
    expect(persist).toHaveBeenCalledWith({ type: 'create', apiKey: CURRENT });
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'config_management.visual.api_keys.muse_subscription_added',
      'success'
    );
  });

  it('shows the synced bearer by fingerprint and re-syncs a rotated one', async () => {
    const { renderer, persist } = mount([PLAIN_KEY, STALE]);
    expect(text(renderer)).toContain(sha256Hex(STALE).slice(0, 12));
    expect(text(renderer)).not.toContain(STALE.slice(6));
    setInput(renderer, CURRENT);
    await click(renderer, RESYNC_LABEL);
    expect(persist).toHaveBeenCalledWith({
      type: 'replace',
      oldApiKey: STALE,
      newApiKey: CURRENT,
    });
  });

  it('rejects values that are not subscription bearers without mutating', async () => {
    const { renderer, persist } = mount([PLAIN_KEY]);
    setInput(renderer, PLAIN_KEY);
    await click(renderer, SYNC_LABEL);
    expect(persist).not.toHaveBeenCalled();
    expect(text(renderer)).toContain('muse_subscription_error_invalid');
  });

  it('reports already-synced instead of duplicating the key', async () => {
    const { renderer, persist } = mount([CURRENT]);
    setInput(renderer, CURRENT);
    await click(renderer, RESYNC_LABEL);
    expect(persist).not.toHaveBeenCalled();
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'config_management.visual.api_keys.muse_subscription_already',
      'success'
    );
  });

  it('deletes the synced bearer only after confirmation', async () => {
    const { renderer, persist } = mount([CURRENT]);
    await click(renderer, 'config_management.visual.common.delete');
    expect(persist).not.toHaveBeenCalled();
    expect(mocks.showConfirmation).toHaveBeenCalledTimes(1);
    const confirmation = mocks.showConfirmation.mock.calls[0][0] as {
      onConfirm: () => Promise<void>;
    };
    await act(async () => {
      await confirmation.onConfirm();
    });
    await flush();
    expect(persist).toHaveBeenCalledWith({ type: 'delete', apiKey: CURRENT });
  });
});
