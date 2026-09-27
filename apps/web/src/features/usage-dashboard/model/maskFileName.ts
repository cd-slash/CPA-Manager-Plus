/**
 * Masked auth-file display names for the usage dashboard.
 *
 * Mirrors the CPAMP credential-privacy convention: the provider prefix stays
 * readable while account-local parts are truncated to their first character.
 */

const KNOWN_KINDS = new Set([
  'claude',
  'codex',
  'xai',
  'gemini',
  'aistudio',
  'qwen',
  'kimi',
  'iflow',
  'antigravity',
  'vertex',
  'devin',
  'meta',
  'zai',
]);

const MASK = '\u2022\u2022\u2022';

const maskPart = (part: string): string => (part ? `${part.slice(0, 1)}${MASK}` : MASK);

const maskDomain = (domain: string): string => {
  const bits = domain.split('.');
  if (bits.length < 2) return maskPart(domain);
  return `${maskPart(bits[0])}.${bits.slice(1).join('.')}`;
};

export const maskAuthFileName = (fileName: string): string => {
  const name = String(fileName ?? '').trim();
  if (!name) return MASK;
  const dotIndex = name.lastIndexOf('.');
  const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const extension = dotIndex > 0 ? name.slice(dotIndex) : '';

  const separator = stem.indexOf('-');
  const kind = separator > 0 ? stem.slice(0, separator).toLowerCase() : '';
  const rest = separator > 0 ? stem.slice(separator + 1) : stem;
  const knownKind = KNOWN_KINDS.has(kind);

  const local = knownKind ? rest : stem;
  const at = local.indexOf('@');
  const core =
    at > 0
      ? `${maskPart(local.slice(0, at))}@${maskDomain(local.slice(at + 1))}`
      : maskPart(local);

  return knownKind ? `${kind}-${core}${extension}` : core + extension;
};
