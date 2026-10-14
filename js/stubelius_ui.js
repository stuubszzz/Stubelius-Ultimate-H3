// Stubelius Ultimate H3: the look the four windows share (Setup, Director, Seeds, Output).
//
// One set of colour tokens per pack theme (the workflow's Stubelius Theme node picks it, see
// stubelius_theme.js; a workflow without one gets "ComfyUI default"), the components the windows are
// built from (panels, segmented switches, sliders, toggles, chips, buttons, menus) and the line icons,
// drawn here so nothing but the two typefaces is fetched. Everything is scoped under .sh3.

const { app } = window.comfyAPI.app;

export const THEMES = {
  "Stuubzzz neon": "neon", "Studio slate": "slate", "Film stock": "film",
  "Paper light": "paper", "Midnight blueprint": "midnight", "ComfyUI default": "comfy",
};
export const THEME_NAMES = Object.keys(THEMES);
// the swatches the Look panel shows: [stripe gradient, four dots]
export const THEME_SWATCHES = {
  "Studio slate": ["linear-gradient(90deg,#2dd4bf,#60a5fa,#a78bfa)", ["#60a5fa", "#a78bfa", "#34d399", "#fbbf24"]],
  "Stuubzzz neon": ["linear-gradient(90deg,#ff3da8,#ff6b5b,#ffc93d)", ["#ff3da8", "#ff8a5c", "#ffd64a", "#7cf0c8"]],
  "Film stock": ["linear-gradient(90deg,#f0b252,#e8a33d,#c8553d)", ["#e8a33d", "#c8553d", "#9bb07a", "#d9c7a3"]],
  "Paper light": ["linear-gradient(90deg,#2f6fdd,#7a4fd6)", ["#2f6fdd", "#7a4fd6", "#0f8a6e", "#c27a12"]],
  "Midnight blueprint": ["linear-gradient(90deg,#4f9dff,#58e1ff,#8ef0b6)", ["#4f9dff", "#58e1ff", "#8ef0b6", "#ffc86b"]],
  "ComfyUI default": ["linear-gradient(90deg,#5c8dff,#7aa7ff)", ["#8a8a8a", "#a0a0a0", "#b8b8b8", "#d0d0d0"]],
};

// ------------------------------------------------------------------------------------------- nodes

export function graphNodes(graph = app.graph) {
  return graph?._nodes || graph?.nodes || [];
}

export function nodesOfType(type, graph = app.graph) {
  return graphNodes(graph).filter((n) => (n.comfyClass || n.type) === type);
}

export function widget(node, name) {
  return node?.widgets?.find((w) => w.name === name) || null;
}

export function widgetValue(node, name, fallback = null) {
  const w = widget(node, name);
  return w ? w.value : fallback;
}

// Set a widget the way the user would: value, its callback (presets, size lists), redraw.
export function setWidget(node, name, value) {
  const w = widget(node, name);
  if (!w) return false;
  w.value = value;
  w.callback?.(w.value, app.canvas, node);
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
  return true;
}

function getLink(graph, id) {
  if (id == null || !graph) return null;
  return graph.getLink?.(id) ?? graph.links?.get?.(id) ?? graph.links?.[id] ?? null;
}

// The node wired into one of this node's inputs.
export function sourceOf(node, inputName) {
  const input = node?.inputs?.find((i) => i.name === inputName);
  const link = getLink(node?.graph, input?.link);
  return link ? node.graph.getNodeById(link.origin_id) : null;
}

// The nodes one of this node's outputs feeds.
export function targetsOf(node, outputName) {
  const out = node?.outputs?.find((o) => o.name === outputName);
  return (out?.links || []).map((id) => getLink(node.graph, id)).filter(Boolean)
    .map((l) => node.graph.getNodeById(l.target_id)).filter(Boolean);
}

