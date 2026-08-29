import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { dataDir } from "./paths";

/**
 * 세이브 하나의 **파일 락** — 같은 게임에 턴이 둘 도는 것을 프로세스 경계 너머에서 막는다.
 *
 * 프로세스 안 뮤텍스(`withGameLock`, apps/web)는 자기 프로세스만 안다. `next start`를
 * 인스턴스 여럿으로 띄우면 두 프로세스가 같은 세이브를 읽고 고쳐 쓰고, 나중에 rename한
 * 쪽이 상대의 턴을 통째로 덮는다 — 원자적 쓰기(persistence.ts)는 반쪽 파일만 막을 뿐
 * 잃어버린 갱신은 막지 못한다.
 *
 * **자문적(advisory) 락이다.** `saveGame`은 이 락을 보지 않는다. 지켜야 하는 구간은 쓰는
 * 순간이 아니라 **읽고 → 고치고 → 쓰는 구간 전체**이고, 그 구간의 시작과 끝을 아는 것은
 * 턴을 도는 쪽뿐이다. 저장 함수가 자기 안에서 잠갔다면 그 구간은 여전히 열려 있다.
 *
 * ⚠️ pid·호스트·시각·토큰은 **락 파일에만** 산다. 세이브 본문에도 시뮬 시드에도 섞이지
 * 않으므로 코어의 결정론과 무관하다 (docs/llm/models.md §1-1).
 */

/** 락 파일에 적히는 것 — 누가, 어디서, 언제 쥐었는가 */
interface LockRecord {
  pid: number;
  host: string;
  /** ISO 시각 — 나이를 재는 축. 파일 mtime은 회수 시도가 건드릴 수 있어 내용을 믿는다 */
  at: string;
  /** 이 락을 쥔 한 번의 시도 — 놓을 때 "내 락인가"를 이걸로 판별한다 */
  token: string;
}

/**
 * 이만큼 늙은 락은 홀더가 살아 있어 보여도 회수한다.
 *
 * 한 턴이 **정당하게** 쥐는 최대 시간은 그 턴이 부르는 에이전트들의 `timeout_ms` 합이다.
 * 지금 설정에서 가장 긴 것은 경기 턴 — `tactic-orders`(60초) + `match-gm`(180초) +
 * `finalize-match`(90초) + `history-compactor`(60초) ≈ 6분 30초 (config/llm.yml).
 * 15분은 그 두 배 남짓이다. **이 값이 그 합보다 짧으면 멀쩡히 돌고 있는 턴의 락을
 * 빼앗는다** — 잃어버린 갱신을 막으려고 세운 락이 스스로 그 길을 연다.
 *
 * 나이는 크래시 회수의 수단이 **아니다**: 죽은 프로세스는 pid로 곧바로 알아본다.
 * 여기 남는 것은 pid로 판정할 수 없는 경우뿐 — pid 재사용, 다른 호스트, 멎은 프로세스.
 */
const STALE_MS = 15 * 60 * 1000;

/** 락을 얻지 못했을 때 다시 두드리는 간격 — 사람이 기다리는 자리라 촘촘해도 싸다 */
const RETRY_MS = 25;

/** 잡고 있는 락 — `release`는 몇 번 불러도 한 번만 듣는다 */
export interface SaveLockHandle {
  release(): void;
}

export function saveLockPath(id: string): string {
  return path.join(dataDir(), `${id}.lock`);
}

/** 이 프로세스가 그 pid에게 신호를 보낼 수 있는가 — 살아 있는지만 묻는다(0번 신호) */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM은 **있다**는 뜻이다 — 남의 프로세스라 신호를 못 보낼 뿐
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRecord(file: string): LockRecord | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const { pid, host, at, token } = raw as Record<string, unknown>;
    if (typeof pid !== "number" || typeof host !== "string") return null;
    if (typeof at !== "string" || typeof token !== "string") return null;
    return { pid, host, at, token };
  } catch {
    return null;
  }
}

