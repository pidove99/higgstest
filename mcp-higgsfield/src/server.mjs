#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { HiggsfieldApiError, HiggsfieldClient } from './client.mjs';
import { HiggsfieldAuthError, loadDotEnv, resolveBaseUrl } from './config.mjs';

loadDotEnv();

const server = new McpServer({
  name: 'higgsfield',
  version: '0.1.0',
});

let client = null;
let clientError = null;

try {
  client = new HiggsfieldClient();
} catch (error) {
  // Missing credentials must not kill the server: it still has to start so the
  // tools can explain how to finish linking the account.
  clientError = error;
}

function jsonResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message, extra = {}) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  };
}

/** Wrap a handler so credential and API failures come back as readable tool errors. */
function withClient(handler) {
  return async (args) => {
    if (!client) {
      return errorResult(clientError?.message ?? 'Higgsfield 클라이언트를 초기화하지 못했습니다.', {
        hint: 'higgsfield_check_connection 을 호출하면 설정 방법을 안내합니다.',
      });
    }

    try {
      return await handler(client, args);
    } catch (error) {
      if (error instanceof HiggsfieldApiError) {
        return errorResult(error.message, {
          status: error.status,
          url: error.url,
          response_body: error.body,
        });
      }
      if (error instanceof HiggsfieldAuthError) {
        return errorResult(error.message);
      }
      throw error;
    }
  };
}

server.registerTool(
  'higgsfield_check_connection',
  {
    title: 'Higgsfield 계정 연동 확인',
    description:
      '설정된 Higgsfield API 키로 실제 인증이 되는지 확인합니다. 자격 증명이 없으면 발급/설정 방법을 안내합니다. ' +
      '연동을 처음 설정했거나 인증 오류가 났을 때 가장 먼저 호출하세요.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    if (!client) {
      return jsonResult({
        connected: false,
        reason: 'missing_credentials',
        base_url: resolveBaseUrl(),
        setup: clientError?.message ?? '자격 증명이 설정되지 않았습니다.',
      });
    }

    const result = await client.checkConnection();
    return jsonResult({ ...result, credentials: client.describeCredentials() });
  },
);

