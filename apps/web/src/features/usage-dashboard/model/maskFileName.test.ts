import { describe, expect, it } from 'vitest';
import { maskAuthFileName } from './maskFileName';

describe('maskAuthFileName', () => {
  it('masks the local part of a provider email auth file', () => {
    expect(maskAuthFileName('claude-terence@foomail.dev.json')).toBe('claude-t\u2022\u2022\u2022@f\u2022\u2022\u2022.dev.json');
  });

  it('masks multi-part domains but keeps the TLD', () => {
    expect(maskAuthFileName('codex-user@mail.example.com.json')).toBe(
      'codex-u\u2022\u2022\u2022@m\u2022\u2022\u2022.example.com.json'
    );
  });

  it('masks account names without a domain', () => {
    expect(maskAuthFileName('kimi-primary-key.json')).toBe('kimi-p\u2022\u2022\u2022.json');
  });

  it('keeps unknown providers masked without the kind prefix', () => {
    expect(maskAuthFileName('secret-token.json')).toBe('s\u2022\u2022\u2022.json');
  });

  it('handles values without an extension', () => {
    expect(maskAuthFileName('claude-ada@lovelace.dev')).toBe('claude-a\u2022\u2022\u2022@l\u2022\u2022\u2022.dev');
  });

  it('returns a mask for empty input', () => {
    expect(maskAuthFileName('')).toBe('\u2022\u2022\u2022');
    expect(maskAuthFileName('   ')).toBe('\u2022\u2022\u2022');
  });

  it('normalizes provider casing', () => {
    expect(maskAuthFileName('Claude-ada@lovelace.dev.json')).toBe('claude-a\u2022\u2022\u2022@l\u2022\u2022\u2022.dev.json');
  });
});
