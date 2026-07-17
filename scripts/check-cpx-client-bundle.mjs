#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const staticRoot = path.resolve('.next/static');
const forbidden = [
  'GEMINI_API_KEY',
  'CPX_PROXY_SHARED_SECRET',
  ...['GEMINI_API_KEY', 'CPX_PROXY_SHARED_SECRET']
    .map((name) => process.env[name])
    .filter((value) => typeof value === 'string' && value.length >= 8),
];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  }));
  return nested.flat();
}

let files;
try {
  files = await filesUnder(staticRoot);
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('`.next/static`이 없습니다. 먼저 `npm run build`를 실행하세요.');
  }
  throw error;
}

const hits = [];
for (const file of files) {
  const content = await readFile(file);
  for (const token of forbidden) {
    if (content.includes(Buffer.from(token))) {
      hits.push(`${path.relative(process.cwd(), file)}: ${token}`);
    }
  }
}

if (hits.length) {
  throw new Error(`CPX 서버 시크릿이 클라이언트 번들에 포함됐습니다.\n${hits.join('\n')}`);
}

console.log(`CPX client bundle secret check passed (${files.length} files)`);
