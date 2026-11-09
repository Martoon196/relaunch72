/**
 * A deliberately small Markdown renderer for course text. Every character is
 * HTML-escaped before any markup is added; links are limited to http(s) and
 * open with rel="noopener noreferrer". Supports paragraphs, headings, lists
 * (one nesting level), block quotes, fenced code, tables, rules, **bold**,
 * *italic*, `code` and [links](https://...).
 */
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderMhpInline(source: string): string {
  const slots: string[] = [];
  const keep = (html: string): string => `\u0000${slots.push(html) - 1}\u0000`;
  let text = source.replace(/\u0000/g, '');
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, ch: string) => keep(escapeHtml(ch)));
  text = text.replace(/\[([^\]\n]{1,300})\]\(([^)\s]{1,600})\)/g, (_, label: string, href: string) => {
    let url: URL;
    try { url = new URL(href); } catch { return keep(escapeHtml(label)); }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return keep(escapeHtml(label));
    return keep(`<a href="${escapeHtml(url.toString())}" rel="noopener noreferrer" target="_blank">${renderMhpInline(label)}</a>`);
  });
  text = escapeHtml(text);
  text = text.replace(/\*\*(?=\S)([^*]+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^\w])_(?=\S)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
  // Slots may nest (a link label with code); resolve until none remain.
  for (let pass = 0; pass < 4 && text.includes('\u0000'); pass++) text = text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => slots[Number(index)] ?? '');
  return text;
}

const cells = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = []; let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') { current += '\\|'; i++; continue; }
    if (trimmed[i] === '|') { out.push(current.trim()); current = ''; continue; }
    current += trimmed[i];
  }
  out.push(current.trim());
  return out;
};
const isTableRule = (line: string | undefined): boolean => !!line && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const listItem = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

export function renderMhpMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const body: string[] = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`); continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { const level = Math.min(6, heading[1]!.length + 1); html.push(`<h${level}>${renderMhpInline(heading[2]!.replace(/\s#+\s*$/, ''))}</h${level}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
    if (line.trim().startsWith('|') && isTableRule(lines[i + 1])) {
      const head = cells(line); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      html.push(`<div class="table"><table><thead><tr>${head.map(c => `<th>${renderMhpInline(c)}</th>`).join('')}</tr></thead><tbody>${
        rows.map(r => `<tr>${head.map((_, k) => `<td>${renderMhpInline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      html.push(`<blockquote>${renderMhpMarkdown(body.join('\n'))}</blockquote>`); continue;
    }
    const first = listItem.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2]!);
      const baseIndent = first[1]!.length;
      const items: { text: string; children: { ordered: boolean; texts: string[] } | null }[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const match = listItem.exec(current);
        if (match && match[1]!.length <= baseIndent + 1) {
          if (/\d/.test(match[2]!) !== ordered) break;
          items.push({ text: match[3]!, children: null }); i++; continue;
        }
        if (match && match[1]!.length > baseIndent + 1 && items.length) {
          const last = items[items.length - 1]!;
          last.children ??= { ordered: /\d/.test(match[2]!), texts: [] };
          last.children.texts.push(match[3]!); i++; continue;
        }
        if (current.trim() && /^\s{2,}\S/.test(current) && items.length) { items[items.length - 1]!.text += ` ${current.trim()}`; i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map(item => `<li>${renderMhpInline(item.text)}${item.children
        ? `<${item.children.ordered ? 'ol' : 'ul'}>${item.children.texts.map(t => `<li>${renderMhpInline(t)}</li>`).join('')}</${item.children.ordered ? 'ol' : 'ul'}>` : ''}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !listItem.test(lines[i]!) && !/^\s*(```|>|#{1,6}\s)/.test(lines[i]!)
      && !(lines[i]!.trim().startsWith('|') && isTableRule(lines[i + 1]))) paragraph.push(lines[i++]!.trim());
    if (paragraph.length) html.push(`<p>${renderMhpInline(paragraph.join(' '))}</p>`);
    else i++;
  }
  return html.join('\n');
}
