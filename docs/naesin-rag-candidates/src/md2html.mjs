// 최소 Markdown → HTML 변환기 (헤딩/문단/목록/표/인용/코드/굵게/이미지/링크)
import fs from 'node:fs';
const [,, src, out, cssPath] = process.argv;
const md = fs.readFileSync(src, 'utf8');
const css = cssPath ? fs.readFileSync(cssPath, 'utf8') : '';
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const inline = s => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
const lines = md.split('\n');
let html = [], i = 0;
const flushPara = buf => { if (buf.length) { html.push('<p>' + inline(buf.join(' ')) + '</p>'); buf.length = 0; } };
let para = [];
while (i < lines.length) {
  const l = lines[i];
  if (/^```/.test(l)) { flushPara(para); let code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; html.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); continue; }
  const h = l.match(/^(#{1,4})\s+(.*)/);
  if (h) { flushPara(para); const lv = h[1].length; const id = h[2].replace(/[^\w가-힣]+/g,'-'); html.push(`<h${lv} id="${id}">${inline(h[2])}</h${lv}>`); i++; continue; }
  if (/^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l)) {
    flushPara(para);
    const ordered = /^\s*\d+\./.test(l); const tag = ordered ? 'ol' : 'ul';
    html.push(`<${tag}>`);
    while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
      let item = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''); i++;
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) { item += ' ' + lines[i].trim(); i++; }
      html.push('<li>' + inline(item) + '</li>');
    }
    html.push(`</${tag}>`); continue;
  }
  if (/^\|/.test(l)) {
    flushPara(para);
    const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
    const cells = r => r.replace(/^\||\|$/g,'').split('|').map(c => inline(c.trim()));
    html.push('<table><thead><tr>' + cells(rows[0]).map(c=>`<th>${c}</th>`).join('') + '</tr></thead><tbody>');
    for (const r of rows.slice(2)) html.push('<tr>' + cells(r).map(c=>`<td>${c}</td>`).join('') + '</tr>');
    html.push('</tbody></table>'); continue;
  }
  if (/^>\s?/.test(l)) { flushPara(para); let q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/,'')); html.push('<blockquote>' + inline(q.join(' ')) + '</blockquote>'); continue; }
  if (/^---+$/.test(l)) { flushPara(para); html.push('<hr>'); i++; continue; }
  if (/^\s*$/.test(l)) { flushPara(para); i++; continue; }
  para.push(l.trim()); i++;
}
flushPara(para);
fs.writeFileSync(out, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css}</style></head><body>${html.join('\n')}</body></html>`);
console.log('wrote', out);
