# 적대적 검수 리포트 001

- 검수일: 2026-09-01
- 대상: `sheet_mcp` 프로젝트 전체
- 기준 리비전: `bcec6d4` (`login-flow`)
- 검수 방식: 문서·소스·테스트·설정 대조, 로컬 품질 게이트 실행, 프로덕션 의존성 보안 감사
- 변경 원칙: 검수 중 기존 소스와 설정은 변경하지 않음

## 1. 총평

T0~T2 범위의 스캐폴딩, 도메인 타입, 설정 파서, 인메모리 시트 클라이언트는 선언된 품질 게이트를 통과하며 방어적으로 구현되어 있다. 그러나 T3~T10이 아직 TODO이므로 현재 저장소는 실행 가능한 MCP 제품이 아니다. 운영 또는 사용자 대상 테스트에 투입해서는 안 된다.

핵심 위험은 다음과 같다.

1. MCP 도구, 실제 시트 연동, 발송, 멱등성, 발송 로그가 아직 구현되지 않았다.
2. 빈 필터 설정이 공백 문자열로 반환되어 향후 파이프라인에서 잘못 활성화될 수 있다.
3. 프로덕션 의존성 경로에 중간 심각도 취약점 4건이 존재한다.
4. Prettier가 완료 게이트에 포함되지 않아 `npm run check`가 포맷 품질을 보장하지 않는다.
5. README의 상태 및 퀵스타트 설명이 실제 구현 상태와 일치하지 않는다.

## 2. 발견 사항

### AR-001 — 핵심 제품 기능 미구현

- 심각도: 높음
- 근거:
  - `src/server.ts`는 MCP 서버 대신 미구현 안내 문구만 표준 출력으로 내보낸다.
  - `scripts/smoke.ts`도 미구현 안내만 출력한다.
  - `docs/TASKS.md` 기준 T3~T10이 TODO다.
- 영향:
  - `read_rows`, `preview_messages`, `send_notifications`, `get_send_log`를 호출할 수 없다.
  - Google Sheets 연동, 이메일 발송, 중복 발송 방지, 상태 기록, 발송 이력 조회가 불가능하다.
  - README의 `npm run dev`를 따라도 사용 가능한 MCP 서버가 기동되지 않는다.
- 판정: 현재 로드맵상 예정된 미구현이지만, 릴리스 준비도 관점에서는 차단 사유다.
- 권고:
  - `docs/TASKS.md`의 의존 순서에 따라 T3~T10을 완료한다.
  - T8 이후 stdio MCP 클라이언트로 프로토콜 기동을 검증한다.
  - T9의 e2e-mock과 T10의 수동 스모크가 끝나기 전에는 v0.1 완료로 표시하지 않는다.

### AR-002 — 빈 필터 설정의 의미적 정규화 누락

- 심각도: 중간
- 위치: `src/core/config.ts:68-69`, `src/core/config.ts:105-106`
- 현상:
  - 검증 단계는 공백뿐인 `filter_column`과 `filter_value`를 설정되지 않은 값으로 취급한다.
  - 반환 단계는 같은 값을 `undefined`가 아닌 원본 공백 문자열로 반환한다.
- 재현:

```ts
parseNotifyConfig({
  data_tab: "x",
  id_column: "id",
  recipient_column: "email",
  channel: "email",
  subject_template: "s",
  body_template: "b",
  filter_column: "   ",
  filter_value: "   ",
});
```

실제 반환값의 관련 부분:

```json
{ "filterColumn": "   ", "filterValue": "   " }
```

- 영향:
  - 향후 파이프라인이 `filterColumn !== undefined` 또는 truthiness 외의 방식으로 필터 활성화를 판정하면 공백 이름의 컬럼을 조회할 수 있다.
  - 모든 행이 의도치 않게 필터링되는 장애로 이어질 수 있다.
- 권고:
  - 두 선택값이 blank이면 모두 `undefined`로 정규화한다.
  - 공백 쌍 입력이 `undefined` 쌍으로 반환되는 회귀 테스트를 추가한다.
  - 필수 식별자와 탭 이름의 앞뒤 공백 처리 정책도 문서에서 명시한다.

### AR-003 — 프로덕션 의존성 취약점

- 심각도: 중간
- 검증 명령: `npm audit --omit=dev --json`
- 결과:
  - 총 4건: moderate 4, high 0, critical 0
  - 직접 의존성: `googleapis@144.0.0`
  - 관련 전이 의존성: `googleapis-common`, `gaxios`, `uuid`
  - `uuid` 관련 권고: GHSA-w5hq-g745-h8pq
  - 감사 도구가 제시한 수정은 `googleapis@178.0.0` 메이저 업그레이드다.
- 영향:
  - 현재 구현은 Google 어댑터가 없어 취약 경로의 실사용 여부가 제한적이다.
  - T3에서 `googleapis`를 실제 사용하기 시작하면 공격 표면이 확대된다.