server.registerTool(
  'higgsfield_generate',
  {
    title: 'Higgsfield 생성 작업 실행',
    description:
      'Higgsfield 생성 엔드포인트를 호출합니다. endpoint 는 "/v1/text2image/soul" 처럼 슬래시로 시작하는 전체 경로이거나 ' +
      '"flux-pro/kontext/max/text-to-image" 처럼 모델 경로일 수 있습니다(후자는 /v1/ 이 앞에 붙습니다). ' +
      'body 는 API에 그대로 전달되므로 문서의 요청 본문을 그대로 넣으세요(대개 {"params": {...}} 형태). ' +
      'wait 를 true 로 두면 작업이 끝날 때까지 폴링한 뒤 최종 결과를 돌려줍니다.',
    inputSchema: {
      endpoint: z.string().min(1).describe('생성 엔드포인트 경로 또는 모델 경로'),
      body: z.record(z.string(), z.unknown()).describe('API에 그대로 보낼 JSON 요청 본문'),
      wait: z.boolean().optional().describe('작업 완료까지 폴링할지 여부 (기본 true)'),
      poll_interval_ms: z.number().int().min(1000).max(60_000).optional().describe('폴링 간격 (기본 5000ms)'),
      poll_timeout_ms: z.number().int().min(10_000).max(1_800_000).optional().describe('폴링 최대 대기 시간 (기본 600000ms)'),
      webhook_url: z.string().url().optional().describe('완료 알림을 받을 웹훅 URL (선택)'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  withClient(async (hf, args) => {
    const path = args.endpoint.startsWith('/') || args.endpoint.startsWith('http')
      ? args.endpoint
      : `/v1/${args.endpoint}`;

    const submitted = await hf.request('POST', path, {
      body: args.body,
      query: args.webhook_url ? { hf_webhook: args.webhook_url } : undefined,
    });

    const jobId = extractJobId(submitted);
    const wait = args.wait ?? true;

    if (!wait || !jobId) {
      return jsonResult({
        endpoint: path,
        submitted,
        job_id: jobId,
        waited: false,
        note: jobId
          ? '작업을 제출했습니다. higgsfield_job_status 로 진행 상황을 확인하세요.'
          : '응답에서 작업 ID를 찾지 못했습니다. 응답 본문을 직접 확인하세요.',
      });
    }

    const final = await hf.waitForJob(jobId, {
      intervalMs: args.poll_interval_ms ?? 5_000,
      timeoutMs: args.poll_timeout_ms ?? 600_000,
    });

    return jsonResult({
      endpoint: path,
      job_id: jobId,
      waited: true,
      status: final.status,
      succeeded: final.succeeded,
      timed_out: final.timed_out,
      polls: final.polls,
      result: final.payload,
    });
  }),
);

server.registerTool(
  'higgsfield_job_status',
  {
    title: 'Higgsfield 작업 상태 조회',
    description:
      '제출된 Higgsfield 작업(job set / request)의 현재 상태를 조회합니다. wait 를 true 로 주면 완료될 때까지 기다립니다.',
    inputSchema: {
      job_id: z.string().min(1).describe('higgsfield_generate 가 돌려준 작업 ID'),
      wait: z.boolean().optional().describe('완료까지 폴링할지 여부 (기본 false)'),
      poll_interval_ms: z.number().int().min(1000).max(60_000).optional(),
      poll_timeout_ms: z.number().int().min(10_000).max(1_800_000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  withClient(async (hf, args) => {
    if (args.wait) {
      const final = await hf.waitForJob(args.job_id, {
        intervalMs: args.poll_interval_ms ?? 5_000,
        timeoutMs: args.poll_timeout_ms ?? 600_000,
      });
      return jsonResult({
        job_id: args.job_id,
        status: final.status,
        succeeded: final.succeeded,
        timed_out: final.timed_out,
        polls: final.polls,
        result: final.payload,
      });
    }

    const current = await hf.getJobStatus(args.job_id);
    return jsonResult({ job_id: args.job_id, status: current.status, result: current.payload });
  }),
);

server.registerTool(
  'higgsfield_list_catalog',
  {
    title: 'Higgsfield 카탈로그 조회',
    description:
      '생성 요청에 필요한 ID 목록을 가져옵니다. motions(카메라 모션), soul_styles(스타일 프리셋), soul_ids(등록한 캐릭터) 중 하나를 고르세요.',
    inputSchema: {
      kind: z.enum(['motions', 'soul_styles', 'soul_ids']).describe('조회할 카탈로그 종류'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  withClient(async (hf, args) => {
    const result = await hf.listCatalog(args.kind);
    return jsonResult({ kind: args.kind, resolved_path: result.path, items: result.items });
  }),
);

server.registerTool(
  'higgsfield_request',
  {
    title: 'Higgsfield 임의 API 호출',
    description:
      '연동된 계정으로 임의의 Higgsfield API 엔드포인트를 직접 호출합니다. 인증 헤더만 대신 붙여주는 저수준 도구로, ' +
      '다른 도구가 아직 감싸지 않은 엔드포인트를 쓸 때 사용하세요.',
    inputSchema: {
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP 메서드'),
      path: z.string().min(1).describe('API 경로 (예: /v1/motions)'),
      body: z.record(z.string(), z.unknown()).optional().describe('JSON 요청 본문 (선택)'),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('쿼리 파라미터 (선택)'),
      timeout_ms: z.number().int().min(1000).max(600_000).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  withClient(async (hf, args) => {
    const result = await hf.rawRequest(args.method, args.path, {
      body: args.body,
      query: args.query,
      timeoutMs: args.timeout_ms,
    });

    return jsonResult({
      ok: result.ok,
      status: result.status,
      status_text: result.statusText,
      url: result.url,
      body: result.body,
    });
  }),
);

/** Job identifiers show up under a few different names depending on the endpoint. */
export function extractJobId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of ['id', 'job_set_id', 'jobSetId', 'request_id', 'requestId', 'generation_id']) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
  }
  if (payload.data && typeof payload.data === 'object') return extractJobId(payload.data);
  return null;
}

const transport = new StdioServerTransport();
await server.connect(transport);
