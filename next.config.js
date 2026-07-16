/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next.js 가 workspace root 를 잘못 추정하지 않도록 프로젝트 루트를 트레이싱 루트로 명시.
  outputFileTracingRoot: __dirname,
  // 네이티브 모듈 / 큰 SDK 는 server bundle 에 포함하지 않고 런타임 require 로 처리.
  // @napi-rs/canvas 는 .node 바이너리, tesseract.js / pdfjs-dist / pdf-parse 는 큰 wasm /
  // worker 자산을 동적 로드해 webpack 번들에 부적합.
  serverExternalPackages: [
    '@napi-rs/canvas',
    'canvas',
    'tesseract.js',
    'pdfjs-dist',
    'pdf-parse',
  ],
  // pdfjs-dist 의 worker / cmaps / standard_fonts 는 데이터 파일이라
  // serverExternalPackages 만으로는 자동 포함이 안 된다. Vercel 함수 번들에
  // 명시 포함시켜 PDF 처리 라우트에서 require() 가능하도록 지정한다.
  outputFileTracingIncludes: {
    '/api/uploads/analyze': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.js',
      './node_modules/pdfjs-dist/cmaps/**/*',
      './node_modules/pdfjs-dist/standard_fonts/**/*',
    ],
    '/api/uploads/[id]/process': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.js',
      './node_modules/pdfjs-dist/cmaps/**/*',
      './node_modules/pdfjs-dist/standard_fonts/**/*',
    ],
    '/api/queue/process-upload': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.js',
      './node_modules/pdfjs-dist/cmaps/**/*',
      './node_modules/pdfjs-dist/standard_fonts/**/*',
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '500mb',
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
      },
    ],
  },
};

module.exports = nextConfig;
