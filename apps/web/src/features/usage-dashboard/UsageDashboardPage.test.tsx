import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  act,
  create,
  type ReactTestRendererJSON,
} from 'react-test-renderer';

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
      ],
    })),
  },
}));

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

import { UsageDashboardPage } from './UsageDashboardPage';

const iso = (offsetMinutes: number) =>
  new Date(Date.now() + offsetMinutes * 60_000).toISOString();

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
  if (typeof node === 'object' && node !== null && Array.isArray((node as { children?: unknown }).children)) {
    return ((node as { children: unknown[] }).children).flatMap((child) => collectText(child));
  }
  return [];
};

const toJson = (instance: { toJSON: () => ReactTestRendererJSON | ReactTestRendererJSON[] | null }):
  | ReactTestRendererJSON
  | ReactTestRendererJSON[] =>
  (instance.toJSON() ?? []) as ReactTestRendererJSON | ReactTestRendererJSON[];

describe('UsageDashboardPage', () => {
  beforeEach(() => {
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
    expect(texts).toContain('zai-c\u2022\u2022\u2022.json');
    expect(texts).toContain('codex-t\u2022\u2022\u2022.json');
    expect(texts).toContain('5-hour limit');
    expect(texts).toContain('Weekly limit');
    expect(texts).toContain('41%');
    expect(texts).toContain('42%');
    // Codex upstream returns 404 -> visible error state, group still renders.
    expect(texts).toContain('Error');
    renderer!.unmount();
  });
});
