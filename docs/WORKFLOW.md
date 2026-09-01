# WORKFLOW — 이 레포를 굴리는 AI-native 규칙

출처: Clare Liguori (AWS), "From AI-Assisted to AI-Native: Building a Frontier Development Team"
(https://youtu.be/Ry0WHNxDbYA · 동일 연구의 AWS 블로그: https://aws.amazon.com/blogs/machine-learning/how-frontier-teams-are-reinventing-ai-native-development/)
Amazon 내부에서 일반 팀들을 장기 관찰해 도출한 "프론티어 팀" 습관을 이 1인 프로젝트에 맞게 번역했다.

## 0. 프론티어 개발자의 3행동 → 나의 역할 정의

| 행동 (영상 1:34~) | 이 레포에서 |
|---|---|
| Hands-off Coding — 직접 코딩 1~2% | Jin은 SPEC/DESIGN 작성·수정, 리뷰, 실발송 승인만. 구현은 에이전트 |
| Infrequent Interaction — 수 시간 자율 실행 | 태스크에 실행 가능한 완료 기준을 박아 세션 중 개입 없이 완주시킨다 |
| Minimized Idle Time — 병렬 에이전트 | T1 이후 레인 A~D를 worktree로 동시 실행. 사람은 리뷰 큐만 소화 |

## 1. 습관별 규칙

**습관 1 — Invest in Agent Context (08:02)**
- 부족지식(tribal knowledge)은 전부 `CLAUDE.md`와 `docs/`에 적는다. 대화로만 설명한 규칙은 없는 규칙이다.
- **프루닝**: 격주로 CLAUDE.md를 훑어 낡은 규칙을 삭제하고 프루닝 로그에 날짜를 남긴다. 문서가 길어지는 것 자체가 컨텍스트 비용이다.

**습관 2 — Slow Down to Speed Up (10:19)**
- T0에 도구 셋업을 몰아서 한다: strict TS(에이전트에게 가장 싼 피드백 루프), 게이트 스크립트, 린트.
- 에러 메시지는 "무엇이 왜 + 어떻게 고치나"까지. 에이전트가 에러 문자열만 보고 자가 수정할 수 있어야 한다.
- 코드 구조는 작게 쪼갠 파일 + 인터페이스 경계 = agent-friendly 코드베이스.

**습관 3 — Feed Agents, Don't Babysit (12:38)**
- 바이브 코딩(짧은 왕복 대화) 금지. 배정 프롬프트는 TASKS.md의 템플릿 한 개로 끝낸다.
- 자율성의 연료는 **자기 검증 수단**: 모든 태스크 완료 기준은 `npm run check` + 명시된 테스트로 기계 판정 가능하게 쓴다.
- 병렬 실행:
  ```bash
  git worktree add ../sheet_mcp-t4 -b t4 && cd ../sheet_mcp-t4 && claude
  # 다른 터미널에서 t5, t6 동일하게 — 레인이 다르면 충돌 없음
  ```

**습관 4 — Make Intent Explicit (13:46)**
- 코드보다 문서가 먼저다. 새 기능/변경 = ① SPEC 또는 DESIGN에 diff → ② 그 diff를 근거로 태스크 추가 → ③ 에이전트 구현.
- 설계 문서 위에서 AI와 왕복하는 것이 레포 곳곳에 흩어진 코드 수정을 고치는 것보다 싸다. 이 원칙 때문에 이 레포는 코드 0줄 상태에서 문서 7개로 시작했다.

**습관 5 — Shift Testing Left (14:57)**
- 로컬 결정론적 목 서비스가 핵심 기법: 구글시트도 이메일 API도 목으로 대체해 라이브 클라우드 없이 반복한다 (`docs/TESTING.md`).
- 라이브 의존 테스트는 게이트에 넣지 않는다. 실세계 검증은 사람이 스모크로.

## 2. 일일 운영 루틴

1. 아침: TASKS.md에서 착수 가능 태스크 확인 → 레인별 worktree에 에이전트 배정
2. 에이전트 실행 중: 다음 버전 SPEC/DESIGN을 다듬거나 리뷰 (개입하지 않는다)
3. 완료 보고 도착: `npm run check` 재실행 → diff 리뷰 → 머지, 태스크 상태 갱신
4. 격주: CLAUDE.md 프루닝 + TASKS.md 정리

## 3. 자율성의 한계선 (사람이 잡고 있는 것)

- `SEND_MODE=live` 전환과 실발송 승인 — 항상 사람.
- 스펙 변경 결정 — 에이전트는 제안까지만, 문서 수정 승인은 사람.
- 시크릿 관리와 서비스 계정 공유 범위.
