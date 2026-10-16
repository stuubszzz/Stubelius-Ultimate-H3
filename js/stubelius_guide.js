// Stubelius Ultimate H3: the How to use window, in the windows' look.
//
// A frontend-only node, like ComfyUI's own notes (nothing of it goes to the server). Its text is how_to_use.md next
// to this file, so it changes with the pack, not with the workflow. A workflow that still has the old How to use
// note gets this window in its place once, when it opens.
import { app } from "../../scripts/app.js";
import { h, icon, clear, windowFrame, goToStep, mountWindow, autoHeight, refreshThemes, injectStyles, graphNodes }
  from "./stubelius_ui.js";

const TYPE = "StubeliusH3Guide";
const TEXT_URL = new URL("./how_to_use.md", import.meta.url).href;
const REPO = "https://github.com/stuubszzz/Stubelius-Ultimate-H3";
const OLD_NOTE = /^\s*#\s*Ultimate H3\s*[—–-]\s*how to use/i;
// The how-to note's text in every version the pack shipped (whitespace collapsed, FNV-1a): only an untouched note
// becomes the guide; a note the user wrote into stays as it is
const SHIPPED_NOTES = new Set(["f184ff7d", "11bfe5ed", "83935cbd", "50e2547d", "1a6aa4a6", "f8afe4b1", "89532f74", "8bda15c1",
  "ae6c5527", "fd59e063", "4dbef44f", "4046937a", "3ec372dc"]);

function noteHash(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text).replace(/\s+/g, " ").trim()) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(16);
}
let text = null;

async function guideText() {
  if (text === null) {
    try {
      const r = await fetch(TEXT_URL, { cache: "no-cache" });
      text = r.ok ? await r.text() : "";
    } catch (e) {
      text = "";
    }
  }
  return text;
}

// ------------------------------------------------------------------------------------------- the text

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// **bold**, *italics*, `code`, [links](https://…) of the pack's own text (escaped first)
function inline(s) {
  const codes = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, "$1<i>$2</i>")
    .replace(/→/g, '<span class="g-arrow">→</span>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

function html(el, s) {
  el.innerHTML = inline(s);
  return el;
}

// The guide's Markdown as blocks: intro paragraphs, then "## N · NAME — subtitle" sections of paragraphs, lists, tables
export function parseGuide(src) {
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  const doc = { title: "", intro: [], sections: [] };
  let blocks = doc.intro;
  let para = null, list = null, table = null;
  const close = () => { para = null; list = null; table = null; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#\s/.test(line)) { doc.title = line.replace(/^#\s+/, ""); close(); continue; }
    const sec = /^##\s+(?:(\d+)\s*·\s*)?(.+?)(?:\s+—\s+(.+))?$/.exec(line);
    if (sec) {
      close();
      const s = { num: sec[1] || "", name: sec[2].trim(), sub: (sec[3] || "").trim(), blocks: [] };
      doc.sections.push(s);
      blocks = s.blocks;
      continue;
    }
    if (!line.trim()) { close(); continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!list) { close(); list = { type: "list", items: [] }; blocks.push(list); }
      list.items.push(line.replace(/^\s*[-*]\s+/, ""));
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (!table) { close(); table = { type: "table", rows: [] }; blocks.push(table); }
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) table.rows.push(cells);
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
    if (!para) { close(); para = { type: "para", text: "" }; blocks.push(para); }
    para.text += (para.text ? " " : "") + line.trim();
  }
  return doc;
}

function renderBlocks(blocks, tips) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "para") out.push(html(h("p.g-p"), b.text));
    else if (b.type === "list" && tips) {
      out.push(h("div.g-tips", ...b.items.map((t) => h("div.g-tip", h("span.g-tip-ic", icon("info", 15)), html(h("div"), t)))));
    } else if (b.type === "list") {
      out.push(h("ul.g-ul", ...b.items.map((t) => html(h("li"), t))));
    } else if (b.type === "table") {
      const [head, ...rows] = b.rows;
      out.push(h("div.g-tablewrap", h("table.g-table",
        h("thead", h("tr", ...(head || []).map((c) => html(h("th"), c)))),
        h("tbody", ...rows.map((r) => h("tr", ...r.map((c, i) => html(h(i ? "td" : "th"), c))))))));
    }
  }
  return out;
}

