"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

/**
 * 선수 카탈로그 어드민 — 게임과 무관한 **초기치 DB**만 편집한다.
 * 여기서의 변경은 이후 새로 시작하는 게임에 반영되고, 진행 중인 게임은 그대로다.
 */

interface CatalogPosition {
  position: string;
  proficiency: number;
  isNatural: boolean;
}
interface CatalogPlayer {
  id: string;
  teamId: string;
  nameKo: string;
  nameEn: string;
  birthdate: string;
  positions: CatalogPosition[];
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
  goalkeeping: number;
  potential: number;
  /** 서버 파생 (읽기 전용) */
  age: number;
  overall: number;
  position: string;
}
interface CatalogTeam {
  teamId: string;
  teamName: string;
  tier: number;
  players: CatalogPlayer[];
}

const ATTRS = [
  "pace", "shooting", "passing", "dribbling", "defending", "physical", "goalkeeping",
] as const;
const ATTR_KO: Record<string, string> = {
  pace: "스피드",
  shooting: "슈팅",
  passing: "패스",
  dribbling: "드리블",
  defending: "수비",
  physical: "피지컬",
  goalkeeping: "골키핑",
};
const POSITIONS = [
  "GK", "RB", "RWB", "RCB", "CB", "LCB", "LB", "LWB",
  "DM", "CDM", "RCM", "CM", "LCM", "AM", "CAM", "RM", "LM",
  "RW", "LW", "SS", "ST", "CF",
];

type Draft = Record<string, number | string>;

