import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

/** A stand-in Higgsfield API so the stdio server can be driven end to end. */
function startFakeApi() {
  const requests = [];

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw });

      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.headers.authorization !== 'Key key_abc:secret_xyz') return send(401, { detail: 'unauthorized' });
      if (req.method === 'GET' && req.url.startsWith('/v1/motions')) return send(200, [{ id: 'motion_1' }]);
      if (req.method === 'POST' && req.url.startsWith('/v1/text2image/soul')) return send(200, { id: 'job_1' });
      if (req.method === 'GET' && req.url === '/v1/job-sets/job_1') {
        return send(200, { status: 'completed', results: [{ url: 'https://cdn.test/out.png' }] });
      }
      return send(404, { detail: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, port: server.address().port });
    });
  });
}

/** Minimal newline-delimited JSON-RPC client for the stdio transport. */
function connect(env) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buffer = '';
  let stderr = '';

  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      const message = JSON.parse(line);
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });

  let nextId = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} 응답이 오지 않았습니다. stderr:\n${stderr}`));
    }, 15_000).unref();
  });

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  return { child, send, notify, getStderr: () => stderr };
}

async function handshake(env) {
  const client = connect(env);
  const initialized = await client.send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-harness', version: '0.0.0' },
  });
  client.notify('notifications/initialized', {});
  return { client, initialized };
}

function parseToolResult(response) {
  assert.ok(response.result, `툴 호출이 실패했습니다: ${JSON.stringify(response.error)}`);
  return JSON.parse(response.result.content[0].text);
}

let api;

before(async () => { api = await startFakeApi(); });
after(() => { api.server.close(); });

test('서버가 핸드셰이크하고 계정 연동 도구들을 노출한다', async (t) => {
  const { client, initialized } = await handshake({
    HIGGSFIELD_API_KEY: 'key_abc',
    HIGGSFIELD_API_SECRET: 'secret_xyz',
    HIGGSFIELD_BASE_URL: `http://127.0.0.1:${api.port}`,
  });
  t.after(() => client.child.kill());

  assert.equal(initialized.result.serverInfo.name, 'higgsfield');

  const tools = await client.send('tools/list', {});
  const names = tools.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'higgsfield_check_connection',
    'higgsfield_generate',
    'higgsfield_job_status',
    'higgsfield_list_catalog',
    'higgsfield_request',
  ]);
});

test('higgsfield_check_connection 이 올바른 키로 연동 성공을 보고한다', async (t) => {
  const { client } = await handshake({
    HIGGSFIELD_API_KEY: 'key_abc',
    HIGGSFIELD_API_SECRET: 'secret_xyz',
    HIGGSFIELD_BASE_URL: `http://127.0.0.1:${api.port}`,
  });
  t.after(() => client.child.kill());

  const result = parseToolResult(await client.send('tools/call', {
    name: 'higgsfield_check_connection',
    arguments: {},
  }));

  assert.equal(result.connected, true);
  assert.equal(result.verified_with, '/v1/motions');
  assert.equal(result.credentials.key_id, 'key_abc');
  assert.ok(!JSON.stringify(result).includes('secret_xyz'), '시크릿 원문이 응답에 노출되면 안 됩니다');
});

test('잘못된 키로는 연동 실패를 보고한다', async (t) => {
  const { client } = await handshake({
    HIGGSFIELD_API_KEY: 'key_abc',
    HIGGSFIELD_API_SECRET: 'wrong',
    HIGGSFIELD_BASE_URL: `http://127.0.0.1:${api.port}`,
  });
  t.after(() => client.child.kill());

  const result = parseToolResult(await client.send('tools/call', {
    name: 'higgsfield_check_connection',
    arguments: {},
  }));

  assert.equal(result.connected, false);
  assert.match(result.detail, /거부/);
});

test('자격 증명이 없어도 서버는 뜨고 발급 방법을 안내한다', async (t) => {
  const { client } = await handshake({
    HIGGSFIELD_API_KEY: '',
    HIGGSFIELD_API_SECRET: '',
    HIGGSFIELD_CREDENTIALS: '',
    HIGGSFIELD_BASE_URL: `http://127.0.0.1:${api.port}`,
  });
  t.after(() => client.child.kill());

  const result = parseToolResult(await client.send('tools/call', {
    name: 'higgsfield_check_connection',
    arguments: {},
  }));

  assert.equal(result.connected, false);
  assert.equal(result.reason, 'missing_credentials');
  assert.match(result.setup, /cloud\.higgsfield\.ai/);
});

test('higgsfield_generate 가 작업을 제출하고 완료까지 폴링한다', async (t) => {
  const { client } = await handshake({
    HIGGSFIELD_API_KEY: 'key_abc',
    HIGGSFIELD_API_SECRET: 'secret_xyz',
    HIGGSFIELD_BASE_URL: `http://127.0.0.1:${api.port}`,
  });
  t.after(() => client.child.kill());

  const result = parseToolResult(await client.send('tools/call', {
    name: 'higgsfield_generate',
    arguments: {
      endpoint: '/v1/text2image/soul',
      body: { params: { prompt: '노을 지는 해변' } },
      wait: true,
      poll_interval_ms: 1000,
      poll_timeout_ms: 15_000,
    },
  }));

  assert.equal(result.job_id, 'job_1');
  assert.equal(result.status, 'completed');
  assert.equal(result.succeeded, true);

  const submitted = api.requests.find((request) => request.method === 'POST');
  assert.equal(JSON.parse(submitted.body).params.prompt, '노을 지는 해변', '요청 본문은 그대로 전달되어야 합니다');
});

test('엔드포인트를 모델 경로로 주면 /v1/ 이 앞에 붙는다', async (t) => {
  const { client } = await handshake({
    HIGGSFIELD_API_KEY: 'key_abc',
    HIGGSFIELD_API_SECRET: 'secret_xyz',
    HIGGSFIELD_BASE_URL: `http://127.0.0.1:${api.port}`,
  });
  t.after(() => client.child.kill());

  const result = parseToolResult(await client.send('tools/call', {
    name: 'higgsfield_generate',
    arguments: { endpoint: 'text2image/soul', body: { params: {} }, wait: false },
  }));

  assert.equal(result.endpoint, '/v1/text2image/soul');
});

test('higgsfield_request 는 인증 헤더만 붙여 임의 경로를 호출한다', async (t) => {
  const { client } = await handshake({
    HIGGSFIELD_API_KEY: 'key_abc',
    HIGGSFIELD_API_SECRET: 'secret_xyz',
    HIGGSFIELD_BASE_URL: `http://127.0.0.1:${api.port}`,
  });
  t.after(() => client.child.kill());

  const result = parseToolResult(await client.send('tools/call', {
    name: 'higgsfield_request',
    arguments: { method: 'GET', path: '/v1/motions' },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, [{ id: 'motion_1' }]);
});

test('알 수 없는 경로는 HTTP 상태와 함께 오류로 보고된다', async (t) => {
  const { client } = await handshake({
    HIGGSFIELD_API_KEY: 'key_abc',
    HIGGSFIELD_API_SECRET: 'secret_xyz',
    HIGGSFIELD_BASE_URL: `http://127.0.0.1:${api.port}`,
  });
  t.after(() => client.child.kill());

  const response = await client.send('tools/call', {
    name: 'higgsfield_generate',
    arguments: { endpoint: '/v1/nope', body: {}, wait: false },
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /HTTP 404/);
});
