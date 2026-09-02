# 적대적 검수 리포트 004 — npm publish 최종 검수

- 검수일: 2026-09-02
- 대상: 전체 소스·테스트·문서·빌드·npm 배포 산출물
- 기준 리비전: `be2b38f` (`T13: 설치 방식 문서 갱신 (npx sheet-mcp)`)
- 이전 최종 현황: `docs/ADVERSARIAL_REVIEW_003_STATUS.md` 및 후속 STATUS GAPS 문서
- 검수 방식: 코드 전수 정적 검토, 문서/구현 대조, 품질 게이트·커버리지·보안 감사, 시크릿 탐색, `npm pack`/`npm publish --dry-run`, 공개 레지스트리 이름 조회
- 변경 원칙: 제품 코드와 기존 문서는 변경하지 않고 이 감사 기록만 신규 생성

## 1. 최종 판정

**현재 리비전을 npm에 publish해서는 안 된다.**

코어 기능의 자동 검증 상태는 양호하다. 정상 로컬 IPC 권한에서 175개 테스트가 모두 통과했고 코어 라인 커버리지는 93.36%, 프로덕션 의존성 취약점은 0건이다. tarball에는 저장소 시크릿·테스트·감사 문서가 포함되지 않았고 크기도 작다. `npx` 심볼릭 링크 진입점 회귀 테스트도 통과한다.

그러나 공개 패키지 계약과 운영 안정성에서 릴리스 차단 결함이 확인됐다.

1. 공개 tarball에는 stale-claim 복구 스크립트가 없지만 package.json과 README는 그 명령을 제공한다고 선언한다.
2. 공개 사용 권한을 정의하는 LICENSE가 없다.
3. `npm publish --dry-run`이 `bin` 경로를 자동 교정하는 경고를 내므로 배포 메타데이터가 정규화되지 않았다.
4. preview/live 파이프라인은 데이터 탭 전체를 메모리에 적재·응답하며 행 수 상한이 없다.
5. Google/Resend 외부 호출에 timeout이 없어 단일 요청이 배치와 claim을 장시간 고정할 수 있다.
6. 실제 Google Sheet+Resend 수동 스모크는 여전히 PENDING이다.

명시적인 영구 객체 보유 형태의 메모리 누수는 확인되지 않았다. 대신 입력 크기와 외부 요청 시간이 무제한인 비한정 자원 사용 위험이 존재한다.

## 2. 배포 차단 발견 사항

### AR-019 — 공개 패키지의 npm 스크립트가 존재하지 않는 파일·devDependency를 참조함

- 심각도: 높음(배포 차단)
- 위치:
  - `package.json`의 `dev`, `smoke`, `recover:stale-claim`, `check`, `build` 스크립트
  - `package.json`의 `files`
  - `README.md:66-76`
- tarball 근거:
  - 포함 대상은 `dist/`, `.env.example`, README, package.json뿐이다.
  - `scripts/recoverStaleClaim.ts`, `scripts/smoke.ts`, `src/`, `tests/`, tsconfig 파일은 포함되지 않는다.
  - `tsx`, TypeScript, Vitest, ESLint는 devDependencies라 일반 소비자의 설치 의존성으로 설치되지 않는다.
- 현상:
  - 공개 패키지에서 `npm run recover:stale-claim`은 `tsx scripts/recoverStaleClaim.ts`를 실행하려 하지만 둘 다 없다.
  - `npm run smoke`와 `npm run dev`도 같은 이유로 깨진다.
  - `npm run check`/`build` 역시 테스트·src·tsconfig·개발 도구가 없어 실행할 수 없다.
  - 특히 README는 stale claim 복구를 공식 운영 절차로 안내하므로 단순한 개발 편의 문제가 아니다.
- 영향:
  - npx 사용자가 프로세스 중단이나 release 실패로 남은 claim을 공식 절차대로 복구할 수 없다.
  - 장애 시 행이 영구적으로 `skipped_duplicate`에 머물 수 있다.
  - package.json이 제공한다고 선언한 명령과 실제 설치물이 다르므로 공개 패키지 계약이 깨진다.
