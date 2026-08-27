import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HiggsfieldClient, extractStatus } from '../src/client.mjs';
import { HiggsfieldAuthError, loadDotEnv, maskSecret, resolveBaseUrl, resolveCredentials } from '../src/config.mjs';

const CREDS = { HIGGSFIELD_API_KEY: 'key_abc', HIGGSFIELD_API_SECRET: 'secret_xyz' };

/** Build a fetch stand-in from a path -> {status, body} table. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    const { pathname, search } = new URL(url);
    calls.push(pathname + search);
    const route = routes[pathname] ?? { status: 404, body: { detail: 'not found' } };
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      statusText: route.statusText ?? '',
      headers: { 'content-type': 'application/json' },
    });
  };
  impl.calls = calls;
  return impl;
}

test('resolveCredentials reads the split key/secret pair', () => {
  assert.deepEqual(resolveCredentials({ ...CREDS }), { keyId: 'key_abc', keySecret: 'secret_xyz' });
});

test('resolveCredentials reads the combined KEY_ID:KEY_SECRET form', () => {
  assert.deepEqual(
    resolveCredentials({ HIGGSFIELD_CREDENTIALS: 'key_abc:secret_xyz' }),
    { keyId: 'key_abc', keySecret: 'secret_xyz' },
  );
});

test('resolveCredentials rejects a combined value with no colon', () => {
  assert.throws(() => resolveCredentials({ HIGGSFIELD_CREDENTIALS: 'nocolon' }), HiggsfieldAuthError);
});

test('resolveCredentials explains how to issue a key when nothing is set', () => {
  assert.throws(() => resolveCredentials({}), (error) => {
    assert.ok(error instanceof HiggsfieldAuthError);
    assert.match(error.message, /cloud\.higgsfield\.ai/);
    return true;
  });
});

test('resolveBaseUrl defaults to the platform host and strips trailing slashes', () => {
  assert.equal(resolveBaseUrl({}), 'https://platform.higgsfield.ai');
  assert.equal(resolveBaseUrl({ HIGGSFIELD_BASE_URL: 'https://example.test/' }), 'https://example.test');
});

test('maskSecret never reveals the middle of a secret', () => {
  const masked = maskSecret('abcdefghijklmnop');
  assert.equal(masked, 'abcd********mnop');
  assert.ok(!masked.includes('efghij'));
});

test('loadDotEnv fills in missing keys but never overwrites the real environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hf-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, '# comment\nexport HIGGSFIELD_API_KEY="from_file"\nHIGGSFIELD_API_SECRET=file_secret\nBAD_LINE\n');

  const env = { HIGGSFIELD_API_KEY: 'from_shell' };
  const result = loadDotEnv(path, env);

  assert.equal(result.loaded, true);
  assert.equal(env.HIGGSFIELD_API_KEY, 'from_shell');
  assert.equal(env.HIGGSFIELD_API_SECRET, 'file_secret');
});

test('loadDotEnv is a no-op when the file is absent', () => {
  const result = loadDotEnv(join(tmpdir(), 'definitely-missing-hf', '.env'), {});
  assert.equal(result.loaded, false);
});

test('the Authorization header uses the Key KEY_ID:KEY_SECRET form', async () => {
  let seen = null;
  const impl = async (url, init) => {
    seen = init.headers.Authorization;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });
  await client.request('GET', '/v1/motions');

  assert.equal(seen, 'Key key_abc:secret_xyz');
});

test('checkConnection reports success on the first endpoint that answers 2xx', async () => {
  const impl = fakeFetch({ '/v1/motions': { status: 200, body: [] } });
  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });

  const result = await client.checkConnection();
  assert.equal(result.connected, true);
  assert.equal(result.verified_with, '/v1/motions');
});

test('checkConnection treats 401 as conclusive proof the key is wrong', async () => {
  const impl = fakeFetch({ '/v1/motions': { status: 401, body: { detail: 'unauthorized' } } });
  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });

  const result = await client.checkConnection();
  assert.equal(result.connected, false);
  assert.match(result.detail, /거부/);
  assert.equal(impl.calls.length, 1, '401 이후에는 다른 경로를 더 시도하지 않아야 합니다');
});

test('checkConnection stays undecided when every probe path 404s', async () => {
  const impl = fakeFetch({});
  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });

  const result = await client.checkConnection();
  assert.equal(result.connected, false);
  assert.equal(result.verified_with, null);
  assert.match(result.detail, /단정할 수 없습니다/);
});

test('checkConnection distinguishes an unreachable host from a rejected key', async () => {
  const impl = async () => { throw new TypeError('fetch failed'); };
  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });

  const result = await client.checkConnection();
  assert.equal(result.connected, false);
  assert.match(result.detail, /도달하지 못했습니다/);
});

test('getJobStatus discovers the working status path and reuses it', async () => {
  const impl = fakeFetch({
    '/requests/job_1/status': { status: 200, body: { status: 'queued' } },
    '/requests/job_2/status': { status: 200, body: { status: 'completed' } },
  });
  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });

  const first = await client.getJobStatus('job_1');
  assert.equal(first.status, 'queued');
  assert.equal(impl.calls.length, 2, '첫 조회는 /v1/job-sets 를 먼저 시도합니다');

  const second = await client.getJobStatus('job_2');
  assert.equal(second.status, 'completed');
  assert.equal(impl.calls.length, 3, '두 번째 조회는 학습된 경로로 한 번에 성공해야 합니다');
});

test('getJobStatus surfaces an auth failure instead of trying every path', async () => {
  const impl = fakeFetch({ '/v1/job-sets/job_1': { status: 403, body: { detail: 'forbidden' } } });
  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });

  await assert.rejects(client.getJobStatus('job_1'), /인증에 실패/);
});

test('waitForJob polls until the job reaches a terminal status', async () => {
  let polls = 0;
  const impl = async (url) => {
    const { pathname } = new URL(url);
    if (pathname !== '/v1/job-sets/job_1') {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    polls += 1;
    const status = polls < 3 ? 'in_progress' : 'completed';
    return new Response(JSON.stringify({ status, results: ['https://cdn.test/out.mp4'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });
  const result = await client.waitForJob('job_1', { intervalMs: 1, timeoutMs: 5_000 });

  assert.equal(result.status, 'completed');
  assert.equal(result.succeeded, true);
  assert.equal(result.timed_out, false);
  assert.equal(result.polls, 3);
});

test('waitForJob marks a nsfw/failed terminal status as unsuccessful', async () => {
  const impl = fakeFetch({ '/v1/job-sets/job_1': { status: 200, body: { status: 'nsfw' } } });
  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });

  const result = await client.waitForJob('job_1', { intervalMs: 1, timeoutMs: 5_000 });
  assert.equal(result.succeeded, false);
  assert.equal(result.timed_out, false);
});

test('waitForJob gives up with timed_out instead of hanging forever', async () => {
  const impl = fakeFetch({ '/v1/job-sets/job_1': { status: 200, body: { status: 'in_progress' } } });
  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });

  const result = await client.waitForJob('job_1', { intervalMs: 1, timeoutMs: 30 });
  assert.equal(result.timed_out, true);
  assert.equal(result.succeeded, false);
});

test('listCatalog falls through candidate paths until one answers', async () => {
  const impl = fakeFetch({ '/v1/soul_styles': { status: 200, body: [{ id: 'style_1' }] } });
  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });

  const result = await client.listCatalog('soul_styles');
  assert.equal(result.path, '/v1/soul_styles');
  assert.deepEqual(result.items, [{ id: 'style_1' }]);
});

test('rawRequest reports a timeout as a network error rather than throwing AbortError', async () => {
  const impl = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  const client = new HiggsfieldClient({ env: { ...CREDS }, fetchImpl: impl });
  await assert.rejects(client.rawRequest('GET', '/v1/motions', { timeoutMs: 20 }), /네트워크 오류/);
});

test('extractStatus understands flat, nested and per-job payload shapes', () => {
  assert.equal(extractStatus({ status: 'completed' }), 'completed');
  assert.equal(extractStatus({ state: 'queued' }), 'queued');
  assert.equal(extractStatus({ jobs: [{ status: 'completed' }, { status: 'in_progress' }] }), 'in_progress');
  assert.equal(extractStatus({ jobs: [{ status: 'completed' }, { status: 'completed' }] }), 'completed');
  assert.equal(extractStatus({ jobs: [{ status: 'completed' }, { status: 'failed' }] }), 'failed');
  assert.equal(extractStatus(null), null);
});
