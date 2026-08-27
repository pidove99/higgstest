import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'https://platform.higgsfield.ai';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..', '..');

export class HiggsfieldAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HiggsfieldAuthError';
  }
}

/**
 * Minimal .env reader so the user only has to fill in a file — no shell exports
 * needed before launching Claude Code. Values already present in the real
 * environment always win, so exported secrets are never overwritten by the file.
 */
export function loadDotEnv(envPath = resolve(PROJECT_ROOT, '.env'), env = process.env) {
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return { loaded: false, path: envPath, keys: [] };
  }

  const keys = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    keys.push(key);
    if (env[key] === undefined) env[key] = value;
  }

  return { loaded: true, path: envPath, keys };
}

const SETUP_HELP = [
  'Higgsfield 자격 증명을 찾지 못했습니다.',
  '',
  '발급 방법:',
  '  1. https://cloud.higgsfield.ai 에 로그인합니다.',
  '  2. 대시보드에서 API / API Keys 메뉴로 이동합니다.',
  '  3. 새 키를 만들면 KEY_ID 와 KEY_SECRET 이 한 번만 표시됩니다. 즉시 복사해 두세요.',
  '',
  '설정 방법 (둘 중 하나):',
  '  - 저장소 루트의 .env 파일에 기록',
  '      HIGGSFIELD_API_KEY=<KEY_ID>',
  '      HIGGSFIELD_API_SECRET=<KEY_SECRET>',
  '  - 또는 합쳐진 형태 한 줄로',
  '      HIGGSFIELD_CREDENTIALS=<KEY_ID>:<KEY_SECRET>',
  '',
  '.env 는 .gitignore 에 등록되어 있으므로 커밋되지 않습니다.',
].join('\n');

/** Resolve the key id / secret pair from the environment. */
export function resolveCredentials(env = process.env) {
  const combined = (env.HIGGSFIELD_CREDENTIALS ?? '').trim();

  let keyId = '';
  let keySecret = '';

  if (combined) {
    const sep = combined.indexOf(':');
    if (sep === -1) {
      throw new HiggsfieldAuthError(
        `HIGGSFIELD_CREDENTIALS 형식이 잘못되었습니다. "KEY_ID:KEY_SECRET" 형태여야 합니다.\n\n${SETUP_HELP}`,
      );
    }
    keyId = combined.slice(0, sep).trim();
    keySecret = combined.slice(sep + 1).trim();
  } else {
    keyId = (env.HIGGSFIELD_API_KEY ?? env.HIGGSFIELD_KEY_ID ?? '').trim();
    keySecret = (env.HIGGSFIELD_API_SECRET ?? env.HIGGSFIELD_KEY_SECRET ?? '').trim();
  }

  if (!keyId || !keySecret) throw new HiggsfieldAuthError(SETUP_HELP);

  return { keyId, keySecret };
}

export function resolveBaseUrl(env = process.env) {
  const raw = (env.HIGGSFIELD_BASE_URL ?? '').trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Never log a secret; show just enough of the key id to identify which key is in use. */
export function maskSecret(value) {
  if (!value) return '(없음)';
  if (value.length <= 8) return `${value.slice(0, 2)}${'*'.repeat(Math.max(value.length - 2, 1))}`;
  return `${value.slice(0, 4)}${'*'.repeat(8)}${value.slice(-4)}`;
}

export { SETUP_HELP };
