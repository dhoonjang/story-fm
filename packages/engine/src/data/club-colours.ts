/**
 * 구단 대표색 — 1부 96팀의 공식 색 (team.md §3.1 · sources.md §7.5 원장).
 *
 * 출처 우선순위: 구단 공식 사이트의 CSS 토큰·브랜드 가이드 → 위키미디어 커먼즈 공식
 * 엠블럼 SVG의 fill → 위키백과 infobox → 집계 사이트(teamcolorcodes 등). 팀마다 두
 * 출처 이상을 대조했고, 집계 사이트의 반올림값과 옛 엠블럼 값은 공식 값으로 바로잡았다.
 * 각 줄의 꼬리 주석이 색 이름과 대조 출처 하나를 든다.
 *
 * ⚠️ **값은 공식 값 그대로다.** 어두운 화면에서 안 보이는 남색·검정은 여기서 밝히지
 * 않는다 — 화면이 `clubTonesOf`로 명도만 올린 사본을 쓴다 (ui/design-system.md §2).
 * `accent`가 빈 문자열인 구단은 유채색이 없다(흑백).
 *
 * 문장의 도형(방패·분할)은 여전히 id 해시다 — 엠블럼은 미탑재다 (sources.md §7.1).
 */
import type { ClubColours } from "@story-fm/domain";

