// Stubelius Ultimate H3: the canvas under the four windows.
//
// The step groups (1 SETUP, 2 DIRECTOR, 3 SEEDS, 4 OUTPUT) are drawn as panels in the workflow theme's colours
// instead of ComfyUI's tinted boxes. The small helper nodes the windows edit (models, theme, output settings, the
// prompt override, the final save) sit behind their window, and the wires of a node that lies behind a window are
// not drawn: move the window and the node shows again, wires and all. tidy() puts a workflow's helpers there: the
// Setup window's "Tidy the canvas", and once by itself when a workflow laid out before the step panels opens.
import { app } from "../../scripts/app.js";
import { themeKey, injectStyles, graphNodes, toast } from "./stubelius_ui.js";

const STEP_TITLE = /^\s*([1-4])\s+(SETUP|DIRECTOR|SEEDS|OUTPUT)\s*$/i;
const WINDOWS = ["StubeliusH3Setup", "StubeliusH3DirectorV2", "StubeliusSeedPreviews", "StubeliusH3Finish"];
const FONT = '"SH3 Space Grotesk", "Space Grotesk", "SH3 Inter", system-ui, sans-serif';

// ------------------------------------------------------------------------------------------- colours

const palettes = new Map();

// The theme's colour tokens, read from the windows' own CSS (one source for both)
function palette() {
  const key = themeKey() || "comfy";
  if (palettes.has(key)) return palettes.get(key);
  injectStyles();
  const probe = document.createElement("div");
  probe.className = "sh3";
  probe.dataset.theme = key;
  probe.style.cssText = "position:absolute;left:-9999px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const v = (name) => cs.getPropertyValue(name).trim();
  const brand = (v("--brand").match(/#[0-9a-f]{3,8}|rgba?\([^)]*\)/gi) || []);
  const p = {
    page: v("--page"), inA: v("--in-a"), inB: v("--in-b"), inHi: v("--in-hi"),
    glow1: v("--glow1"), glow2: v("--glow2"), glow3: v("--glow3"),
    text: v("--text"), text2: v("--text2"), text3: v("--text3"), stroke: v("--stroke2"),
    ac: v("--ac"), ac2: v("--ac2"), on: v("--on"), brand: brand.length ? brand : ["#5c8dff", "#7aa7ff"],
  };
  probe.remove();
  if (!p.page || !p.ac) return FALLBACK;          // the windows' styles aren't in yet: try again next frame
  p.light = luminance(p.page) > 0.5;
  palettes.set(key, p);
  return p;
}

const FALLBACK = {
  page: "#111111", inA: "#232323", inB: "#1c1c1c", inHi: "rgba(255,255,255,.02)", glow1: "rgba(255,255,255,.04)",
  glow2: "rgba(92,141,255,.07)", glow3: "transparent", text: "#e2e2e2", text2: "#a3a3a3", text3: "#727272",
  stroke: "rgba(255,255,255,.14)", ac: "92,141,255", ac2: "122,167,255", on: "#0a1430", brand: ["#5c8dff", "#7aa7ff"],
  light: false,
};

function luminance(color) {
  const m = color.match(/^#([0-9a-f]{6})/i);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

const rgba = (triple, a) => `rgba(${triple},${a})`;

// ------------------------------------------------------------------------------------------- the step panels

export function isStage(group, graph = app.graph) {
  if (group?.flags?.sh3_stage) return true;
  if (!STEP_TITLE.test(String(group?.title || ""))) return false;
  return graphNodes(graph).some((n) => WINDOWS.includes(n.comfyClass || n.type));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function glow(ctx, cx, cy, radius, color) {
  if (!color || color === "transparent") return;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
}

function drawStage(group, canvas, ctx) {
  const [x, y] = group.pos;
  const [w, h] = group.size;
  const p = palette();
  const r = Math.min(36, w / 6, h / 6);
  const head = 64;                                   // the band above the window's own title bar
  ctx.save();
  ctx.globalAlpha = canvas?.editor_alpha ?? 1;

  // the panel: the windows' dark glass, lifted off the canvas by a soft glow in the theme's accent
  const scale = canvas?.ds?.scale || 1;
  roundRect(ctx, x, y, w, h, r);
  const body = ctx.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, p.light ? "#f4f3ef" : p.inA);
  body.addColorStop(1, p.light ? "#e9e8e2" : p.inB);
  ctx.fillStyle = body;
  ctx.shadowColor = p.light ? "rgba(0,0,0,.18)" : rgba(p.ac, 0.16);
  ctx.shadowBlur = 70 * scale;
  ctx.shadowOffsetY = 18 * scale;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // the theme's ambient light, as in the windows
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  const big = Math.max(w, h);
  glow(ctx, x + w * 0.22, y + head, big * 0.62, p.glow1);
  glow(ctx, x + w * 0.95, y + h * 0.92, big * 0.55, p.glow2);
  glow(ctx, x + w * 0.6, y + h * 0.45, big * 0.4, p.glow3);
  const sheen = ctx.createLinearGradient(0, y, 0, y + head * 2);
  sheen.addColorStop(0, p.light ? "rgba(255,255,255,.7)" : "rgba(255,255,255,.045)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, head * 2);
  ctx.restore();

  // the edge: the theme's accent fading through to its second colour
  const edge = ctx.createLinearGradient(x, y, x + w, y + h);
  edge.addColorStop(0, rgba(p.ac, p.light ? 0.55 : 0.75));
  edge.addColorStop(0.35, rgba(p.ac2, 0.22));
  edge.addColorStop(0.6, p.light ? "rgba(0,0,0,.06)" : "rgba(255,255,255,.06)");
  edge.addColorStop(1, rgba(p.ac2, p.light ? 0.3 : 0.45));
  roundRect(ctx, x + 0.75, y + 0.75, w - 1.5, h - 1.5, r);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = edge;
  ctx.stroke();

  // the title: the step number in the brand colours, the step's name
  const m = STEP_TITLE.exec(String(group.title || ""));
  const cy = y + head / 2 + 2;
  let tx = x + 28;
  if (m) {
    const cr = 17;
    const chip = ctx.createLinearGradient(tx, cy - cr, tx + cr * 2, cy + cr);
    p.brand.forEach((c, i) => chip.addColorStop(p.brand.length > 1 ? i / (p.brand.length - 1) : 0, c));
    ctx.beginPath();
    ctx.arc(tx + cr, cy, cr, 0, Math.PI * 2);
    ctx.fillStyle = chip;
    ctx.fill();
    ctx.fillStyle = p.on || "#000";
    ctx.font = `700 19px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(m[1], tx + cr, cy + 1);
    tx += cr * 2 + 16;
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = p.text;
  ctx.font = `700 25px ${FONT}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "3px";
  const name = m ? m[2].toUpperCase() : String(group.title || "");
  ctx.fillText(name, tx, cy + 1);
  tx += ctx.measureText(name).width;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  const sub = subtitleOf(group);
  if (sub || group.pinned) {
    ctx.fillStyle = p.text3;
    ctx.font = `500 21px ${FONT}`;
    ctx.fillText(`${sub ? `   ${sub}` : ""}${group.pinned ? "  📌" : ""}`, tx, cy + 2);
  }

  // resize corner and selection, as ComfyUI's own groups have them
  const k = 12;
  ctx.beginPath();
  ctx.moveTo(x + w - 6, y + h - 6 - k);
  ctx.lineTo(x + w - 6, y + h - 6);
  ctx.lineTo(x + w - 6 - k, y + h - 6);
  ctx.closePath();
  ctx.fillStyle = p.light ? "rgba(0,0,0,.18)" : "rgba(255,255,255,.18)";
  ctx.fill();
  if (group.selected) {
    roundRect(ctx, x - 5, y - 5, w + 10, h + 10, r + 5);
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgba(p.ac, 0.9);
    ctx.stroke();
  }
  ctx.restore();
}

// A panel holds a window when the window's top-left corner is inside it (a window that grew past its panel, as a
// long one does before the panel follows it, still belongs to it)
function holds(group, node) {
  const x = node.pos[0] + 10, y = node.pos[1] + 10;
  return x > group.pos[0] && x < group.pos[0] + group.size[0] && y > group.pos[1] && y < group.pos[1] + group.size[1];
}

// The window inside a step panel
function windowIn(group) {
  return graphNodes(group.graph || app.graph).find((n) => n._sh3 && holds(group, n)) || null;
}

// "OUTPUT — the winner, finished (Finish node)" -> "the winner, finished"
function subtitleOf(group) {
  const t = String(windowIn(group)?.title || "");
  const i = t.search(/\s[—–-]\s/);
  return i < 0 ? "" : t.slice(i + 3).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

// A window shown on a step panel: its title bar, badges and node background aren't drawn (the panel's title says
// it, the window covers the rest); the title strip still moves it
export function onStage(node) {
  if (!node?._sh3) return false;
  const graph = node.graph || app.graph;
  return (graph?._groups || graph?.groups || []).some((g) => isStage(g, graph) && holds(g, node));
}

// The rail between the step panels, 1 -> 2 -> 3 -> 4, where they stand in a row
function drawRails(canvas, ctx) {
  const graph = canvas?.graph || app.graph;
  const steps = (graph?._groups || graph?.groups || []).filter((g) => isStage(g, graph))
    .map((g) => [Number(STEP_TITLE.exec(String(g.title || ""))?.[1] || 0), g]).filter(([k]) => k).sort((a, b) => a[0] - b[0]);
  if (steps.length < 2) return;
  const p = palette();
  ctx.save();
  for (let i = 0; i + 1 < steps.length; i++) {
    const [ka, a] = steps[i], [kb, b] = steps[i + 1];
    if (kb !== ka + 1) continue;
    const x0 = a.pos[0] + a.size[0], x1 = b.pos[0];
    const y0 = a.pos[1] + 34, y1 = b.pos[1] + 34;
    if (x1 - x0 < 24 || Math.abs(y1 - y0) > 120) continue;
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, rgba(p.ac, 0.15));
    g.addColorStop(0.5, rgba(p.ac, 0.75));
    g.addColorStop(1, rgba(p.ac2, 0.15));
    ctx.strokeStyle = g;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x0 + 8, y0);
    ctx.lineTo(x1 - 8, y1);
    ctx.stroke();
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    ctx.fillStyle = rgba(p.ac, 0.95);
    ctx.beginPath();
    ctx.moveTo(mx - 7, my - 8);
    ctx.lineTo(mx + 8, my);
    ctx.lineTo(mx - 7, my + 8);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ------------------------------------------------------------------------------------------- behind a window

// Ids of the nodes that lie inside a window's body (the window covers them, so their wires aren't drawn)
export function nodesBehindWindows(graph = app.graph) {
  const nodes = graphNodes(graph);
  const wins = nodes.filter((n) => n._sh3 && !n.flags?.collapsed).map((n) => [n, n.pos[0], n.pos[1], n.size[0], n.size[1]]);
  const out = new Set();
  if (!wins.length) return out;
  for (const n of nodes) {
    if (n._sh3) continue;
    const b = n.boundingRect || [n.pos[0], n.pos[1] - 30, n.size[0], n.size[1] + 30];
    if (wins.some(([win, x, y, w, h]) => win !== n && b[0] >= x && b[1] >= y && b[0] + b[2] <= x + w && b[1] + b[3] <= y + h)) {
      out.add(n.id);
    }
  }
  return out;
}

function patch() {
  const G = window.LGraphGroup || window.LiteGraph?.LGraphGroup;
  const C = window.LGraphCanvas || window.LiteGraph?.LGraphCanvas;
  if (G?.prototype?.draw && !G.prototype.__sh3Stage) {
    const draw = G.prototype.draw;
    G.prototype.draw = function (canvas, ctx) {
      if (!isStage(this, this.graph)) return draw.apply(this, arguments);
      try {
        drawStage(this, canvas, ctx);
      } catch (e) {
        console.warn("[Stubelius] step panel:", e);
        return draw.apply(this, arguments);
      }
    };
    const th = Object.getOwnPropertyDescriptor(G.prototype, "titleHeight");
    if (th?.get) {
      Object.defineProperty(G.prototype, "titleHeight", {
        configurable: true,
        get() { return isStage(this, this.graph) ? 64 : th.get.call(this); },   // the whole title row moves the group
      });
    }
    G.prototype.__sh3Stage = true;
  }
  const N = window.LGraphNode || window.LiteGraph?.LGraphNode;
  if (N?.prototype && !N.prototype.__sh3Stage) {
    for (const name of ["drawTitleBarBackground", "drawTitleBox", "drawTitleText", "drawBadges"]) {
      const orig = N.prototype[name];
      if (typeof orig !== "function") continue;
      N.prototype[name] = function () {
        if (this._sh3 && onStage(this)) return;
        return orig.apply(this, arguments);
      };
    }
    N.prototype.__sh3Stage = true;
  }
  if (C?.prototype?.drawNodeShape && !C.prototype.__sh3Shape) {
    const shape = C.prototype.drawNodeShape;
    C.prototype.drawNodeShape = function (node, ctx, size, fg, bg, selected) {
      if (node?._sh3 && onStage(node)) return shape.call(this, node, ctx, size, fg, "rgba(0,0,0,0)", selected);
      return shape.apply(this, arguments);
    };
    C.prototype.__sh3Shape = true;
  }
  if (C?.prototype?.drawConnections && C.prototype._renderAllLinkSegments && !C.prototype.__sh3Wires) {
    const drawConnections = C.prototype.drawConnections;
    C.prototype.drawConnections = function () {
      try {
        this.__sh3Behind = nodesBehindWindows(this.graph);
      } catch (e) {
        this.__sh3Behind = null;
      }
      try {
        return drawConnections.apply(this, arguments);
      } finally {
        this.__sh3Behind = null;
      }
    };
    const segments = C.prototype._renderAllLinkSegments;
    C.prototype._renderAllLinkSegments = function (ctx, link) {
      const behind = this.__sh3Behind;
      if (behind?.size && link && (behind.has(link.origin_id) || behind.has(link.target_id))) return;
      return segments.apply(this, arguments);
    };
    C.prototype.__sh3Wires = true;
  }
}

// ------------------------------------------------------------------------------------------- tidy

// Where each helper goes: the window it belongs to
function homeOf(node, windows, graph) {
  const t = node.comfyClass || node.type || "";
  if (t === "StubeliusTheme" || t === "StubeliusH3Models") return windows.StubeliusH3Setup;
  if (t === "StubeliusH3Output") return windows.StubeliusH3Finish || windows.StubeliusH3Setup;
  if (t === "StubeliusLivePreview") return windows.StubeliusH3DirectorV2;          // no wires: it finds the Director
  const linked = new Set();
  const walk = (n, depth) => {
    for (const inp of n.inputs || []) {
      const l = inp.link != null ? graph.getLink?.(inp.link) ?? graph.links?.[inp.link] : null;
      const src = l && graph.getNodeById(l.origin_id);
      if (src) { linked.add(src); if (depth > 0) walk(src, depth - 1); }
    }
    for (const out of n.outputs || []) {
      for (const id of out.links || []) {
        const l = graph.getLink?.(id) ?? graph.links?.[id];
        const dst = l && graph.getNodeById(l.target_id);
        if (dst) linked.add(dst);
      }
    }
  };
  walk(node, 1);
  for (const cls of ["StubeliusH3Finish", "StubeliusH3DirectorV2", "StubeliusSeedPreviews", "StubeliusH3Setup"]) {
    const win = windows[cls];
    if (win && linked.has(win)) return win;
  }
  return null;
}

// Put the helper nodes behind their windows (collapsed) and fit the step groups to their window. Notes and any
// node not wired to a window stay where they are. Returns how many nodes moved.
export function tidy(graph = app.graph) {
  const nodes = graphNodes(graph);
  const windows = {};
  for (const n of nodes) if (WINDOWS.includes(n.comfyClass) && n._sh3) windows[n.comfyClass] = n;
  if (!windows.StubeliusH3DirectorV2) return 0;
  const slots = new Map();
  let moved = 0;
  for (const n of nodes) {
    if (n._sh3 || WINDOWS.includes(n.comfyClass) || /Note$/.test(n.comfyClass || n.type || "")) continue;
    const home = homeOf(n, windows, graph);
    if (!home) continue;
    const i = slots.get(home) || 0;
    slots.set(home, i + 1);
    const to = [home.pos[0] + 48, home.pos[1] + 140 + i * 56];
    if (n.flags?.collapsed && Math.abs(n.pos[0] - to[0]) < 1 && Math.abs(n.pos[1] - to[1]) < 1) continue;   // there already
    if (!n.flags?.collapsed) n.collapse?.(true);
    n.pos = to;
    moved += 1;
  }
  for (const g of graph?._groups || graph?.groups || []) {
    if (!isStage(g, graph)) continue;
    const inside = Object.values(windows).find((w) => holds(g, w));
    g.flags = g.flags || {};
    g.flags.sh3_stage = true;
    if (inside) {
      g.pos = [inside.pos[0] - 30, inside.pos[1] - 94];
      g.size = [inside.size[0] + 60, inside.size[1] + 94 + 36];
    }
  }
  graph?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty(true, true);
  return moved;
}

// A step panel laid out by tidy() (flags.sh3_stage) keeps the height of its window as the window grows or shrinks
function fitStageTo(win) {
  const graph = win?.graph || app.graph;
  if (!win?.pos || !win?.size) return;
  for (const g of graph?._groups || graph?.groups || []) {
    if (!g.flags?.sh3_stage) continue;
    const [gx, gy, gw, gh] = [g.pos[0], g.pos[1], g.size[0], g.size[1]];
    if (!holds(g, win)) continue;
    if (Math.abs(gx - (win.pos[0] - 30)) > 4 || Math.abs(gw - (win.size[0] + 60)) > 4) continue;   // arranged by hand
    const want = Math.round(win.pos[1] + win.size[1] + 36 - gy);
    if (Math.abs(gh - want) > 2) g.size = [gw, want];
  }
}

// A workflow laid out before the step panels (step groups, none of them marked as panels yet) is tidied once, when it
// opens. Marked panels mean it was tidied before: whatever was moved out from behind a window since stays out.
async function autoTidy(graph) {
  for (let i = 0; i < 40; i++) {                     // the windows mount just after the graph is configured
    if (graph !== app.graph) return;
    if (graphNodes(graph).some((n) => n.comfyClass === "StubeliusH3DirectorV2" && n._sh3)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 300));     // and size themselves
  if (graph !== app.graph) return;
  const steps = (graph?._groups || graph?.groups || []).filter((g) => isStage(g, graph));
  if (!steps.length || steps.some((g) => g.flags?.sh3_stage)) return;
  const n = tidy(graph);
  if (!n) return;
  for (const node of graphNodes(graph)) {
    if (node._sh3?.root) toast(node._sh3.root, `Tidied: ${n} helper node${n === 1 ? " is" : "s are"} behind the windows now (move a window to reach them)`);
  }
}

app.registerExtension({
  name: "Stubelius.Stage",
  afterConfigureGraph() {
    autoTidy(app.graph).catch((e) => console.warn("[Stubelius] tidy:", e));
  },
  setup() {
    patch();
    const canvas = app.canvas;
    if (canvas && !canvas.__sh3Rails) {
      const before = canvas.onDrawBackground;
      canvas.onDrawBackground = function (ctx, area) {
        const r = before?.apply(this, arguments);
        try { drawRails(this, ctx); } catch (e) { /* the rails are decoration */ }
        return r;
      };
      canvas.__sh3Rails = true;
    }
    window.addEventListener("stubelius-window-size", (e) => fitStageTo(e.detail?.node));
    window.addEventListener("stubelius-theme", () => app.canvas?.setDirty(true, true));
    document.fonts?.ready?.then(() => app.canvas?.setDirty(true, true));
  },
});
