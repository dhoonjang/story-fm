"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CatalogResponse,
  CupCatalogResponse,
  LeagueCatalogResponse,
  TeamCatalogResponse,
} from "./types";

/**
 * 어드민 네 층의 카탈로그를 **페이지가 한 번 받아 쥔다**.
 *
 * 카탈로그는 불변 시드다 — 이 화면이 서 있는 동안 서버 쪽이 저 혼자 바뀌는 일은
 * 없고, 바뀌는 순간은 여기서의 편집·리셋뿐이다. 그래서 받는 일은 이 훅 한 곳이고,
 * 패널은 받은 값을 쓰기만 한다. 탭마다 제 손으로 받으면 선수 카탈로그(3.6MB)를
 * 탭을 옮길 때마다 다시 받고, 그동안 목록이 비어 있다.
 *
 * 층은 서로를 흔든다. 어느 편집이 어느 층을 낡게 만드는지는 아래 `apply*` 한 곳에
 * 모아 둔다 — 패널마다 흩어 두면 한 층을 고칠 때 다른 층이 조용히 낡는다.
 */

/** 한 층이 패널에 보이는 모습 — 받아 둔 응답과, "없다"와 "아직"을 가르는 표시 */
export interface CatalogLayer<R> {
  data: R;
  loaded: boolean;
}

interface Layer<R> extends CatalogLayer<R> {
  /** 서버가 돌려준 새 값으로 갈아 끼운다 (편집·리셋 응답) */
  apply: (next: R) => void;
  /** 다른 층의 편집이 이 층을 낡게 만들었을 때 — 다시 받는다 */
  reload: () => void;
}

export interface AdminCatalog {
  players: CatalogLayer<CatalogResponse>;
  teams: CatalogLayer<TeamCatalogResponse>;
  leagues: CatalogLayer<LeagueCatalogResponse>;
  cups: CatalogLayer<CupCatalogResponse>;
  applyPlayers: (next: CatalogResponse) => void;
  applyTeams: (next: TeamCatalogResponse) => void;
  applyLeagues: (next: LeagueCatalogResponse) => void;
  applyCups: (next: CupCatalogResponse) => void;
}

const EMPTY_PLAYERS: CatalogResponse = { teams: [] };
const EMPTY_TEAMS: TeamCatalogResponse = { teams: [] };
const EMPTY_LEAGUES: LeagueCatalogResponse = { leagues: [] };
const EMPTY_CUPS: CupCatalogResponse = { europe: [], domestic: [] };

/**
 * 층 하나 — 마운트 때 한 번 받고, 그 뒤로는 `apply`(응답으로 갈아 끼우기)와
 * `reload`(다시 받기)로만 움직인다.
 *
 * `onError`는 호출부에서 안정적이어야 한다 (페이지의 `setState`) — 매 렌더 새
 * 함수가 들어오면 아래 `useEffect`가 다시 돌아 카탈로그를 또 받는다.
 */
function useLayer<R extends object>(
  url: string,
  empty: R,
  failMessage: string,
  onError: (e: string) => void,
): Layer<R> {
  const [data, setData] = useState<R>(empty);
  const [loaded, setLoaded] = useState(false);
  const [token, setToken] = useState(0);

  // 응답에 없는 필드는 그대로 둔다 — `ageRef`처럼 GET만 실어 주는 값이 있다
  const apply = useCallback((next: R) => setData((prev) => ({ ...prev, ...next })), []);
  const reload = useCallback(() => setToken((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => r.json())
      .then((d: R & { error?: string }) => {
        if (!alive) return;
        if (d.error) onError(d.error);
        else setData((prev) => ({ ...prev, ...d }));
        setLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        onError(failMessage);
        setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [url, failMessage, onError, token]);

  // 다시 받는 동안 `loaded`는 참으로 둔다 — 이미 보여 준 목록을 "불러오는 중"으로
  // 되돌리면 화면이 한 번 비었다가 같은 값으로 다시 찬다
  return useMemo(() => ({ data, loaded, apply, reload }), [data, loaded, apply, reload]);
}

export function useAdminCatalog(onError: (e: string) => void): AdminCatalog {
  const players = useLayer(
    "/api/admin/catalog",
    EMPTY_PLAYERS,
    "카탈로그를 불러오지 못했습니다",
    onError,
  );
  const teams = useLayer(
    "/api/admin/catalog/team",
    EMPTY_TEAMS,
    "팀 카탈로그를 불러오지 못했습니다",
    onError,
  );
  const leagues = useLayer(
    "/api/admin/catalog/league",
    EMPTY_LEAGUES,
    "리그 목록을 불러오지 못했습니다",
    onError,
  );
  const cups = useLayer(
    "/api/admin/catalog/cup",
    EMPTY_CUPS,
    "컵 카탈로그를 불러오지 못했습니다",
    onError,
  );

  /**
   * 팀이 늘거나 줄거나 리그를 옮기면 그 팀의 명단(선수 카탈로그)과 리그의 팀 수가
   * 함께 달라진다 — 둘 다 서버만 아는 값이라 다시 받는다.
   */
  const applyTeams = useCallback(
    (next: TeamCatalogResponse) => {
      teams.apply(next);
      players.reload();
      leagues.reload();
    },
    [teams, players, leagues],
  );

  /** 리그 이름은 팀 행에 박혀서 온다 */
  const applyLeagues = useCallback(
    (next: LeagueCatalogResponse) => {
      leagues.apply(next);
      teams.reload();
    },
    [leagues, teams],
  );

  // 선수 쪽 편집은 팀 행의 스쿼드 인원만 흔드는데, 그 수는 팀 패널이 선수
  // 카탈로그에서 세므로 (`squadSizes`) 팀 목록을 다시 받을 이유가 없다.
  return useMemo(
    () => ({
      players,
      teams,
      leagues,
      cups,
      applyPlayers: players.apply,
      applyTeams,
      applyLeagues,
      applyCups: cups.apply,
    }),
    [players, teams, leagues, cups, applyTeams, applyLeagues],
  );
}
