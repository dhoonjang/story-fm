"use client";
import { useEffect, useRef, useState } from "react";
import { FIELD, type LiveMatchFrame } from "@story-fm/domain";
import type { MatchView } from "@story-fm/engine";

const EVENT_LABEL: Record<string, string> = {
  goal: "골",
  shot: "슈팅",
  save: "선방",
  foul: "파울",
  injury: "부상",
  yellow_card: "경고",
  red_card: "퇴장",
  substitution: "교체",
  chance: "공격 무산",
  tactical_shift: "전술 변경",
  kickoff: "킥오프",
  half_time: "하프타임",
  extra_time_start: "연장 시작",
  extra_half_time: "연장 하프타임",
  full_time: "경기 종료",
};
export function LivePitch({
  frame,
  match,
  paused,
  blocked,
  error,
  onToggle,
}: {
  frame: LiveMatchFrame | null;
  match: MatchView;
  paused: boolean;
  blocked: boolean;
  error: string | null;
  onToggle: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const motion = useRef<{
    previous: LiveMatchFrame | null;
    current: LiveMatchFrame | null;
    at: number;
  }>({ previous: null, current: frame, at: 0 });
  const model = useRef(match);
  model.current = match;
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    motion.current = { previous: motion.current.current, current: frame, at: performance.now() };
  }, [frame]);
  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    const style = getComputedStyle(element);
    const palette = Object.fromEntries(
      [
        "grass",
        "stripe",
        "line",
        "goal",
        "selection",
        "shadow",
        "ours",
        "theirs",
        "our-outline",
        "their-outline",
        "number",
        "ball",
        "ball-shadow",
        "ball-outline",
      ].map((key) => [key, style.getPropertyValue(`--live-${key}`).trim()]),
    ) as Record<string, string>;
    let request = 0;
    const draw = (now: number) => {
      const rect = element.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
      }
      ctx.setTransform(width / FIELD.length, 0, 0, height / FIELD.width, 0, 0);
      ctx.fillStyle = palette["grass"]!;
      ctx.fillRect(0, 0, 105, 68);
      for (let stripe = 0; stripe < 10; stripe++) {
        if (stripe % 2) {
          ctx.fillStyle = palette["stripe"]!;
          ctx.fillRect(stripe * 10.5, 0, 10.5, 68);
        }
      }
      ctx.strokeStyle = palette["line"]!;
      ctx.lineWidth = 0.18;
      ctx.strokeRect(0.6, 0.6, 103.8, 66.8);
      ctx.beginPath();
      ctx.moveTo(52.5, 0.6);
      ctx.lineTo(52.5, 67.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(52.5, 34, 9.15, 0, Math.PI * 2);
      ctx.stroke();
      for (const end of [0, 1]) {
        ctx.strokeRect(end ? 88.5 : 0.6, 13.84, 15.9, 40.32);
        ctx.strokeRect(end ? 99.5 : 0.6, 24.84, 4.9, 18.32);
        ctx.fillStyle = palette["goal"]!;
        ctx.fillRect(end ? 104.4 : 0, 30.34, 0.6, 7.32);
        ctx.beginPath();
        ctx.arc(end ? 94 : 11, 34, 0.25, 0, Math.PI * 2);
        ctx.fill();
      }
      const { previous, current, at } = motion.current;
      if (current) {
        const blend = window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 1
          : Math.min(1, Math.max(0, (now - at) / 100));
        const same = previous?.matchId === current.matchId && current.tick >= previous.tick;
        const interpolate = (from: number | undefined, to: number) =>
          from === undefined || !same ? to : from + (to - from) * blend;
        const all = [...model.current.onPitch.home, ...model.current.onPitch.away];
        for (const player of current.players) {
          const old = previous?.players.find((p) => p.id === player.id);
          const x = interpolate(old?.x, player.x),
            y = interpolate(old?.y, player.y);
          const info = all.find((p) => p.id === player.id);
          const ours = player.side === (model.current.home.ours ? "home" : "away");
          if (selectedRef.current === player.id) {
            ctx.strokeStyle = palette["selection"]!;
            ctx.lineWidth = 0.35;
            ctx.beginPath();
            ctx.arc(x, y, 2.5, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = palette["shadow"]!;
          ctx.beginPath();
          ctx.ellipse(x + 0.25, y + 0.6, 1.55, 0.9, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = ours ? palette["ours"]! : palette["theirs"]!;
          ctx.beginPath();
          ctx.arc(x, y, 1.65, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = ours ? palette["our-outline"]! : palette["their-outline"]!;
          ctx.lineWidth = 0.22;
          ctx.stroke();
          const speed = Math.hypot(player.vx, player.vy);
          if (speed > 0.2) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + (player.vx / speed) * 2.25, y + (player.vy / speed) * 2.25);
            ctx.stroke();
          }
          ctx.fillStyle = palette["number"]!;
          ctx.font = "bold 1.65px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(info?.squadNumber ?? "·"), x, y + 0.1);
          if (selectedRef.current === player.id && info) {
            ctx.font = "1.65px sans-serif";
            ctx.fillStyle = palette["ball"]!;
            ctx.fillText(info.name, x, Math.max(3, y - 3.3));
          }
        }
        const x = interpolate(previous?.ball.x, current.ball.x),
          y = interpolate(previous?.ball.y, current.ball.y);
        ctx.fillStyle = palette["ball-shadow"]!;
        ctx.beginPath();
        ctx.ellipse(x + 0.3, y + 0.5, 0.7, 0.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = palette["ball"]!;
        ctx.strokeStyle = palette["ball-outline"]!;
        ctx.lineWidth = 0.18;
        ctx.beginPath();
        ctx.arc(x, y - current.ball.z * 0.7, 0.65, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      request = requestAnimationFrame(draw);
    };
    request = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(request);
  }, []);
  const seconds = Math.floor(frame?.seconds ?? match.minute * 60);
  const players = [...match.onPitch.home, ...match.onPitch.away];
  const name = (id: string) => players.find((p) => p.id === id)?.name ?? "";
  const events = (frame?.events ?? []).filter((e) => e.type !== "kickoff").slice(-5);
  return (
    <section className="live-pitch" aria-label="실시간 경기" data-testid="live-pitch">
      <div className="live-pitch-toolbar">
        <span className={`live-indicator${paused ? " paused" : ""}`} />
        <strong>
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </strong>
        <span role="status">
          {!frame && !error
            ? "경기장 연결 중"
            : error
              ? "연결 확인 필요"
              : frame?.finished
                ? "경기 종료"
                : frame?.interval
                  ? "하프타임"
                  : blocked
                    ? "지시·전술 편집 중"
                    : paused
                      ? "일시정지"
                      : "경기 진행 중"}
        </span>
        {!frame?.finished && (
          <button onClick={onToggle} disabled={blocked || !frame}>
            {frame?.interval || paused ? "재개" : "일시정지"}
          </button>
        )}
      </div>
      <div className="live-pitch-field">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${match.home.short} 대 ${match.away.short}, ${match.score.home} 대 ${match.score.away}, ${Math.floor(seconds / 60)}분`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * 105,
              y = ((e.clientY - r.top) / r.height) * 68;
            const hit = frame?.players.find((p) => Math.hypot(p.x - x, p.y - y) < 3);
            setSelected(hit?.id ?? null);
          }}
        />
      </div>
      <div className="live-pitch-teams">
        <span>{match.home.short} 골문</span>
        <span>{match.away.short} 골문</span>
      </div>
      <div className="live-pitch-footer">
        <select
          aria-label="경기장에서 선수 선택"
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value || null)}
        >
          <option value="">선수 선택</option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.squadNumber} · {p.name}
            </option>
          ))}
        </select>
        <span>선수를 누르면 이름을 볼 수 있습니다</span>
      </div>
      {error && (
        <p className="live-pitch-error" role="alert">
          {error}
        </p>
      )}
      <ol className="live-events" aria-label="최근 경기 사건">
        {events.map((event, i) => (
          <li key={`${event.minute}-${event.type}-${i}`}>
            <time>{event.minute}′</time>
            <b>{EVENT_LABEL[event.type] ?? event.type}</b>
            <span>{event.actors.map(name).filter(Boolean).join(" · ")}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
