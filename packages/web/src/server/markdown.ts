// 导读和线程里的 Markdown 转成 HTML：先整体转义，再只认书畔用得到的几种写法（标题、列表、引用、粗体、行内代码），
// 所以内容里写了什么 HTML 都只会原样显示，不会执行。
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}

export function markdownToHtml(text: string): string {
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    if (quote.length) out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
    if (list) out.push(`</${list}>`);
    para = [];
    quote = [];
    list = null;
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、)]\s+(.*)$/);
    const q = line.match(/^>\s?(.*)$/);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      // 页面里已有 h1、h2，正文的标题从 h3 起。
      const level = Math.min(6, heading[1]!.length + 2);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        flush();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul ?? ol)![1]!)}</li>`);
    } else if (q) {
      if (!quote.length) flush();
      quote.push(q[1]!);
    } else {
      if (list || quote.length) flush();
      para.push(line);
    }
  }
  flush();
  return out.join("\n");
}
