import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as catalog from "../harness/catalog";
import { HARNESSES } from "../harness/catalog";
import type { Harness } from "../harness/harness";

/**
 * **`pnpm balance --list`에 서는 것과 돌릴 수 있는 것은 같아야 한다**
 * (→ `docs/simulation/balance-harness.md` §4).
 *
 * 둘이 갈리는 두 방향 다 조용하다. 목록에만 있는 서술자는 `--list`에 서고도 돌지
 * 않아 주간 리포트에 `missing`으로만 나타나고, 목록에 없는 하네스는 돌면서도
 * 「하네스 n/N개가 보고했다」의 분모에서 빠져 그 수가 어긋난 채 산다. 하네스는
 * `pnpm test`가 걷지 않는 자리라 어느 쪽도 스위트가 만나지 못한다 — 그래서 짝만
 * 여기서 못 박는다. 밴드 숫자는 보지 않는다(그건 서술자 것이다).
 *
 * 하네스 본체는 import하지 않는다 — 세계를 세우는 파일이라 그것만으로 몇 초를 문다.
 * 서술자 이름이 소스에 서 있는지만 읽는다.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PACKAGES = join(ROOT, "packages");

function isHarness(value: unknown): value is Harness {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    Array.isArray((value as { bands?: unknown }).bands)
  );
}

/** 서술자 이름 → 서술자 — `HARNESSES`가 아니라 카탈로그가 내보내는 것 전부 */
const declared = new Map<string, Harness>();
for (const [name, value] of Object.entries(catalog)) {
  if (isHarness(value)) declared.set(name, value);
}

/** 하네스 본체 파일 — `vitest.balance.config.ts`의 include가 걷는 그 자리다 */
function harnessFiles(): string[] {
  const found: string[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const dir = join(PACKAGES, pkg.name, "harness");
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith(".harness.ts")) found.push(join(dir, name));
    }
  }
  return found;
}

/** 그 파일이 이름을 대는 서술자들 — 단어 경계로 찾는다 */
function referencedBy(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...declared.keys()].filter((name) => new RegExp(`\\b${name}\\b`).test(source));
}

describe("밸런스 하네스 목록", () => {
  const files = harnessFiles();

  it("목록에 선 서술자는 전부 돌릴 하네스를 갖는다", () => {
    const runnable = new Set(files.flatMap(referencedBy));
    const listedOnly = HARNESSES.filter(
      (h) => ![...runnable].some((name) => declared.get(name) === h),
    ).map((h) => h.id);
    expect(listedOnly).toEqual([]);
  });

  it("도는 하네스는 전부 목록에 선다", () => {
    const listed = new Set(HARNESSES);
    const unlisted = files
      .flatMap((file) => referencedBy(file).map((name) => ({ file, name })))
      .filter(({ name }) => !listed.has(declared.get(name)!))
      .map(({ name }) => name);
    expect(unlisted).toEqual([]);
  });

  it("id가 겹치지 않는다 — 리포트가 두 하네스를 한 줄로 접는다", () => {
    const ids = HARNESSES.map((h) => h.id);
    expect([...new Set(ids)]).toEqual(ids);
  });

  it("하네스 파일은 서술자 없이 서지 않는다", () => {
    const orphans = files.filter((file) => referencedBy(file).length === 0);
    expect(orphans).toEqual([]);
  });
});