- 권고:
  1. 복구 스크립트를 TypeScript 빌드 대상에 포함해 `dist/recoverStaleClaim.js`로 배포한다.
  2. 별도 bin(예: `sheet-mcp-recover`) 또는 순수 Node 기반 npm script로 노출한다.
  3. 사람 전용 dry-run/confirm/감사 로그 안전장치를 배포판에서도 동일하게 유지한다.
  4. 공개 패키지에서 지원하지 않을 개발 전용 scripts는 배포 package.json에서 제거하거나 별도 publish manifest를 사용한다.
  5. 실제 tarball을 새 임시 디렉터리에 설치한 뒤 서버 bin과 복구 bin을 각각 검증한다.
- 완전 해소 기준:
  - tarball 설치 환경에서 `sheet-mcp`와 복구 명령이 devDependencies 없이 실행된다.
  - 복구 명령 기본 실행은 read-only이고 confirm 없이는 DB를 변경하지 않는다.
  - package.json에 남은 모든 사용자 공개 scripts가 실제 설치물에서 동작한다.

### AR-020 — LICENSE 부재로 공개 사용·수정·배포 권한이 정의되지 않음

- 심각도: 높음(공개 배포 차단)
- 위치: 저장소 루트 및 `package.json`
- 현상:
  - `LICENSE`/`LICENSE.md` 파일이 없다.
  - package.json에 `license` 필드도 없다.
  - npm tarball에도 라이선스 문서가 포함되지 않는다.
- 영향:
  - 공개 npm에 내려받을 수 있다고 해서 사용·복제·수정·재배포 권한이 자동으로 부여되는 것은 아니다.
  - 소비자와 조직의 법무/보안 검토가 패키지를 거부할 수 있다.
  - 프로젝트가 오픈소스를 의도했다면 그 의도가 법적으로 표현되지 않는다.
- 권고:
  - 권리자가 MIT, Apache-2.0 또는 원하는 정책을 명시적으로 결정한다.
  - SPDX 식별자를 `package.json.license`에 넣고 일치하는 LICENSE 원문을 루트에 추가한다.
  - `npm pack --dry-run`에서 LICENSE가 자동 포함되는지 확인한다.
- 완전 해소 기준:
  - 권리자의 명시적 선택을 받은 라이선스가 package.json과 LICENSE에 일치한다.
  - 최종 tarball에 LICENSE가 포함된다.

### AR-021 — npm publish가 `bin` 메타데이터를 자동 교정함

- 심각도: 중간(배포 전 수정 필수)
- 위치: `package.json`의 `bin.sheet-mcp`
- 재현 명령: `npm publish --dry-run --json`
- 실제 경고:

```text
npm auto-corrected some errors in your package.json
"bin[sheet-mcp]" script name dist/server.js was invalid and removed
```

- 추가 확인:
  - `npm pkg fix`는 `./dist/server.js`를 `dist/server.js`로 정규화했다.
  - 현재 tarball의 `dist/server.js` 파일 모드는 0644이며 shebang은 빌드 후 존재한다.
  - 이전 로컬 설치 검증에서는 npm이 만든 bin 링크로 실행됐지만, publish 과정의 자동 수정에 의존해서는 최종 manifest를 예측하기 어렵다.
- 영향:
  - npm 버전별 정규화 차이로 실제 공개 패키지의 bin 등록이 의도와 다를 수 있다.
  - "publish만 누르면 되는 상태"라는 T12 판정과 충돌한다.
- 권고:
  - `npm pkg fix`가 제시한 정규형(`dist/server.js`)을 소스 package.json에 직접 반영한다.
  - postbuild에서 shebang뿐 아니라 실행 권한도 명시적으로 보장하는 방안을 검토한다.
  - 수정 후 publish dry-run에서 자동 교정 경고가 0건인지 확인한다.
  - dry-run 결과 manifest 또는 실제 tarball 설치 후 `.bin/sheet-mcp` 실행을 재검증한다.
