import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

vi.mock('@/services/api/authFiles', () => ({
  authFilesApi: {
    list: vi.fn(async () => ({
      files: [
        {
          name: 'claude-terence@foomail.dev.json',
          provider: 'claude',
          authIndex: 'claude-01',
          disabled: false,
        },
        { name: 'codex-team-01.json', provider: 'codex', authIndex: 'codex-01', disabled: false },
        {
          name: 'zai-coding-plan.json',
          provider: 'zai',
          authIndex: 'zai-01',
          disabled: false,
        },
        { name: 'xai-team.json', provider: 'xai', authIndex: 'xai-01', disabled: false },
      ],
    })),
  },
}));

let xaiRateLimitWindows: unknown[] = [];

const apiCallResponses = new Map<string, [number, string]>();

vi.mock('@/services/api/apiCall', () => ({
  apiCallApi: {
    request: vi.fn(async (payload: { url: string }) => {
      const match = [...apiCallResponses.entries()].find(([url]) => payload.url.startsWith(url));
      if (!match) {
        return { statusCode: 404, hasStatusCode: true, header: {}, bodyText: '', body: null };
      }
      const [statusCode, bodyText] = match[1];
      return { statusCode, hasStatusCode: true, header: {}, bodyText, body: null };
    }),
  },
  getApiCallErrorMessage: () => 'request failed',
}));

vi.mock('@/services/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api/client')>();
  return {
    ...actual,
    apiClient: {
      get: vi.fn(async () => ({
        plan: 'GLM Coding Pro',
        windows: [
          {
            id: 'zai-3',
            label: '5-hour limit',
            remainingPercent: 58,
            resetAtMs: Date.now() + 90 * 60_000,
          },
          {
            id: 'zai-6',
            label: 'Weekly limit',
            remainingPercent: 89,
            resetAtMs: Date.now() + 3 * 24 * 60 * 60_000,
          },
        ],
      })),
      post: vi.fn(async () => ({ windows: xaiRateLimitWindows })),
    },
  };
});

import { UsageDashboardPage } from './UsageDashboardPage';

const iso = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();

interface RenderTextNode {
  type: '#text';
  value: string;
  children?: undefined;
}

const isTextNode = (node: unknown): node is RenderTextNode =>
  typeof node === 'object' &&
  node !== null &&
  (node as { type?: unknown }).type === '#text' &&
  typeof (node as { value?: unknown }).value === 'string';

const collectText = (node: unknown): string[] => {
  if (typeof node === 'string') return [node];
  if (isTextNode(node)) return [node.value];
  if (Array.isArray(node)) return node.flatMap((child) => collectText(child));
  if (
    typeof node === 'object' &&
    node !== null &&
    Array.isArray((node as { children?: unknown }).children)
  ) {
    return (node as { children: unknown[] }).children.flatMap((child) => collectText(child));
  }
  return [];
};

const toJson = (instance: {
  toJSON: () => ReactTestRendererJSON | ReactTestRendererJSON[] | null;
}): ReactTestRendererJSON | ReactTestRendererJSON[] =>
  (instance.toJSON() ?? []) as ReactTestRendererJSON | ReactTestRendererJSON[];

const findProviderTree = (
  nodes: ReactTestRendererJSON[],
  provider: string
): ReactTestRendererJSON | undefined => {
  for (const node of nodes) {
    const props =
      typeof node.props === 'object' && node.props !== null
        ? (node.props as Record<string, unknown>)
        : undefined;
    if (props?.['data-usage-provider'] === provider) return node;
    const children = Array.isArray(node.children)
      ? (node.children.filter((child) => typeof child === 'object') as ReactTestRendererJSON[])
      : [];
    const match = findProviderTree(children, provider);
    if (match) return match;
  }
  return undefined;
};

