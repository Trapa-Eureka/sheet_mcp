// SMS adapter for NotificationProvider — v0.1 stub.
// Design: docs/DESIGN.md §6, roadmap: docs/SPEC.md §6.
// Since the SIM Registration Act, PH business SMS requires going through a gateway plus Sender ID
// registration, so this is not actually implemented in v0.1. The interface must exist from the
// start (so v0.2 can swap in the adapter without changing pipeline code), so this is left as a
// stub whose constructor only throws a clear, instructive error.

import type { NotificationProvider, OutboundMessage, SendResult } from "../core/types.js";

const NOT_YET_ACTIVATED_MESSAGE =
  "SemaphoreSmsProvider is not yet activated. PH SMS will be supported in v0.2 once Sender ID " +
  "registration is complete (see the roadmap in docs/SPEC.md). In v0.1, use only channel=email in notify_config.";

export class SemaphoreSmsProvider implements NotificationProvider {
  readonly channel = "sms" as const;

  constructor() {
    throw new Error(NOT_YET_ACTIVATED_MESSAGE);
  }

  send(_msg: OutboundMessage): Promise<SendResult> {
    // This method never runs since the constructor always throws. It's here only to satisfy the interface.
    return Promise.reject(new Error(NOT_YET_ACTIVATED_MESSAGE));
  }
}