function render(win, src) {
  const body = clear(win.body);
  const doc = parseGuide(src);
  if (!doc.sections.length && !doc.intro.length) {
    body.appendChild(h("div.g-intro.sh3-panel", h("p.g-p", "The guide didn't load: see README.md in custom_nodes/Stubelius-Ultimate-H3.")));
    return;
  }
  if (doc.intro.length) body.appendChild(h("div.g-intro.sh3-panel", ...renderBlocks(doc.intro, false)));
  for (const s of doc.sections) {
    const tips = /good to know/i.test(s.name);
    const step = Number(s.num);
    const head = h("div.g-sec-h",
      s.num ? h("span.g-chip", s.num) : null, h("b.g-name", s.name), s.sub ? h("span.g-sub", s.sub) : null,
      h("div.sh3-spacer"),
      step >= 1 && step <= 4 ? h("button.sh3-btn.small.flat.g-go", { type: "button", title: `Go to the ${s.name.toLowerCase()} window`,
        onclick: (e) => { e.stopPropagation(); goToStep(step); } }, h("span", "Open"), icon("arrowRight", 14)) : null);
    body.appendChild(h(`section.g-sec.sh3-panel${tips ? ".g-good" : ""}`, head, h("div.g-sec-b", ...renderBlocks(s.blocks, tips))));
  }
}

// ------------------------------------------------------------------------------------------- the node

async function mount(node) {
  if (node._sh3 || !node.graph) return;
  injectStyles();
  injectGuideStyles();
  // no step bar (it needs a wide window): each section's Open goes to its window
  const f = windowFrame({ title: "Ultimate H3 · How to use", subtitle: "Four windows, one video: read me first", step: 0, onStep: goToStep });
  f.root.classList.add("sh3-g");
  f.foot.append(h("span.sh3-fi", icon("info", 14), "Updates: ComfyUI Manager → Update All"), h("div.sh3-spacer"),
    h("a.sh3-link.sh3-fi.g-repo", { href: REPO, target: "_blank", rel: "noopener noreferrer" }, icon("external", 14), "github.com/stuubszzz/Stubelius-Ultimate-H3"));
  const win = { ...f, node };
  node._sh3 = win;
  mountWindow(node, "sh3_guide", f.root, { minWidth: 560, minHeight: 400 });
  win.fit = autoHeight(node, f.root, { minHeight: 400, extra: 46, minWidth: 560 });
  refreshThemes();
  render(win, await guideText());
}

function register() {
  const LG = window.LiteGraph;
  const Base = window.LGraphNode || LG?.LGraphNode;
  if (!LG || !Base || LG.registered_node_types?.[TYPE]) return;
  class GuideNode extends Base {
    constructor(title) {
      super(title);
      this.isVirtualNode = true;               // nothing of it goes to the server
      this.serialize_widgets = false;
      if (!this.size || this.size[0] < 560) this.size = [660, 900];
      setTimeout(() => mount(this), 0);
    }
  }
  LG.registerNodeType(TYPE, Object.assign(GuideNode, { title: "HOW TO USE", collapsable: true }));
  GuideNode.category = "Stubelius";
}

// The old How to use note (a Markdown note of the example) becomes this window, once, where it was
function upgradeNote() {
  const graph = app.graph;
  const nodes = graphNodes(graph);
  if (!graph || nodes.some((n) => n.type === TYPE)) return;
  const textOf = (n) => String(n.widgets?.find((w) => w.name === "text")?.value ?? n.widgets_values?.[0] ?? "");
  const note = nodes.find((n) => /^(MarkdownNote|Note)$/.test(n.type || "") && OLD_NOTE.test(textOf(n)));
  if (!note || !SHIPPED_NOTES.has(noteHash(textOf(note)))) return;
  const LG = window.LiteGraph;
  const guide = LG?.createNode?.(TYPE);
  if (!guide) return;
  const [x, y] = note.pos;
  guide.pos = [x, y];
  guide.size = [Math.max(600, note.size?.[0] || 660), note.size?.[1] || 900];
  graph.add(guide);
  graph.remove(note);
  const groups = graph._groups || graph.groups || [];
  const inside = groups.some((g) => x > g.pos[0] && x < g.pos[0] + g.size[0] && y > g.pos[1] && y < g.pos[1] + g.size[1]);
  const Group = window.LGraphGroup || LG?.LGraphGroup;
  if (!inside && Group) {
    const g = new Group("HOW TO USE");
    g.flags = { sh3_stage: true };
    graph.add(g);
    g.pos = [x - 30, y - 94];
    g.size = [guide.size[0] + 60, guide.size[1] + 130];
  }
  graph.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "Stubelius.UltimateH3.Guide",
  registerCustomNodes() {
    register();
  },
  setup() {
    register();
  },
  afterConfigureGraph() {
    setTimeout(() => { try { upgradeNote(); } catch (e) { console.warn("[Stubelius] guide:", e); } }, 300);
  },
});

