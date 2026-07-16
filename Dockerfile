# node-canvas(cairo) 기반 PDF 렌더링용 이미지.
# @napi-rs/canvas 는 pdfjs 와 함께 쓰면 serverless/제약 환경에서 native crash(SIGSEGV)
# 또는 napi "CanvasElement unwrap" 에러를 일으켜 폐기. node-canvas 는 cairo 시스템
# 라이브러리만 있으면 안정적이며 pdfjs 공식 예제가 쓰는 조합이다.
FROM node:22-bookworm-slim

# node-canvas 빌드(node-gyp) + 런타임에 필요한 시스템 라이브러리
# + PPT/PPTX·DOCX → PDF 변환용 LibreOffice(impress/writer) 와 한국어(CJK) 폰트.
#   impress 없으면 PPT/PPTX, writer 없으면 DOCX 변환이 실패한다.
#   fonts-noto-cjk 가 없으면 변환 PDF 의 한글이 두부(□)로 렌더된다.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg62-turbo-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    python3 \
    libreoffice-impress \
    libreoffice-writer \
    fonts-noto-cjk \
    mupdf-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 — 레이어 캐시를 위해 매니페스트를 먼저 복사
COPY package.json package-lock.json* ./
RUN npm install

# 소스 복사 후 Next.js 빌드
COPY . .
# 클라이언트 번들에 인라인되는 공개 값(NEXT_PUBLIC_*)은 빌드 타임에 주입해야 한다.
# (서버 시크릿은 이미지에 굽지 않고 런타임 --env-file 로 전달)
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
RUN npm run build

ENV NODE_ENV=production
# Render 는 런타임에 PORT 를 주입하지만 기본값을 명시 (next start 가 PORT 를 읽음)
ENV PORT=10000
EXPOSE 10000

CMD ["npm", "start"]
