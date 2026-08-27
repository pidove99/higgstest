#!/usr/bin/env node
/**
 * Standalone connection check — run `npm run check` inside mcp-higgsfield/
 * to confirm the account is linked without going through Claude Code.
 */
import { HiggsfieldClient } from './client.mjs';
import { HiggsfieldAuthError, loadDotEnv, resolveBaseUrl } from './config.mjs';

const dotenv = loadDotEnv();
console.log(dotenv.loaded ? `.env 읽음: ${dotenv.path}` : `.env 없음 (${dotenv.path}) — 실제 환경변수만 사용합니다`);
console.log(`base URL: ${resolveBaseUrl()}\n`);

let client;
try {
  client = new HiggsfieldClient();
} catch (error) {
  if (error instanceof HiggsfieldAuthError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}

const credentials = client.describeCredentials();
console.log(`key id: ${credentials.key_id}`);
console.log(`key secret: ${credentials.key_secret}\n`);

const result = await client.checkConnection();
for (const attempt of result.attempts) {
  console.log(`  ${attempt.path} -> ${attempt.status || 'network error'} ${attempt.note ?? ''}`.trimEnd());
}
console.log('');
console.log(result.connected ? '✅ 연동 성공' : '❌ 연동 실패');
console.log(result.detail);

process.exit(result.connected ? 0 : 1);