- 완전 해소 기준:
  - `npm publish --dry-run`에 package.json 자동 교정 경고가 없다.
  - 새 임시 설치 환경에서 `npx --package=<tarball> sheet-mcp`가 기대한 fail-fast 또는 MCP 기동까지 도달한다.

## 3. 운영 안정성 발견 사항

### AR-022 — preview/send가 전체 데이터 탭과 전체 상세 결과를 무제한 메모리에 적재함

- 심각도: 중간
- 위치:
  - `src/adapters/googleSheetClient.ts:177-195`
  - `src/core/pipeline.ts:122-167`
  - `src/server.ts:64-110`
- 현상:
  - GoogleSheetClient `readRows()`는 탭 전체 범위를 한 번에 가져와 모든 행을 객체로 변환한다.
  - `preview_messages`와 `send_notifications`는 필터 결과 전부에 대해 workingRows와 details를 만든다.
  - 각 detail에는 수신자, 렌더된 제목, 본문, 오류가 포함된다.
  - 응답은 동일 payload를 JSON 문자열 `content`와 `structuredContent`로 함께 구성해 큰 데이터가 중복 상주할 수 있다.
  - `read_rows`만 반환 행을 200개로 자르며, 실제 Google API 읽기 자체와 preview/send에는 상한이 없다.
- 영향:
  - 대형 또는 실수로 전체 열이 사용된 시트에서 메모리 급증, 긴 GC 정지, MCP 메시지 크기 초과, 프로세스 OOM이 발생할 수 있다.
  - 이는 전형적인 영구 메모리 누수는 아니지만 호출 입력에 비례해 제한 없이 증가하는 자원 고갈 경로다.
  - live에서는 매우 많은 고객에게 한 번에 발송하는 운영 사고로도 이어진다.
- 권고:
  1. config 또는 도구 입력에 명시적 `maxRows`를 두고 보수적인 기본/절대 상한을 강제한다.
  2. live 발송은 preview에서 생성된 batch token 또는 예상 행 수 재확인을 요구한다.
  3. 시트를 페이지/범위 단위로 읽고 처리하며 write-back도 chunk한다.
  4. MCP 응답 details는 상한을 두고 total/truncated를 반환한다.
  5. 대용량 테스트에서 peak RSS와 응답 크기를 측정한다.
- 완전 해소 기준:
  - 구성된 최대 행 수를 넘으면 발송 전 안전하게 중단된다.
  - preview/send 응답이 일정 크기 이상 커지지 않는다.
  - 대형 시트 처리에서 메모리 상한과 chunk 동작이 테스트된다.

### AR-023 — Google/Resend 외부 요청에 timeout·취소가 없음

- 심각도: 중간
- 위치:
  - `src/adapters/resendProvider.ts:56-79`
  - `src/adapters/googleSheetClient.ts`의 API 호출 전체
- 현상:
  - Resend fetch에 `AbortSignal` 또는 timeout이 없다.
  - Google API 호출에도 명시적 timeout/abort 정책이 없다.
  - 파이프라인은 행을 순차 발송하므로 한 행의 요청이 끝나지 않으면 뒤 행 전체가 진행되지 않는다.
  - claim은 Provider 호출 전에 만들어지므로 강제 종료까지 해당 행은 claimed 상태로 남는다.
- 영향:
  - 네트워크 half-open, DNS/TLS 지연, SDK 내부 장기 재시도에서 MCP 호출이 무기한 또는 지나치게 오래 대기할 수 있다.
  - 장수 요청과 pending Promise는 메모리·소켓을 계속 점유하고 운영자가 stale claim 복구를 수행해야 할 수 있다.
- 권고:
  - Resend fetch에 `AbortSignal.timeout()` 또는 주입 가능한 timeout을 추가한다.
  - Google client 요청에도 일관된 timeout을 설정한다.
  - timeout을 행 단위 failed로 분류하고 안전하게 claim release하되, Provider가 실제 처리했을 가능성이 있는 애매한 timeout은 `delivery_unknown` 정책을 별도로 검토한다.
  - 서버 종료 시 진행 중 요청을 취소할 수 있는 수명주기를 설계한다.
