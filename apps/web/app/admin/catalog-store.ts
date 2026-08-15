"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AdminLeagueRow,
  AdminTeamRow,
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
  /**
   * 편집 응답을 받은 횟수. 다시 받는 중에 편집이 끼어들면 **나중에 도착한 GET이 더
   * 낡았다** — 3.6MB 카탈로그는 몇 초씩 날아오므로 그 사이 고친 값이 조용히
   * 되돌아간다. 요청을 띄운 시점의 횟수와 다르면 그 응답을 버린다.
   */
  const applied = useRef(0);

  // 응답에 없는 필드는 그대로 둔다 — `ageRef`처럼 GET만 실어 주는 값이 있다
  const apply = useCallback((next: R) => {
    applied.current += 1;
    setData((prev) => ({ ...prev, ...next }));
  }, []);
  const reload = useCallback(() => setToken((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const startedAt = applied.current;
    fetch(url)
      .then((r) => r.json())
      .then((d: R & { error?: string }) => {
        if (!alive) return;
        if (d.error) onError(d.error);
        else if (applied.current === startedAt) setData((prev) => ({ ...prev, ...d }));
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

/**
 * 다른 층이 팀에서 읽어 가는 것 — 선수 카탈로그는 팀의 이름·소속·체급을 함께 싣고,
 * 리그의 팀 수는 소속에서 나온다. 순서까지 담는다 (팀을 리그로 묶는 순서가 표에서
 * 그대로 온다).
 */
function teamIdentity(rows: AdminTeamRow[]): string {
  return rows.map((t) => `${t.id}:${t.name}:${t.leagueId}:${t.tier}`).join("|");
}

/** 다른 층이 리그에서 읽어 가는 것 — 팀 행이 싣고 오는 리그 이름 */
function leagueIdentity(rows: AdminLeagueRow[]): string {
  return rows.map((l) => `${l.id}:${l.name}`).join("|");
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
   * 팀이 늘거나 줄거나 이름·소속·체급이 바뀌면 그 팀의 명단(선수 카탈로그)과 리그의
   * 팀 수가 함께 달라진다 — 둘 다 서버만 아는 값이라 다시 받는다.
   *
   * 살림 값(수용인원·포메이션·전술 성향·브랜드 등급)만 고친 편집은 두 층을 건드리지
   * 않는다. 그때까지 3.6MB를 다시 받으면 탭 왕복에서 덜어낸 왕복을 편집이 도로
   * 만들어 낸다.
   */
  const applyTeams = useCallback(
    (next: TeamCatalogResponse) => {
      const before = teamIdentity(teams.data.teams);
      teams.apply(next);
      if (teamIdentity(next.teams) === before) return;
      players.reload();
      leagues.reload();
    },
    [teams, players, leagues],
  );

  /** 리그 이름은 팀 행에 박혀서 온다 — 계수·중계권만 고쳤으면 팀 목록은 그대로다 */
  const applyLeagues = useCallback(
    (next: LeagueCatalogResponse) => {
      const before = leagueIdentity(leagues.data.leagues);
      leagues.apply(next);
      if (leagueIdentity(next.leagues) !== before) teams.reload();
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
