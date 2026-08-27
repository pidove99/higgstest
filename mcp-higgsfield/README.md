# Higgsfield MCP 서버

Claude Code에서 힉스필드(Higgsfield) 계정으로 이미지·영상 생성을 직접 호출할 수 있게 해 주는
stdio MCP 서버입니다. API 키 관리와 인증 헤더 처리를 서버가 대신하므로, 스킬이나 대화에서는
`higgsfield_*` 도구만 부르면 됩니다.

## 1. API 키 발급

1. https://cloud.higgsfield.ai 에 힉스필드 계정으로 로그인합니다.
2. 대시보드에서 **API / API Keys** 메뉴로 이동합니다.
3. **Create key** 로 새 키를 만듭니다.
4. `KEY_ID` 와 `KEY_SECRET` 이 **생성 시 한 번만** 표시됩니다. 즉시 복사해 두세요.
   (닫고 나면 다시 볼 수 없고, 새 키를 만들어야 합니다.)

> 생성 API 호출에는 힉스필드 크레딧이 소모됩니다. 키를 만들기 전에 요금제/크레딧 잔액을 확인하세요.

## 2. 자격 증명 설정

저장소 루트에서:

```bash
cp .env.example .env
```

`.env` 에 값을 채웁니다:

```
HIGGSFIELD_API_KEY=<KEY_ID>
HIGGSFIELD_API_SECRET=<KEY_SECRET>
```

합쳐진 형태를 선호하면 이 한 줄만 써도 됩니다:

```
HIGGSFIELD_CREDENTIALS=<KEY_ID>:<KEY_SECRET>
```

`.env` 는 `.gitignore` 에 등록되어 있어 커밋되지 않습니다. 서버는 실제 환경변수를 우선하므로,
셸에서 `export` 한 값이 있으면 그쪽이 이깁니다.

## 3. 설치와 연동 확인

```bash
cd mcp-higgsfield
npm install
npm run check
```

`npm run check` 는 Claude Code를 거치지 않고 자격 증명만 검증합니다. 출력 예시:

```
✅ 연동 성공
자격 증명이 Higgsfield API에서 정상적으로 인증되었습니다.
```

## 4. Claude Code에 연결

저장소 루트의 `.mcp.json` 에 이미 등록되어 있습니다. Claude Code를 이 저장소에서 다시 열면
프로젝트 MCP 서버 승인 여부를 물어보고, 승인하면 도구가 로드됩니다.

```bash
claude
# /mcp 로 higgsfield 서버가 connected 인지 확인
```

연결 후 대화에서 `higgsfield_check_connection` 을 호출하면 연동 상태가 확인됩니다.

## 도구 목록

| 도구 | 하는 일 |
| --- | --- |
| `higgsfield_check_connection` | 설정된 키로 실제 인증이 되는지 확인. 키가 없으면 발급 방법을 안내 |
| `higgsfield_generate` | 생성 엔드포인트 호출. `wait: true` 면 완료까지 폴링 후 결과 반환 |
| `higgsfield_job_status` | 제출된 작업의 현재 상태 조회 (`wait` 로 완료까지 대기 가능) |
| `higgsfield_list_catalog` | `motions` / `soul_styles` / `soul_ids` 목록 조회 |
| `higgsfield_request` | 임의 엔드포인트를 인증 헤더만 붙여 직접 호출하는 저수준 도구 |

### 사용 예

```jsonc
// higgsfield_generate
{
  "endpoint": "/v1/text2image/soul",
  "body": { "params": { "prompt": "노을 지는 해변, 시네마틱" } },
  "wait": true
}
```

`endpoint` 는 `/v1/image2video/dop` 처럼 슬래시로 시작하는 전체 경로를 주거나,
`flux-pro/kontext/max/text-to-image` 처럼 모델 경로만 줘도 됩니다(후자는 앞에 `/v1/` 이 붙습니다).

`body` 는 **가공 없이 그대로** API로 전달됩니다. 힉스필드 문서의 요청 본문을 그대로 붙여 넣으세요.

## 알아 둘 점 — 엔드포인트 경로

이 서버를 만든 환경에서는 `docs.higgsfield.ai` 로의 아웃바운드가 프록시에 차단되어 있어,
호스트 문서로 엔드포인트를 검증하지 못했습니다. 그래서 설계를 이렇게 잡았습니다.

- **인증은 확정적입니다.** `Authorization: Key KEY_ID:KEY_SECRET` 헤더와
  `https://platform.higgsfield.ai` 베이스 URL은 공식 SDK 문서에서 확인한 값입니다.
- **생성 요청은 통과(pass-through)입니다.** 경로와 본문을 서버가 재해석하지 않으므로,
  힉스필드가 엔드포인트를 추가/변경해도 이 서버를 고칠 필요가 없습니다.
- **작업 상태와 카탈로그 경로는 후보를 순서대로 시도합니다.** 공개 SDK들이 쓰는 것으로 확인된
  `/v1/job-sets/{id}`, `/requests/{id}/status`, `/v1/status/{id}` 를 차례로 찔러 보고,
  응답한 경로를 그 세션 동안 재사용합니다.
- 어떤 도구도 맞지 않으면 `higgsfield_request` 로 어떤 경로든 직접 호출할 수 있습니다.

실제 키로 한 번 호출해 보고 나면 정확한 경로를 알 수 있으니, 그때 `src/client.mjs` 의
`JOB_STATUS_PATHS` / `CATALOG_PATHS` 후보 목록을 확정된 값 하나로 줄이면 됩니다.

## 테스트

```bash
cd mcp-higgsfield
npm test
```

가짜 Higgsfield API를 띄우고 stdio로 서버를 실제 구동해서, 핸드셰이크·도구 목록·연동 성공/실패·
작업 폴링·오류 보고를 검증합니다. 실제 힉스필드 계정이나 크레딧은 필요하지 않습니다.
