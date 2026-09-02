# sheet_mcp

구글 스프레드시트를 DB처럼 쓰는 필리핀 SME를 위한 **알림 자동 발송 MCP 서버**.

- 시트의 행 데이터를 읽어 템플릿에 머지하고, 수신자에게 알림을 발송한 뒤, 발송 상태를 시트에 다시 기록한다.
- **v0.1 발송 채널은 이메일.** SMS(Semaphore 등 PH 게이트웨이)는 Sender ID 등록 이슈가 정리되는 대로 v0.2에서 어댑터로 추가한다. 채널은 처음부터 `NotificationProvider` 인터페이스 뒤에 두므로 SMS 추가 시 파이프라인 코드는 바뀌지 않는다.
- MCP 자동화 코어의 공통 기능(시트 연동 → 알림 발송)을 검증하는 첫 번째 수직 절단(vertical slice)이다. 검증되면 코어에 편입한다.

## 문서 맵

> 아래 상대 경로는 저장소를 clone했거나 [GitHub 저장소](https://github.com/Trapa-Eureka/sheet_mcp)를
> 보고 있을 때만 유효하다 — `npx sheet-mcp`로 설치한 패키지에는 `docs/`가 포함되지 않는다
> (docs/ADVERSARIAL_REVIEW_004.md AR-027).

| 문서               | 내용                                                  | 읽는 시점                              |
| ------------------ | ----------------------------------------------------- | -------------------------------------- |
| `CLAUDE.md`        | 에이전트 스티어링 파일 — 스택, 명령어, 규칙, 가드레일 | 모든 에이전트 세션 시작 시 (자동 로드) |
| `docs/SPEC.md`     | 제품 스펙 — 배경, 목표/비목표, 시나리오, 로드맵       | 기능 논의·범위 판단 전                 |
| `docs/DESIGN.md`   | 기술 설계 — 아키텍처, 인터페이스, 시트 규약, MCP 도구 | 구현 전 필독                           |
| `docs/TESTING.md`  | 테스트 전략 — 목(mock) 구성, 엣지 케이스, 게이트      | 테스트 작성 전                         |
| `docs/TASKS.md`    | 태스크 백로그 — 에이전트 실행 단위, 완료 기준         | 작업 배정 시                           |
| `docs/WORKFLOW.md` | AI-native 개발 방식 — 이 레포를 굴리는 규칙           | 최초 1회 + 운영 중 참조                |

## 개발 방식

이 프로젝트는 **문서 → 에이전트 구현 → 검증** 순서로 진행한다 (`docs/WORKFLOW.md` 참조).
사람(Jin)은 스펙·설계·리뷰·실발송 승인을 맡고, 코드 작성은 Claude Code 에이전트가 `docs/TASKS.md`의 태스크 단위로 수행한다. 모든 태스크의 공통 완료 조건은 `npm run check` 통과다.

## 퀵스타트 (개발/검증)

```bash
npm install
npm run check         # typecheck + lint + format:check + test — 에이전트/사람 공통 게이트
npm run dev           # MCP 서버 stdio 실행 (.env 시크릿 필요 — 아래 "실행 절차" 참고)
```

## 실행 절차 (실제 시트/이메일로 써보기)

1. `.env.example`을 `.env`로 복사하고 `GOOGLE_SERVICE_ACCOUNT_JSON`/`RESEND_API_KEY`/`MAIL_FROM`을 채운다.
2. 아래 "예시 시트 템플릿"대로 구글시트를 만들고 서비스 계정 이메일에 편집자로 공유한 뒤, `.env`에 `SMOKE_SHEET_ID=<시트 ID>`를 넣는다.
3. `npm run smoke`로 미리보기를 확인한다 (기본값은 항상 dry-run — 실제 발송 없음).
4. 실제 발송하려면 `SEND_MODE=live SMOKE_CONFIRM_SEND=1 npm run smoke` (대상 행이 정확히 1개일 때만 발송됨).
5. Claude Code에서는 이 레포를 열고 `/mcp`로 `sheet-mcp` 연결을 확인한다 (`.mcp.json` 커밋됨, `docs/DESIGN.md` §8).

레포를 clone하지 않고 `npx sheet-mcp`로 바로 쓰는 방법도 준비 중이다(`docs/DESIGN.md` §8-B) —
이 경로에서는 `.env` 파일 대신 `claude mcp add sheet-mcp -e GOOGLE_SERVICE_ACCOUNT_JSON=<절대경로> -e RESEND_API_KEY=... -e MAIL_FROM=... -- npx -y sheet-mcp`처럼
`-e` 플래그로 환경변수를 직접 넘기는 걸 권장한다(이유는 §8-B 참고).
**단 아직 `npm publish`를 하지 않아 지금은 동작하지 않는다.** 그 전까지는 위 clone 방식만 쓸 수 있다.

## 예시 시트 템플릿

`notify_config` 탭(A열=키, B열=값)과 데이터 탭 하나로 구성한다 — 전체 키 목록/규칙은 `docs/DESIGN.md` §2.

**notify_config 탭 최소 구성**

| A                  | B                                           |
| ------------------ | ------------------------------------------- |
| `data_tab`         | `customers`                                 |
| `id_column`        | `customer_id`                               |
| `recipient_column` | `email`                                     |
| `channel`          | `email`                                     |
| `subject_template` | `[{{shop}}] 결제 안내`                      |
| `body_template`    | `{{name}}님, {{amount}} 결제 부탁드립니다.` |
| `filter_column`    | `status`                                    |
| `filter_value`     | `unpaid`                                    |

**데이터 탭**: 1행은 헤더(=템플릿 변수명), 2행부터 데이터. `fixtures/sheets/collections.json`이
실제 예시(12행, 타갈로그/영어 혼용 미수금 시나리오)다 — 같은 컬럼 구성으로 구글시트에 옮기면
스모크용으로 바로 쓸 수 있다. 발송 결과는 이 탭 끝에 `_send_status`/`_sent_at`/`_message_id`/`_error`
4개 컬럼으로 자동 기록되며, 사용자 데이터 컬럼은 절대 수정되지 않는다.

## 운영 — 기존 DB 업그레이드 / stale claim 복구

- **기존 `sendlog.db` 업그레이드**: 서버(`npm run dev`)나 스모크(`npm run smoke`)를 새 버전 코드로
  다시 실행하면 `SqliteSendLog`가 기존 DB 스키마를 자동 감지해 무손실로 새 스키마로 마이그레이션한다
  (원본은 `send_log_v1_backup_*` 테이블로 보존). 사람이 따로 할 일은 없다. 상세 동작은
  `docs/DESIGN.md` §6.
- **claim이 오래 걸려 있을 때(정상 종료 없이 프로세스가 죽은 경우 등)**: 절대 DB 파일을 직접
  손대지 말고 먼저 조회한다 — 레포 clone 개발 환경이면
  `npm run recover:stale-claim -- --db ./data/sendlog.db --sheet-id <id> --tab <tab> --row-key <key> --template-hash <hash>`,
  `npx sheet-mcp`로 설치했다면 `npx sheet-mcp-recover --db ... --sheet-id ... --tab ... --row-key ... --template-hash ...`
  (같은 인자, 기본은 읽기 전용이라 아무 것도 지우지 않음). 회수하려면 `--older-than-ms`와
  `--confirm`을 추가한다. 자세한 옵션과 안전장치는 `src/cli/recoverStaleClaim.ts` 상단 주석과
  `docs/DESIGN.md` §6을 참고.

## 상태

진행 상태는 여기 수동으로 적지 않는다 — `docs/TASKS.md`의 각 태스크 상태(`DONE(날짜)`/`TODO`)가
유일한 진실의 원천이다. README에 별도로 적으면 다음 태스크 완료 시 갱신을 잊고 뒤처지기 쉽다
(`docs/ADVERSARIAL_REVIEW_002.md` AR-010).

MCP 도구까지 전부 동작하는 실행 가능한 제품인지는 T8~T10이 `DONE`인지로 판단한다.
