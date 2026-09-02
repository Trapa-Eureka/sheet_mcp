// npm run build 마지막 단계 — tsc는 shebang을 보존하지 않으므로, 빌드된 dist/server.js 최상단에
// `#!/usr/bin/env node`를 붙여야 `node dist/server.js`/`npx sheet-mcp`가 실행 가능한 CLI로 동작한다
// (T11, docs/TASKS.md). tsx/devDependencies 없이 순수 node로 실행 가능한지가 이 스크립트의 목적이라
// tsx를 쓰지 않고 plain Node ESM으로 작성한다.

import { readFileSync, writeFileSync } from "node:fs";

const target = "dist/server.js";
const shebang = "#!/usr/bin/env node\n";

const original = readFileSync(target, "utf8");
if (!original.startsWith(shebang)) {
  writeFileSync(target, shebang + original);
}
