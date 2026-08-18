import { spawnSync } from "node:child_process";
import { HARNESSES } from "./catalog";
import { listing } from "./harness";

/**
 * `pnpm balance` — 밸런스 하네스를 돌리거나(인자 없이·파일 이름으로 걸러) 목록만 본다.
 *
 * `--list`는 세계를 세우지 않는다. 밸런스 손잡이를 옮긴 뒤 **무엇을 돌려야 하는가**를
 * 고르는 자리라, 몇 분을 쓰기 전에 한 화면을 먼저 준다.
 */
const args = process.argv.slice(2);

if (args.includes("--list")) {
  process.stdout.write(`${listing(HARNESSES)}\n`);
} else {
  const run = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "--config", "vitest.balance.config.ts", ...args],
    { stdio: "inherit" },
  );
  process.exitCode = run.status ?? 1;
}
