// npm run build 마지막 단계 — tsc는 shebang을 보존하지 않으므로, 빌드된 bin 진입점들 최상단에
// `#!/usr/bin/env node`를 붙여야 `node dist/server.js`/`npx sheet-mcp` 같은 실행이 된다
// (T11, docs/TASKS.md). package.json의 bin 필드와 대상이 같아야 한다(AR-019 — sheet-mcp-recover
// 추가). tsx/devDependencies 없이 순수 node로 실행 가능한지가 이 스크립트의 목적이라 tsx를 쓰지
// 않고 plain Node ESM으로 작성한다.

import { readFileSync, writeFileSync } from "node:fs";

const SHEBANG = "#!/usr/bin/env node\n";
const BIN_TARGETS = ["dist/server.js", "dist/cli/recoverStaleClaim.js"];

for (const target of BIN_TARGETS) {
  const original = readFileSync(target, "utf8");
  if (!original.startsWith(SHEBANG)) {
    writeFileSync(target, SHEBANG + original);
  }
}