let styled = false;
function injectGuideStyles() {
  if (styled) return;
  styled = true;
  document.head.appendChild(h("style", { id: "stubelius-uh3-guide", text: `
.sh3-g .sh3-steps{display:none}
.sh3-g .sh3-body{display:flex;flex-direction:column;gap:16px}
.sh3-g .g-intro{padding:18px 20px;display:flex;flex-direction:column;gap:10px}
.sh3-g .g-p{margin:0;color:var(--text2);font-size:13.5px;line-height:1.6}
.sh3-g .g-p b,.sh3-g li b,.sh3-g .g-tip b,.sh3-g td b{color:var(--text);font-weight:600}
.sh3-g a{color:rgb(var(--ac));text-decoration:none;border-bottom:1px solid rgba(var(--ac),.35)}
.sh3-g a:hover{border-bottom-color:rgb(var(--ac))}
.sh3-g code{font-family:var(--fm);font-size:12px;padding:1px 6px;border-radius:6px;background:var(--well);border:1px solid var(--stroke);color:var(--text)}
.sh3-g i{color:var(--text);font-style:italic}
.sh3-g .g-arrow{color:rgb(var(--ac));font-weight:600}
.sh3-g .g-sec{padding:16px 18px 18px;display:flex;flex-direction:column;gap:12px}
.sh3-g .g-sec-h{display:flex;align-items:center;gap:12px}
.sh3-g .g-chip{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:none;background:var(--brand);color:var(--on);
  font-family:var(--fh);font-weight:700;font-size:15px;box-shadow:0 0 18px rgba(var(--ac),.35)}
.sh3-g .g-name{font-family:var(--fh);font-size:17px;letter-spacing:2px;color:var(--text)}
.sh3-g .g-sub{color:var(--text3);font-size:13px}
.sh3-g .g-go{gap:6px}
.sh3-g .g-sec-b{display:flex;flex-direction:column;gap:10px}
.sh3-g .g-ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.sh3-g .g-ul li{position:relative;padding-left:18px;color:var(--text2);font-size:13.5px;line-height:1.55}
.sh3-g .g-ul li:before{content:"";position:absolute;left:3px;top:.62em;width:6px;height:6px;border-radius:50%;background:rgb(var(--ac));
  box-shadow:0 0 8px rgba(var(--ac),.6)}
.sh3-g .g-tablewrap{overflow-x:auto;border-radius:12px;border:1px solid var(--stroke)}
.sh3-g .g-table{width:100%;border-collapse:collapse;font-size:12.5px}
.sh3-g .g-table th,.sh3-g .g-table td{padding:8px 10px;text-align:left;vertical-align:top;border-bottom:1px solid var(--stroke);color:var(--text2)}
.sh3-g .g-table thead th{color:var(--text3);font-weight:600;font-size:11px;letter-spacing:1px;text-transform:uppercase;background:var(--well)}
.sh3-g .g-table tbody th{color:var(--text);font-family:var(--fh);font-weight:600}
.sh3-g .g-table tr:last-child th,.sh3-g .g-table tr:last-child td{border-bottom:0}
.sh3-g .g-tips{display:grid;grid-template-columns:1fr;gap:8px}
.sh3-g .g-tip{display:flex;gap:10px;padding:10px 12px;border-radius:12px;background:var(--glass);border:1px solid var(--stroke);
  color:var(--text2);font-size:13px;line-height:1.55}
.sh3-g .g-tip-ic{color:rgb(var(--ac));flex:none;margin-top:2px}
.sh3-g .g-repo{text-decoration:none;border:0}
` }));
}
