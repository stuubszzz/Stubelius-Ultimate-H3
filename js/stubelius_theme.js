import { app } from "../../scripts/app.js";

// Per-workflow theme. A "Stubelius Theme" node inside a workflow decides how THAT workflow looks
// while its tab is open: node colours, a stage stripe on each title bar, group colours, the canvas
// background and the Director/LoRA/Live Preview panels. Workflows without the node are untouched
// "ComfyUI default" clears the theme from this workflow and shows your normal ComfyUI look.

const THEMES = {
  "Studio slate":       { cv: "#1c1d21", nb: "#232429", tb: "#2b2d33", tx: "#e7e8eb", mu: "#8b909c", inp: "#16171b", bd: "#34363e", ac: "#2dd4bf", on: "#0b1413", s: ["#60a5fa", "#a78bfa", "#34d399", "#fbbf24"] },
  "Stuubzzz neon":      { cv: "#141117", nb: "#1b1720", tb: "#241e2a", tx: "#f3eef6", mu: "#a095ab", inp: "#110e14", bd: "#3a2f42", ac: "#ff3da8", on: "#1a0610", s: ["#ff3da8", "#ff8a5c", "#ffd64a", "#7cf0c8"] },
  "Film stock":         { cv: "#171411", nb: "#1f1a15", tb: "#29221b", tx: "#efe6d8", mu: "#a3937e", inp: "#14110d", bd: "#3b3127", ac: "#e8a33d", on: "#1a1206", s: ["#e8a33d", "#c8553d", "#9bb07a", "#d9c7a3"] },
  "Paper light":        { cv: "#e7e6e1", nb: "#f8f7f3", tb: "#eeede7", tx: "#26262a", mu: "#6f6d68", inp: "#ffffff", bd: "#d6d4cc", ac: "#2f6fdd", on: "#ffffff", s: ["#2f6fdd", "#7a4fd6", "#0f8a6e", "#c27a12"] },
  "Midnight blueprint": { cv: "#0c1524", nb: "#101d31", tb: "#15263f", tx: "#dbe7ff", mu: "#7f93b5", inp: "#0a1220", bd: "#233857", ac: "#4f9dff", on: "#06101f", s: ["#4f9dff", "#58e1ff", "#8ef0b6", "#ffc86b"] },
  "ComfyUI default":    null,
};
const STYLE_ID = "stubelius-workflow-theme";
let savedCanvasBg;            // the canvas colour before a theme touched it
let active = null;            // name of the theme currently applied, or null

function stageOf(node) {
  const t = node.comfyClass || node.type || "";
  const title = (node.title || "").toLowerCase();
  if (t === "StubeliusH3Setup" || t === "StubeliusTheme" || t === "MarkdownNote") return 0;
  if (t === "StubeliusH3Models") return 1;
  if (t === "StubeliusH3Finish" || title.startsWith("final") || title.startsWith("last frame")) return 3;
  if (t.startsWith("StubeliusH3Director") || t === "StubeliusLivePreview" || t === "PreviewAny"
      || t === "PrimitiveStringMultiline" || title.startsWith("seed")) return 2;
  return 2;
}

function css(p) {
  return `
.mmd-root, [class*="mmd-"] { --mmd-accent: ${p.ac} !important; color: ${p.tx}; }
[class*="mmd-box"] { background: ${p.nb} !important; border: 1px solid ${p.bd} !important; border-top: 2px solid ${p.ac} !important; box-shadow: none !important; }
.mmd-box-title, [class*="mmd-box"] [class*="box-title"] { color: ${p.ac} !important; }
[class*="mmd-"] label, .mmd-box-subtitle, .mmd-chunk-heading, .mmd-lora-label, .mmd-lora-sum { color: ${p.mu} !important; }
.mmd-chunk-heading { color: ${p.ac} !important; }
[class*="mmd-"] input[type="text"], [class*="mmd-"] input[type="number"], [class*="mmd-"] select, [class*="mmd-"] textarea,
.mmd-box-select, .mmd-box-number, .mmd-lora-filter { background: ${p.inp} !important; color: ${p.tx} !important; border: 1px solid ${p.bd} !important; }
[class*="mmd-"] select option, [class*="mmd-"] select optgroup { background: ${p.inp}; color: ${p.tx}; }
[class*="mmd-"] input:focus, [class*="mmd-"] select:focus, [class*="mmd-"] textarea:focus { border-color: ${p.ac} !important; outline: none !important; }
[class*="mmd-"] input[type="checkbox"], [class*="mmd-"] input[type="range"], .mmd-box-checkbox { accent-color: ${p.ac} !important; }
[class*="mmd-"] button, .mmd-analyze-btn { background: ${p.inp} !important; color: ${p.tx} !important; border: 1px solid ${p.bd} !important; box-shadow: none !important; }
[class*="mmd-"] button:hover, .mmd-analyze-btn:hover { border-color: ${p.ac} !important; color: ${p.ac} !important; }
.mmd-add-cut, .mmd-add-cut-bar, .mmd-add-chunk-bar, .mmd-delete-chunk-bar { background: ${p.nb} !important; color: ${p.mu} !important; border-color: ${p.bd} !important; }
.mmd-add-cut:hover, .mmd-add-cut-bar:hover, .mmd-add-chunk-bar:hover { color: ${p.ac} !important; border-color: ${p.ac} !important; }
.mmd-char-slot, .mmd-av-slot { background: ${p.inp} !important; border-color: ${p.bd} !important; }
.mmd-char-slot:hover, .mmd-av-slot:hover { border-color: ${p.ac} !important; }
.mmd-speaker-chip { background: ${p.inp} !important; color: ${p.tx} !important; border: 1px solid ${p.bd} !important; }
.mmd-speaker-chip.mmd-speaker-chip-active { background: ${p.ac} !important; color: ${p.on} !important; border-color: ${p.ac} !important; }
.mmd-mode-pill, .mmd-badge { background: ${p.ac} !important; color: ${p.on} !important; border-color: ${p.ac} !important; }
.mmd-lora-sum.high, .mmd-lora-note { color: ${p.s[3]} !important; }
.stb-live-preview, .stb-live-preview > div { color: ${p.mu} !important; }
.stb-live-preview-stage { background: ${p.inp} !important; border: 1px solid ${p.bd}; box-sizing: border-box; }
[data-node-type^="Stubelius"], [data-node-type^="MuseMinimax"] { background: ${p.nb} !important; color: ${p.tx} !important; border-color: ${p.bd} !important; }
[data-node-type^="Stubelius"] header, [data-node-type^="MuseMinimax"] header,
[data-node-type^="Stubelius"] .node-title, [data-node-type^="MuseMinimax"] .node-title { background: ${p.tb} !important; color: ${p.tx} !important; }
`;
}