// Glide the canvas to a node (the step bar's Setup / Director / Seeds / Output).
export function glideTo(node) {
  const canvas = app.canvas;
  const ds = canvas?.ds;
  if (!node || !ds) return;
  const el = canvas.canvas;
  const w = el.width / (window.devicePixelRatio || 1);
  const h = el.height / (window.devicePixelRatio || 1);
  const scale = Math.min(1, Math.max(0.25, Math.min((w * 0.92) / node.size[0], (h * 0.9) / (node.size[1] + 40))));
  const to = [w / 2 / scale - node.pos[0] - node.size[0] / 2, h / 2 / scale - node.pos[1] - node.size[1] / 2 + 15];
  const from = [ds.offset[0], ds.offset[1]], fromScale = ds.scale, t0 = performance.now();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const step = (now) => {
    const k = ease(Math.min(1, (now - t0) / 420));
    ds.scale = fromScale + (scale - fromScale) * k;
    ds.offset[0] = from[0] + (to[0] - from[0]) * k;
    ds.offset[1] = from[1] + (to[1] - from[1]) * k;
    canvas.setDirty(true, true);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------------------------------- theme

export function themeName(graph = app.graph) {
  const node = nodesOfType("StubeliusTheme", graph)[0];
  const name = widgetValue(node, "theme");
  return name && THEMES[name] ? name : "ComfyUI default";
}

export function themeKey(graph = app.graph) {
  return THEMES[themeName(graph)];
}

const themed = new Set();          // window roots that follow the workflow's theme

export function followTheme(root) {
  themed.add(root);
  root.dataset.theme = themeKey();
}

export function forgetTheme(root) {
  themed.delete(root);
}

export function refreshThemes() {
  const key = themeKey();
  for (const root of themed) {
    if (!root.isConnected && !document.body.contains(root)) continue;
    root.dataset.theme = key;
  }
}
window.addEventListener("stubelius-theme", refreshThemes);

// ------------------------------------------------------------------------------------------- DOM

// h("div.cls.other", {attrs}, ...children): a small element builder.
export function h(spec, attrs, ...children) {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = (el.className ? el.className + " " : "") + v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "style") el.style.cssText = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// Keep pointer and key events inside a window from reaching the canvas (dragging, shortcuts),
// except a wheel over plain surfaces, which still zooms the canvas.
export function isolate(el) {
  for (const type of ["pointerdown", "mousedown", "dblclick", "contextmenu", "keydown", "keyup"]) {
    el.addEventListener(type, (e) => {
      if (type === "keydown" || type === "keyup") {
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) e.stopPropagation();
        return;
      }
      e.stopPropagation();
    });
  }
}

export function fmtSeconds(s, places = 1) {
  return `${(Number(s) || 0).toFixed(places)} s`;
}

export function fmtClock(s) {
  s = Math.max(0, Number(s) || 0);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

// ------------------------------------------------------------------------------------------- icons

const P = {
  check: "M5 12l5 5l10 -10",
  chevronRight: "M9 6l6 6l-6 6",
  chevronDown: "M6 9l6 6l6 -6",
  chevronUp: "M6 15l6 -6l6 6",
  plus: "M12 5l0 14M5 12l14 0",
  x: "M18 6l-12 12M6 6l12 12",
  refresh: "M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4",
  dice: "M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2zM8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01",
  link: "M9 15l6 -6M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463",
  photo: "M15 8h.01M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3zM3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3",
  frame: "M4 7l16 0M4 17l16 0M7 4l0 16M17 4l0 16",
  cut: "M4 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0M14 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0M9.15 14.85l8.85 -10.85M6 4l8.85 10.85",
  bolt: "M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11",
  sparkles: "M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z",
  palette: "M12 21a9 9 0 0 1 0 -18c4.97 0 9 3.582 9 8c0 1.06 -.474 2.078 -1.318 2.828c-.844 .75 -1.989 1.172 -3.182 1.172h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25M8.5 10.5h.01M12.5 7.5h.01M16.5 10.5h.01",
  wave: "M21 12h-2c-.894 0 -1.662 -.857 -1.761 -2c-.296 -3.45 -.749 -6 -2.749 -6s-2.5 3.582 -2.5 8s-.5 8 -2.5 8s-2.452 -2.547 -2.749 -6c-.1 -1.147 -.867 -2 -1.763 -2h-2",
  music: "M3 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0M13 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0M9 17v-13h10v13M9 8h10",
  mic: "M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1 -6 0zM5 10a7 7 0 0 0 14 0M8 21l8 0M12 17l0 4",
  users: "M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2M16 3.13a4 4 0 0 1 0 7.75M21 21v-2a4 4 0 0 0 -3 -3.85",
  user: "M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2",
  settings: "M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065zM9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0",
  folder: "M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2",
  copy: "M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667zM4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  movie: "M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2zM8 4l0 16M16 4l0 16M4 8l4 0M4 16l4 0M4 12l16 0M16 8l4 0M16 16l4 0",
  columns: "M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2zM12 4l0 16",
  crown: "M12 6l4 6l5 -4l-2 10h-14l-2 -10l5 4z",
  headphones: "M4 15a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2zM15 15a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2zM4 15v-3a8 8 0 0 1 16 0v3",
  volume: "M15 8a5 5 0 0 1 0 8M17.7 5a9 9 0 0 1 0 14M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5",
  volumeOff: "M15 8a5 5 0 0 1 1.912 4.934m-1.377 2.602a5 5 0 0 1 -.535 .464M17.7 5a9 9 0 0 1 2.362 11.086m-1.676 2.299a9 9 0 0 1 -.686 .615M9.069 5.054l.431 -.554a.8 .8 0 0 1 1.5 .5v2m0 4v8a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l1.294 -1.664M3 3l18 18",
  maximize: "M16 4l4 0l0 4M14 10l6 -6M8 20l-4 0l0 -4M4 20l6 -6M16 20l4 0l0 -4M14 14l6 6M8 4l-4 0l0 4M4 4l6 6",
  repeat: "M4 12v-3a3 3 0 0 1 3 -3h13m-3 -3l3 3l-3 3M20 12v3a3 3 0 0 1 -3 3h-13m3 3l-3 -3l3 -3",
  zoom: "M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0M21 21l-6 -6M7 10l6 0M10 7l0 6",
  download: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2M7 11l5 5l5 -5M12 4l0 12",
  upload: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2M7 9l5 -5l5 5M12 4l0 12",
  lock: "M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2zM11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0M8 11v-4a4 4 0 1 1 8 0v4",
  alert: "M12 9v4M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0zM12 16h.01",
  circleCheck: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0M9 12l2 2l4 -4",
  cpu: "M5 6a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1zM9 9h6v6h-6zM3 10h2M3 14h2M10 3v2M14 3v2M21 10h-2M21 14h-2M14 21v-2M10 21v-2",
  database: "M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0M4 6v6a8 3 0 0 0 16 0v-6M4 12v6a8 3 0 0 0 16 0v-6",
  eye: "M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6",
  lines: "M4 6h16M4 12h11M4 18h14",
  message: "M8 9h8M8 13h6M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z",
  trash: "M4 7l16 0M10 11l0 6M14 11l0 6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  arrowsH: "M21 17l-18 0M6 10l-3 -3l3 -3M3 7l18 0M18 20l3 -3l-3 -3",
  arrowRight: "M5 12l14 0M13 18l6 -6M13 6l6 6",
  clock: "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0M12 7v5l3 3",
  stairs: "M4 18h4v-4h4v-4h4v-4h4",
  aspect: "M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2zM7 12v-3h3M17 12v3h-3",
  grid: "M4 4h6v6h-6zM14 4h6v6h-6zM4 14h6v6h-6zM14 14h6v6h-6z",
  sliders: "M4 6h8M16 6h4M14 4v4M4 12h2M10 12h10M8 10v4M4 18h11M19 18h1M17 16v4",
  sun: "M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7",
  layers: "M12 4l-8 4l8 4l8 -4l-8 -4M4 12l8 4l8 -4M4 16l8 4l8 -4",
  chart: "M4 19l16 0M4 15l4 -6l4 2l4 -5l4 4",
  scan: "M4 8v-2a2 2 0 0 1 2 -2h2M4 16v2a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v2M16 20h2a2 2 0 0 0 2 -2v-2M8 12h8",
  type: "M4 7v-2h16v2M12 5v14M9 19h6",
  run: "M13 4a1 1 0 1 0 2 0a1 1 0 1 0 -2 0M4 17l5 1l.75 -1.5M15 21l0 -4l-4 -3l1 -6M7 12l0 -3l5 -1l3 3l3 1",
  wand: "M6 21l15 -15l-3 -3l-15 15l3 3M15 6l3 3M9 3a2 2 0 0 0 2 2a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2a2 2 0 0 0 2 -2M19 13a2 2 0 0 0 2 2a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2a2 2 0 0 0 2 -2",
  film: "M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2zM4 9h16M4 15h16M8 4v5M12 4v5M16 4v5M8 15v5M12 15v5M16 15v5",
  external: "M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6M11 13l9 -9M15 4h5v5",
  history: "M12 8l0 4l2 2M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5",
  hand: "M8 13v-7.5a1.5 1.5 0 0 1 3 0v6.5M11 5.5v-2a1.5 1.5 0 1 1 3 0v8.5M14 5.5a1.5 1.5 0 0 1 3 0v6.5M17 7.5a1.5 1.5 0 0 1 3 0v8.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.47 1.47",
  speaker: "M15 8a5 5 0 0 1 0 8M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5",
  diamond: "M6 5h12l3 5l-8.5 9.5a.7 .7 0 0 1 -1 0l-8.5 -9.5l3 -5M10 12l-2 -2.2l.6 -1",
  info: "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0M12 9h.01M11 12h1v4h1",
  hash: "M5 9l14 0M5 15l14 0M11 4l-4 16M17 4l-4 16",
  target: "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0M7 12a5 5 0 1 0 10 0a5 5 0 1 0 -10 0M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
};
const FILLED = {
  play: "M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z",
  pause: "M9 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2zM17 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z",
  next: "M3 5v14a1 1 0 0 0 1.6 .8l7.4 -7a1 1 0 0 0 0 -1.6l-7.4 -7a1 1 0 0 0 -1.6 .8zM13 5v14a1 1 0 0 0 1.6 .8l7.4 -7a1 1 0 0 0 0 -1.6l-7.4 -7a1 1 0 0 0 -1.6 .8z",
  dot: "M12 7a5 5 0 1 1 0 10a5 5 0 0 1 0 -10z",
};

// icon("check", 18) -> an inline SVG element
export function icon(name, size = 18, extraClass = "") {
  const filled = FILLED[name];
  const d = filled || P[name] || P.dots;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("class", `sh3-ic ${extraClass}`.trim());
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  if (filled) {
    path.setAttribute("fill", "currentColor");
  } else {
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
  }
  svg.appendChild(path);
  return svg;
}

// ------------------------------------------------------------------------------------------- components

// A segmented switch: options = [[value, label, iconName?], ...]
export function seg(options, value, onChange, extraClass = "") {
  const el = h(`div.sh3-seg${extraClass ? "." + extraClass : ""}`);
  const draw = (current) => {
    clear(el);
    for (const [v, label, ic, hint] of options) {
      el.appendChild(h("button.sh3-seg-opt", {
        type: "button", class: v === current ? "on" : null, title: hint || null,
        onclick: () => { if (v !== current) { onChange(v); draw(v); } },
      }, ic ? icon(ic, 15) : null, label));
    }
  };
  draw(value);
  el.setValue = draw;
  return el;
}

export function toggle(value, onChange, title = "") {
  const el = h("button.sh3-tog", { type: "button", class: value ? "on" : null, title: title || null });
  el.addEventListener("click", () => {
    value = !value;
    el.classList.toggle("on", value);
    onChange(value);
  });
  el.setValue = (v) => { value = !!v; el.classList.toggle("on", value); };
  return el;
}

// A range slider with the brand fill; onInput while dragging, onChange on release
export function slider({ min = 0, max = 1, step = 0.01, value = 0, onInput, onChange, title }) {
  const input = h("input.sh3-range", { type: "range", min, max, step, value, title: title || null });
  const fill = () => {
    const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--pct", `${Math.max(0, Math.min(100, pct))}%`);
  };
  input.addEventListener("input", () => { fill(); onInput?.(Number(input.value)); });
  input.addEventListener("change", () => onChange?.(Number(input.value)));
  fill();
  input.setValue = (v) => { input.value = v; fill(); };
  return input;
}

export function select(options, value, onChange, extraClass = "") {
  const el = h(`select.sh3-select${extraClass ? "." + extraClass : ""}`);
  for (const o of options) {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    el.appendChild(h("option", { value: v, text: label, selected: v === value }));
  }
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

export function button(label, ic, kind = "", onClick = null, title = "") {
  const el = h(`button.sh3-btn${kind ? "." + kind.split(" ").join(".") : ""}`, { type: "button", title: title || null },
    ic ? icon(ic, kind.includes("cta") ? 20 : 16) : null, label ? h("span", label) : null);
  if (onClick) el.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return el;
}

export function iconButton(ic, title, onClick) {
  return h("button.sh3-ibtn", { type: "button", title, onclick: (e) => { e.stopPropagation(); onClick?.(e); } }, icon(ic, 18));
}

export function badge(text, kind = "") {
  return h(`span.sh3-badge${kind ? "." + kind : ""}`, text);
}

export function label(text) {
  return h("span.sh3-lbl", text);
}

// A popover menu under `anchor`: items = [{label, icon, onClick, danger, disabled, hint}] or null for a divider
export function menu(anchor, items) {
  closeMenus();
  const root = anchor.closest(".sh3") || document.body;
  const el = h("div.sh3-menu");
  for (const it of items) {
    if (!it) { el.appendChild(h("div.sh3-menu-sep")); continue; }
    el.appendChild(h("button.sh3-menu-item", {
      type: "button", class: [it.danger ? "danger" : "", it.disabled ? "disabled" : ""].join(" ").trim() || null,
      onclick: (e) => { e.stopPropagation(); if (it.disabled) return; closeMenus(); it.onClick?.(); },
    }, it.icon ? icon(it.icon, 16) : h("span.sh3-menu-noicon"), h("span", it.label),
    it.hint ? h("span.sh3-menu-hint", it.hint) : null));
  }
  const a = anchor.getBoundingClientRect(), r = root.getBoundingClientRect();
  const zoom = r.width / (root.offsetWidth || r.width) || 1;          // the canvas scales the window
  el.style.left = `${(a.left - r.left) / zoom}px`;
  el.style.top = `${(a.bottom - r.top) / zoom + 6}px`;
  root.appendChild(el);
  const width = el.offsetWidth;
  if ((a.left - r.left) / zoom + width > root.offsetWidth - 12) {
    el.style.left = `${Math.max(12, (a.right - r.left) / zoom - width)}px`;
  }
  setTimeout(() => document.addEventListener("pointerdown", onAway, true), 0);
  return el;
}

// A popover panel under `anchor` holding any element (settings and the like)
export function popover(anchor, content, width = 380) {
  closeMenus();
  const root = anchor.closest(".sh3") || document.body;
  const el = h("div.sh3-menu.sh3-pop", { style: { width: `${width}px`, maxWidth: "none" } }, content);
  const a = anchor.getBoundingClientRect(), r = root.getBoundingClientRect();
  const zoom = r.width / (root.offsetWidth || r.width) || 1;
  root.appendChild(el);
  let left = (a.right - r.left) / zoom - width;
  if (left < 12) left = Math.min((a.left - r.left) / zoom, root.offsetWidth - width - 12);
  el.style.left = `${Math.max(12, left)}px`;
  el.style.top = `${(a.bottom - r.top) / zoom + 6}px`;
  setTimeout(() => document.addEventListener("pointerdown", onAway, true), 0);
  return el;
}

function onAway(e) {
  if (e.target.closest?.(".sh3-menu")) return;
  closeMenus();
}

export function closeMenus() {
  document.querySelectorAll(".sh3-menu").forEach((m) => m.remove());
  document.removeEventListener("pointerdown", onAway, true);
}

// A short message at the bottom of a window
export function toast(root, text, kind = "") {
  const el = h(`div.sh3-toast${kind ? "." + kind : ""}`, text);
  (root.closest?.(".sh3") || root).appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
  setTimeout(() => { el.classList.remove("in"); setTimeout(() => el.remove(), 400); }, 2600);
}

// The window frame every window uses: gradient edge, glass inside, header with the step bar.
export function windowFrame({ title, subtitle, step, onStep }) {
  const root = h("div.sh3.sh3-window");
  followTheme(root);
  const inner = h("div.sh3-inner");
  const ambient = h("div.sh3-ambient");
  inner.append(ambient, h("div.sh3-pattern"), h("div.sh3-grain"));
  const steps = h("div.sh3-steps");
  const names = ["Setup", "Director", "Seeds", "Output"];
  names.forEach((name, i) => {
    if (i) steps.appendChild(icon("chevronRight", 14, "sh3-chev"));
    steps.appendChild(h("button.sh3-step", {
      type: "button", class: i + 1 === step ? "on" : null, dataset: { step: String(i + 1) },
      title: i + 1 === step ? null : `Go to ${name}`,
      onclick: (e) => { e.stopPropagation(); if (i + 1 !== step) onStep?.(i + 1); },
    }, h("b", String(i + 1)), name));
  });
  const head = h("div.sh3-hdr",
    h("div.sh3-logo", h("span", "S")),
    h("div.sh3-title", h("div.sh3-ttl", title), h("div.sh3-sub", subtitle || "")),
    steps);
  const body = h("div.sh3-body");
  const foot = h("div.sh3-foot");
  inner.append(head, body, foot);
  root.appendChild(inner);
  isolate(root);
  return { root, inner, head, body, foot, ambient, steps };
}

// Mark the step bar: done = set of step numbers with a check
export function markSteps(stepsEl, done) {
  stepsEl.querySelectorAll(".sh3-step").forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle("done", done.has(n) && !el.classList.contains("on"));
    const b = el.querySelector("b");
    clear(b);
    if (done.has(n) && !el.classList.contains("on")) b.appendChild(icon("check", 12));
    else b.textContent = String(n);
  });
}

// The four windows, by step number, in the current workflow
export function windowNodes(graph = app.graph) {
  return {
    1: nodesOfType("StubeliusH3Setup", graph)[0],
    2: nodesOfType("StubeliusH3DirectorV2", graph)[0],
    3: nodesOfType("StubeliusSeedPreviews", graph)[0],
    4: nodesOfType("StubeliusH3Finish", graph)[0],
  };
}

export function goToStep(n) {
  const node = windowNodes()[n];
  if (node) glideTo(node);
}

// Grow or shrink a node to its window's height, measured from the window's content (ComfyUI sizes the
// widget element itself, so its own height would only echo the node's).
export function windowHeight(root) {
  const inner = root.querySelector(":scope > .sh3-inner");
  return Math.ceil((inner ? inner.offsetHeight + 3 : root.scrollHeight) || 0);
}

export function autoHeight(node, root, { minHeight = 400, extra = 50, minWidth = 900 } = {}) {
  let frame = 0;
  const fit = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = 0;
        const content = Math.max(windowHeight(root), minHeight);
        const width = Math.max(node.size?.[0] || minWidth, minWidth);
        const height = Math.ceil(content + extra);
        if (!node.size || Math.abs(node.size[1] - height) > 2 || node.size[0] !== width) {
          node.setSize([width, height]);
          node.setDirtyCanvas?.(true, true);
        }
      });
    });
  };
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(fit);
    ro.observe(root);
    const inner = root.querySelector(":scope > .sh3-inner");
    if (inner) ro.observe(inner);
  }
  fit();
  return fit;
}

