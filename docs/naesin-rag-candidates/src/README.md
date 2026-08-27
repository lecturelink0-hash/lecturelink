# 인포그래픽 · PDF 재생성 방법

계획서 본문은 `../plan-2026-08-23.md` 가 정본이고, PDF와 PNG는 아래 스크립트로 다시 만든다.
외부 패키지 없이 macOS의 Google Chrome(헤드리스)과 Node만 쓴다.

**전달용 PDF** `../plan-2026-08-23.pdf` (18쪽, 인포그래픽 3장 포함, ≈4.4 MB)는 리포에 함께 둔다.
루트 `.gitignore` 의 `*.pdf` 규칙에 이 폴더만 예외(`!docs/naesin-rag-candidates/*.pdf`)를 두었으므로,
본문을 고치면 아래 2) 절차로 PDF도 다시 만들어 같이 커밋한다.

```bash
cd docs/naesin-rag-candidates/src

# 1) 인포그래픽 PNG (1600×1900 CSS px, 2배 스케일 → 3200×3800)
zsh render.sh "$PWD/infographic-1.html" ../infographic-1-advanced-rag.png 1600 1900
zsh render.sh "$PWD/infographic-2.html" ../infographic-2-self-corrective-rag.png 1600 1900
zsh render.sh "$PWD/infographic-3.html" ../infographic-3-graph-rag.png 1600 1900

# 2) 계획서 PDF (Markdown → HTML → Chrome print)
node md2html.mjs ../plan-2026-08-23.md /tmp/plan.html doc.css
sed -i '' "s#src=\"infographic-#src=\"file://$PWD/../infographic-#g" /tmp/plan.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --no-pdf-header-footer --print-to-pdf=../plan-2026-08-23.pdf file:///tmp/plan.html
```

- `infographic.css` 의 색은 dataviz 기준 팔레트(blue `#2a78d6` / orange `#eb6834` / violet `#4a3aa7`)에서 후보별로 하나씩 쓴다.
- 후보 2의 루프 화살표는 `infographic-2.html` 상단 SVG에 절대 좌표로 그려져 있다(박스 중심 x = 84 + i×188.5). 단계 수를 바꾸면 좌표를 다시 맞출 것.
- `md2html.mjs` 는 헤딩·목록·표·코드·인용·이미지만 지원하는 최소 변환기다.