- 권고:
  - T3 착수 전에 최신 `googleapis`로의 업그레이드 호환성을 확인한다.
  - 메이저 업그레이드 후 타입체크 및 읽기 스모크를 수행한다.
  - CI 또는 정기 점검에 프로덕션 의존성 감사를 추가한다.

### AR-004 — Prettier가 완료 게이트에서 누락됨

- 심각도: 낮음
- 위치: `package.json`의 `scripts.check`
- 현상:
  - `npm run check`는 typecheck, lint, test만 실행한다.
  - Prettier가 개발 의존성으로 설치되어 있지만 검사 스크립트와 완료 게이트에 포함되지 않았다.
- 검증 명령: `npx prettier --check .`
- 결과: 7개 파일에서 포맷 불일치
  - `docs/DESIGN.md`
  - `docs/SPEC.md`
  - `docs/TASKS.md`
  - `docs/TESTING.md`
  - `docs/WORKFLOW.md`
  - `README.md`
  - `tests/config.test.ts`
- 영향:
  - `npm run check` 통과가 저장소에서 선언한 포맷 품질을 보장하지 못한다.
  - 에이전트별 결과물의 포맷이 점진적으로 달라질 수 있다.
- 권고:
  - `format:check` 스크립트를 추가하고 `check`에 포함한다.
  - 기존 문서 포맷을 일괄 수정하기 전에 Markdown 포맷 정책을 확정한다.

### AR-005 — README와 실제 구현 상태 불일치

- 심각도: 낮음
- 위치: `README.md:25-37`
- 현상:
  - 상태는 여전히 "문서 단계 (코드 미작성)"으로 표시된다.
  - 실제로는 T0~T2 코드와 테스트가 존재한다.
  - 퀵스타트의 `npm run dev`는 정상 MCP 서버 실행처럼 보이지만 현재는 미구현 안내만 출력한다.
- 영향:
  - 신규 개발자와 에이전트가 현재 완료 범위 및 실행 가능성을 잘못 판단할 수 있다.
- 권고:
  - 상태를 "T0~T2 완료, T3 이후 미구현"으로 갱신한다.
  - T8 전까지 `npm run dev`가 플레이스홀더임을 퀵스타트에 명시한다.

## 3. 검증 결과

### 선언된 완료 게이트

`npm run check` 통과:

- TypeScript typecheck: 통과
- ESLint: 통과
- Vitest: 테스트 파일 3개 통과
- 테스트 케이스: 27개 통과, 실패 0개

### 커버리지

`npm test -- --coverage` 결과:

- `src/core/` statements: 95.12%
- branches: 94.11%
- functions: 100%
- lines: 95.12%

현재 구현된 core 범위는 `docs/SPEC.md`의 90% 목표를 넘지만, 향후 `template.ts`와 `pipeline.ts`가 추가되면 다시 측정해야 한다.

### 저장소 위생

- 검수 시작 당시 Git 작업 트리: 깨끗함
- 커밋된 `.env`: 없음
- `.gitignore`의 `.env`, `data/`, `node_modules/`, `dist/`, `coverage/`: 정상
- 대형 픽스처 수신자: RFC 2606 예약 도메인 `example.invalid` 사용

## 4. 확인된 강점

- TypeScript strict 및 `noUncheckedIndexedAccess`가 활성화되어 있다.
- 외부 입력인 config와 fixture를 zod 경계에서 검증한다.
- `InMemorySheetClient`의 읽기 결과는 복사본이어서 호출자가 내부 상태를 변조하기 어렵다.
- `writeStatus`는 배치 대상 행을 먼저 검증하여 부분 반영을 방지한다.
- 사용자 데이터 컬럼과 상태 컬럼의 책임이 분리되어 있다.
- 오류 메시지에 문제 원인과 수정 방법이 포함되어 있다.
- 1,000행 픽스처 생성이 결정론적이며 실제 이메일 도달 가능성을 차단한다.

## 5. 조치 우선순위

1. AR-002의 빈 필터 정규화 및 회귀 테스트
2. AR-003의 `googleapis` 업그레이드 검토
3. T3~T7 핵심 어댑터와 파이프라인 구현
4. T8~T10 MCP/E2E/스모크 완료
5. AR-004의 포맷 검사 게이트 추가
6. AR-005의 README 상태 갱신

## 6. 추적 규칙

- 후속 적대적 검수는 같은 디렉터리에 `ADVERSARIAL_REVIEW_002.md`, `ADVERSARIAL_REVIEW_003.md` 순서로 추가한다.
- 기존 리포트는 당시 상태의 감사 기록이므로 덮어쓰지 않는다.
- 발견 사항을 수정할 때는 해당 ID(`AR-001` 등)를 커밋 또는 태스크 설명에 연결한다.