// Hide a node's own widgets: the window is their UI (same guarded hider the Director always used).
export function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  if (!w.options) w.options = {};
  w.options.hidden = true;
  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    w.computeSize = () => [0, -4];
    if (!w._hiddenDrawHooked) {
      w._origDraw = Object.prototype.hasOwnProperty.call(w, "draw") ? w.draw : undefined;
      w._hiddenDrawHooked = true;
    }
    w.draw = () => {};
  }
  if (w.element) w.element.style.display = "none";
}

// Mount a window on a node as its DOM widget, sized to the window's height. The window starts right under
// the title and covers the node's socket rows (the links still attach there).
export function mountWindow(node, name, root, { minWidth = 1200, minHeight = 600 } = {}) {
  node.widgets_start_y = 0;
  const w = node.addDOMWidget(name, name, root, { serialize: false, hideOnZoom: false, getMinHeight: () => minHeight });
  w.computeSize = (width) => [Math.max(node.size?.[0] || width || minWidth, minWidth),
    Math.max(windowHeight(root), minHeight)];
  return w;
}

// ------------------------------------------------------------------------------------------- styles

const FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";

export function injectStyles() {
  if (document.getElementById("stubelius-uh3-ui")) return;
  if (!document.getElementById("stubelius-uh3-fonts")) {
    document.head.appendChild(h("link", { id: "stubelius-uh3-fonts", rel: "stylesheet", href: FONTS }));
  }
  document.head.appendChild(h("style", { id: "stubelius-uh3-ui", text: CSS }));
}