- 완전 해소 기준:
  - never-resolving mock fetch/API 테스트가 제한 시간 안에 끝난다.
  - 뒤 행이 계속 처리되거나 명시된 배치 중단 정책을 따른다.
  - timeout 후 재발송 안전 정책이 문서화된다.

### AR-024 — 실제 Google Sheet+Resend 수동 스모크 미완료

- 심각도: 중간(릴리스 완료 판정 차단)
- 위치: `docs/TASKS.md` T10, `docs/SPEC.md` §5
- 현상:
  - T10 상태가 `CODE DONE / MANUAL SMOKE PENDING`이다.
  - 실제 Google 권한, Resend 도메인/API, 실제 메일 수신, 시트 write-back, 두 번째 실행 중복 차단은 검증되지 않았다.
- 영향:
  - 로컬 mock/계약 테스트가 잡지 못하는 실제 API·권한·요금제·도메인 문제가 최초 npm 사용자에게 노출될 수 있다.
- 권고 및 완료 기준:
  - 기존 STATUS-GAP-005의 7단계 실제 스모크를 수행하고 시크릿 없는 감사 증거를 남긴 뒤 publish한다.

## 4. 배포 품질 개선 사항

### AR-025 — 공개 패키지 메타데이터가 지나치게 빈약함

- 심각도: 낮음
- 위치: `package.json`
- 누락 항목:
  - `description`
  - `keywords`
  - `repository`
  - `homepage`
  - `bugs`
  - `author` 또는 maintainers 정책
  - `license`(AR-020은 별도 차단 항목)
- 영향:
  - npm 검색·신뢰·이슈 보고·소스 검증이 어렵다.
  - 사용자가 공식 저장소와 유지보수 주체를 확인하기 어렵다.
- 권고:
  - 실제 공개 저장소 URL과 유지보수 정보를 권리자가 확정한 뒤 채운다.

### AR-026 — tarball에 런타임에서 사용하지 않는 mocks가 포함됨

- 심각도: 낮음
- 위치: `tsconfig.build.json`, package.json `files`
- 현상:
  - `src` 전체를 컴파일해 `dist/mocks/*` 네 파일도 공개 tarball에 포함한다.
  - 서버 런타임은 이 파일들을 import하지 않는다.
- 영향:
  - 현재 약 16KB 수준이라 성능 영향은 작다.
  - 공개 API가 아닌 테스트 도구가 배포 표면에 포함돼 지원 범위가 모호해진다.
- 권고:
  - 빌드 include 또는 publish files를 런타임 모듈로 좁히거나, mocks를 공식 export할 의도가 있다면 exports와 지원 정책을 명시한다.

### AR-027 — 배포 README가 tarball에 없는 저장소 문서를 링크함

- 심각도: 낮음
- 위치: `README.md` 문서 맵 및 운영 안내
- 현상:
  - npm tarball에는 docs 디렉터리가 없지만 README는 `docs/DESIGN.md`, `docs/SPEC.md`, `docs/TASKS.md` 등 상대 경로를 안내한다.
- 영향:
  - npm 패키지 페이지나 설치 디렉터리에서 링크가 깨지거나 내용을 찾을 수 없다.
- 권고:
  - 공개 저장소 절대 URL로 링크하거나 사용자용 필수 문서만 tarball에 포함한다.

## 5. 검증 결과

### 자동 품질 게이트

정상 로컬 IPC 권한에서 `npm run check`:

- TypeScript typecheck: 통과
- ESLint: 통과
- Prettier: 통과
- Vitest: 14개 테스트 파일, 175개 테스트 통과

제한 샌드박스에서는 `tsx`가 Unix socket을 만들지 못해 e2e/심볼릭 링크 테스트가 `EPERM`으로 실패했으나 정상 권한 재실행에서 전부 통과했다. 제품 결함이 아닌 검수 환경 제약이다.

