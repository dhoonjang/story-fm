/**
 * 수석코치 실명 시드 — **구단의 실제 수석코치**(assistant manager / assistant head
 * coach)를 그 팀을 맡았을 때 만나는 사람으로 쓴다.
 *
 * ⚠️ **라이선스 부채** (data-sourcing.md §7 · personas.md §4): 실명 인물에게 게임이
 * 지어낸 성격·대사를 붙이는 구조다. 부정적 실명 서사 금지 가드와 **세트로만** 운용하고
 * (GM·캐스터 프롬프트), 정식 출시 전에는 가명 전환이 필수다.
 *
 * **여기 없는 팀은 실명을 쓰지 않는다** — 팀 국적에 맞는 가상 이름으로 대체된다
 * (`persona.ts`). 표에 한 줄을 더하면 그 팀은 다음 새 게임부터 실명이 된다
 * (진행 중 세이브는 이미 만난 사람을 유지한다).
 *
 * **찾는 방법 — 영어 검색이 아니라 각국 위키 시즌 문서의 raw 위키텍스트다.**
 * 감독은 리그 공식 페이지가 전 구단을 한 표로 주지만 수석코치는 그런 집계가 없어
 * 오래 헤맸다. 결국 통한 경로는 이것뿐이었다:
 *
 *   it.wikipedia.org/wiki/{정식명}_2026-2027?action=raw        → organigramma `allenatore2`
 *   fr.wikipedia.org/wiki/Saison_2026-2027_du_{클럽}?action=raw → Encadrement technique
 *   es.wikipedia.org/wiki/Anexo:Temporada_2026-27_del_{클럽}?action=raw → Cuerpo técnico
 *   nl.wikipedia.org/wiki/{클럽}?action=raw                    → `Staf` 표 (EPL·분데스)
 *
 * `?action=raw`가 핵심이다 — 렌더된 문서를 읽으면 본문이 잘려 감독만 보이지만,
 * 위키텍스트는 인포박스가 앞에 와서 수석코치가 그대로 들어온다. 이탈리아 위키가
 * 가장 촘촘하다(시도한 13팀 중 12팀).
 *
 * **영어 위키에는 코칭스태프 절이 아예 없다.** EPL은 대신 **네덜란드어 위키**가
 * 클럽 문서에 `Staf` 표를 두어 그 구멍을 메운다. 다만 표마다 "Laatste update"가
 * 제각각이라 **날짜와 감독 교체를 함께 봐야 한다** — 감독이 바뀐 팀의 낡은 스태프는
 * 곧 틀린 이름이다(크리스탈 팰리스·본머스·브라이튼을 그래서 뺐다).
 *
 * ⚠️ **그래도 96팀은 못 채운다.** 이 표는 "언젠가 96줄이 될 목록"이 아니라 **확인된
 * 것만 담는 부분 집합**이다 — 없는 팀은 자동으로 국적 기반 가상 이름을 쓴다.
 *
 * 기준 시점: **2026-27 시즌**. 출처는 각 항목의 주석에 남긴다.
 */
export const HEAD_COACH_NAMES: Record<string, string> = {
  // ── 프리미어리그 (영어권 보도 — 클럽별 검색) ──
  // 아르테타의 오른팔 — 2019년부터 함께한다 (arseblog 2026-01 · arsenalinsider)
  arsenal: "알베르트 스투이벤베르흐",
  // 이라올라 감독과 함께 부임 (ESPN · rousingthekop 2026-05)
  liverpool: "이니고 페레스",
  // 클롭의 전 수석 — 과르디올라 코칭스태프로 합류 (fotmob)
  mancity: "펩 레인더르스",
  // 캐릭 감독 체제의 수석 (2026-27 맨유 시즌 문서)
  manutd: "스티브 홀랜드",
  // 사비 알론소 감독 체제의 수석 (2026-27 첼시 시즌 문서)
  chelsea: "캘럼 맥팔레인",
  // 데 제르비 감독과 함께 (ESPN · Training Ground Guru 2026)
  tottenham: "브루노 살토르",
  // 2026년 7월 합류 — 발렌시아·셰필드 U·오사수나 경력 (avfc.co.uk 2026-07-02)
  astonvilla: "호세 마리아 산스",
  // 아래 6팀은 nl.wikipedia 클럽 문서의 `Staf` 표에서 (영어 위키엔 이 절이 없다).
  // 표마다 "Laatste update"가 달라 **감독 교체가 확인된 팀은 넣지 않았다** —
  // 감독이 바뀌면 스태프도 바뀌므로 낡은 이름이 곧 틀린 이름이 된다.
  newcastle: "플로렌스 코흐", // Florens Koch — 2026 야이슬레와 함께 알아흘리에서
  fulham: "케빈 카르데이로", // Kevin Cardeiro — 2026-07 갱신, 레알 마드리드 출신
  everton: "레이턴 베인스", // Leighton Baines — 모예스 체제
  nottingham: "스티브 스톤", // Steve Stone — 계약 2027
  leeds: "크리스토퍼 욘", // Christopher John — 계약 2027
  brentford: "마틴 드루리", // Martin Drury

  // ── 분데스리가 ──
  // 콤파니 코칭스태프 (ran.de · spox)
  bayern: "르네 마리치",
  leipzig: "톰 치혼", // Tom Cichon — 계약 2027 (nl.wikipedia)

  // ── 라리가 (es.wikipedia `Anexo:Temporada 2026-27 …` — Cuerpo técnico) ──
  // 무리뉴가 페네르바흐체에서 데려온 segundo entrenador (okdiario · eldesmarque 2026-07)
  realmadrid: "주앙 트랄량",
  // 플리크의 오랜 수석 (Marcus Sorg)
  barcelona: "마르쿠스 조르크",

  // ── 세리에A (it.wikipedia 시즌 문서 — organigramma의 `allenatore2`) ──
  // 치부 체제의 vice allenatore — 인테르 선수 출신 (LaPresse · Sky Sport)
  inter: "알렉산다르 콜라로프",
  // 알레그리를 12년째 따라다니는 vice (ilmattino · napolinetwork 2026-05)
  napoli: "마르코 란두치",
  // 아모링 체제 (Carlos Fernandes)
  milan: "카를루스 페르난데스",
  // 스팔레티의 오랜 수석 (Marco Domenichini)
  juventus: "마르코 도메니키니",
  roma: "툴리오 그리티", // Tullio Gritti
  lazio: "루이지 리초", // Luigi Riccio
  fiorentina: "라파엘레 롱고", // Raffaele Longo
  bologna: "안드레아 타로치", // Andrea Tarozzi
  torino: "디에고 라이몬디", // Diego Raimondi
  udinese: "프셰미스와프 마웨츠키", // Przemysław Malecki (POL)
  como: "다니엘 긴도스", // Daniel Guindos López (ESP)
  genoa: "기예르모 자코마시", // Guillermo Giacomazzi (URY)
  parma: "후이 사 레모스", // Rui Sá Lemos (PRT)

  // ── 리그앙 (fr.wikipedia `Saison 2026-2027 …` — Encadrement technique) ──
  psg: "라펠 폴", // Rafel Pol — 루이스 엔리케의 오랜 수석
  marseille: "제레미 브레셰", // Jérémie Bréchet
  monaco: "이반 팔랑코", // Iván Palanco (ESP)
};

/** 이 팀은 실명 수석코치를 아는가 */
export function realCoachNameOf(teamId: string): string | null {
  return HEAD_COACH_NAMES[teamId] ?? null;
}
