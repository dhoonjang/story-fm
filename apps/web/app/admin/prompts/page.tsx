"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface Prompts {
  gm: string;
  match: string;
}

interface PromptPayload {
  prompts: Prompts;
  edited: boolean;
  message?: string;
  error?: string;
}

interface SkillEntry {
  name: string;
  label: string;
  group: string;
  readOnly: boolean;
  description: string;
}

interface SkillPayload {
  skills: SkillEntry[];
  edited: boolean;
  message?: string;
  error?: string;
}

const EMPTY: Prompts = { gm: "", match: "" };

export default function PromptAdminPage() {
  const [prompts, setPrompts] = useState<Prompts>(EMPTY);
  const [saved, setSaved] = useState<Prompts>(EMPTY);
  const [edited, setEdited] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [savedSkills, setSavedSkills] = useState<SkillEntry[]>([]);
  const [skillsEdited, setSkillsEdited] = useState(false);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [skillsMessage, setSkillsMessage] = useState<string | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  const applyPayload = useCallback((data: PromptPayload) => {
    setPrompts(data.prompts);
    setSaved(data.prompts);
    setEdited(data.edited);
    setMessage(data.message ?? null);
    setError(null);
    setLoaded(true);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/prompts", { cache: "no-store" });
      const data = (await response.json()) as PromptPayload;
      if (!response.ok || data.error) throw new Error(data.error ?? "프롬프트 조회 실패");
      applyPayload(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoaded(true);
    }
  }, [applyPayload]);

  useEffect(() => {
    void load();
  }, [load]);

  const applySkillsPayload = useCallback((data: SkillPayload) => {
    setSkills(data.skills);
    setSavedSkills(data.skills);
    setSkillsEdited(data.edited);
    setSkillsMessage(data.message ?? null);
    setSkillsError(null);
    setSkillsLoaded(true);
  }, []);

  const loadSkills = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/skills", { cache: "no-store" });
      const data = (await response.json()) as SkillPayload;
      if (!response.ok || data.error) throw new Error(data.error ?? "스킬 설명 조회 실패");
      applySkillsPayload(data);
    } catch (cause) {
      setSkillsError(cause instanceof Error ? cause.message : String(cause));
      setSkillsLoaded(true);
    }
  }, [applySkillsPayload]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const dirty = useMemo(
    () => prompts.gm !== saved.gm || prompts.match !== saved.match,
    [prompts, saved],
  );
  const valid = prompts.gm.trim().length > 0 && prompts.match.trim().length > 0;
  const skillsDirty = useMemo(
    () =>
      skills.length === savedSkills.length &&
      skills.some(
        (skill, index) =>
          skill.name !== savedSkills[index]?.name ||
          skill.description !== savedSkills[index]?.description,
      ),
    [skills, savedSkills],
  );
  const skillsValid =
    skills.length > 0 && skills.every((skill) => skill.description.trim().length > 0);

  async function save() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/admin/prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prompts),
      });
      const data = (await response.json()) as PromptPayload;
      if (!response.ok || data.error) throw new Error(data.error ?? "프롬프트 저장 실패");
      applyPayload(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (
      !window.confirm(
        "저장된 프롬프트 편집을 삭제하고 코드 기본값으로 되돌릴까요?\n다음 실모드 턴부터 적용됩니다.",
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/admin/prompts", { method: "DELETE" });
      const data = (await response.json()) as PromptPayload;
      if (!response.ok || data.error) throw new Error(data.error ?? "프롬프트 초기화 실패");
      applyPayload(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveSkills() {
    setSkillsBusy(true);
    setSkillsMessage(null);
    setSkillsError(null);
    try {
      const response = await fetch("/api/admin/skills", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          descriptions: Object.fromEntries(skills.map((skill) => [skill.name, skill.description])),
        }),
      });
      const data = (await response.json()) as SkillPayload;
      if (!response.ok || data.error) throw new Error(data.error ?? "스킬 설명 저장 실패");
      applySkillsPayload(data);
    } catch (cause) {
      setSkillsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSkillsBusy(false);
    }
  }

  async function resetSkills() {
    if (
      !window.confirm(
        "저장된 스킬 설명 편집을 삭제하고 코드 기본값으로 되돌릴까요?\n다음 실모드 턴부터 적용됩니다.",
      )
    ) {
      return;
    }
    setSkillsBusy(true);
    setSkillsMessage(null);
    setSkillsError(null);
    try {
      const response = await fetch("/api/admin/skills", { method: "DELETE" });
      const data = (await response.json()) as SkillPayload;
      if (!response.ok || data.error) throw new Error(data.error ?? "스킬 설명 초기화 실패");
      applySkillsPayload(data);
    } catch (cause) {
      setSkillsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSkillsBusy(false);
    }
  }

  return (
    <main className="admin prompt-admin">
      <div className="admin-head">
        <div>
          <Link href="/admin" className="back-link">
            ← 선수 카탈로그
          </Link>
          <h1>LLM 기본 프롬프트</h1>
        </div>
        <div className="admin-head-actions">
          {edited && (
            <span className="badge warn" data-testid="prompts-edited">
              프롬프트 커스텀
            </span>
          )}
          <button
            className="ghost-btn"
            onClick={reset}
            disabled={busy || (!edited && !dirty)}
            data-testid="prompts-reset"
          >
            코드 기본값으로
          </button>
          <button
            className="primary-btn prompt-save"
            onClick={save}
            disabled={!loaded || busy || !dirty || !valid}
            data-testid="prompts-save"
          >
            {busy ? "처리 중…" : "저장"}
          </button>
        </div>
      </div>

      <p className="hint prompt-hint">
        저장하면 다음 <b>실모드 LLM 턴부터 모든 게임에 즉시 적용</b>됩니다. 진행 중인 세이브도 새
        프롬프트를 사용하며, mock 모드는 규칙 기반이라 영향을 받지 않습니다. 프롬프트가 바뀐 뒤 첫
        호출에서는 캐시가 새로 형성됩니다. 내용의 의미는 자동 검증하지 않으므로 @출력 문법이나 도구
        사용 규칙을 제거하면 게임 진행이 깨질 수 있습니다.
      </p>

      {message && (
        <div className="admin-msg ok" data-testid="prompts-msg">
          {message}
        </div>
      )}
      {error && (
        <div className="admin-msg err" data-testid="prompts-error">
          {error}
        </div>
      )}

      {loaded && !error && (
        <div className="prompt-grid">
          <PromptEditor
            id="gm"
            title="GM · 메인 채팅"
            description="일상 서사, 감독 의도 해석, 조회·훈련·전술·판정 규칙"
            value={prompts.gm}
            onChange={(gm) => setPrompts((current) => ({ ...current, gm }))}
          />
          <PromptEditor
            id="match"
            title="매치 캐스터 · 경기 진행"
            description="경기 사건 결정, 중계, 정지점 진행, 장부 기록 규칙"
            value={prompts.match}
            onChange={(match) => setPrompts((current) => ({ ...current, match }))}
          />
        </div>
      )}

      <section className="skill-admin-section" data-testid="skill-admin">
        <div className="skill-section-head">
          <div>
            <h2>스킬 설명</h2>
            <p>
              모델이 스킬을 언제·어떻게 사용할지 판단하는 설명입니다. 이름·입력 스키마·실행 로직은
              코드에 고정되어 있습니다.
            </p>
          </div>
          <div className="admin-head-actions">
            {skillsEdited && (
              <span className="badge warn" data-testid="skills-edited">
                스킬 설명 커스텀
              </span>
            )}
            <button
              className="ghost-btn"
              onClick={resetSkills}
              disabled={skillsBusy || (!skillsEdited && !skillsDirty)}
              data-testid="skills-reset"
            >
              코드 기본값으로
            </button>
            <button
              className="primary-btn prompt-save"
              onClick={saveSkills}
              disabled={!skillsLoaded || skillsBusy || !skillsDirty || !skillsValid}
              data-testid="skills-save"
            >
              {skillsBusy ? "처리 중…" : "스킬 설명 저장"}
            </button>
          </div>
        </div>

        {skillsMessage && (
          <div className="admin-msg ok" data-testid="skills-msg">
            {skillsMessage}
          </div>
        )}
        {skillsError && (
          <div className="admin-msg err" data-testid="skills-error">
            {skillsError}
          </div>
        )}

        {skillsLoaded && !skillsError && (
          <div className="skill-grid">
            {skills.map((skill) => (
              <SkillEditor
                key={skill.name}
                skill={skill}
                onChange={(description) =>
                  setSkills((current) =>
                    current.map((item) =>
                      item.name === skill.name ? { ...item, description } : item,
                    ),
                  )
                }
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function PromptEditor({
  id,
  title,
  description,
  value,
  onChange,
}: {
  id: "gm" | "match";
  title: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <section className="prompt-card">
      <div className="prompt-card-head">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span>{value.length.toLocaleString()}자</span>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-label={`${title} 프롬프트`}
        data-testid={`prompt-${id}`}
      />
    </section>
  );
}

function SkillEditor({
  skill,
  onChange,
}: {
  skill: SkillEntry;
  onChange: (description: string) => void;
}) {
  return (
    <article className="skill-card">
      <div className="skill-card-head">
        <div>
          <h3>{skill.label}</h3>
          <code>{skill.name}</code>
        </div>
        <div className="skill-badges">
          <span>{skill.group}</span>
          {skill.readOnly && <span>읽기 전용</span>}
        </div>
      </div>
      <textarea
        value={skill.description}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-label={`${skill.label} 스킬 설명`}
        data-testid={`skill-${skill.name}`}
      />
      <div className="skill-char-count">{skill.description.length.toLocaleString()}자</div>
    </article>
  );
}