export default function AdminPage() {
  const [teams, setTeams] = useState<CatalogTeam[]>([]);
  const [edited, setEdited] = useState(false);
  const [ageRef, setAgeRef] = useState("");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const applyResponse = useCallback((data: { teams: CatalogTeam[]; edited?: boolean; ageRef?: string }) => {
    setTeams(data.teams ?? []);
    if (data.edited !== undefined) setEdited(data.edited);
    if (data.ageRef) setAgeRef(data.ageRef);
  }, []);

  const load = useCallback(() => {
    fetch("/api/admin/catalog")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setErr(d.error);
        else {
          applyResponse(d);
          setDrafts({});
        }
      })
      .catch(() => setErr("카탈로그를 불러오지 못했습니다"));
  }, [applyResponse]);

  useEffect(() => load(), [load]);

  const flat = useMemo(
    () => teams.flatMap((t) => t.players.map((p) => ({ ...p, teamName: t.teamName }))),
    [teams],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return flat.filter((p) => {
      if (teamFilter !== "all" && p.teamId !== teamFilter) return false;
      if (q && !`${p.nameKo} ${p.nameEn} ${p.position} ${p.teamName}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [flat, teamFilter, query]);

  function draftOf(p: CatalogPlayer): Draft {
    return (
      drafts[p.id] ?? {
        nameKo: p.nameKo,
        birthdate: p.birthdate,
        position: p.position,
        potential: p.potential,
        ...Object.fromEntries(ATTRS.map((a) => [a, p[a]])),
      }
    );
  }
  function setField(id: string, field: string, value: number | string) {
    setDrafts((d) => ({
      ...d,
      [id]: { ...draftOf(flat.find((p) => p.id === id)!), ...d[id], [field]: value },
    }));
  }

  async function send(
    url: string,
    init: RequestInit,
    onOk?: () => void,
  ): Promise<void> {
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(url, init);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "요청 실패");
      applyResponse(data);
      setMsg(data.message);
      onOk?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveRow(p: CatalogPlayer) {
    const d = drafts[p.id];
    if (!d) return;
    setBusy(p.id);
    await send(
      `/api/admin/catalog/player/${p.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nameKo: String(d.nameKo),
          birthdate: String(d.birthdate),
          position: String(d.position),
          potential: Number(d.potential),
          ...Object.fromEntries(ATTRS.map((a) => [a, Number(d[a])])),
        }),
      },
      () =>
        setDrafts((cur) => {
          const next = { ...cur };
          delete next[p.id];
          return next;
        }),
    );
    setBusy(null);
  }

  async function removeRow(p: CatalogPlayer & { teamName: string }) {
    if (!window.confirm(`카탈로그에서 ${p.teamName}의 ${p.nameKo}을(를) 삭제할까요?\n(새 게임부터 반영됩니다)`)) {
      return;
    }
    setBusy(p.id);
    await send(`/api/admin/catalog/player/${p.id}`, { method: "DELETE" });
    setBusy(null);
  }

  async function resetCatalog() {
    if (!window.confirm("카탈로그 편집을 모두 취소하고 시드 기본값으로 되돌릴까요?")) return;
    setBusy("reset");
    await send("/api/admin/catalog", { method: "DELETE" }, () => setDrafts({}));
    setBusy(null);
  }

  return (
    <main className="admin">
      <div className="admin-head">
        <div>
          <Link href="/" className="back-link">← 게임 목록</Link>
          <h1>선수 카탈로그 어드민</h1>
        </div>
        <div className="admin-head-actions">
          {edited && <span className="badge warn" data-testid="catalog-edited">편집됨</span>}
          <button
            className="ghost-btn"
            onClick={resetCatalog}
            disabled={busy === "reset" || !edited}
            data-testid="catalog-reset"
          >
            시드 기본값으로
          </button>
        </div>
      </div>

      <p className="hint" style={{ maxWidth: 900, marginBottom: 16 }}>
        여기는 <b>게임과 무관한 초기치 DB</b>입니다 — 편집 결과는 <b>이후 새로 시작하는 게임</b>에만
        반영되고, 진행 중인 게임은 시작 시 복사한 값으로 계속 돕니다. 나이·OVR은 저장하지 않는
        파생값입니다{ageRef ? ` (나이는 ${ageRef} 기준 표시)` : ""}.
      </p>

      <div className="admin-toolbar">
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          data-testid="admin-team-filter"
        >
          <option value="all">전체 팀</option>
          {teams.map((t) => (
            <option key={t.teamId} value={t.teamId}>
              {t.teamName} (T{t.tier})
            </option>
          ))}
        </select>
        <input
          className="admin-search"
          placeholder="이름·로마자·포지션·팀 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="admin-search"
        />
        <span className="admin-count">{visible.length}명</span>
        <button
          className="primary-btn"
          onClick={() => setShowAdd((s) => !s)}
          data-testid="admin-add-toggle"
        >
          {showAdd ? "닫기" : "+ 새 선수"}
        </button>
      </div>

      {showAdd && (
        <AddPlayerForm
          teams={teams.map((t) => ({ id: t.teamId, name: t.teamName }))}
          defaultTeam={teamFilter !== "all" ? teamFilter : (teams[0]?.teamId ?? "")}
          onDone={(data) => {
            applyResponse(data);
            setMsg(data.message);
            setShowAdd(false);
          }}
          onError={setErr}
        />
      )}

      {msg && <div className="admin-msg ok" data-testid="admin-msg">{msg}</div>}
      {err && <div className="admin-msg err" data-testid="admin-err">{err}</div>}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>팀</th>
              <th>이름</th>
              <th>주 포지션</th>
              <th>가능 포지션</th>
              <th>생년월일</th>
              {ATTRS.map((a) => (
                <th key={a} title={ATTR_KO[a]}>{ATTR_KO[a]}</th>
              ))}
              <th>OVR</th>
              <th>POT</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const d = draftOf(p);
              const dirty = !!drafts[p.id];
              return (
                <tr key={p.id} className={dirty ? "dirty" : ""} data-testid={`admin-row-${p.id}`}>
                  <td className="admin-team">{p.teamName}</td>
                  <td>
                    <input
                      className="ai name"
                      value={d.nameKo as string}
                      onChange={(e) => setField(p.id, "nameKo", e.target.value)}
                    />
                    <span className="muted" style={{ fontSize: 11 }}>{p.nameEn}</span>
                  </td>
                  <td>
                    <select
                      value={d.position as string}
                      onChange={(e) => setField(p.id, "position", e.target.value)}
                    >
                      {POSITIONS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </td>
                  <td className="admin-poslist">
                    {p.positions.map((x) => (
                      <span key={x.position} className={x.isNatural ? "pos natural" : "pos"}>
                        {x.position} {x.proficiency}
                      </span>
                    ))}
                  </td>
                  <td className="admin-birth">
                    <input
                      className="ai date"
                      type="date"
                      value={d.birthdate as string}
                      onChange={(e) => setField(p.id, "birthdate", e.target.value)}
                    />
                    <span className="muted">{p.age}세</span>
                  </td>
                  {ATTRS.map((a) => (
                    <td key={a}>
                      <input
                        className="ai num"
                        type="number"
                        value={d[a] as number}
                        onChange={(e) => setField(p.id, a, e.target.value)}
                      />
                    </td>
                  ))}
                  <td className="admin-ovr">{p.overall}</td>
                  <td>
                    <input
                      className="ai num"
                      type="number"
                      value={d.potential as number}
                      onChange={(e) => setField(p.id, "potential", e.target.value)}
                    />
                  </td>
                  <td className="admin-actions">
                    <button
                      className="mini-btn save"
                      disabled={!dirty || busy === p.id}
                      onClick={() => saveRow(p)}
                      data-testid={`admin-save-${p.id}`}
                    >
                      저장
                    </button>
                    <button
                      className="mini-btn del"
                      disabled={busy === p.id}
                      onClick={() => removeRow(p)}
                      data-testid={`admin-del-${p.id}`}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function AddPlayerForm({
  teams,
  defaultTeam,
  onDone,
  onError,
}: {
  teams: Array<{ id: string; name: string }>;
  defaultTeam: string;
  onDone: (data: { teams: CatalogTeam[]; edited?: boolean; message: string }) => void;
  onError: (e: string) => void;
}) {
  const [teamId, setTeamId] = useState(defaultTeam);
  const [nameKo, setNameKo] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [position, setPosition] = useState("CM");
  const [birthdate, setBirthdate] = useState("2004-01-01");
  const [attrs, setAttrs] = useState<Record<string, number>>(
    Object.fromEntries([...ATTRS, "potential"].map((a) => [a, a === "potential" ? 70 : 60])),
  );
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          nameKo: nameKo.trim(),
          nameEn: nameEn.trim() || undefined,
          birthdate,
          position,
          ...Object.fromEntries(ATTRS.map((a) => [a, attrs[a]])),
          potential: attrs.potential,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "추가 실패");
      onDone(data);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-add" data-testid="admin-add-form">
      <div className="admin-add-row">
        <label>
          팀
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)} data-testid="add-team">
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label>
          이름(한글)
          <input
            value={nameKo}
            onChange={(e) => setNameKo(e.target.value)}
            data-testid="add-name"
            placeholder="예: 김선수"
          />
        </label>
        <label>
          로마자(선택)
          <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="예: Kim Player" />
        </label>
        <label>
          주 포지션
          <select value={position} onChange={(e) => setPosition(e.target.value)} data-testid="add-position">
            {POSITIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          생년월일
          <input
            type="date"
            value={birthdate}
            onChange={(e) => setBirthdate(e.target.value)}
            data-testid="add-birthdate"
          />
        </label>
      </div>
      <div className="admin-add-row">
        {ATTRS.map((a) => (
          <label key={a}>
            {ATTR_KO[a]}
            <input
              className="num"
              type="number"
              value={attrs[a]}
              onChange={(e) => setAttrs((s) => ({ ...s, [a]: Number(e.target.value) }))}
            />
          </label>
        ))}
        <label>
          POT
          <input
            className="num"
            type="number"
            value={attrs.potential}
            onChange={(e) => setAttrs((s) => ({ ...s, potential: Number(e.target.value) }))}
          />
        </label>
      </div>
      <button
        className="primary-btn"
        onClick={submit}
        disabled={saving || !nameKo.trim()}
        data-testid="add-submit"
      >
        {saving ? "추가 중…" : "카탈로그에 추가"}
      </button>
    </div>
  );
}
