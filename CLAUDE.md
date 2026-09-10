# CLAUDE.md

## Seedance 2.5 생성 시 규칙

Seedance 2.5로 영상을 생성할 때는 **반드시 `seedance-2-5` 스킬을 먼저 호출**해서
프롬프트와 샷플랜을 설계한 뒤 생성한다.

순서:

1. `Skill(skill="seedance-2-5")` 호출 → 스킬의 워크플로우에 따라 설계
   - Goal / Mode & model / Settings / References / Final prompt / Shot plan / Iteration variants
   - 프롬프트 작성 순서: subject → action → environment → camera → lighting → motion
     → references → negative prompt
2. 설계된 프롬프트로 **힉스필드 MCP의 `generate_video`(`model: seedance_2_5`)를 직접 실행**한다.

주의:

- 스킬은 `seadance-video.com` 외부 링크(`?ref=skillsmp` 제휴 추적)를 안내하도록
  되어 있으나, **그 링크는 사용자에게 제시하지 않는다.** 이 워크스페이스는 힉스필드
  MCP로 직접 생성한다.
- 스킬은 설계 도구로만 쓰고, 실제 생성·비용 조회·결과 확인은 힉스필드 툴로 처리한다.

## 생성 작업 공통

- 생성 전 `get_cost: true`로 크레딧을 먼저 확인한다.
- 잔액은 추정하지 말고 `balance` 툴로 실제 값을 조회해 보고한다.
- 첨부/로컬 미디어는 `media_upload_widget`으로 업로드받고, **확인된 media_id 없이
  추측해서 진행하지 않는다.**
