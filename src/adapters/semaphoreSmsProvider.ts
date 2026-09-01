// NotificationProvider의 SMS 어댑터 — v0.1 스텁.
// 설계: docs/DESIGN.md §6, 로드맵: docs/SPEC.md §6.
// SIM 등록법 이후 PH 비즈니스 SMS는 게이트웨이 경유 + Sender ID 등록이 필요해 v0.1에서는
// 실구현하지 않는다. 인터페이스는 처음부터 존재해야 하므로(파이프라인 코드 변경 없이 v0.2에서
// 어댑터만 교체) 생성자에서 명확한 안내 에러만 던지는 스텁으로 둔다.

import type { NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

const NOT_YET_ACTIVATED_MESSAGE =
  "SemaphoreSmsProvider는 아직 활성화되지 않았습니다. PH SMS는 Sender ID 등록이 완료된 뒤 " +
  "v0.2에서 지원됩니다 (docs/SPEC.md 로드맵 참고). v0.1에서는 notify_config의 channel=email만 사용하세요.";

export class SemaphoreSmsProvider implements NotificationProvider {
  readonly channel = "sms" as const;

  constructor() {
    throw new Error(NOT_YET_ACTIVATED_MESSAGE);
  }

  send(_msg: OutboundMessage): Promise<SendResult> {
    // 생성자가 항상 throw하므로 이 메서드는 실행되지 않는다. 인터페이스 충족을 위한 형식적 구현.
    return Promise.reject(new Error(NOT_YET_ACTIVATED_MESSAGE));
  }
}
