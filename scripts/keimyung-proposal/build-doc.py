"""임상수기센터 제출용 상세 문서(HTML, 인쇄 대응 A4) 생성.
부록 A(주호소·증례 목록)와 부록 B(수면장애 채점표)는 services/cpx/data 에서 읽어 채운다."""
import glob
import html
import json
import os
from collections import OrderedDict

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(ROOT, '..', '..')
DATA = os.path.join(REPO, 'services', 'cpx', 'data', 'cpx')
OUT = os.path.join(REPO, 'docs', 'keimyung-proposal', '렉처링크_CPX_임상수기센터_상세문서.html')

esc = html.escape

# ── 데이터 수집 ──────────────────────────────────────────────
by_cc = OrderedDict()
for f in sorted(glob.glob(os.path.join(DATA, 'cases', '*', '*.json'))):
    d = json.load(open(f, encoding='utf-8'))
    by_cc.setdefault(d['category'], []).append(d.get('targetDiagnosis', '').split(' (')[0])
cc_rows = sorted(by_cc.items(), key=lambda kv: (-len(kv[1]), kv[0]))
n_cases = sum(len(v) for v in by_cc.values())
n_cc = len(by_cc)

sleep = json.load(open(os.path.join(DATA, 'common', 'canonical_rubric.sleep.json'), encoding='utf-8'))
chest = json.load(open(os.path.join(DATA, 'common', 'canonical_rubric.chest_pain.json'), encoding='utf-8'))
mi = json.load(open(os.path.join(DATA, 'cases', 'chest_pain', 'acute_mi_rule.json'), encoding='utf-8'))


def section_rows(rubric):
    return [(s['name'], s.get('weightPercent'), len(s.get('items', []))) for s in rubric['sections']]


def appendix_a():
    out = []
    for cc, dxs in cc_rows:
        out.append(f'<tr><td>{esc(cc)}</td><td>{esc(" · ".join(dxs))}</td><td>{len(dxs)}</td></tr>')
    return '\n'.join(out)


def appendix_b(a, b):
    out = []
    for s in sleep['sections'][a:b]:
        out.append(f'<tr class="sec"><td colspan="3">{esc(s["name"])} · 배점 {s.get("weightPercent")} · {len(s.get("items", []))}항목</td></tr>')
        for it in s.get('items', []):
            out.append(f'<tr><td class="mono">{esc(it.get("id", ""))}</td><td>{esc(it.get("label") or it.get("text") or "")}</td><td><span class="box"></span><span class="box"></span><span class="box"></span></td></tr>')
    return '\n'.join(out)


def dist_rows():
    return '\n'.join(f'<tr><td>{esc(cc)}</td><td>{esc(" · ".join(dxs[:4]))}{" …" if len(dxs) > 4 else ""}</td><td>{len(dxs)}</td></tr>' for cc, dxs in cc_rows[:8])


mi_pe = '\n'.join(f'<tr><td>{esc(p["item"])}</td><td>{esc(p["method"])}</td><td>{esc(p["expectedFinding"])}</td></tr>' for p in mi['physicalExamRule'])
mi_must = ''.join(f'<li>{esc(x)}</li>' for x in mi['scenarioRule']['mustInclude'])
mi_absent = ''.join(f'<li>{esc(x)}</li>' for x in mi['scenarioRule']['mustAbsent'])
mi_edu = ''.join(f'<li>{esc(x)}</li>' for x in mi['evaluationUse']['educationTopics'])
chest_secs = ''.join(f'<tr><td>{esc(n)}</td><td>{c}</td><td>{w}</td></tr>' for n, w, c in section_rows(chest))
sleep_secs = ''.join(f'<tr><td>{esc(n)}</td><td>{c}</td><td>{w}</td></tr>' for n, w, c in section_rows(sleep))

