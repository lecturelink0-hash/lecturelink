import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

const sourceDir = 'C:/Users/sixth/OneDrive/바탕 화면/lecturelinkUI';
const targets = [
  ['lecturelink-auth-redesign.html', '.ll-auth-page'],
  ['lecturelink-dashboard-redesign-0708.html', '.ll-dashboard-page'],
  ['lecturelink-exam-redesign-0708.html', '.ll-exam-page'],
  ['lecturelink-exam-scroll-redesign.html', '.ll-exam-session-page'],
  ['lecturelink-exam-result-redesign.html', '.ll-exam-result-page'],
  ['lecturelink-mock-redesign-0708.html', '.ll-mock-page'],
  ['lecturelink-library-redesign-ux.html', '.ll-library-page'],
  ['lecturelink-upload-redesign-0708.html', '.ll-upload-page'],
  ['lecturelink-wrong-notes-redesign.html', '.ll-wrong-page'],
  ['lecturelink-plan-redesign.html', '.ll-plan-page'],
];

const chunks = ['/* Generated from user-owned redesign HTML files. Do not hand-edit. */'];

for (const [filename, scope] of targets) {
  const html = fs.readFileSync(path.join(sourceDir, filename), 'utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/i)?.[1];
  if (!css) throw new Error(`No style block: ${filename}`);
  const root = postcss.parse(css);
  root.walkAtRules('import', (rule) => rule.remove());
  root.walkRules((rule) => {
    rule.selectors = rule.selectors.map((selector) => {
      const trimmed = selector.trim();
      if (trimmed === ':root') return scope;
      if (trimmed === 'html' || trimmed === 'body') return scope;
      if (trimmed === '*') return `${scope} *`;
      if (trimmed.startsWith('body ')) return `${scope} ${trimmed.slice(5)}`;
      return `${scope} ${trimmed}`;
    });
  });
  chunks.push(`\n/* ${filename} */\n${root.toString()}`);
}

fs.writeFileSync(path.resolve('app/redesign-reference.css'), chunks.join('\n'), 'utf8');
