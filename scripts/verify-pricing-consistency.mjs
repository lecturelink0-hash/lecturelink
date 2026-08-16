import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const catalog = read('lib/payment/plans.ts');
const landing = read('components/landing/Landing.tsx');
const vercelIgnore = read('.vercelignore');
const errors = [];

const paidPlans = [...catalog.matchAll(/^\s{2}(lite|standard|pro):\s*\{/gm)].map((match) => match[1]);
if (paidPlans.join(',') !== 'lite,standard,pro') {
  errors.push(`PLAN_CATALOG must contain exactly lite, standard, pro; found ${paidPlans.join(', ') || 'none'}.`);
}

if (!landing.includes("import { PLAN_CATALOG } from '@/lib/payment/plans';")) {
  errors.push('Landing pricing must import PLAN_CATALOG instead of defining independent names and prices.');
}

if (!landing.includes('lg:grid-cols-3') || landing.includes('lg:grid-cols-4')) {
  errors.push('Landing pricing must use a three-column desktop grid.');
}

for (const legacyName of ['자료 생성 전용', '국가고시형 전용', '통합형 무제한']) {
  if (landing.includes(legacyName)) {
    errors.push(`Legacy pricing plan remains in Landing.tsx: ${legacyName}`);
  }
}

if (!vercelIgnore.split(/\r?\n/).some((line) => line.trim() === 'public/landing.html')) {
  errors.push('Legacy public/landing.html must be excluded from Vercel uploads.');
}

if (errors.length > 0) {
  console.error(['Pricing consistency check failed:', ...errors.map((error) => `- ${error}`)].join('\n'));
  process.exit(1);
}

console.log(`Pricing consistency check passed: ${paidPlans.length} paid plans (${paidPlans.join(', ')}), legacy static landing excluded.`);
