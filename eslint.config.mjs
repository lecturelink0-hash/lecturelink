import { FlatCompat } from '@eslint/eslintrc';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: root });

export default [
  ...compat.extends('next/core-web-vitals'),
  {
    ignores: ['.next/**', '.codex-preview-*/**', 'node_modules/**', 'coverage/**', 'public/**'],
  },
];
