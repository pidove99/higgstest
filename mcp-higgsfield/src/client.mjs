import { maskSecret, resolveBaseUrl, resolveCredentials } from './config.mjs';

export class HiggsfieldApiError extends Error {
  constructor(message, { status, statusText, body, url, method }) {
    super(message);
    this.name = 'HiggsfieldApiError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.url = url;
    this.method = method;
  }
}

const TERMINAL_STATUSES = new Set(['completed', 'complete', 'succeeded', 'success', 'failed', 'error', 'nsfw', 'canceled', 'cancelled']);
const FAILED_STATUSES = new Set(['failed', 'error', 'nsfw', 'canceled', 'cancelled']);

/**
 * Paths the public SDKs are known to use for reading back an async job.
 * The hosted docs are not reachable from this environment, so the client
 * probes them in order and caches whichever one the account answers on.
 */
const JOB_STATUS_PATHS = [
  (id) => `/v1/job-sets/${encodeURIComponent(id)}`,
  (id) => `/requests/${encodeURIComponent(id)}/status`,
  (id) => `/v1/status/${encodeURIComponent(id)}`,
];

/** Cheap authenticated GETs used to prove the credentials are accepted. */
const PROBE_PATHS = ['/v1/motions', '/v1/soul-styles', '/v1/account', '/v1/me', '/v1/credits'];

export const CATALOG_PATHS = {
  motions: ['/v1/motions', '/v1/motion', '/motions'],
  soul_styles: ['/v1/soul-styles', '/v1/soul_styles', '/soul-styles'],
  soul_ids: ['/v1/soul-ids', '/v1/soul_ids', '/soul-ids'],
};

function isJsonContentType(contentType) {
  return typeof contentType === 'string' && contentType.toLowerCase().includes('json');
}

export class HiggsfieldClient {
  #keyId;
  #keySecret;
  #jobStatusPathIndex = null;