export const CLUB_COLOURS: Readonly<Record<string, ClubColours>> = {
  // ── 프리미어리그 ──
  arsenal: { primary: "#e30613", secondary: "#ffffff", accent: "#e30613" }, // 빨강·흰 · https://resources.premierleague.com/premierleague/badges/t3.svg
  mancity: { primary: "#6cadde", secondary: "#00285d", accent: "#6cadde" }, // 하늘색·남색(흰 반바지) · https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=Manchester%20City
  manutd: { primary: "#db1d24", secondary: "#ffe500", accent: "#db1d24" }, // 빨강·노랑(흰 반바지·검 양말) · https://www.brandcolorcode.com/manchester-united
  liverpool: { primary: "#e31b23", secondary: "#ffffff", accent: "#e31b23" }, // 빨강·흰 · https://resources.premierleague.com/premierleague/badges/t14.svg
  astonvilla: { primary: "#480024", secondary: "#94bee5", accent: "#480024" }, // 클라렛·하늘색 · https://resources.premierleague.com/premierleague/badges/t7.svg
  bournemouth: { primary: "#ea0029", secondary: "#000000", accent: "#ea0029" }, // 빨강·검 · https://1000logos.net/afc-bournemouth-logo/
  chelsea: { primary: "#001489", secondary: "#ffffff", accent: "#001489" }, // 로열블루·흰 · https://res.cloudinary.com/chelsea-production/image/upload/c_fit,h_630,w_1200/v1/site-assets/Backgrounds/Screensaver
  newcastle: { primary: "#231f20", secondary: "#ffffff", accent: "#f0b83d" }, // 검·흰(엠블럼 금·하늘색) · https://www.brandcolorcode.com/newcastle-united
  sunderland: { primary: "#dc0714", secondary: "#ffffff", accent: "#dc0714" }, // 빨강·흰(검 반바지) · https://resources.premierleague.com/premierleague/badges/t56.svg
  brighton: { primary: "#004899", secondary: "#ffffff", accent: "#004899" }, // 파랑·흰 · https://resources-uk.yinzcam.com/soccer/shared/logos/fawsl_bha_dark.png
  brentford: { primary: "#c10000", secondary: "#ffffff", accent: "#c10000" }, // 빨강·흰(검 반바지) · https://www.brandcolorcode.com/brentford
  fulham: { primary: "#ffffff", secondary: "#000000", accent: "#e5231b" }, // 흰·검(엠블럼 빨강) · https://resources.premierleague.com/premierleague/badges/t54.svg
  everton: { primary: "#00009e", secondary: "#ffffff", accent: "#00009e" }, // 로열블루·흰 · https://www.brandcolorcode.com/everton
  leeds: { primary: "#ffffff", secondary: "#0058a2", accent: "#ffdf00" }, // 흰·파랑·노랑 · https://www.brandcolorcode.com/leeds-united
  crystalpalace: { primary: "#0055a5", secondary: "#ee2e24", accent: "#0055a5" }, // 빨강·파랑 · https://resources.premierleague.com/premierleague/badges/t31.svg
  nottingham: { primary: "#dd0000", secondary: "#ffffff", accent: "#dd0000" }, // 가리발디 레드·흰 · https://r2.thesportsdb.com/images/media/team/badge/1i2kvh1719918076.png
  tottenham: { primary: "#ffffff", secondary: "#000a3c", accent: "#000a3c" }, // 흰·남색 · https://resources.premierleague.com/premierleague/badges/t6.svg
  coventry: { primary: "#62b5e5", secondary: "#ffffff", accent: "#62b5e5" }, // 스카이블루·흰 · https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=Coventry%20City
  ipswich: { primary: "#0333a0", secondary: "#ffffff", accent: "#0333a0" }, // 파랑·흰 · https://resources.premierleague.com/premierleague/badges/t40.svg
  hull: { primary: "#f18a01", secondary: "#000000", accent: "#f18a01" }, // 앰버·검 · https://r2.thesportsdb.com/images/media/team/badge/fbqqda1601726113.png
  // ── 라리가 ──
  barcelona: { primary: "#a50044", secondary: "#004d98", accent: "#a50044" }, // 청홍(blaugrana) — 그라나(적갈)·파랑 · https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=Barcelona
  realmadrid: { primary: "#ffffff", secondary: "#febe10", accent: "#febe10" }, // 흰 / 금(엠블럼 왕관)·남색 #00529f · https://logos-world.net/real-madrid-logo/
  villarreal: { primary: "#ffe715", secondary: "#003c6c", accent: "#ffe715" }, // 노랑(groguet) / 남색 · https://villarrealcf.es/_next/static/chunks/edfebfe71db62398.css
  atletico: { primary: "#e8151e", secondary: "#ffffff", accent: "#e8151e" }, // 빨강·흰(rojiblanco) / 남색 #282a6f · http://web.archive.org/web/20250703102000/https://www.atleticodemadrid.com/css/manzanares_root.css
  betis: { primary: "#008835", secondary: "#ffffff", accent: "#008835" }, // 초록·흰(verdiblanco) · https://www.realbetisbalompie.es/media/img/graphics/new_logos/logo_horizontal.svg
  athletic: { primary: "#e0092c", secondary: "#ffffff", accent: "#e0092c" }, // 빨강·흰(rojiblanco) · https://web.archive.org/web/2026/https://www.athletic-club.eus/_astro/index.4Od6Tidy.css
  celta: { primary: "#6cace4", secondary: "#ffffff", accent: "#6cace4" }, // 하늘색(celeste)·흰 · https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams
  getafe: { primary: "#00369e", secondary: "#ffffff", accent: "#00369e" }, // 진파랑(azulón)·흰 · https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=Getafe
  rayo: { primary: "#ffffff", secondary: "#e21921", accent: "#e21921" }, // 흰 / 빨강 사선(franja roja) · https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=Rayo%20Vallecano
  valencia: { primary: "#ffffff", secondary: "#000000", accent: "#ff671f" }, // 흰·검 / 주황(엠블럼) · https://web.archive.org/web/2026/https://www.valenciacf.com/assets/front-css.css
  realsociedad: { primary: "#0055b3", secondary: "#ffffff", accent: "#0055b3" }, // 파랑·흰(txuri-urdin) · https://cdn.realsociedad.eus/Uploads/styles/rs.css
  espanyol: { primary: "#007cbf", secondary: "#ffffff", accent: "#007cbf" }, // 파랑·흰(blanquiazul) · https://www.rcdespanyol.com/assets/images/logo/emblem.svg
  sevilla: { primary: "#ffffff", secondary: "#d10000", accent: "#d10000" }, // 흰 / 빨강(엠블럼 좌측·소매) · https://sevillafc.es/favicon/android-chrome-512x512.png
  alaves: { primary: "#0032a0", secondary: "#ffffff", accent: "#0032a0" }, // 파랑·흰(albiazul) · https://deportivoalaves.com/styles.633ffcca5db72e44.css
  elche: { primary: "#006633", secondary: "#ffffff", accent: "#006633" }, // 초록·흰(franjiverde) · https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=Elche
  levante: { primary: "#d3003f", secondary: "#0062bf", accent: "#d3003f" }, // 적갈(granate)·파랑 반반(granota) · https://statics-maker.llt-services.com/lev/images/2023/01/24/xlarge/0c81dc1cd02f4b7ed22d845cc88fb94d.png
  osasuna: { primary: "#d60f26", secondary: "#00004d", accent: "#d60f26" }, // 빨강(rojillo) / 남색 · https://es.wikipedia.org/w/index.php?title=Club_Atlético_Osasuna&action=raw
  racing: { primary: "#ffffff", secondary: "#45ac34", accent: "#45ac34" }, // 흰·초록(verdiblanco) · https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams
  deportivo: { primary: "#0831b6", secondary: "#ffffff", accent: "#0831b6" }, // 파랑·흰(blanquiazul) · https://en.wikipedia.org/w/index.php?title=Deportivo_de_A_Coruña&action=raw
  malaga: { primary: "#0033a0", secondary: "#ffffff", accent: "#0033a0" }, // 파랑·흰(blanquiazul) · https://es.wikipedia.org/w/index.php?title=Málaga_Club_de_Fútbol&action=raw
  // ── 세리에 A ──
  inter: { primary: "#011ea0", secondary: "#000000", accent: "#011ea0" }, // 흑청(nerazzurri) — 파랑·검정 · https://www.inter.it/logo.png
  napoli: { primary: "#00abe7", secondary: "#ffffff", accent: "#00abe7" }, // 하늘색(azzurro)·흰 · https://sscnapoli.it/wp-content/themes/Nebula-child/style.css
  roma: { primary: "#990a2c", secondary: "#fbba00", accent: "#990a2c" }, // 적황(giallorossi) — 로마 레드·로마 옐로(금) · https://www.asroma.com/en
  como: { primary: "#153b65", secondary: "#ffffff", accent: "#153b65" }, // 남색(blu reale)·흰 · https://comofootball.com/img/logos/logo.png
  milan: { primary: "#e0071b", secondary: "#000000", accent: "#e0071b" }, // 적흑(rossoneri) — 빨강·검정 · https://www.acmilan.com/_next/static/chunks/0mq-dx8.vlvoi.css
  juventus: { primary: "#000000", secondary: "#ffffff", accent: "" }, // 흑백(bianconeri) · https://www.juventus.com/en/assets/css/base.css
  atalanta: { primary: "#0d68b1", secondary: "#000000", accent: "#0d68b1" }, // 흑청(nerazzurri) — 파랑·검정 · https://images.atalanta.it/image/private/t_q-best/v1779435088/prd/assets/brand/logo-atalanta-new.png
  bologna: { primary: "#8b2638", secondary: "#172a3c", accent: "#8b2638" }, // 적청(rossoblù) — 빨강·남색 · https://www.bolognafc.it/wp-content/themes/bolognafc/css/styles.css
  lazio: { primary: "#84d8f9", secondary: "#ffffff", accent: "#84d8f9" }, // 백청(biancocelesti) — 하늘색·흰 · https://www.sslazio.it/_next/static/css/c8982e7ee30c1d9f.css
  udinese: { primary: "#000000", secondary: "#ffffff", accent: "#9f804d" }, // 흑백(bianconeri) + 금색 테두리 · https://www.udinese.it/WebObjects/Udinese.woa/Contents/WebServerResources/img/logo-new.png
  sassuolo: { primary: "#1ea451", secondary: "#000000", accent: "#1ea451" }, // 흑녹(neroverdi) — 초록·검정 · https://www.sassuolocalcio.it/wp-content/uploads/base/sassuolo-calcio-v.svg
  torino: { primary: "#8e2532", secondary: "#ffffff", accent: "#8e2532" }, // 그라나타(granata, 석류 자갈색)·흰 · https://torinofc.it/sites/default/files/css/css_WN5Mou3o8cs5CCU_-SdkNwVC4yCUFe86fuenZINZR5U.css
  parma: { primary: "#29356d", secondary: "#facc21", accent: "#29356d" }, // 청황(gialloblù) — 파랑·노랑; 홈 킷은 흰 바탕 검정 십자(crociati) · https://www.parmacalcio1913.com/wp-content/themes/custom_theme/assets/css/main.css
  cagliari: { primary: "#a52838", secondary: "#002b49", accent: "#a52838" }, // 적청(rossoblù) — 빨강·남색 · https://cagliaricalcio.com/wp-content/themes/cagliari-theme/img/favicon/android-chrome-512x512.png
  fiorentina: { primary: "#5b28a1", secondary: "#ffffff", accent: "#5b28a1" }, // 보라(viola)·흰 + 빨강 백합 · https://www.acffiorentina.com/getContentAsset/a32c6871-9375-429b-a613-e8e2ebe19da0/fdc2628b-8d67-425c-b6d0-a02576381c81/logo.svg
  genoa: { primary: "#ae1919", secondary: "#00263e", accent: "#ae1919" }, // 적청(rossoblù) — 빨강·남색 + 금 그리핀 · https://genoacfc.it/wp-content/uploads/2023/06/logo-team-genoa.svg
  lecce: { primary: "#fce803", secondary: "#e10e14", accent: "#fce803" }, // 황적(giallorossi) — 노랑·빨강 · https://uslecce.it/wp-content/themes/uslecce/img/logo.png
  venezia: { primary: "#000000", secondary: "#ff6900", accent: "#ff6900" }, // 검정·주황·초록(arancioneroverdi) · https://www.veneziafc.it/_next/static/chunks/14jogjydcd2bq.css
  frosinone: { primary: "#ffdd00", secondary: "#004393", accent: "#ffdd00" }, // 황청(giallazzurri) — 노랑·파랑 · https://www.frosinonecalcio.com/wp-content/uploads/2021/09/cropped-logo-frosinone-270x270.png
  monza: { primary: "#e4032e", secondary: "#ffffff", accent: "#e4032e" }, // 빨강(Rosso Monza)·흰(biancorossi) · https://www.acmonza.com/images/logo/logo.png
  // ── 분데스리가 ──
  bayern: { primary: "#ed0037", secondary: "#ffffff", accent: "#ed0037" }, // 빨강·흰 (엠블럼 파랑) · https://web.archive.org/web/20260301173223id_/https://fcbayern.com/de
  dortmund: { primary: "#ffd900", secondary: "#000000", accent: "#ffd900" }, // 노랑·검 · https://www.bvb.de/etc.clientlibs/bvbweb/clientlibs/clientlib-site/resources/favicon/favicon-32x32.png
  leipzig: { primary: "#dd0741", secondary: "#ffffff", accent: "#dd0741" }, // 빨강·흰 (워드마크 남색) · https://www.fotmob.com/teams/178475/overview/rb-leipzig
  stuttgart: { primary: "#d30029", secondary: "#ffffff", accent: "#d30029" }, // 빨강·흰 (엠블럼 노랑·검) · https://www.fotmob.com/teams/10269/overview/vfb-stuttgart
  hoffenheim: { primary: "#0a4baf", secondary: "#ffffff", accent: "#0a4baf" }, // 파랑·흰 · https://s3.tsg-hoffenheim.de/public/Icons/favicon-neu.svg
  leverkusen: { primary: "#ff0000", secondary: "#000000", accent: "#ff0000" }, // 빨강·검 · https://www.bayer04.de/apple-touch-icon-180x180.png
  freiburg: { primary: "#e40521", secondary: "#000000", accent: "#e40521" }, // 빨강·검·흰 · https://www.scfreiburg.com/favicons/manifest.json
  frankfurt: { primary: "#e30615", secondary: "#000000", accent: "#e30615" }, // 빨강·검·흰 · https://design.eintracht.de/assets/css/main.min.css
  augsburg: { primary: "#d80e16", secondary: "#00462d", accent: "#d80e16" }, // 초록·빨강·흰 (엠블럼 노랑) · https://www.fcaugsburg.de/bundles/exozetfrontend/fca/img/logos/augsburg-logo.png
  mainz: { primary: "#ae0f0a", secondary: "#ffffff", accent: "#ae0f0a" }, // 빨강·흰 · https://commons.wikimedia.org/wiki/File:1._FSV_Mainz_05_logo.svg
  unionberlin: { primary: "#e30613", secondary: "#ffffff", accent: "#e30613" }, // 빨강·흰 (엠블럼 노랑) · https://fanartikel.union-zeughaus.de/
  gladbach: { primary: "#000000", secondary: "#ffffff", accent: "#7ab929" }, // 검·흰·초록 · https://shop.borussia.de/de-de
  hamburg: { primary: "#005aaa", secondary: "#ffffff", accent: "#005aaa" }, // 파랑·흰·검 (킷 빨강) · https://www.fotmob.com/teams/9790/overview/hamburger-sv
  koln: { primary: "#ff0000", secondary: "#ffffff", accent: "#ff0000" }, // 빨강·흰 (엠블럼 검) · https://fc.de/icons.svg
  werder: { primary: "#008149", secondary: "#ffffff", accent: "#008149" }, // 초록·흰 · https://web.archive.org/web/20251231192432id_/https://www.werder.de/_nuxt/icons.Dk2fFhTS.svg
  schalke: { primary: "#004b9c", secondary: "#ffffff", accent: "#004b9c" }, // 파랑(쾨니히스블라우)·흰 · https://schalke04.de/content/themes/fcschalke04/assets/images/apple-touch-icon.png
  elversberg: { primary: "#d2be8c", secondary: "#141414", accent: "#d2be8c" }, // 금·검·흰 · https://commons.wikimedia.org/wiki/File:SV_Elversberg_Wappen.png
  paderborn: { primary: "#0066b3", secondary: "#000000", accent: "#0066b3" }, // 파랑·검·흰 · https://www.scp07.de/favicon.ico
  // ── 리그 1 ──
  psg: { primary: "#004070", secondary: "#e30613", accent: "#004070" }, // 남색·빨강(·흰) · https://fr.wikipedia.org/wiki/Fichier:Logo_Paris_Saint-Germain_2024.svg · https://teamcolorcodes.com/paris-saint-germain-colors/
  lens: { primary: "#c31316", secondary: "#ffd500", accent: "#c31316" }, // 빨강(sang)·노랑(or) · https://hac.football/assets/images/logo-clubs/rcl.svg · https://en.wikipedia.org/wiki/File:RC_Lens_logo.svg
  lille: { primary: "#e01e13", secondary: "#ffffff", accent: "#e01e13" }, // 빨강·흰(·남색) · https://fr.wikipedia.org/wiki/Fichier:Logo_LOSC_Lille_2018.svg · https://hac.football/assets/images/logo-clubs/lil.svg
  lyon: { primary: "#ffffff", secondary: "#0f23aa", accent: "#0f23aa" }, // 흰·파랑·빨강 · https://hac.football/assets/images/logo-clubs/ol.svg · https://teamcolorcodes.com/lyon-colors/
  marseille: { primary: "#ffffff", secondary: "#0b61ac", accent: "#0b61ac" }, // 흰·파랑(·금) · https://www.om.fr/_next/static/immutable/media/logo-om-blue.32tlxxbh_ford.svg · https://simpdovtmiepsfii.public.blob.vercel-storage.com/team-logos/olympique-de-marseille-logo-digital-full-color-rgb.svg
  rennes: { primary: "#cf0c12", secondary: "#000000", accent: "#cf0c12" }, // 빨강·검(·흰) · https://www.staderennais.com/manifest.json · https://hac.football/assets/images/logo-clubs/ren.svg
  monaco: { primary: "#d50b34", secondary: "#ffffff", accent: "#d50b34" }, // 빨강·흰(·금) · https://fr.wikipedia.org/wiki/Fichier:Logo_AS_Monaco_FC_2021.svg · https://hac.football/assets/images/logo-clubs/asm.svg
  strasbourg: { primary: "#009fe3", secondary: "#ffffff", accent: "#009fe3" }, // 파랑·흰(·남색·빨강) · https://www.rcstrasbourgalsace.fr/wp-content/uploads/2019/06/Racing_Club_de_Strasbourg_Alsace_RC_Strasbourg_-_RCS_-_RCSA_logo_officiel.svg · https://hac.football/assets/images/logo-clubs/str.svg
  toulouse: { primary: "#3f2b56", secondary: "#ffffff", accent: "#74598f" }, // 보라(violet)·흰 · https://hac.football/assets/images/logo-clubs/tfc.svg · https://en.wikipedia.org/wiki/File:Toulouse_FC_2018_logo.svg
  lorient: { primary: "#ea670b", secondary: "#161412", accent: "#ea670b" }, // 주황(tango)·검 · https://www.fclorient.bzh/voy_content/uploads/2023/03/logo.svg · https://fr.wikipedia.org/wiki/Fichier:Logo_FC_Lorient_Bretagne-Sud.svg
  parisfc: { primary: "#001238", secondary: "#0395cb", accent: "#0395cb" }, // 남색(bleu marine)·하늘파랑 · https://hac.football/assets/images/logo-clubs/par.svg · https://fr.wikipedia.org/wiki/Fichier:Logo_Paris_FC_2024.svg
  brest: { primary: "#bf0016", secondary: "#ffffff", accent: "#bf0016" }, // 빨강·흰 · https://www.sb29.bzh/default/CMS/images/dist/header_logo.svg · https://hac.football/assets/images/logo-clubs/bre.svg
  angers: { primary: "#000000", secondary: "#ffffff", accent: "#b48b4b" }, // 검·흰(·금) · https://commons.wikimedia.org/wiki/File:Angers_Sporting_Club_de_l%27Ouest_logo.svg
  lehavre: { primary: "#0a152e", secondary: "#74c4fb", accent: "#74c4fb" }, // 하늘파랑(ciel)·남색(marine) · https://hac.football/site.webmanifest · https://hac.football/favicon.svg · https://boutique.hac.football/tenues-officielles/1203-9891-maillot-domicile-hac-2627.html
  auxerre: { primary: "#004ea2", secondary: "#ffffff", accent: "#004ea2" }, // 파랑·흰 · https://hac.football/assets/images/logo-clubs/aja.svg · https://fr.wikipedia.org/wiki/Fichier:Logo_AJ_Auxerre_-_1997.svg
  nice: { primary: "#ed1c24", secondary: "#231f20", accent: "#ed1c24" }, // 빨강·검(·금) · https://hac.football/assets/images/logo-clubs/nic.svg
  troyes: { primary: "#003169", secondary: "#ffffff", accent: "#006bb3" }, // 파랑·흰(·금) · https://www.estac.fr/ (HTML 인라인 --wp--preset--color--primary) · https://www.estac.fr/wp-content/uploads/2024/04/logo-estac.svg
  lemans: { primary: "#c30808", secondary: "#fabe01", accent: "#c30808" }, // 노랑(or)·빨강(sang) · https://shop.lemansfc.fr/12-produits-officiels · https://www.lemansfc.fr/vue/img/interface/logo_lemansfc.png · https://fr.wikipedia.org/wiki/Fichier:Logo_Le_Mans_FC_(2010).svg
};
