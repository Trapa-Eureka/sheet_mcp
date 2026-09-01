# TESTING — sheet_mcp

목적: 에이전트가 라이브 클라우드 없이 **로컬에서 결정론적으로** 자기 변경을 검증할 수 있게 한다 (Shift Testing Left). 테스트가 곧 에이전트의 피드백 루프다.

## 1. 원칙

- 테스트에서 **네트워크 호출 0건**. 구글시트도, 이메일 API도 목으로만.
- 결정론: 시간은 `FixedClock`, 랜덤 없음, 픽스처 고정.
- 빠를 것: 전체 스위트 수 초 내. 느린 테스트는 에이전트 반복 속도를 죽인다.
- `npm run check` = typecheck + lint + test. 모든 태스크의 완료 게이트.

## 2. 목(mock) 구성 — src/mocks/

| 목 | 역할 |
|---|---|
| `InMemorySheetClient` | `fixtures/sheets/*.json`을 로드해 SheetClient 구현. `writeStatus` 결과를 메모리에 반영해 재조회 검증 가능 |
| `MockNotificationProvider` | 보낸 메시지를 배열에 기록. `failFor: rowKey[]` 옵션으로 특정 행 실패 주입 |
| `InMemorySendLog` | SendLog 인메모리 구현 (SQLite 어댑터는 별도 단위 테스트) |
| `FixedClock` | `now()`가 고정 시각 반환 |

픽스처 예: `fixtures/sheets/collections.json` — 미수금 시나리오(SPEC §4-3), 타갈로그/영어 혼용 값 포함.

## 3. 테스트 레이어

1. **unit** — `core/template`, `core/config`(zod 파싱·에러 메시지), templateHash, 멱등성 판정
2. **component** — `SendPipeline`을 목 4종으로 조립해 전체 흐름 검증 (아래 체크리스트가 여기 산다)
3. **e2e-mock** — MCP 서버를 stdio로 띄우고 SDK 클라이언트로 도구 4종 호출 (T9)
4. **manual smoke** — `npm run smoke` (`scripts/smoke.ts`): 실제 시트 + 실제 이메일 1건. **사람만 실행**, CI/에이전트 게이트에 포함하지 않음

## 4. 필수 엣지 케이스 체크리스트 (component 레벨)

- [ ] 빈 데이터 탭 → sent 0, 에러 아님
- [ ] `recipient_column` 값 결측 행 → 그 행만 `failed`, `_error`에 사유
- [ ] 이메일 형식 불량(`@` 없음) → 발송 전 검증에서 `failed`
- [ ] 템플릿 변수 결측(`{{amount}}`인데 컬럼 없음) → 그 행 `failed`, 결측 키 명시
- [ ] 같은 실행 2회 → 2회차 전부 `skipped_duplicate`, provider 호출 0건
- [ ] 템플릿 수정 후 재실행 → templateHash 변경으로 재발송됨
- [ ] 일부 행 실패 주입 → 나머지 정상 발송 + 집계 정확 + 실패 행만 `_error`
- [ ] filter_column/value 적용 정확성 (대소문자 그대로 비교)
- [ ] 유니코드: 타갈로그·한글 값 머지 깨짐 없음
- [ ] `dryRun: true` → provider 호출 0건, writeStatus 호출 0건
- [ ] `SEND_MODE=dry_run`에서 `send_notifications(confirm=true)` → 실발송 없이 dry-run 결과 반환
- [ ] 1,000행 픽스처 파이프라인 < 2초 (성능 회귀 가드)

## 5. 실패 주입 패턴

```ts
const provider = new MockNotificationProvider({ failFor: ["CUST-003"] });
const result = await pipeline.run("sheet-1", { dryRun: false });
expect(result.failed).toBe(1);
expect(provider.sent.map(m => m.rowKey)).not.toContain("CUST-003");
```

## 6. 커버리지

- `src/core/` 라인 커버리지 90% 이상 (vitest `--coverage`, check에는 미포함·T9에서 리포트만).
- 어댑터는 목 대상이 아니므로 낮아도 됨 — 스모크로 보완.