  constructor({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const { keyId, keySecret } = resolveCredentials(env);
    this.#keyId = keyId;
    this.#keySecret = keySecret;
    this.baseUrl = resolveBaseUrl(env);
    this.fetchImpl = fetchImpl;
    this.defaultTimeoutMs = Number(env.HIGGSFIELD_TIMEOUT_MS ?? 60_000);
  }

  /** Identity of the configured key, safe to print. */
  describeCredentials() {
    return {
      base_url: this.baseUrl,
      key_id: this.#keyId,
      key_secret: maskSecret(this.#keySecret),
    };
  }

  #authHeader() {
    return `Key ${this.#keyId}:${this.#keySecret}`;
  }

  #buildUrl(path, query) {
    const normalized = path.startsWith('http://') || path.startsWith('https://')
      ? path
      : `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    const url = new URL(normalized);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  /**
   * Perform one authenticated request. Returns the parsed response plus the
   * status, so callers can distinguish "credentials rejected" (401/403) from
   * "wrong path" (404) instead of collapsing both into one failure.
   */
  async rawRequest(method, path, { body, query, headers, timeoutMs } = {}) {
    const url = this.#buildUrl(path, query);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? this.defaultTimeoutMs);

    const requestHeaders = {
      Authorization: this.#authHeader(),
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    };

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timeout);
      const reason = cause?.name === 'AbortError'
        ? `요청이 ${timeoutMs ?? this.defaultTimeoutMs}ms 안에 끝나지 않아 중단되었습니다`
        : (cause?.message ?? String(cause));
      throw new HiggsfieldApiError(`${method} ${url.pathname} 네트워크 오류: ${reason}`, {
        status: 0,
        statusText: 'network_error',
        body: null,
        url: url.toString(),
        method,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let parsed = text;
    if (isJsonContentType(response.headers.get('content-type')) || (text.startsWith('{') || text.startsWith('['))) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: url.toString(),
      method,
      body: parsed,
    };
  }

  /** Same as rawRequest but throws on a non-2xx response. */
  async request(method, path, options = {}) {
    const result = await this.rawRequest(method, path, options);
    if (!result.ok) {
      throw new HiggsfieldApiError(
        `${method} ${path} 실패 (HTTP ${result.status} ${result.statusText})`,
        result,
      );
    }
    return result.body;
  }

  /**
   * Probe a handful of authenticated endpoints to decide whether the account is
   * actually linked. A 401/403 anywhere is conclusive: the key is wrong. A 2xx
   * anywhere is conclusive: the key works.
   */
  async checkConnection() {
    const attempts = [];

    for (const path of PROBE_PATHS) {
      let result;
      try {
        result = await this.rawRequest('GET', path, { timeoutMs: 15_000 });
      } catch (error) {
        attempts.push({ path, status: 0, note: error.message });
        continue;
      }

      attempts.push({ path, status: result.status, note: result.statusText });

      if (result.ok) {
        return {
          connected: true,
          verified_with: path,
          detail: '자격 증명이 Higgsfield API에서 정상적으로 인증되었습니다.',
          attempts,
        };
      }

      if (result.status === 401 || result.status === 403) {
        return {
          connected: false,
          verified_with: path,
          detail: `자격 증명이 거부되었습니다 (HTTP ${result.status}). KEY_ID / KEY_SECRET 값과 키가 폐기되지 않았는지 확인하세요.`,
          attempts,
        };
      }
    }

    const reachable = attempts.some((attempt) => attempt.status > 0);
    return {
      connected: false,
      verified_with: null,
      detail: reachable
        ? 'API 호스트에는 도달했지만 확인용 엔드포인트가 모두 2xx/401/403이 아닌 응답을 반환했습니다. 자격 증명이 틀렸다고 단정할 수 없습니다 — higgsfield_request 로 실제 사용할 엔드포인트를 직접 호출해 확인하세요.'
        : 'API 호스트에 전혀 도달하지 못했습니다. 네트워크/프록시가 platform.higgsfield.ai 로의 아웃바운드를 차단하고 있는지 확인하세요.',
      attempts,
    };
  }

  /** Read one job set / request by id, discovering the working status path once. */
  async getJobStatus(jobId) {
    const indexes = this.#jobStatusPathIndex === null
      ? JOB_STATUS_PATHS.map((_, index) => index)
      : [this.#jobStatusPathIndex, ...JOB_STATUS_PATHS.map((_, index) => index).filter((index) => index !== this.#jobStatusPathIndex)];

    let lastResult = null;
    for (const index of indexes) {
      const path = JOB_STATUS_PATHS[index](jobId);
      const result = await this.rawRequest('GET', path, { timeoutMs: 20_000 });
      lastResult = result;

      if (result.ok) {
        this.#jobStatusPathIndex = index;
        return { path, status: extractStatus(result.body), payload: result.body };
      }

      if (result.status === 401 || result.status === 403) {
        throw new HiggsfieldApiError(
          `작업 상태 조회가 인증에 실패했습니다 (HTTP ${result.status}). higgsfield_check_connection 으로 계정 연동을 먼저 확인하세요.`,
          result,
        );
      }
    }

    throw new HiggsfieldApiError(
      `작업 ${jobId} 의 상태를 알려진 어떤 경로에서도 조회하지 못했습니다 (마지막 응답 HTTP ${lastResult?.status}).`,
      lastResult ?? { status: 0, statusText: 'unknown', body: null, url: '', method: 'GET' },
    );
  }

  /** Poll until the job reaches a terminal status or the budget runs out. */
  async waitForJob(jobId, { intervalMs = 5_000, timeoutMs = 600_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    let last = null;

    while (Date.now() < deadline) {
      last = await this.getJobStatus(jobId);
      polls += 1;

      if (last.status && TERMINAL_STATUSES.has(last.status.toLowerCase())) {
        return {
          ...last,
          polls,
          timed_out: false,
          succeeded: !FAILED_STATUSES.has(last.status.toLowerCase()),
        };
      }

      await new Promise((resolveTimer) => setTimeout(resolveTimer, intervalMs));
    }

    return { ...(last ?? { path: null, status: null, payload: null }), polls, timed_out: true, succeeded: false };
  }

  /** Try each candidate path for a catalog listing until one answers. */
  async listCatalog(kind) {
    const candidates = CATALOG_PATHS[kind];
    if (!candidates) {
      throw new HiggsfieldApiError(`알 수 없는 카탈로그 종류: ${kind}`, {
        status: 0, statusText: 'bad_request', body: null, url: '', method: 'GET',
      });
    }

    const attempts = [];
    for (const path of candidates) {
      const result = await this.rawRequest('GET', path, { timeoutMs: 30_000 });
      attempts.push({ path, status: result.status });

      if (result.ok) return { path, items: result.body, attempts };

      if (result.status === 401 || result.status === 403) {
        throw new HiggsfieldApiError(
          `카탈로그 조회가 인증에 실패했습니다 (HTTP ${result.status}).`,
          result,
        );
      }
    }

    throw new HiggsfieldApiError(
      `${kind} 카탈로그를 후보 경로 ${candidates.join(', ')} 어디에서도 찾지 못했습니다.`,
      { status: 404, statusText: 'not_found', body: attempts, url: '', method: 'GET' },
    );
  }
}

/** Pull a status string out of the various shapes the API uses for job payloads. */
export function extractStatus(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.status === 'string') return payload.status;
  if (typeof payload.state === 'string') return payload.state;

  const jobs = Array.isArray(payload.jobs) ? payload.jobs : Array.isArray(payload.data) ? payload.data : null;
  if (!jobs || jobs.length === 0) return null;

  const statuses = jobs
    .map((job) => (typeof job?.status === 'string' ? job.status.toLowerCase() : null))
    .filter(Boolean);
  if (statuses.length === 0) return null;

  const failed = statuses.find((status) => FAILED_STATUSES.has(status));
  if (failed) return failed;

  return statuses.every((status) => TERMINAL_STATUSES.has(status)) ? 'completed' : 'in_progress';
}

export { TERMINAL_STATUSES, FAILED_STATUSES, JOB_STATUS_PATHS, PROBE_PATHS };
