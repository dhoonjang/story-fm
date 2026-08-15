import { describe, expect, it, vi } from "vitest";
import { createLineupSaver, type LineupSaveOutcome } from "@/components/lineup-saver";

/**
 * 전술판 저장 대기열 — **턴보다 먼저 서버에 닿는지**를 고정한다.
 *
 * 화면 타이밍(디바운스·언마운트)이라 브라우저 없이는 재현이 어렵지만, 경합의 뿌리는
 * 순서 규칙 하나다: 턴은 대기열이 빈 뒤에 나간다. 그 규칙을 여기서 잡는다.
 */
describe("전술판 저장 대기열", () => {
  const ok = (): Promise<LineupSaveOutcome> => Promise.resolve({ ok: true });

  it("예약된 저장은 조작이 멎어야 나간다 — 그 전에도 flush가 끌어낸다", async () => {
    vi.useFakeTimers();
    try {
      const saver = createLineupSaver(3000);
      const sent: string[] = [];
      saver.schedule(() => {
        sent.push("첫 배치");
        return ok();
      });
      // 아직 창이 열려 있다 — 판을 더 만질 수 있는 시간
      await vi.advanceTimersByTimeAsync(2000);
      expect(sent).toEqual([]);
      // 턴이 나가기 직전 — 대기열을 비우고 기다린다
      const outcome = await saver.flush();
      expect(sent).toEqual(["첫 배치"]);
      expect(outcome).toEqual({ ok: true });
      // 흘려보낸 예약이 타이머로 한 번 더 나가지 않는다
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent).toEqual(["첫 배치"]);
      expect(saver.dirty()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("연속 조작은 마지막 하나로 묶인다", async () => {
    const saver = createLineupSaver(0);
    const sent: string[] = [];
    saver.schedule(() => {
      sent.push("a");
      return ok();
    });
    saver.schedule(() => {
      sent.push("b");
      return ok();
    });
    await saver.flush();
    expect(sent).toEqual(["b"]);
  });

  it("날고 있는 저장이 끝나기를 기다린다 — 턴이 그 앞을 지르지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const saver = createLineupSaver(10);
      let landed = false;
      saver.schedule(
        () =>
          new Promise<LineupSaveOutcome>((resolve) =>
            setTimeout(() => {
              landed = true;
              resolve({ ok: true });
            }, 500),
          ),
      );
      await vi.advanceTimersByTimeAsync(20); // 타이머가 저장을 띄운다
      expect(landed).toBe(false);
      const flushed = saver.flush();
      await vi.advanceTimersByTimeAsync(500);
      await flushed;
      expect(landed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("반려된 저장은 flush가 그대로 알린다 — 턴을 막을 수 있게", async () => {
    const saver = createLineupSaver(0);
    saver.schedule(() => Promise.resolve({ ok: false, error: "저장 실패" }));
    expect(await saver.flush()).toEqual({ ok: false, error: "저장 실패" });
    // 서버가 물린 저장은 대기열에서 빠진다 — 다시 보내면 턴은 나간다
    expect(await saver.flush()).toBeNull();
  });

  it("보낼 수 없는 배치(keep)는 대기열에 남아 다음 턴도 막는다", async () => {
    const saver = createLineupSaver(0);
    const blocked = (): Promise<LineupSaveOutcome> =>
      Promise.resolve({ ok: false, error: "GK 자리", keep: true });
    saver.schedule(blocked);
    expect(await saver.flush()).toMatchObject({ ok: false, error: "GK 자리" });
    expect(saver.dirty()).toBe(true);
    expect(await saver.flush()).toMatchObject({ ok: false, error: "GK 자리" });
  });

  it("저장이 던져도 대기열은 무너지지 않는다 — 이유가 결과로 온다", async () => {
    const saver = createLineupSaver(0);
    saver.schedule(() => Promise.reject(new Error("연결 실패")));
    expect(await saver.flush()).toEqual({ ok: false, error: "연결 실패" });
  });

  it("비어 있으면 턴을 붙잡지 않는다", async () => {
    const saver = createLineupSaver(3000);
    expect(await saver.flush()).toBeNull();
    expect(saver.dirty()).toBe(false);
  });
});