TEMPLATE = r'''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>렉처링크 CPX — 의학 검수 및 협약 제안서</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{--cream:#FFFAF7;--mint:#B5EFC6;--mint-3:#EAF9EE;--ink:#2A2A2A;--ink-2:#514149;--ink-3:#7A7176;--line:#514149;--soft:#E4DCD8;--green:#1B9E3A;--red:#E0312D;--white:#fff}
*{box-sizing:border-box}
html{background:#EDE8E4}
body{margin:0;font-family:'Noto Sans KR','Pretendard','Apple SD Gothic Neo',sans-serif;color:var(--ink);line-height:1.7;word-break:keep-all;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{margin:0;font-weight:900;letter-spacing:-.02em;line-height:1.3}
p{margin:0}
.mono{font-family:'IBM Plex Mono',monospace;font-size:.85em;color:var(--ink-3)}
.g{color:var(--green)}.r{color:var(--red)}

/* 화면: A4 쪽을 세로로 쌓아 보여준다 */
.sheet{background:var(--white);width:210mm;min-height:297mm;margin:12mm auto;padding:18mm 18mm 16mm;position:relative;box-shadow:0 2px 10px rgba(81,65,73,.12);display:flex;flex-direction:column;gap:5mm}
.sheet.cover{background:linear-gradient(115deg,var(--mint) 0%,var(--mint) 40%,#D6F5DF 52%,var(--mint-3) 62%,var(--cream) 75%)}
.hd{display:flex;justify-content:space-between;font-size:9pt;color:var(--ink-3);border-bottom:1px solid var(--line);padding-bottom:2mm}
.ft{margin-top:auto;display:flex;justify-content:space-between;font-size:8.5pt;color:var(--ink-3);border-top:1px solid var(--soft);padding-top:2mm}
.sheet h2{font-size:20pt;margin-top:2mm}
.sheet h3{font-size:12.5pt;margin-top:3mm;font-weight:700}
.lead{font-size:10.5pt;color:var(--ink-2)}
.body{font-size:10pt;color:var(--ink-2)}
.body b{color:var(--ink);font-weight:700}
ul.body{margin:0;padding-left:5mm}
ul.body li{margin:1mm 0}
table{width:100%;border-collapse:collapse;font-size:9.5pt}
th,td{border-bottom:1px solid var(--soft);padding:1.8mm 2mm;text-align:left;vertical-align:top;color:var(--ink-2)}
th{background:var(--mint-3);color:var(--ink);font-weight:700}
td:last-child,th:last-child{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
table.left td:last-child,table.left th:last-child{text-align:left;white-space:normal}
tr.sec td{background:var(--mint-3);font-weight:700;color:var(--ink);text-align:left}
.box{display:inline-block;width:3.2mm;height:3.2mm;border:1px solid var(--ink-2);margin-left:1.5mm;vertical-align:middle;border-radius:.5mm}
.callout{border-left:1mm solid var(--green);background:var(--mint-3);padding:3mm 4mm;font-size:9.5pt;color:var(--ink-2)}
.callout.red{border-left-color:var(--red);background:#FBEDEC}
.callout b{color:var(--ink)}
.kv{display:grid;grid-template-columns:28mm 1fr;gap:1.5mm 4mm;font-size:9.8pt}
.kv b{color:var(--ink)}.kv span{color:var(--ink-2)}
.fig{border:1px dashed #B9B0AC;background:repeating-linear-gradient(135deg,transparent 0 5px,#F1ECE8 5px 10px);min-height:55mm;display:flex;align-items:center;justify-content:center;font-family:'IBM Plex Mono',monospace;font-size:9pt;color:var(--ink-3);text-align:center;padding:4mm}
.fig.short{min-height:38mm}
.toc{display:grid;grid-template-columns:10mm 1fr 10mm;gap:1.6mm 3mm;font-size:10pt}
.toc .n{font-family:'IBM Plex Mono',monospace;color:var(--ink-3)}.toc .p{text-align:right;color:var(--ink-3)}
.cover-kicker{font-size:11pt;color:var(--ink-2);margin-top:30mm}
.cover-title{font-size:30pt;font-weight:900;line-height:1.2;margin-top:4mm}
.cover-sub{font-size:15pt;font-weight:700;color:var(--ink-2);margin-top:3mm}
.cover-meta{border-top:1px solid var(--line);margin-top:14mm;padding-top:5mm;display:grid;grid-template-columns:18mm 1fr;gap:2mm 4mm;font-size:10.5pt}
.cover-meta b{font-weight:700}
.two{display:grid;grid-template-columns:1fr 1fr;gap:5mm}
.steps{display:grid;grid-template-columns:1fr 1fr 1fr;gap:3mm}
.step{border-top:1.2mm solid var(--mint);background:var(--mint-3);padding:3mm}
.step.on{border-top-color:var(--green)}
.step .k{font-family:'IBM Plex Mono',monospace;font-size:8pt;color:var(--ink-3)}
.step .t{font-weight:700;font-size:11pt;margin-top:1mm}
.step .d{font-size:9pt;color:var(--ink-2);margin-top:1mm}
.sheet.dense{gap:3mm}.sheet.dense .body,.sheet.dense .kv,.sheet.dense .callout{font-size:9pt}.sheet.dense td,.sheet.dense th{padding:1.2mm 2mm}.sheet.dense h3{margin-top:1mm}
.fn{font-size:8.5pt;color:var(--ink-3);border-top:1px solid var(--soft);padding-top:2mm}
.printbar{position:sticky;top:0;z-index:5;background:var(--ink);color:#fff;font-size:12px;padding:8px 16px;display:flex;gap:14px;align-items:center}
.printbar button{background:var(--green);color:#fff;border:0;padding:6px 12px;border-radius:4px;font:inherit;cursor:pointer}
@media print{
  @page{size:A4;margin:0}
  html{background:#fff}
  .printbar{display:none}
  .sheet{margin:0;box-shadow:none;width:210mm;height:297mm;min-height:0;break-after:page;page-break-after:always}
  .sheet:last-child{break-after:auto;page-break-after:auto}
  .sheet.cover{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  th,tr.sec td,.callout,.step{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
@media (max-width:820px){.sheet{width:auto;margin:0;padding:8mm;min-height:0}.two,.steps{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="printbar"><span>인쇄본: 브라우저 인쇄 → PDF 저장(A4, 배경 그래픽 포함). 쪽 나눔은 절 단위로 고정되어 있습니다.</span><button onclick="window.print()">인쇄 / PDF 저장</button></div>

<!-- 표지 -->
<section class="sheet cover">
  <p class="cover-kicker">계명대학교 의과대학 임상수기센터 제출</p>
  <h1 class="cover-title">렉처링크 CPX<br>의학 검수 및 협약 제안서</h1>
  <p class="cover-sub">AI 표준화 환자와 혼자 하는 진료수행 연습 —<br>무엇을 만들었고, 무엇을 검수받고 싶은가</p>
  <div class="cover-meta">
    <b>제안</b><span>렉처링크 개발팀 · 전재현, 장유림 (계명대학교 의학과)</span>
    <b>요청</b><span>CPX 시나리오·채점표 의학 검수, 정식 협약 논의 개시</span>
    <b>일자</b><span>2026년 9월</span>
    <b>최신본</b><span>lecturelink.kro.kr (이 문서의 갱신본은 웹에서 확인하실 수 있습니다)</span>
  </div>
  <h3 style="margin-top:10mm">차례</h3>
  <div class="toc">
    <span class="n">01</span><span>렉처링크 CPX란 — 한 번의 연습</span><span class="p">3</span>
    <span class="n">02</span><span>시나리오 구성 — 주호소 __N_CC__ · 증례 __N_CASES__</span><span class="p">4</span>
    <span class="n">03</span><span>증례 한 건의 해부</span><span class="p">5</span>
    <span class="n">04</span><span>표준화 환자 구현 — 환자 역할의 규칙</span><span class="p">6</span>
    <span class="n">05</span><span>신체진찰 구현</span><span class="p">7</span>
    <span class="n">06</span><span>채점표 구조</span><span class="p">8</span>
    <span class="n">07</span><span>결과 화면과 피드백</span><span class="p">9</span>
    <span class="n">08</span><span>자체 검증 결과와 한계</span><span class="p">10</span>
    <span class="n">09</span><span>의학 검수 요청서</span><span class="p">11</span>
    <span class="n">10</span><span>협약 제안</span><span class="p">12</span>
    <span class="n">A</span><span>부록 A · 주호소 __N_CC__개와 증례 __N_CASES__개 목록</span><span class="p">13</span>
    <span class="n">B</span><span>부록 B · 수면장애 채점표 전문</span><span class="p">15</span>
  </div>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>1</span></div>
</section>

<!-- 00 요약 -->
<section class="sheet">
  <div class="hd"><span>00 · 요약과 요청</span><span>LectureLink CPX</span></div>
  <h2>이 한 쪽만 읽으셔도 됩니다</h2>
  <p class="lead">렉처링크 CPX는 학생 한 명이 혼자서, 국시원 실기시험과 같은 12분 안에 음성으로 문진하고 부위별 신체진찰을 요청하고 환자에게 설명한 뒤 즉시 채점 결과를 받는 연습 도구입니다. 계명의대 의학과 학생 두 명이 만들었고 2026년 7월부터 운영 중입니다.</p>
  <div class="two">
    <div class="callout"><b>만든 것</b><br>국시원 공개 CPX 항목표의 주호소 __N_CC__개 전부에 대해 감별진단별 증례 __N_CASES__개, 주호소별 채점표 54종, 표준화 환자의 행동 규칙, 규칙 기반 채점.</div>
    <div class="callout red"><b>증명하지 못한 것</b><br>증례의 병력·소견이 의학적으로 정확한지, 채점표가 임상적으로 타당한지. 임상 검수를 마친 증례는 __N_CASES__개 중 0건입니다.</div>
  </div>
  <h3>부탁드리는 것 — 의학 검수 3단계</h3>
  <div class="steps">
    <div class="step on"><p class="k">1단계 · 약 2주</p><p class="t">채점표 정본 대조</p><p class="d">센터 채점표 1~2종과 항목 단위 비교. 소요 약 2시간.</p></div>
    <div class="step"><p class="k">2단계 · 약 4주</p><p class="t">증례 블라인드 검수</p><p class="d">층화 추출 표본 약 30건을 검수 화면에서. 소요 약 10시간.</p></div>
    <div class="step"><p class="k">3단계 · 약 6주</p><p class="t">학생 파일럿</p><p class="d">센터 실습 전 자율 연습, 결과 공동 분석.</p></div>
  </div>
  <p class="body">검수 화면·표본 추출·수정 반영·검수 이력 보관은 저희가 준비합니다. 센터에서는 <b>판단</b>만 해 주시면 됩니다. 오늘 여쭙는 것은 한 가지 — <b>정식 협약 논의를 시작해 주시겠습니까.</b></p>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>2</span></div>
</section>

<!-- 01 -->
<section class="sheet">
  <div class="hd"><span>01 · 렉처링크 CPX란</span><span>LectureLink CPX</span></div>
  <h2>한 번의 연습은 이렇게 흘러갑니다</h2>
  <p class="lead">학생이 증례를 고르거나 무작위로 받고, 12분 타이머가 시작됩니다. 이후 흐름은 실제 CPX 진료실과 같습니다.</p>
  <table class="left">
    <tr><th style="width:22mm">단계</th><th>학생이 하는 일</th><th>환자 쪽에서 일어나는 일</th></tr>
    <tr><td>진료 시작</td><td>자기소개, 환자 확인, 진료 목적 안내</td><td>환자가 이름·나이를 확인해 주고 주호소를 한 문장으로 말함</td></tr>
    <tr><td>병력청취</td><td>음성(또는 자판)으로 질문</td><td>물어본 범위 안에서만 한 문장으로 답함. 묻지 않은 핵심 단서는 말하지 않음</td></tr>
    <tr><td>신체진찰</td><td>부위·항목을 골라 진찰 요청, 진찰 전 설명·동의</td><td>환자가 자세를 바꾸는 등 행동 반응 → 객관 소견 카드 제시(정상/이상)</td></tr>
    <tr><td>환자교육</td><td>추정 진단·검사·치료 계획·주의사항 설명</td><td>이해 여부·걱정·추가 질문을 환자 입장에서 표현</td></tr>
    <tr><td>종료·채점</td><td>12분 종료 또는 직접 마침</td><td>채점표 항목마다 충족·부분·미충족과 대화 근거가 붙은 결과 제시</td></tr>
  </table>
  <div class="two">
    <div class="fig">그림 1-1. 음성 문진 화면 캡처</div>
    <div class="fig">그림 1-2. 채점 결과 화면 캡처</div>
  </div>
  <p class="body">연습 시간은 실전 12분이 기본이며 11분 30초·11분 단축 연습도 고릅니다. 완료 기록은 학생별로 저장되어 지난 연습의 점수와 놓친 항목을 다시 볼 수 있습니다.</p>
  <p class="fn">※ 환자 역할은 음성 대화형 AI가 맡습니다. 구현 방식은 이 문서의 범위 밖이며, 센터에서 보셔야 할 것은 환자가 따르는 규칙(04절)과 채점표(06절)입니다.</p>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>3</span></div>
</section>

<!-- 02 -->
<section class="sheet">
  <div class="hd"><span>02 · 시나리오 구성</span><span>LectureLink CPX</span></div>
  <h2>주호소 __N_CC__개, 증례 __N_CASES__개</h2>
  <p class="lead">분류 기준은 한국보건의료인국가시험원이 공개한 CPX 진료문항 항목표입니다. 주호소마다 감별진단별로 증례를 두어, 같은 "가슴 통증"이라도 급성심근경색과 늑연골염을 각각 연습합니다.</p>
  <table>
    <tr><th>주호소</th><th>증례 구성 (감별진단)</th><th>수</th></tr>
    __DIST_ROWS__
    <tr><td>… 외 __N_CC_REST__개</td><td>전체 목록은 부록 A</td><td>__N_CASES__</td></tr>
  </table>
  <h3>저작 원칙</h3>
  <ul class="body">
    <li>주호소 분류와 항목 번호는 국시원 공개 항목표를 따릅니다.</li>
    <li>감별 지식은 표준 임상 지식과 시판 CPX 교재를 <b>참조</b>했으며, 교재 문장을 직접 인용하지 않았습니다. 인물·서사·수치는 자체 창작입니다.</li>
    <li>각 증례 파일에 출처 표기와 작성 근거를 남겨, 검수 시 "왜 이렇게 썼는지"를 추적할 수 있습니다.</li>
    <li>성별이 고정되어야 하는 증례(질 분비물·월경 이상·산전 진찰 등)는 무작위 인적사항에서 성별을 잠급니다.</li>
  </ul>
  <div class="callout"><b>검수 관점에서 먼저 보실 것</b> — 주호소별 증례 수가 고르지 않습니다(수면장애 16 vs 산전 진찰 1). 초기 제작 순서 때문이며, 센터 실습 빈도에 맞춰 우선순위를 다시 정하는 것도 협의 대상입니다.</div>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>4</span></div>
</section>

<!-- 03 -->
<section class="sheet dense">
  <div class="hd"><span>03 · 증례의 해부</span><span>LectureLink CPX</span></div>
  <h2>증례 한 건은 이렇게 생겼습니다</h2>
  <p class="lead">예시: 가슴 통증 — <b>__MI_TITLE__</b>. SP 시나리오 대본과 같은 칸으로 정리했습니다. 검수 시 보시게 될 형식입니다.</p>
  <div class="kv">
    <b>진료 장소</b><span>__MI_LOC__ (고정)</span>
    <b>인적사항</b><span>__MI_GENDER__ · __MI_AGE__ 권장. 이름·성별·직업·학력·경제 수준·체격은 연습마다 무작위</span>
    <b>증례 요약</b><span>__MI_SUMMARY__</span>
  </div>
  <div class="two">
    <div><h3>반드시 포함되는 병력</h3><ul class="body">__MI_MUST__</ul></div>
    <div><h3>없어야 하는 소견 (감별 배제)</h3><ul class="body">__MI_ABSENT__</ul><h3>환자교육 주제</h3><ul class="body">__MI_EDU__</ul></div>
  </div>
  <h3>신체진찰 소견</h3>
  <table class="left">
    <tr><th style="width:26mm">항목</th><th>방법</th><th>기대 소견</th></tr>
    __MI_PE__
  </table>
  <div class="callout">환자가 <b>먼저 말하지 않는 정보</b>와 <b>물으면 공개하는 정보</b>가 증례 안에 구분되어 있습니다. 예: 이 환자는 "체한 것 같다"고 여기며, 전구 증상(3주 전부터 계단 오를 때 답답함)은 관련 질문을 받아야 말합니다.</div>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>5</span></div>
</section>

<!-- 04 -->
<section class="sheet">
  <div class="hd"><span>04 · 표준화 환자 구현</span><span>LectureLink CPX</span></div>
  <h2>환자 역할의 행동 규칙</h2>
  <p class="lead">센터에서 표준화 환자를 교육하실 때의 원칙과 같은 순서로 적었습니다. 왼쪽이 SP 교육 원칙, 오른쪽이 렉처링크 환자가 따르는 규칙입니다.</p>
  <table class="left">
    <tr><th style="width:40mm">SP 교육 원칙</th><th>렉처링크 환자의 규칙</th></tr>
    <tr><td>묻지 않은 정보는 말하지 않는다</td><td>질문 범위 안에서만, 보통 한 문장으로 답합니다. "다른 증상은요?"처럼 넓게 물으면 주요 동반 증상 1~2개만 말합니다.</td></tr>
    <tr><td>진단명을 확정해 주지 않는다</td><td>학생이 병명을 말해도 "예전에 그런 말을 들은 적은 있지만 지금도 그건지는 모르겠다"는 식으로 답합니다.</td></tr>
    <tr><td>민감 정보는 라포 이후에</td><td>음주·흡연·성생활·정신건강·폭력 등은 이유를 설명하고 정중히 물으면 협조하고, 갑작스러우면 "꼭 말씀드려야 하나요?"처럼 주저합니다. 안전과 직결된 정보는 숨기지 않습니다.</td></tr>
    <tr><td>감정과 성격을 연기한다</td><td>증례별 감정·성격 설정에 따라 불안·답답함·민망함을 표현합니다. 공감적으로 말하면 더 협조적, 무례하면 불편해합니다.</td></tr>
    <tr><td>진찰 시 환자답게 반응한다</td><td>진찰 요청에 먼저 행동(자세 바꾸기, 숨 깊게 쉬기)으로 반응하고, 객관 소견은 별도 소견 카드로 제공합니다. 없는 소견을 지어내지 않습니다.</td></tr>
    <tr><td>검사 결과를 모른다</td><td>증례에 없는 검사를 물으면 "아직 검사는 안 받은 것 같다"고 답합니다.</td></tr>
    <tr><td>평가자가 아니다</td><td>학생을 칭찬하거나 평가하지 않고, 교육 내용을 대신 정리하지 않습니다.</td></tr>
  </table>
  <div class="two">
    <div class="fig short">그림 4-1. 환자 캐릭터와 음성 대화 화면</div>
    <div class="callout"><b>검수 관점</b> — 규칙 자체보다 "규칙을 실제로 지키는가"가 검수 대상입니다. 2단계 블라인드 검수에서 대화 기록을 함께 보시면서 규칙 위반(먼저 단서 공개, 병명 확정 등)을 표시하실 수 있습니다.</div>
  </div>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>6</span></div>
</section>

<!-- 05 -->
<section class="sheet">
  <div class="hd"><span>05 · 신체진찰 구현</span><span>LectureLink CPX</span></div>
  <h2>부위를 고르면 소견 카드가 나옵니다</h2>
  <p class="lead">음성 대화만으로는 신체진찰을 연습할 수 없어, 진찰은 화면에서 부위·항목을 고르는 방식으로 구현했습니다. 실제 시험에서 "청진하겠습니다"라고 말하고 시행하는 것에 해당합니다.</p>
  <div class="kv">
    <b>진찰 항목</b><span>증례마다 필요한 진찰이 정해져 있고(예: 가슴 통증 — 생명징후·흉벽·심음·호흡음·양팔 혈압·심전도), 화면에는 신체 부위로 묶여 나타납니다.</span>
    <b>소견 카드</b><span>정상/이상 여부, 구체 소견(혈압 150/95, 심음 규칙, 흉벽 압통 없음 …), 필요 시 해석 메모.</span>
    <b>진찰 예절</b><span>진찰 전 설명·동의, 손 소독, 진찰 중 불편 확인은 채점표 항목으로 평가됩니다.</span>
    <b>기본 진찰 사전</b><span>부위·방법·정상 소견을 정리한 진찰 사전(156개 진찰 개념)을 두어 증례에 없는 진찰을 요청해도 정상 소견을 돌려줍니다.</span>
  </div>
  <div class="fig">그림 5-1. 부위별 신체진찰 선택 화면과 소견 카드</div>
  <div class="callout red"><b>한계</b> — 촉진·타진의 손기술은 연습되지 않습니다. 이 도구가 대체하는 것은 "무엇을 진찰할지 판단하고 순서대로 수행하는 것"이며, 손기술은 센터 실습의 영역입니다. 협약에서 두 연습의 역할을 나누는 것이 자연스럽습니다.</div>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>7</span></div>
</section>

<!-- 06 -->
<section class="sheet">
  <div class="hd"><span>06 · 채점표</span><span>LectureLink CPX</span></div>
  <h2>채점표의 구조</h2>
  <p class="lead">실제 CPX 배점 구조(체크리스트 영역 70 + 환자의사관계 30)를 따릅니다. 주호소마다 채점표가 있고, 모든 항목에 대화 기록의 근거가 붙습니다.</p>
  <div class="two">
    <div><h3>가슴 통증 채점표</h3><table><tr><th>영역</th><th>항목</th><th>배점</th></tr>__CHEST_SECS__</table></div>
    <div><h3>수면장애 채점표 (부록 B 전문)</h3><table><tr><th>영역</th><th>항목</th><th>배점</th></tr>__SLEEP_SECS__</table></div>
  </div>
  <h3>판정 방식</h3>
  <ul class="body">
    <li>항목마다 <b>충족(1) · 부분(0.5) · 미충족(0)</b>. 영역 점수는 충족 비율로, 영역 등급(우수/보통/미흡)은 항목 수 컷오프로 병기합니다.</li>
    <li><b>판정 원칙 ①</b> 단어가 아니라 문맥 — "정신과 다닌 적 있으세요?"는 '정신건강의학과 진료력 질문'으로 인정.</li>
    <li><b>판정 원칙 ②</b> 말로 선언하면 시행 — "청진을 해보겠습니다"는 청진 시행으로 인정.</li>
    <li><b>판정 원칙 ③</b> 모든 판정에 대화 근거 인용 — 어느 발화에서 그렇게 판단했는지 결과에 함께 표시.</li>
    <li>음성 인식 오류(예: '환자분'→'안사분')는 문맥으로 복원해 판정합니다.</li>
    <li>감점 항목: 비전문적 표현, 성급한 진단 단정, 환자 답변 무시, 위험 신호 무시, 안전에 반하는 조언, 민감 정보 배려 부족.</li>
  </ul>
  <div class="callout"><b>점수는 누가 계산하는가</b> — 환자 역할을 하는 AI는 채점에 관여하지 않습니다. 채점 단계의 AI는 대화 기록에서 <b>각 항목의 근거만 찾아 표시</b>하고, 점수 계산은 정해진 규칙이 합니다. 그래서 같은 대화에는 같은 점수가 나오고(08절), 채점표를 고치면 결과가 그대로 따라옵니다.</div>
  <p class="fn">※ 채점표는 국시원 공개 항목과 시판 교재의 채점 영역을 참조해 자체 재작성했습니다. 교재의 다단계 판정을 세 단계로 바꾼 것, 영역 가중치, 컷오프는 모두 파생 규칙이며 검수 대상입니다.</p>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>8</span></div>
</section>

<!-- 07 -->
<section class="sheet">
  <div class="hd"><span>07 · 결과 화면</span><span>LectureLink CPX</span></div>
  <h2>학생이 받는 피드백</h2>
  <p class="lead">결과 화면은 총점이 아니라 "무엇을 했고, 무엇을 놓쳤고, 다음에 어떻게 고칠지"를 먼저 보여 줍니다.</p>
  <div class="fig">그림 7-1. 채점 결과 화면 — 영역별 점수, 항목별 판정과 근거, 놓친 항목</div>
  <table class="left">
    <tr><th style="width:34mm">화면 요소</th><th>내용</th></tr>
    <tr><td>영역별 점수</td><td>병력청취·신체진찰·환자교육·환자의사관계 (신체진찰이 면제되는 증례는 3영역)</td></tr>
    <tr><td>항목별 판정</td><td>충족·부분·미충족과, 판정 근거가 된 학생 발화</td></tr>
    <tr><td>놓친 항목</td><td>미충족 항목을 모아 "다음 문진에서 물어볼 것"으로 제시</td></tr>
    <tr><td>감점 사유</td><td>해당 시 발화와 함께 표시</td></tr>
    <tr><td>연습 기록</td><td>학생별 누적 — 같은 주호소의 이전 점수와 비교</td></tr>
  </table>
  <div class="callout"><b>검수 관점</b> — 피드백 문구가 학생을 잘못 가르칠 수 있는 지점(예: 감별 순서, 검사 우선순위)이 있다면 2단계 검수에서 함께 표시해 주시면 됩니다.</div>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>9</span></div>
</section>

<!-- 08 -->
<section class="sheet">
  <div class="hd"><span>08 · 검증과 한계</span><span>LectureLink CPX</span></div>
  <h2>무엇을 확인했고, 무엇을 확인하지 못했나</h2>
  <p class="lead">두 사람이 자체적으로 잴 수 있는 것은 <b>일관성과 형식</b>입니다. <b>의학적 정확성과 임상 타당성</b>은 저희가 잴 수 없습니다.</p>
  <h3>확인한 것 (2026-08-22 자체 측정)</h3>
  <table>
    <tr><th>항목</th><th>방법</th><th>결과</th></tr>
    <tr><td>채점 일관성</td><td>같은 대화 기록(수면장애, 32항목)을 10회 재채점</td><td>31/32 항목 전 회차 동일</td></tr>
    <tr><td>총점 안정성</td><td>위와 동일</td><td>평균 60.4점, 편차 ±0.75</td></tr>
    <tr><td>채점표 형식 준수</td><td>10회 모두 정해진 결과 형식으로 출력되었는가</td><td>10/10</td></tr>
    <tr><td>환자 정보 유출</td><td>진단명·정답 단서를 유도하는 질문 시험</td><td>통과</td></tr>
    <tr><td>운영</td><td>2026-07-17 이후 연습 세션</td><td>최근 30일 73회</td></tr>
  </table>
  <p class="fn">※ 흔들린 1개 항목은 '동반 신체 증상 확인'(충족 5회 / 부분 5회)으로, 항목 문구가 모호한 사례입니다. 이런 항목이 1단계 대조에서 먼저 드러납니다.</p>
  <h3>확인하지 못한 것</h3>
  <div class="callout red">
    <b>① 증례의 의학적 정확성</b> — 병력·소견·교육 주제가 현행 임상 지식과 맞는가.<br>
    <b>② 채점표의 임상 타당성</b> — 항목 구성과 배점이 센터의 채점표·교육 목표와 맞는가.<br>
    <b>③ 표준화 환자의 적절성</b> — 환자의 말과 반응이 실제 SP 수준인가.<br>
    <b>④ 학습 효과</b> — 이 연습이 실제 실습·시험 수행을 높이는가.<br>
    임상 검수를 마친 증례: <b>__N_CASES__개 중 0건.</b>
  </div>
  <table class="left">
    <tr><th style="width:34mm">구분</th><th>코드가 검사하는 것 (구조)</th><th>전문가만 판단할 수 있는 것 (의미)</th></tr>
    <tr><td>채점</td><td>같은 입력 → 같은 출력, 형식 준수</td><td>판정이 임상적으로 옳은가</td></tr>
    <tr><td>증례</td><td>필수 항목이 채워졌는가</td><td>내용이 의학적으로 맞는가</td></tr>
    <tr><td>환자</td><td>규칙 위반 유도 시험 통과</td><td>환자다운가, 교육적으로 적절한가</td></tr>
  </table>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>10</span></div>
</section>

<!-- 09 -->
<section class="sheet">
  <div class="hd"><span>09 · 검수 요청서</span><span>LectureLink CPX</span></div>
  <h2>의학 검수 요청</h2>
  <p class="lead">세 단계로 나누었고, 앞 단계의 결론이 뒷 단계의 기준이 됩니다. 1단계가 먼저여야 하는 이유는, 채점표 기준이 바뀌면 증례 검수를 다시 해야 하기 때문입니다.</p>
  <table class="left">
    <tr><th style="width:30mm">단계</th><th>센터에서 하실 일</th><th>저희가 준비하는 것</th><th style="width:20mm">소요</th></tr>
    <tr><td><b>1 · 채점표 정본 대조</b><br><span class="mono">약 2주</span></td><td>센터 채점표 1~2종(수면장애 권장, 부록 B)과 항목 단위로 대조하고 차이·누락·불필요 항목을 표시</td><td>대조표 양식, 항목별 출처 주석, 수정 반영</td><td>약 2시간</td></tr>
    <tr><td><b>2 · 증례 블라인드 검수</b><br><span class="mono">약 4주</span></td><td>층화 추출 표본 약 30건을 검수 화면에서 읽고 정오·수정 의견 기록. 대화 기록 5~10건의 환자 규칙 위반 표시</td><td>검수 화면(증례 출처 가림), 표본 추출, 의견 취합·반영, 검수 이력 보관</td><td>약 10시간</td></tr>
    <tr><td><b>3 · 학생 파일럿</b><br><span class="mono">약 6주</span></td><td>실습 전 학생 자율 연습 허용, 결과 공동 분석, 실습 평가와의 관계 확인</td><td>학생 계정, 연습 기록 집계, 분석 보고서 초안</td><td>협의</td></tr>
  </table>
  <h3>산출물</h3>
  <ul class="body">
    <li>단계별 검수 보고서 — 센터 명의 병기, 검수 완료 콘텐츠에 "계명의대 임상수기센터 검수" 표기</li>
    <li>검수 이력 — 누가 언제 무엇을 바꿨는지, 이후 분쟁이나 연구 자료로 쓸 수 있도록 보관</li>
  </ul>
  <h3>기한</h3>
  <p class="body">1단계는 협약 논의 개시 후 2주 안에 시작하기를 제안드립니다. 2·3단계 일정은 협약에서 정합니다.</p>
  <p class="fn">※ 소요 시간 산출 근거 — 1단계: 32항목 × 항목당 3분 + 전체 검토 30분. 2단계: 증례 1건 읽기·의견 15분 × 30건 + 대화 기록 10건 × 10분.</p>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>11</span></div>
</section>

<!-- 10 -->
<section class="sheet">
  <div class="hd"><span>10 · 협약 제안</span><span>LectureLink CPX</span></div>
  <h2>정식 협약 논의를 제안드립니다</h2>
  <p class="lead">협약서 초안이 아니라, 논의의 범위를 제안하는 쪽입니다. 아래 항목은 모두 협의 대상입니다.</p>
  <div class="kv">
    <b>범위</b><span>CPX 콘텐츠 의학 검수(09절) · 학생 파일럿 · 검수 결과의 공동 발표</span>
    <b>역할</b><span>센터: 의학적 판단과 검수 명의. 렉처링크: 도구·표본·반영·운영·비용.</span>
    <b>데이터</b><span>학생 연습 기록은 협약 범위 안에서만 사용하고 개인 식별 정보는 제외합니다. 센터 채점표 원본은 대조 목적으로만 보관하고 콘텐츠에 옮겨 쓰지 않습니다.</span>
    <b>표기</b><span>검수 완료 콘텐츠에 센터 검수 표기. 검수 전 콘텐츠는 "검수 전"으로 구분 표시.</span>
    <b>저작권</b><span>증례·채점표의 저작권은 렉처링크에 있고, 검수 의견의 반영 결과는 센터와 공유합니다. 교재 인용 금지 원칙은 유지합니다.</span>
    <b>일정</b><span>논의 개시 → 1단계 2주 → 2단계 4주 → 파일럿 6주</span>
    <b>센터에 남는 것</b><span>학생 자율 연습 채널(SP·실습실 부하 분산), 실습 전 학생 수준 파악 자료, 검수된 교육 콘텐츠와 공동 성과</span>
  </div>
  <div class="callout"><b>회신</b> — 2026년 9월 __일까지 협약 논의 개시 여부를 알려 주시면, 다음 주에 1단계 대조표를 보내 드리겠습니다.</div>
  <div class="kv" style="margin-top:4mm">
    <b>연락</b><span>전재현 · 장유림 (계명대학교 의학과) · 연락처 · 이메일</span>
    <b>최신본</b><span>lecturelink.kro.kr</span>
  </div>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>12</span></div>
</section>

<!-- 부록 A -->
<section class="sheet">
  <div class="hd"><span>부록 A · 증례 목록 (1/2)</span><span>LectureLink CPX</span></div>
  <h2>주호소 __N_CC__개 · 증례 __N_CASES__개</h2>
  <p class="body">증례 수 내림차순. 감별진단 이름은 증례 제목의 표적 진단을 그대로 옮겼습니다.</p>
  <table style="font-size:8.6pt"><tr><th>주호소</th><th>증례 (표적 진단)</th><th>수</th></tr>__APPX_A_1__</table>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>13</span></div>
</section>
<section class="sheet">
  <div class="hd"><span>부록 A · 증례 목록 (2/2)</span><span>LectureLink CPX</span></div>
  <table style="font-size:8.6pt"><tr><th>주호소</th><th>증례 (표적 진단)</th><th>수</th></tr>__APPX_A_2__</table>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>14</span></div>
</section>

<!-- 부록 B -->
<section class="sheet">
  <div class="hd"><span>부록 B · 수면장애 채점표 전문 (1/2)</span><span>LectureLink CPX</span></div>
  <h2>__SLEEP_TITLE__</h2>
  <p class="body">총점 100 · 충족 / 부분 / 미충족. 오른쪽 칸은 센터 채점표와 대조하실 때 쓰시는 표시란입니다(□ 일치 · □ 차이 · □ 불필요). 1단계 검수에서 이 쪽을 그대로 쓰실 수 있습니다.</p>
  <table class="left" style="font-size:8.8pt"><tr><th style="width:14mm">번호</th><th>항목</th><th style="width:22mm">대조</th></tr>__APPX_B_1__</table>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>15</span></div>
</section>
<section class="sheet">
  <div class="hd"><span>부록 B · 수면장애 채점표 전문 (2/2)</span><span>LectureLink CPX</span></div>
  <table class="left" style="font-size:8.8pt"><tr><th style="width:14mm">번호</th><th>항목</th><th style="width:22mm">대조</th></tr>__APPX_B_2__</table>
  <p class="fn">※ 판정 원칙: 단어가 아니라 문맥으로 인정 · 말로 선언하면 시행으로 간주 · 모든 판정에 대화 근거 인용 · 음성 인식 오류는 문맥으로 복원. 원 루브릭의 0/1/2 등급은 영역 등급(우수/보통/미흡)으로 병기합니다.</p>
  <div class="ft"><span>LectureLink CPX 제안서</span><span>16</span></div>
</section>

</body>
</html>
'''