describe('UsageDashboardPage', () => {
  beforeEach(() => {
    xaiRateLimitWindows = [];
    apiCallResponses.clear();
    apiCallResponses.set('https://api.anthropic.com/api/oauth/usage', [
      200,
      JSON.stringify({
        five_hour: { utilization: 41.2, resets_at: iso(120) },
        seven_day: { utilization: 12.4, resets_at: iso(3 * 24 * 60) },
      }),
    ]);
    apiCallResponses.set('https://api.anthropic.com/api/oauth/profile', [
      200,
      JSON.stringify({ account: { has_claude_pro: true } }),
    ]);
    apiCallResponses.set('https://api.z.ai/api/monitor/usage/quota/limit', [
      200,
      JSON.stringify({
        data: {
          level: 'GLM Coding Pro',
          limits: [
            { unit: 3, number: 5, percentage: 42, nextResetTime: iso(90) },
            { unit: 6, number: 1, percentage: 11, nextResetTime: iso(3 * 24 * 60) },
          ],
        },
      }),
    ]);
  });

  const flush = async () => {
    for (let i = 0; i < 12; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  it('renders provider-grouped masked account rows with windows and percentages', async () => {
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(<UsageDashboardPage />);
    });
    await flush();

    const rendered = toJson(renderer!);
    const trees = Array.isArray(rendered) ? rendered : [rendered];
    const texts = trees.flatMap((tree) => collectText(tree));
    expect(texts).toContain('claude-t\u2022\u2022\u2022@f\u2022\u2022\u2022.dev.json');
    expect(texts).toContain('c\u2022\u2022\u2022.yaml');
    expect(texts).toContain('codex-t\u2022\u2022\u2022.json');
    expect(texts).toContain('5-hour limit');
    expect(texts).toContain('Weekly limit');
    expect(texts.join('')).toContain('59% remaining');
    expect(texts.join('')).toContain('58% remaining');
    // Codex upstream returns 404 -> visible error state, group still renders.
    expect(texts).toContain('Error');
    renderer!.unmount();
  });

  it('labels xAI per-model rate-limit windows without reset periods', async () => {
    xaiRateLimitWindows = [
      {
        id: 'xai-ratelimit-grok-4.7',
        label: 'grok-4.7 token rate limit',
        remainingPercent: 72,
        limitTokens: 100000,
        remainingTokens: 72000,
      },
      {
        id: 'xai-ratelimit-grok-4.3',
        label: 'grok-4.3 token rate limit',
        remainingPercent: 100,
        limitTokens: 100000,
        remainingTokens: 100000,
      },
    ];

    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(<UsageDashboardPage />);
    });
    await flush();

    const rendered = toJson(renderer!);
    const trees = Array.isArray(rendered) ? rendered : [rendered];
    const xaiTree = findProviderTree(trees, 'xai');
    expect(xaiTree).toBeDefined();
    const texts = collectText(xaiTree);
    expect(texts).toContain('grok-4.7 token rate limit');
    expect(texts).toContain('grok-4.3 token rate limit');
    expect(texts.join('')).toContain('72% remaining');
    expect(texts.join('')).toContain('100% remaining');
    // Rate-limit headers carry no 5h/weekly reset clock: no countdown may render.
    expect(texts.join('')).not.toMatch(/in \d+[dhm]/);
    renderer!.unmount();
  });

  it('renders xAI weekly usage as unavailable when the provider publishes no percent', async () => {
    apiCallResponses.set('https://cli-chat-proxy.grok.com/v1/billing?format=credits', [
      200,
      JSON.stringify({
        config: {
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
            end: new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString(),
          },
          onDemandCap: { val: 0 },
          onDemandUsed: { val: 0 },
        },
      }),
    ]);
    xaiRateLimitWindows = [
      {
        id: 'xai-ratelimit-grok-4.7',
        label: 'grok-4.7 token rate limit',
        remainingPercent: 72,
        limitTokens: 100000,
        remainingTokens: 72000,
      },
    ];

    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(<UsageDashboardPage />);
    });
    await flush();

    const rendered = toJson(renderer!);
    const trees = Array.isArray(rendered) ? rendered : [rendered];
    const xaiTree = findProviderTree(trees, 'xai');
    expect(xaiTree).toBeDefined();
    const texts = collectText(xaiTree);
    expect(texts).toContain('weekly usage');
    expect(texts).toContain('Unavailable');
    expect(texts).toContain('grok-4.7 token rate limit');
    // Exactly one percent readout: the token rate limit, never a weekly proxy.
    expect(texts.join('').match(/% remaining/g)).toHaveLength(1);
    // The unavailable window renders no meter bar.
    const unavailableNodes: ReactTestRendererJSON[] = [];
    const walk = (node: ReactTestRendererJSON): void => {
      const props =
        typeof node.props === 'object' && node.props !== null
          ? (node.props as Record<string, unknown>)
          : undefined;
      if (props?.['data-usage-unavailable'] === 'true') unavailableNodes.push(node);
      for (const child of node.children ?? []) {
        if (typeof child === 'object') walk(child);
      }
    };
    (Array.isArray(rendered) ? rendered : [rendered]).forEach(walk);
    expect(unavailableNodes).toHaveLength(1);
    expect(
      unavailableNodes[0].children?.some(
        (child) =>
          typeof child === 'object' &&
          (child as { props?: { className?: string } }).props?.className?.includes('track')
      )
    ).toBe(false);
    renderer!.unmount();
  });
});