/** 락 파일의 나이(ms) — 내용을 못 읽으면 mtime으로 잰다 */
function ageOf(file: string, record: LockRecord | null): number {
  const stamp = record ? Date.parse(record.at) : NaN;
  if (Number.isFinite(stamp)) return Date.now() - stamp;
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return 0; // 방금 사라졌다 — 다음 시도가 그 자리를 가져간다
  }
}

/**
 * 이 락을 회수해도 되는가.
 *
 * 1. **같은 호스트인데 pid가 죽었다** → 곧바로. 턴 도중에 죽은 프로세스가 남긴 락은
 *    아무도 풀어 주지 않는다.
 * 2. **그 밖에는 나이만 본다** (`STALE_MS`). 다른 호스트의 pid는 물어볼 수 없고, 같은
 *    호스트여도 pid는 재사용된다 — 죽은 홀더가 산 것처럼 보이는 경우의 유일한 backstop.
 */
function reclaimable(file: string, record: LockRecord | null): boolean {
  if (record && record.host === hostname() && !pidAlive(record.pid)) return true;
  return ageOf(file, record) > STALE_MS;
}

/**
 * 늙은 락을 치운다 — **rename으로.** 두 프로세스가 같은 락을 동시에 회수해도 이름을
 * 바꾸는 데 성공하는 쪽은 하나뿐이라, 진 쪽이 이긴 쪽의 새 락을 지우는 일이 없다.
 * (`rmSync`로 지우면 A가 지운 자리에 B가 락을 세우고 A가 그 락을 또 지운다.)
 */
function reclaim(file: string): void {
  const grave = `${file}.${randomBytes(4).toString("hex")}.stale`;
  try {
    renameSync(file, grave);
  } catch {
    return; // 누가 먼저 가져갔다 — 다음 시도가 새 락을 본다
  }
  rmSync(grave, { force: true });
}

/** 락을 한 번 걸어 본다 — 성공하면 토큰, 이미 누가 쥐고 있으면 null */
function tryTake(file: string, token: string): string | null {
  const record: LockRecord = {
    pid: process.pid,
    host: hostname(),
    at: new Date().toISOString(),
    token,
  };
  try {
    // `wx` — 이미 있으면 실패한다. 존재 확인과 생성이 한 번의 호출이라 그 사이가 없다
    writeFileSync(file, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return null;
  }
}

/**
 * 세이브 락을 얻는다 — `waitMs` 안에 얻지 못하면 **null**. 빼앗지 않는다.
 *
 * 기다림에 상한이 있는 것과 잠금이 시간으로 풀리는 것은 다른 일이다: 지친 쪽은
 * 물러나기만 하고 아무것도 쓰지 않으므로, 같은 세이브에 쓰는 손은 여전히 하나다.
 */
export async function acquireSaveLock(id: string, waitMs: number): Promise<SaveLockHandle | null> {
  const file = saveLockPath(id);
  mkdirSync(path.dirname(file), { recursive: true });
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + Math.max(0, waitMs);

  for (;;) {
    if (tryTake(file, token) !== null) return handle(file, token);
    // 쥐고 있는 쪽이 이미 죽었으면 기다릴 이유가 없다
    if (reclaimable(file, readRecord(file))) {
      reclaim(file);
      if (tryTake(file, token) !== null) return handle(file, token);
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, Math.min(RETRY_MS, Math.max(1, deadline - Date.now()))));
  }
}

function handle(file: string, token: string): SaveLockHandle {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      /**
       * **내 토큰일 때만 지운다.** 내 락이 늙어 회수당한 뒤라면 그 자리의 락은 남의
       * 것이고, 그걸 지우면 두 턴이 같은 세이브에 동시에 앉는다.
       */
      const record = readRecord(file);
      if (record !== null && record.token !== token) return;
      rmSync(file, { force: true });
    },
  };
}