appx_rows = appendix_a().split('\n')
half = 30
out = (TEMPLATE
       .replace('__N_CC__', str(n_cc)).replace('__N_CASES__', str(n_cases)).replace('__N_CC_REST__', str(n_cc - 8))
       .replace('__DIST_ROWS__', dist_rows())
       .replace('__MI_TITLE__', esc(mi['targetDiagnosis']))
       .replace('__MI_LOC__', esc(mi['demographicsRule']['fixed'].get('location', '')))
       .replace('__MI_GENDER__', esc(mi['demographicsRule']['recommended'].get('gender', '')))
       .replace('__MI_AGE__', esc(mi['demographicsRule']['recommended'].get('age', '')))
       .replace('__MI_SUMMARY__', esc(mi['scenarioRule']['caseSummary']))
       .replace('__MI_MUST__', mi_must).replace('__MI_ABSENT__', mi_absent).replace('__MI_EDU__', mi_edu).replace('__MI_PE__', mi_pe)
       .replace('__CHEST_SECS__', chest_secs).replace('__SLEEP_SECS__', sleep_secs)
       .replace('__APPX_A_1__', '\n'.join(appx_rows[:half])).replace('__APPX_A_2__', '\n'.join(appx_rows[half:]))
       .replace('__SLEEP_TITLE__', esc(sleep['title']))
       .replace('__APPX_B_1__', appendix_b(0, 2)).replace('__APPX_B_2__', appendix_b(2, 4)))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w', encoding='utf-8').write(out)
print('saved', OUT, n_cc, 'cc', n_cases, 'cases', len(out) // 1024, 'KB')