function drawStripe(node) {
  if (node.__stbStripe) return;
  node.__stbStripe = true;
  const orig = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    const r = orig?.apply(this, arguments);
    if (active && THEMES[active] && this.__stbColor && !this.flags?.collapsed) {
      const h = window.LiteGraph?.NODE_TITLE_HEIGHT || 30;
      ctx.save();
      ctx.fillStyle = this.__stbColor;
      ctx.fillRect(0, -h, 4, h);
      ctx.restore();
    }
    return r;
  };
}

function clearOurColours(graph) {
  for (const n of graph?._nodes || []) {
    if (n.__stbColor || n.__stbStripe) { delete n.color; delete n.bgcolor; n.__stbColor = null; }
  }
}

function themeNode(graph) {
  return (graph?._nodes || graph?.nodes || []).find((n) => (n.comfyClass || n.type) === "StubeliusTheme");
}

function apply() {
  const graph = app.graph;
  const tn = themeNode(graph);
  const name = tn?.widgets?.find((w) => w.name === "theme")?.value ?? null;
  const p = name ? THEMES[name] : null;
  const canvas = app.canvas;
  if (savedCanvasBg === undefined && canvas) savedCanvasBg = canvas.clear_background_color;

  let style = document.getElementById(STYLE_ID);
  if (!p) {
    // No theme node (another workflow): never touch its nodes. "ComfyUI default" chosen in THIS
    // workflow: clear the colours our theme wrote.
    active = name;
    window.__stubeliusWorkflowTheme = false;
    style?.remove();
    const gold = document.getElementById("stubelius-gold-graph");
    if (gold) gold.disabled = false;
    if (canvas && savedCanvasBg !== undefined) canvas.clear_background_color = savedCanvasBg;
    if (name) clearOurColours(graph);
    window.__stubeliusGoldRepaint?.();
    canvas?.setDirty(true, true);
    return;
  }

  active = name;
  window.__stubeliusWorkflowTheme = true;
  const gold = document.getElementById("stubelius-gold-graph");
  if (gold) gold.disabled = true;
  if (!style) { style = document.createElement("style"); style.id = STYLE_ID; }
  style.textContent = css(p);
  document.head.appendChild(style);
  if (canvas) canvas.clear_background_color = p.cv;

  for (const n of graph?._nodes || []) {
    n.color = p.tb;
    n.bgcolor = p.nb;
    n.__stbColor = p.s[stageOf(n)];
    drawStripe(n);
  }
  const stageByGroup = { "1": 0, "2": 2, "3": 2, "4": 3 };
  for (const g of graph?._groups || graph?.groups || []) {
    const k = String(g.title || "").trim()[0];
    if (k in stageByGroup) g.color = p.s[stageByGroup[k]];
  }
  canvas?.setDirty(true, true);
}

const later = () => setTimeout(apply, 0);   // run after other extensions (gold) have painted

app.registerExtension({
  name: "Stubelius.WorkflowTheme",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "StubeliusTheme") return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const w = this.widgets?.find((x) => x.name === "theme");
      if (w) {
        const orig = w.callback;
        w.callback = (...args) => { const res = orig?.apply(w, args); later(); return res; };
      }
      later();
      return r;
    };
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const r = onRemoved?.apply(this, arguments);
      const graph = app.graph;
      setTimeout(() => {           // theme node deleted from this workflow: undo its colours here only
        if (!themeNode(graph)) clearOurColours(graph);
        apply();
      }, 0);
      return r;
    };
  },
  nodeCreated() { if (active) later(); },
  afterConfigureGraph() { later(); },
});
