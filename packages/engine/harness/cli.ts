import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { HARNESSES } from "./catalog";
import { listing } from "./harness";
import { prepareReportDir, writeReport, SUMMARY_FILE } from "./report";

/**
 * `pnpm balance` — 밸런스 하네스를 돌리거나(인자 없이·파일 이름으로 걸러) 목록만 본다.
 *
 * `--list`는 세계를 세우지 않는다. 밸런스 손잡이를 옮긴 뒤 **무엇을 돌려야 하는가**를
 * 고르는 자리라, 몇 분을 쓰기 전에 한 화면을 먼저 준다.
 *
 * `--report <디렉터리>`는 측정값을 파일로도 남긴다 — 주간 워크플로가 읽는 자리다
 * (→ `docs/simulation/balance-harness.md` §5).
 */
const args = process.argv.slice(2);

if (args.includes("--list")) {
  process.stdout.write(`${listing(HARNESSES)}\n`);
} else {
  const at = args.indexOf("--report");
  const dir = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && (dir === undefined || dir.startsWith("-"))) {
    process.stderr.write("--report 뒤에 디렉터리를 적어라 (예: --report balance-report)\n");
    process.exitCode = 2;
  } else {
    // 걸러 돌릴 파일 이름만 vitest에 넘긴다 — `--report`와 그 값은 우리 것이다
    // (`--report`가 없으면 `at`이 -1이라 자리로 거르면 첫 인자가 통째로 사라진다)
    const filters = at < 0 ? args : args.filter((_, i) => i !== at && i !== at + 1);
    const reportDir = dir === undefined ? undefined : resolve(dir);
    const env = { ...process.env };
    if (reportDir !== undefined) env.BALANCE_REPORT = prepareReportDir(reportDir);

    const run = spawnSync(
      "pnpm",
      ["exec", "vitest", "run", "--config", "vitest.balance.config.ts", ...filters],
      { stdio: "inherit", env },
    );

    if (reportDir !== undefined) {
      // 하네스가 빨갛게 끝나도 리포트는 남긴다 — 이탈을 읽으려고 돌린 것이다
      const { breaches, reported } = writeReport(reportDir, filters.length === 0);
      process.stdout.write(
        `\n[balance] 하네스 ${reported}개 보고 · 이탈 ${breaches.length}건 → ${resolve(reportDir, SUMMARY_FILE)}\n`,
      );
    }
    process.exitCode = run.status ?? 1;
  }
}