const CSS = `
.sh3{--page:#030306;--glow1:rgba(255,61,168,.20);--glow2:rgba(143,123,255,.20);--glow3:rgba(255,201,61,.05);
  --in-a:#0d0c14;--in-b:#08080e;--in-hi:rgba(255,61,168,.07);
  --edge:linear-gradient(135deg,rgba(255,61,168,.9),rgba(255,107,91,.35) 25%,rgba(255,255,255,.08) 45%,rgba(143,123,255,.35) 80%,rgba(63,213,255,.6));
  --text:#f3f1f8;--text2:#aaa7bb;--text3:#6f6c82;
  --glass:rgba(255,255,255,.035);--glass2:rgba(255,255,255,.06);--glass3:rgba(255,255,255,.09);
  --stroke:rgba(255,255,255,.08);--stroke2:rgba(255,255,255,.14);--well:rgba(0,0,0,.18);--field:rgba(0,0,0,.28);
  --ac:255,61,168;--ac2:255,107,91;--on:#22070f;
  --brand:linear-gradient(100deg,#ff3da8 0%,#ff6b5b 52%,#ffc93d 100%);
  --k:143,123,255;--snd:63,213,255;--cut:255,201,61;--ok:61,242,176;--bad:255,92,92;
  --shadow:0 40px 120px rgba(0,0,0,.65);--panel-shadow:0 30px 80px rgba(0,0,0,.45);
  --grain:rgba(255,255,255,.035);--pattern:none;--ambient:.42;--menu:#15131c;--video:#000;
  --ff:Inter,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
  --fh:"Space Grotesk","Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;
  --fm:"JetBrains Mono",Consolas,"Cascadia Mono",monospace;}
.sh3[data-theme="slate"]{--page:#040506;--glow1:rgba(45,212,191,.15);--glow2:rgba(96,165,250,.14);--glow3:rgba(167,139,250,.05);
  --in-a:#131418;--in-b:#0b0c0f;--in-hi:rgba(45,212,191,.06);
  --edge:linear-gradient(135deg,rgba(45,212,191,.85),rgba(96,165,250,.35) 30%,rgba(255,255,255,.07) 50%,rgba(167,139,250,.45));
  --text:#e9eaee;--text2:#a3a8b4;--text3:#6b7080;--ac:45,212,191;--ac2:96,165,250;--on:#04201c;
  --brand:linear-gradient(100deg,#2dd4bf 0%,#60a5fa 55%,#a78bfa 100%);
  --k:167,139,250;--snd:96,165,250;--cut:251,191,36;--ok:52,211,153;--menu:#16181d;}
.sh3[data-theme="film"]{--page:#070504;--glow1:rgba(232,163,61,.17);--glow2:rgba(200,85,61,.13);--glow3:rgba(217,199,163,.05);
  --in-a:#17120d;--in-b:#0d0a07;--in-hi:rgba(232,163,61,.07);
  --edge:linear-gradient(135deg,rgba(232,163,61,.85),rgba(200,85,61,.4) 30%,rgba(255,255,255,.06) 52%,rgba(217,199,163,.4));
  --text:#f0e7d9;--text2:#b5a690;--text3:#7d6e5b;--ac:232,163,61;--ac2:200,85,61;--on:#1a1206;
  --brand:linear-gradient(100deg,#f0b252 0%,#e8a33d 35%,#c8553d 100%);
  --k:155,176,122;--snd:217,199,163;--cut:200,85,61;--ok:155,176,122;--grain:rgba(255,236,200,.05);--ambient:.5;--menu:#1b1610;}
.sh3[data-theme="paper"]{--page:#cfcdc6;--glow1:rgba(47,111,221,.14);--glow2:rgba(122,79,214,.12);--glow3:rgba(15,138,110,.05);
  --in-a:#fbfaf7;--in-b:#f0efe9;--in-hi:rgba(47,111,221,.05);
  --edge:linear-gradient(135deg,rgba(47,111,221,.55),rgba(122,79,214,.25) 35%,rgba(0,0,0,.06) 55%,rgba(15,138,110,.3));
  --text:#232327;--text2:#5d5b56;--text3:#8e8b84;
  --glass:rgba(255,255,255,.75);--glass2:rgba(0,0,0,.035);--glass3:rgba(0,0,0,.06);
  --stroke:rgba(0,0,0,.08);--stroke2:rgba(0,0,0,.13);--well:rgba(0,0,0,.03);--field:rgba(255,255,255,.9);
  --ac:47,111,221;--ac2:122,79,214;--on:#ffffff;--brand:linear-gradient(100deg,#2f6fdd 0%,#5a5fe0 50%,#7a4fd6 100%);
  --k:122,79,214;--snd:15,138,110;--cut:194,122,18;--ok:15,138,110;--bad:206,56,56;
  --shadow:0 40px 100px rgba(40,38,30,.28);--panel-shadow:0 18px 50px rgba(40,38,30,.14);--grain:rgba(0,0,0,.025);
  --ambient:.28;--menu:#ffffff;}
.sh3[data-theme="midnight"]{--page:#02050b;--glow1:rgba(79,157,255,.22);--glow2:rgba(88,225,255,.12);--glow3:rgba(142,240,182,.05);
  --in-a:#0b1527;--in-b:#060d1a;--in-hi:rgba(79,157,255,.08);
  --edge:linear-gradient(135deg,rgba(79,157,255,.9),rgba(88,225,255,.4) 30%,rgba(255,255,255,.06) 52%,rgba(142,240,182,.4));
  --text:#dce8ff;--text2:#93a7c8;--text3:#5d7090;--stroke:rgba(140,180,255,.10);--stroke2:rgba(140,180,255,.18);
  --ac:79,157,255;--ac2:88,225,255;--on:#041022;--brand:linear-gradient(100deg,#4f9dff 0%,#58e1ff 55%,#8ef0b6 100%);
  --k:88,225,255;--snd:142,240,182;--cut:255,200,107;--ok:142,240,182;--menu:#0c1729;
  --pattern:linear-gradient(rgba(79,157,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(79,157,255,.06) 1px,transparent 1px);}
.sh3[data-theme="comfy"]{--page:#111111;--glow1:rgba(255,255,255,.04);--glow2:rgba(92,141,255,.07);--glow3:transparent;
  --in-a:#232323;--in-b:#1c1c1c;--in-hi:rgba(255,255,255,.02);
  --edge:linear-gradient(135deg,rgba(255,255,255,.16),rgba(255,255,255,.08));
  --text:#e2e2e2;--text2:#a3a3a3;--text3:#727272;--ac:92,141,255;--ac2:122,167,255;--on:#0a1430;
  --brand:linear-gradient(100deg,#5c8dff 0%,#7aa7ff 100%);--k:170,140,255;--snd:88,200,230;--cut:240,190,80;--ok:90,200,140;
  --shadow:0 30px 90px rgba(0,0,0,.6);--grain:transparent;--ambient:.25;--menu:#262626;}

.sh3{position:relative;box-sizing:border-box;width:100%;font-family:var(--ff);font-size:13px;line-height:1.35;color:var(--text);
  -webkit-font-smoothing:antialiased;text-align:left;letter-spacing:normal}
.sh3 *,.sh3 *:before,.sh3 *:after{box-sizing:border-box}
.sh3 button{font:inherit;color:inherit;margin:0;cursor:pointer;-webkit-appearance:none;appearance:none}
.sh3 input,.sh3 textarea,.sh3 select{font:inherit;color:var(--text);margin:0}
.sh3-window{border-radius:30px;padding:1.5px;background:var(--edge);box-shadow:var(--shadow),0 0 80px rgba(var(--ac),.10);height:auto !important}
.sh3-inner{position:relative;border-radius:29px;overflow:hidden;display:flex;flex-direction:column;min-height:300px;
  background:radial-gradient(1200px 500px at 30% 0%,var(--in-hi),transparent 70%),linear-gradient(180deg,var(--in-a) 0%,var(--in-b) 100%)}
.sh3-pattern{position:absolute;inset:0;pointer-events:none;background-image:var(--pattern);background-size:32px 32px}
.sh3-grain{position:absolute;inset:0;pointer-events:none;opacity:.35;background-image:radial-gradient(var(--grain) 1px,transparent 1px);background-size:3px 3px}
.sh3-ambient{position:absolute;left:0;top:150px;width:62%;height:60%;opacity:var(--ambient);filter:blur(80px) saturate(1.7);pointer-events:none;
  background-size:cover;background-position:center;border-radius:60px;transition:background-image .6s}
.sh3-ic{display:block;flex:none}

/* header */
.sh3-hdr{position:relative;height:74px;display:flex;align-items:center;gap:16px;padding:0 28px;border-bottom:1px solid var(--stroke);flex:none}
.sh3-logo{width:42px;height:42px;border-radius:13px;background:var(--brand);display:grid;place-items:center;flex:none;
  box-shadow:0 8px 30px rgba(var(--ac),.45),inset 0 1px 0 rgba(255,255,255,.4)}
.sh3-logo span{font-family:var(--fh);font-weight:700;font-size:19px;color:var(--on);letter-spacing:-.5px}
.sh3-title{min-width:0}
.sh3-ttl{font-family:var(--fh);font-weight:600;font-size:21px;letter-spacing:-.3px;white-space:nowrap}
.sh3-sub{color:var(--text3);font-size:12px;margin-top:2px;white-space:nowrap}
.sh3-steps{display:flex;align-items:center;gap:6px;padding:5px;border-radius:14px;background:var(--glass);border:1px solid var(--stroke);flex:none}
.sh3-step{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:10px;color:var(--text3);font-weight:500;background:none;border:0}
.sh3-step:hover{color:var(--text2);background:var(--glass2)}
.sh3-step b{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;border:1px solid var(--stroke2);font-family:var(--fh)}
.sh3-step.done{color:var(--text2)} .sh3-step.done b{background:rgba(var(--ok),.15);border-color:rgba(var(--ok),.5);color:rgb(var(--ok))}
.sh3-step.on{background:var(--glass3);color:var(--text);box-shadow:inset 0 1px 0 rgba(255,255,255,.08);cursor:default}
.sh3-step.on b{background:var(--brand);border:none;color:var(--on)}
.sh3-chev{color:var(--text3)}
.sh3-status{display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:12px;background:rgba(var(--ok),.08);
  border:1px solid rgba(var(--ok),.3);color:var(--text);font-weight:500;white-space:nowrap;max-width:460px;overflow:hidden;text-overflow:ellipsis}
.sh3-status.busy{background:rgba(var(--ac),.10);border-color:rgba(var(--ac),.45)}
.sh3-status.warn{background:rgba(var(--cut),.10);border-color:rgba(var(--cut),.45)}
.sh3-status.bad{background:rgba(var(--bad),.10);border-color:rgba(var(--bad),.45)}
.sh3-dot{width:8px;height:8px;border-radius:50%;background:rgb(var(--ok));box-shadow:0 0 12px rgb(var(--ok));flex:none}
.sh3-status.busy .sh3-dot{background:rgb(var(--ac));box-shadow:0 0 12px rgb(var(--ac));animation:sh3-pulse 1.1s ease-in-out infinite}
.sh3-status.warn .sh3-dot{background:rgb(var(--cut));box-shadow:0 0 12px rgb(var(--cut))}
.sh3-status.bad .sh3-dot{background:rgb(var(--bad));box-shadow:0 0 12px rgb(var(--bad))}
@keyframes sh3-pulse{50%{opacity:.35}}
.sh3-ibtn{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:var(--glass);border:1px solid var(--stroke);color:var(--text2);flex:none}
.sh3-ibtn:hover{color:var(--text);border-color:var(--stroke2);background:var(--glass2)}
.sh3-ibtn.on{color:rgb(var(--ac));border-color:rgba(var(--ac),.5)}
.sh3-spacer{flex:1}

/* body + footer */
.sh3-body{position:relative;display:flex;flex-direction:column;gap:18px;padding:18px 28px 6px}
.sh3-foot{position:relative;min-height:44px;display:flex;align-items:center;gap:18px;padding:6px 28px 10px;color:var(--text3);font-size:12px;flex-wrap:wrap}
.sh3-foot b{color:var(--text2);font-weight:500}
.sh3-foot .sh3-fi{display:flex;align-items:center;gap:6px}
.sh3-foot a,.sh3-link{color:var(--text2);text-decoration:none;cursor:pointer;border:0;background:none;padding:0;font:inherit}
.sh3-foot a:hover,.sh3-link:hover{color:var(--text)}

/* pieces */
.sh3-panel{position:relative;border-radius:24px;background:linear-gradient(180deg,var(--glass2),var(--glass));border:1px solid var(--stroke2);
  box-shadow:var(--panel-shadow),inset 0 1px 0 rgba(255,255,255,.06)}
.sh3-grp{display:flex;align-items:center;gap:10px;padding:0 16px;border-radius:18px;background:var(--glass);border:1px solid var(--stroke);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.sh3-lbl{font-size:10.5px;letter-spacing:.9px;text-transform:uppercase;color:var(--text3);font-weight:600}
.sh3-h2{font-family:var(--fh);font-size:19px;font-weight:600;letter-spacing:-.2px}
.sh3-h3{font-family:var(--fh);font-size:15px;font-weight:600}
.sh3-muted{color:var(--text3)} .sh3-t2{color:var(--text2)}
.sh3-mono{font-family:var(--fm);font-size:12px}
.sh3-ico{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex:none}
.sh3-ico.ac{background:rgba(var(--ac),.14);color:rgb(var(--ac))} .sh3-ico.snd{background:rgba(var(--snd),.13);color:rgb(var(--snd))}
.sh3-ico.k{background:rgba(var(--k),.15);color:rgb(var(--k))} .sh3-ico.cut{background:rgba(var(--cut),.14);color:rgb(var(--cut))}
.sh3-ico.ok{background:rgba(var(--ok),.14);color:rgb(var(--ok))}
.sh3-chip{display:flex;align-items:center;gap:10px;padding:9px 13px;border-radius:13px;background:var(--glass);border:1px solid var(--stroke);min-width:0}
button.sh3-chip:hover{border-color:var(--stroke2);background:var(--glass2)}
.sh3-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:8px;font-size:11px;font-weight:600;
  background:var(--glass2);border:1px solid var(--stroke);color:var(--text2);white-space:nowrap}
.sh3-badge.ac{background:rgba(var(--ac),.14);border-color:rgba(var(--ac),.4);color:var(--text)}
.sh3-badge.ok{background:rgba(var(--ok),.12);border-color:rgba(var(--ok),.4);color:var(--text)}
.sh3-badge.cut{background:rgba(var(--cut),.12);border-color:rgba(var(--cut),.45);color:var(--text)}
.sh3-badge.bad{background:rgba(var(--bad),.12);border-color:rgba(var(--bad),.45);color:var(--text)}
.sh3-badge.k{background:rgba(var(--k),.12);border-color:rgba(var(--k),.45);color:var(--text)}

/* buttons */
.sh3-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 14px;border-radius:12px;
  background:var(--glass2);border:1px solid var(--stroke2);font-weight:600;color:var(--text);white-space:nowrap;transition:filter .15s,border-color .15s}
.sh3-btn:hover{border-color:rgba(var(--ac),.5)}
.sh3-btn:disabled,.sh3-btn.disabled{opacity:.45;cursor:default;filter:none}
.sh3-btn.brand{background:linear-gradient(100deg,rgba(var(--ac),.22),rgba(var(--ac2),.12));border-color:rgba(var(--ac),.5)}
.sh3-btn.cta{height:58px;padding:0 26px;border-radius:16px;background:var(--brand);border:0;color:var(--on);font-family:var(--fh);font-weight:700;font-size:18px;
  box-shadow:0 14px 40px rgba(var(--ac),.45),0 0 0 1px rgba(255,255,255,.18) inset,inset 0 1px 0 rgba(255,255,255,.45)}
.sh3-btn.cta:hover{filter:brightness(1.07)}
.sh3-btn.ghost{height:58px;padding:0 18px;border-radius:16px;background:var(--glass)}
.sh3-btn.small{height:30px;padding:0 10px;border-radius:9px;font-size:12px;gap:6px}
.sh3-btn.flat{background:none;border-color:transparent;color:var(--text2)}
.sh3-btn.flat:hover{color:var(--text);border-color:var(--stroke)}
.sh3-btn.danger:hover{border-color:rgba(var(--bad),.6);color:rgb(var(--bad))}
.sh3-btn.wide{width:100%}

/* segmented switch, toggle, slider, fields */
.sh3-seg{display:flex;border-radius:13px;background:var(--well);border:1px solid var(--stroke);padding:4px;gap:4px}
.sh3-seg-opt{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;text-align:center;padding:9px 6px;border-radius:9px;
  color:var(--text2);font-weight:600;background:none;border:0;white-space:nowrap}
.sh3-seg-opt:hover{color:var(--text)}
.sh3-seg-opt.on{background:linear-gradient(160deg,rgba(var(--ac),.30),rgba(var(--ac2),.14));color:var(--text);
  box-shadow:0 0 18px rgba(var(--ac),.25),inset 0 0 0 1px rgba(var(--ac),.6)}
.sh3-tog{width:40px;height:23px;border-radius:12px;background:var(--glass3);border:1px solid var(--stroke2);position:relative;flex:none;padding:0}
.sh3-tog:after{content:"";position:absolute;left:3px;top:2px;width:17px;height:17px;border-radius:50%;background:var(--text3);transition:left .15s}
.sh3-tog.on{background:var(--brand);border-color:transparent;box-shadow:0 0 14px rgba(var(--ac),.4)}
.sh3-tog.on:after{left:19px;background:#fff}
.sh3-range{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:4px;outline:none;cursor:pointer;margin:8px 0;
  background:linear-gradient(90deg,rgb(var(--ac)) 0%,rgb(var(--ac2)) var(--pct,50%),var(--glass3) var(--pct,50%))}
.sh3-range::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#fff;border:0;
  box-shadow:0 0 0 4px rgba(var(--ac),.3),0 0 14px rgba(var(--ac),.6)}
.sh3-range::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:#fff;border:0;box-shadow:0 0 0 4px rgba(var(--ac),.3)}
.sh3-select,.sh3-input,.sh3-text{background:var(--field);border:1px solid var(--stroke2);border-radius:11px;color:var(--text);outline:none}
.sh3-select{height:38px;padding:0 30px 0 12px;font-weight:600;-webkit-appearance:none;appearance:none;cursor:pointer;max-width:100%;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6l6 -6'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 11px center}
.sh3-select option,.sh3-select optgroup{background:var(--menu);color:var(--text)}
.sh3-input{height:38px;padding:0 12px}
.sh3-text{width:100%;padding:10px 12px;resize:vertical;line-height:1.45;min-height:44px;font-size:13.5px}
.sh3-select:focus,.sh3-input:focus,.sh3-text:focus{border-color:rgba(var(--ac),.7);box-shadow:0 0 0 3px rgba(var(--ac),.15)}
.sh3-input::placeholder,.sh3-text::placeholder{color:var(--text3)}
.sh3-check{width:18px;height:18px;accent-color:rgb(var(--ac));cursor:pointer;margin:0}

/* menus and toasts */
.sh3-menu{position:absolute;z-index:50;min-width:220px;max-width:360px;padding:6px;border-radius:14px;background:var(--menu);
  border:1px solid var(--stroke2);box-shadow:0 24px 60px rgba(0,0,0,.5)}
.sh3-menu-item{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border-radius:9px;border:0;background:none;color:var(--text);text-align:left}
.sh3-menu-item:hover{background:var(--glass3)}
.sh3-menu-item.danger{color:rgb(var(--bad))}
.sh3-menu-item.disabled{opacity:.4;cursor:default}
.sh3-menu-item .sh3-ic{color:var(--text2)}
.sh3-menu-noicon{width:16px;flex:none}
.sh3-menu-hint{margin-left:auto;color:var(--text3);font-size:11.5px}
.sh3-menu-sep{height:1px;background:var(--stroke);margin:5px 4px}
.sh3-toast{position:absolute;left:50%;bottom:22px;transform:translate(-50%,20px);opacity:0;transition:all .3s;z-index:60;
  padding:11px 18px;border-radius:13px;background:var(--menu);border:1px solid rgba(var(--ac),.5);box-shadow:0 18px 50px rgba(0,0,0,.45);
  font-weight:500;pointer-events:none;max-width:80%}
.sh3-toast.in{opacity:1;transform:translate(-50%,0)}
.sh3-toast.bad{border-color:rgba(var(--bad),.6)}

/* empty states and drop targets */
.sh3-drop{border:1.5px dashed var(--stroke2);border-radius:14px;color:var(--text3);display:flex;align-items:center;justify-content:center;
  gap:8px;text-align:center;padding:12px;cursor:pointer;background:var(--well)}
.sh3-drop:hover,.sh3-drop.over{border-color:rgba(var(--ac),.7);color:var(--text2);background:rgba(var(--ac),.06)}
.sh3-spin{width:18px;height:18px;border-radius:50%;border:2.5px solid rgba(var(--ac),.25);border-top-color:rgb(var(--ac));animation:sh3-spin .8s linear infinite;flex:none}
@keyframes sh3-spin{to{transform:rotate(360deg)}}
.sh3-progress{height:6px;border-radius:4px;background:var(--glass3);overflow:hidden}
.sh3-progress>span{display:block;height:100%;background:var(--brand);border-radius:4px;transition:width .3s}
.sh3-gchip{padding:8px 12px;border-radius:12px;background:rgba(10,8,16,.45);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.16);
  font-weight:500;display:flex;align-items:center;gap:7px;color:#f3f1f8;white-space:nowrap}
.sh3-gchip.brand{border-color:rgba(var(--ac),.6)}
button.sh3-gchip:hover{border-color:rgba(255,255,255,.35)}
`;
