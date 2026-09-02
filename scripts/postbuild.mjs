// Final step of npm run build — tsc doesn't preserve shebangs, so `#!/usr/bin/env node` must be
// prepended to the top of each built bin entry point for `node dist/server.js`/`npx sheet-mcp`
// style execution to work (T11, docs/TASKS.md). Targets must match package.json's bin field
// (AR-019 — added sheet-mcp-recover). Since the point of this script is to be runnable with
// plain Node, without tsx/devDependencies, it's written as plain Node ESM instead of using tsx.

import { readFileSync, writeFileSync } from "node:fs";

const SHEBANG = "#!/usr/bin/env node\n";
const BIN_TARGETS = ["dist/server.js", "dist/cli/recoverStaleClaim.js"];

for (const target of BIN_TARGETS) {
  const original = readFileSync(target, "utf8");
  if (!original.startsWith(SHEBANG)) {
    writeFileSync(target, SHEBANG + original);
  }
}