### 커버리지

`npm run test:coverage`:

| 범위 | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `src/core/**` 전체 | 93.36% | 83.01% | 100% | 93.36% |
| `pipeline.ts` | 91.63% | 77.63% | 100% | 91.63% |

라인 목표 90%는 충족한다. 다만 adapter, entrypoint, recovery script는 커버리지 집계 대상이 아니다.

### 프로덕션 의존성 보안

`npm audit --omit=dev --json`:

- 취약점: 0
- 프로덕션 의존성: 190
- high/critical: 0

### npm 배포 산출물

`npm pack --dry-run --json`:

- tarball: `sheet-mcp-0.1.0.tgz`
- 압축 크기: 30,525 bytes
- 해제 크기: 94,252 bytes
- 파일 수: 19
- 포함: README, `.env.example`, package.json, `dist/**`
- 제외 확인: src, tests, docs 감사 문서, fixtures, 실제 `.env`, 서비스 계정 키
- 시크릿 패턴 탐색: 실제 키/개인키 파일 발견 없음

`npm publish --dry-run --json`:

- prepublishOnly → check → build → prepack → build 실행
- 실제 publish는 수행하지 않음
- package.json bin 자동 교정 경고 발생(AR-021)
- npm 로그인 필요 안내는 dry-run의 정상 동작

### 공개 이름 조회

`npm view sheet-mcp ...` 결과는 2026-09-02 기준 404였다. 현재 공개 패키지가 조회되지 않았다는 뜻이지만, 실제 publish 시점까지 이름 사용 가능성을 보장하지는 않는다.

## 6. 메모리·자원 누수 판정

- 확인되지 않음:
  - 요청 결과를 전역 배열/Map에 영구 축적하는 프로덕션 코드
  - 호출마다 프로세스 이벤트 리스너를 추가하는 경로(main은 1회)
  - 정상 종료에서 SQLite 핸들이 닫히지 않는 경로
- 잔여 위험:
  - AR-022의 무제한 행/응답 메모리
  - AR-023의 무제한 외부 요청 대기 및 소켓/Promise 점유
  - SendLog 자체는 pagination과 limit이 있어 단일 조회 메모리가 제한됨
- 결론: 전형적인 누수는 재현되지 않았지만 비한정 자원 사용 때문에 장기 운영 안정성을 보장할 수 없다.

## 7. publish 전 필수 조치 순서

1. AR-019: 배포판에서 서버·복구 명령 계약을 실제 tarball과 일치시킨다.
2. AR-020: 권리자가 라이선스를 결정하고 LICENSE/package.json에 반영한다.
3. AR-021: npm manifest 정규화 후 publish dry-run 경고를 제거한다.
4. AR-022: live/preview 최대 행 수와 응답 상한을 추가한다.
5. AR-023: 외부 요청 timeout 및 불확실 발송 정책을 추가한다.
6. AR-024: 실제 Google Sheet+Resend 스모크를 완료한다.
7. AR-025~027: 공개 메타데이터·문서 링크·불필요 배포 파일을 정리한다.
8. 최종 tarball을 빈 임시 프로젝트에 설치해 `npx sheet-mcp`와 복구 명령을 검증한다.
9. `npm publish --dry-run`과 `npm audit --omit=dev`를 다시 실행한다.
10. 그 뒤에만 별도의 명시적 사용자 승인으로 실제 `npm publish`를 수행한다.

## 8. 추적 규칙

- 다음 검수/해소 기록은 기존 감사 문서를 덮어쓰지 않고 별도 파일로 추가한다.
- 수정 커밋과 테스트 이름에 AR-019~027을 연결한다.
- AR-019~024가 해소되기 전에는 npm publish 준비 완료로 표시하지 않는다.
- 실제 `npm publish`는 공개 상태 변경이므로 이 문서 작성이나 코드 수정 권한에 포함되지 않는다.
