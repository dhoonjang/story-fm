/**
 * 스켈레톤 — **올 것의 모양을 미리 그려 둔다.**
 *
 * 목록처럼 **무엇이 올지 이미 아는 자리**에서는 도는 원보다 낫다: 카드가 도착할
 * 때 줄이 튀지 않고, 기다리는 동안에도 화면이 자기 골격을 유지한다. 반대로
 * 게임 화면처럼 무엇이 올지 모양으로 요약할 수 없는 자리에는 마크(`Loading`)가 선다.
 *
 * ⚠️ 뼈대는 **진짜 마크업과 같은 클래스**(`.game-card` · `.league-node`)를 쓴다 —
 * 여기서 따로 상자를 만들면 카드 여백이 바뀔 때마다 두 곳을 고쳐야 하고, 결국
 * 어긋난다. 바뀌는 것은 안에 든 글자가 막대가 되는 것뿐이다.
 */
import { ringPoints, ringPolygon } from "@/lib/ring";

/** 게임 카드 — 몇 장이 올지는 알 수 없으니 "목록이 온다"만 말하는 두 장이다 */
export function GameListSkeleton() {
  return (
    <div className="game-list" role="status" aria-label="게임 목록 불러오는 중">
      {[0, 1].map((i) => (
        <div className="game-card skel-box" key={i} aria-hidden>
          <div className="game-card-body">
            <span className="game-card-main">
              <span className="skel skel-team" />
              <span className="skel skel-sub" />
            </span>
            <span className="game-card-when">
              <span className="skel skel-season" />
              <span className="skel skel-date" />
            </span>
          </div>
          {/* 삭제 버튼이 앉을 자리 — 비워 두지 않으면 시즌·날짜가 오른쪽 끝까지
              밀려 있다가 카드가 도착할 때 32px 안쪽으로 뛴다 */}
          <span className="game-del" />
        </div>
      ))}
    </div>
  );
}

/** 리그 고리 — 5대 리그가 올 자리라 오각형이다 (좌표는 `lib/ring`이 정한다) */
export function LeagueRingSkeleton() {
  const points = ringPoints(5);
  return (
    <div className="league-ring" role="status" aria-label="리그 목록 불러오는 중">
      <svg viewBox="0 0 100 100" aria-hidden>
        <polygon className="ring-edge" points={ringPolygon(points)} />
      </svg>
      {points.map((p, i) => (
        <div
          className="league-node skel-box"
          key={i}
          style={{ left: `${p.x}%`, top: `${p.y}%` }}
          aria-hidden
        >
          <span className="skel skel-league" />
          <span className="skel skel-country" />
        </div>
      ))}
    </div>
  );
}
