"""G0 'PDF 페이지' 대조 — 저장된 본문 청크의 page_index 가 실제로 그 페이지의 글인지.

추출기(pdfjs)와 독립인 poppler(pdftotext)로 페이지별 텍스트를 따로 뽑아, 청크 어절이 가장 많이
들어 있는 페이지가 저장된 page_index 와 같은지 본다. 표본은 텍스트형 자료(slide·notes) 1회차의
본문 청크에서 시드 고정으로 20개. 추출기마다 글자 순서가 달라 연속 부분문자열이 아니라 어절
포함률로 비교한다. 사람이 볼 표본 목록도 함께 출력한다.

  python3 scripts/rag-eval/page-index-check.py <결과 폴더> <label> <manifest.json>
"""
import json, glob, random, subprocess, re, sys, unicodedata
out_root, label, manifest = sys.argv[1], sys.argv[2], sys.argv[3]
man = {m['key']: m for m in json.load(open(manifest))['materials']}
norm = lambda s: re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', s))
pages_cache = {}
def pdf_pages(path):
    if path not in pages_cache:
        out = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True).stdout
        pages_cache[path] = [norm(p) for p in out.split('\f')]
    return pages_cache[path]
cands = []
for f in sorted(glob.glob(f'{out_root}/{label}/*/run1.json')):
    r = json.load(open(f))
    if r['kind'] not in ('slide', 'notes'):
        continue
    for c in r['chunks']:
        if c['kind'] == 'slide_text' and len(norm(c['text'])) >= 60:
            cands.append((r['key'], c))
random.Random(20260928).shuffle(cands)
sample = cands[:20]
ok = 0
for key, c in sample:
    pages = pdf_pages(man[key]['file'])
    # 추출기마다 글자 순서가 달라(도형·주석 배치) 연속 부분문자열 대신 어절 포함률로 본다.
    toks = {w for w in re.findall(r'[\w가-힣]{2,}', unicodedata.normalize('NFKC', c['text']))}
    def score(pi):
        pt = pages[pi - 1] if 0 < pi <= len(pages) else ''
        return sum(w in pt for w in toks) / max(1, len(toks))
    s = score(c['page_index'])
    best = max(range(1, len(pages) + 1), key=score)
    match = s >= 0.6 and s >= score(best) - 1e-9
    ok += match
    print(f"{'OK ' if match else 'NG '} {key} chunk#{c['chunk_index']:>3} page {c['page_index']:>3} 포함률 {s:.2f} 최고 {best}({score(best):.2f}) 어절 {len(toks)}")
print(f"\n{ok}/{len(sample)} page_index 일치 (표본 {len(sample)}, 후보 {len(cands)})")
