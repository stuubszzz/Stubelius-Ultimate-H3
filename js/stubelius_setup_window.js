// Stubelius Ultimate H3: the Setup window (step 1 of 4), on the Setup node.
//
// How the video is rendered: the six modes (each fills steps, size and turbo strength), the fine-tuning
// under them, the models (the Models node: checkpoints, text encoder, VAEs, live preview), the turbo,
// PDMD and global LoRAs, the speed and memory switches, the video memory, and the look every window
// follows (the Theme node). The window edits those nodes' own widgets; nothing is stored twice.
import {
  h, icon, clear, seg, button, iconButton, label, badge, toast, select, slider, toggle, windowFrame, markSteps, goToStep,
  injectStyles, widget, widgetValue, setWidget, sourceOf, targetsOf, nodesOfType, fmtBytes, refreshThemes, THEME_NAMES,
  THEME_SWATCHES, windowOrCompact,
} from "./stubelius_ui.js";
import { tidy } from "./stubelius_stage.js";
import { SPEEDUP_RE, OMNI, FLEX } from "./stubelius_director_shared.js";

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const MODES = [
  ["PDMD", "Fastest. Its own 4-step LoRA keeps fast motion clean."],
  ["Speed", "Rough drafts and timing checks at a small size."],
  ["Hybrid", "Fluid motion with the turbo LoRA. Best for action."],
  ["Quality", "Finals. Polished on the way to 1080p, 2K or 4K."],
  [OMNI, "Reference only. Its own 8-step model: smooth motion."],
  [FLEX, "The clearest sound. 6 steps, about 1.5x PDMD's time."],
];
const SETUP_WIDGETS = ["mode", "seeds", "steps", "sampler", "scheduler", "megapixels", "speedup_lora_strength",
  "shift_video", "shift_audio"];
const MODEL_CARDS = [
  ["fl2va_model", "Video model · first/last frame", "film", ["diffusion_models", "unet_gguf"]],
  ["ref2va_model", "Video model · reference", "users", ["diffusion_models", "unet_gguf"]],
  ["omni_model", "Video model · FastH3 Omni", "bolt", ["diffusion_models"]],   // its mode only
  ["flex_ref_lora", "Pika H3 Flex LoRA · reference", "wave", ["loras"]],        // its mode only
  ["flex_fl_lora", "Pika H3 Flex LoRA · first/last frame", "wave", ["loras"]],  // its mode only
  ["text_encoder", "Text encoder", "scan", ["text_encoders", "clip_gguf"]],
  ["video_vae", "Video VAE", "aspect", ["vae"]],
  ["audio_vae", "Audio VAE", "wave", ["vae"]],
  ["live_preview", "Live preview", "eye", ["vae_approx"]],
];
const PERF = [
  ["attention", "Attention", "bolt", "INT8 kernels, the fastest here"],
  ["sage_attention", "Sage attention", "sparkles", ""],
  ["low_vram_attention", "Low-VRAM attention", "layers", "saves memory, same picture"],
  ["chunk_feed_forward", "Chunked feed-forward", "copy", "saves memory, same picture"],
  ["spectrum", "Spectrum forecasting", "chart", "faster, may soften"],
  ["h3_cache", "H3 step cache", "database", "faster, may soften"],
];
const TURBO_RE = SPEEDUP_RE;            // a few-step LoRA by its name (stubelius_director_shared.js)
const OMNI_LOCK = "FastH3 Omni mode uses no turbo LoRA: the checkpoint is distilled to 8 steps already";
const FLEX_LOCK = "Pika H3 Flex mode sets it: its LoRAs run at full strength on their own 6 steps, with LCM and H3's 12 / 3";
const MODE_ONLY = { omni_model: OMNI, flex_ref_lora: FLEX, flex_fl_lora: FLEX };   // model cards one mode uses
const LORA_MAX = 9;

function precision(name) {
  const n = String(name || "").toLowerCase();
  for (const [re, tag] of [[/nvfp4/, "NVFP4"], [/int8/, "INT8"], [/fp8|e4m3/, "FP8"], [/bf16/, "BF16"], [/fp16/, "FP16"], [/fp32/, "FP32"],
    [/q8_0/, "GGUF Q8"], [/q6/, "GGUF Q6"], [/q5/, "GGUF Q5"], [/q4/, "GGUF Q4"], [/\.gguf$/, "GGUF"]]) {
    if (re.test(n)) return tag;
  }
  return null;
}

// The flow shift a speed-up LoRA was trained on (its model card), by its file name: LightX2V's 768p turbo LoRAs on
// 6 / 3, its 544p ones and PDMD's 4 steps on H3's own 12 / 3. null = nothing known (another LoRA, or none in use).
export function shiftWanted(mode, turbo, strength) {
  if (mode === "PDMD") return { v: 12, a: 3, why: "PDMD's 4 steps are set for H3's own 12 / 3" };
  if (mode === OMNI) return { v: 12, a: 3, why: "FastH3 Omni's template runs on H3's own 12 / 3" };
  if (mode === FLEX) return { v: 12, a: 3, why: "Pika H3 Flex's 6 steps are set for H3's own 12 / 3" };
  if (mode === "Quality" || !(Number(strength) > 0)) return null;
  const n = String(turbo || "").split(/[\\/]/).pop().toLowerCase();
  if (/turbo/.test(n) && /768p/.test(n)) return { v: 6, a: 3, why: "LightX2V's 768p turbo LoRAs were trained on 6 / 3" };
  if (/lightx2v|turbo_(4|8)step/.test(n)) return { v: 12, a: 3, why: "LightX2V's 544p turbo LoRAs were trained on 12 / 3" };
  return null;
}

function turboInfo(name) {
  const n = String(name || "").split(/[\\/]/).pop();      // the file's own name, not its folder
  if (/motion.?enhancer/i.test(n)) return ["Motion Enhancer", "8-step turbo · livelier motion and sound"];
  if (/lightx2v|fl2v_turbo_8step|turbo_8step/i.test(n)) return ["LightX2V turbo", "8-step turbo · the original"];
  if (/taomate/i.test(n)) return ["TaoMate", "3-step finisher"];
  return [n.replace(/\.safetensors$/i, ""), "turbo LoRA"];
}

// The render size a mode's megapixels make at the Director's shape: _resolve_resolution's formula (ComfyUI's
// ResolutionSelector, sides on 32), Python's round included (halves to the even side)
function sizeFor(mp, aspect) {
  const m = /(\d+)\s*:\s*(\d+)/.exec(String(aspect || "16:9"));
  const [wr, hr] = m ? [Number(m[1]), Number(m[2])] : [16, 9];
  const scale = Math.sqrt((Number(mp) * 1024 * 1024) / (wr * hr));
  const round = (x) => { const f = Math.floor(x), d = x - f; return d > 0.5 || (d === 0.5 && f % 2) ? f + 1 : f; };
  return `${round((wr * scale) / 32) * 32}×${round((hr * scale) / 32) * 32}`;
}

// ------------------------------------------------------------------------------------------- mode art

function art(mode) {
  const svg = (inner) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    el.setAttribute("viewBox", "0 0 280 150");
    el.setAttribute("preserveAspectRatio", "xMidYMid slice");
    el.setAttribute("class", "su-art-svg");
    el.innerHTML = inner;
    return el;
  };
  const g = (id, a, b) => `<linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" style="stop-color:rgb(var(--${a}));stop-opacity:0"/>`
    + `<stop offset="1" style="stop-color:rgb(var(--${b}));stop-opacity:1"/></linearGradient>`;
  if (mode === "PDMD") {
    let streaks = "";
    [[18, 40, 190, 1], [34, 70, 150, .7], [52, 20, 220, .9], [70, 90, 140, .55], [88, 50, 200, .85], [106, 110, 120, .5], [124, 30, 180, .7]]
      .forEach(([y, x, w, o]) => { streaks += `<rect x="${x}" y="${y}" width="${w}" height="5" rx="2.5" fill="url(#pdg)" opacity="${o}"/>`; });
    return svg(`<defs>${g("pdg", "ac", "ac2")}<radialGradient id="pdr"><stop offset="0" style="stop-color:#fff"/><stop offset="1" style="stop-color:rgb(var(--ac));stop-opacity:0"/></radialGradient></defs>`
      + `<rect width="280" height="150" fill="url(#pdr)" opacity=".05"/>${streaks}<circle cx="236" cy="76" r="20" fill="url(#pdr)" opacity=".9"/>`
      + `<circle cx="236" cy="76" r="7" style="fill:#fff"/>`);
  }
  if (mode === OMNI) {
    // its sparse attention: each part of the video looks closely at about a tenth of the rest
    let cubes = "";
    let k = 0;
    for (let y = 9; y < 150; y += 16) {
      for (let x = 6; x < 280; x += 16) {
        k++;
        const lit = (k * 73 + 41) % 97 < 10;
        cubes += `<rect x="${x}" y="${y}" width="11" height="11" rx="2.5" style="fill:${lit ? `rgb(var(--${k % 3 ? "ac" : "ac2"}))` : "rgba(255,255,255,.07)"}"/>`;
      }
    }
    return svg(cubes);
  }
  if (mode === FLEX) {
    // a clean waveform: what it does best
    let bars = "";
    for (let i = 0; i < 26; i++) {
      const tall = 14 + Math.abs(Math.sin(i * 0.62) * Math.cos(i * 0.21)) * 92;
      bars += `<rect x="${12 + i * 10}" y="${75 - tall / 2}" width="5" height="${tall}" rx="2.5" style="fill:rgb(var(--${i % 3 ? "ac" : "ac2"}))" opacity="${0.45 + (i % 4) * 0.15}"/>`;
    }
    return svg(bars);
  }
  if (mode === "Speed") {
    let lines = "";
    for (let i = 0; i < 6; i++) {
      let p = "";
      for (let x = 10; x <= 270; x += 20) p += `${x},${30 + i * 18 + ((x / 20) % 2 ? 7 : -5) + (i % 2 ? 3 : 0)} `;
      lines += `<polyline points="${p}" fill="none" style="stroke:rgb(var(--${i % 2 ? "ac2" : "ac"}))" stroke-width="2" stroke-dasharray="${8 + i * 2} 6" opacity="${0.35 + i * 0.1}" stroke-linecap="round"/>`;
    }
    return svg(`<rect width="280" height="150" fill="none"/>${lines}`);
  }
  if (mode === "Hybrid") {
    let waves = "";
    for (let i = 0; i < 5; i++) {
      let d = `M0 ${75 + i * 6}`;
      for (let x = 0; x <= 280; x += 10) d += ` L${x} ${(75 + i * 6 + Math.sin(x / 34 + i * 0.9) * (30 - i * 4)).toFixed(1)}`;
      waves += `<path d="${d}" fill="none" stroke="url(#hyg${i % 2})" stroke-width="${4 - i * 0.5}" opacity="${0.95 - i * 0.15}" stroke-linecap="round"/>`;
    }
    return svg(`<defs>${g("hyg0", "ac", "ac2")}${g("hyg1", "snd", "ac")}<filter id="hyb"><feGaussianBlur stdDeviation="2.4"/></filter></defs>`
      + `<g filter="url(#hyb)" opacity=".7">${waves}</g>${waves}`);
  }
  let rings = "";
  for (let r = 8; r <= 66; r += 6) rings += `<circle cx="140" cy="75" r="${r}" fill="none" style="stroke:rgb(var(--${r % 12 ? "ac" : "ac2"}))" stroke-width="${r % 18 ? 0.8 : 1.6}" opacity="${1 - r / 80}"/>`;
  let grid = "";
  for (let x = 0; x <= 280; x += 14) grid += `<line x1="${x}" y1="0" x2="${x}" y2="150" style="stroke:rgba(255,255,255,.05)"/>`;
  for (let y = 0; y <= 150; y += 14) grid += `<line x1="0" y1="${y}" x2="280" y2="${y}" style="stroke:rgba(255,255,255,.05)"/>`;
  return svg(`${grid}${rings}<path d="M140 30 L144 71 L185 75 L144 79 L140 120 L136 79 L95 75 L136 71 Z" style="fill:#fff" opacity=".9"/>`);
}

// ------------------------------------------------------------------------------------------- the window

class SetupWindow {
  constructor(node) {
    this.node = node;
    this.sizes = {};          // "folder|name" -> bytes
    this.stats = null;
    this.loras = null;
    injectStyles();
    injectSetupStyles();
    const f = windowFrame({ title: "Ultimate H3 · Setup", subtitle: "Models, speed and look", step: 1, onStep: goToStep });
    Object.assign(this, f);
    this.root.classList.add("sh3-u");
    this.status = h("div.sh3-status", h("span.sh3-dot"), h("span", "Models"));
    this.head.append(h("div.sh3-spacer"), this.status,
      iconButton("refresh", "Read the model folders and the video memory again", () => this.reload(true)));
    this.left = h("div.su-left");
    this.right = h("div.su-right");
    this.body.appendChild(h("div.su-main", this.left, this.right));
    this.render();
    this.reload(false);
  }

  models() {
    return targetsOf(this.node, "setup").find((n) => n.comfyClass === "StubeliusH3Models") || nodesOfType("StubeliusH3Models")[0] || null;
  }

  director() {
    return targetsOf(this.node, "setup").find((n) => n.comfyClass === "StubeliusH3DirectorV2") || nodesOfType("StubeliusH3DirectorV2")[0] || null;
  }

  theme() {
    return nodesOfType("StubeliusTheme")[0] || null;
  }

  async reload(force) {
    const m = this.models();
    const items = [];
    for (const [name, , , folders] of MODEL_CARDS) {
      const v = widgetValue(m, name);
      if (v && v !== "off" && v !== "none") for (const f of folders) items.push([f, v]);
    }
    for (const name of ["speedup_lora", "extra_lora_1", "extra_lora_2", "pdmd_lora"]) {
      const v = widgetValue(m, name);
      if (v && v !== "none") items.push(["loras", v]);
    }
    try {
      const [info, stats] = await Promise.all([
        api.fetchApi("/stubelius_ultimate_h3/model_info", { method: "POST", body: JSON.stringify({ items }) }).then((r) => (r.ok ? r.json() : { items: [] })),
        api.fetchApi("/system_stats").then((r) => (r.ok ? r.json() : null)),
      ]);
      for (const it of info.items || []) if (it.found) this.sizes[`${it.name}`] = it.size;
      this.stats = stats;
    } catch (e) {
      // older pack routes: no sizes
    }
    this.render();
    if (force) toast(this.root, "Model folders and video memory read again");
  }

  setM(name, value) {
    const m = this.models();
    if (!m) return;
    setWidget(m, name, value);
    this.reload(false);
    this.director()?._sh3?.renderCmd?.();
  }

  setShift(video, audio) {
    setWidget(this.node, "shift_video", video);
    setWidget(this.node, "shift_audio", audio);
    this.render();
    this.director()?._sh3?.renderCmd?.();
  }

  setS(name, value) {
    setWidget(this.node, name, value);
    this.render();
    this.director()?._sh3?.renderCmd?.();
    window.dispatchEvent(new CustomEvent("stubelius-setup", { detail: { name } }));   // the Output's sizes follow the mode
  }

  // ----------------------------------------------------------------------------------- drawing

  render() {
    this.renderStatus();
    const L = clear(this.left), R = clear(this.right);
    L.append(this.modesPanel(), this.modelsPanel(), this.lorasPanel());
    R.append(this.memoryPanel(), this.perfPanel(), this.lookPanel());
    this.renderFoot();
    this.markSteps();
  }

  modelState() {
    const m = this.models();
    let found = 0, total = 0;
    for (const [name] of MODEL_CARDS) {
      const w = widget(m, name);
      if (!w) continue;
      if (name === "live_preview" && w.value === "off") continue;
      if (MODE_ONLY[name] && widgetValue(this.node, "mode") !== MODE_ONLY[name]) continue;     // used by its mode only
      total++;
      const opts = w.options?.values || [];
      if (opts.includes(w.value) && w.value !== "none") found++;
    }
    return { found, total };
  }

  renderStatus() {
    const s = this.status;
    if (!this.models()) {
      s.className = "sh3-status warn";
      s.lastChild.textContent = "Add a Stubelius H3 Models node";
      return;
    }
    const { found, total } = this.modelState();
    s.className = "sh3-status" + (found < total ? " warn" : "");
    s.lastChild.textContent = found < total ? `${total - found} model${total - found > 1 ? "s" : ""} missing · ${found} of ${total} found`
      : `Models ready · ${found} of ${total} found`;
  }

  modesPanel() {
    const mode = widgetValue(this.node, "mode", "Hybrid");
    const presets = this.node.constructor?.nodeData?.input?.required?.mode?.[1]?.presets || {};
    const aspect = widgetValue(this.director(), "aspect_ratio", "16:9");
    const panel = h("div.sh3-panel.su-modes", h("div.su-ph", h("div.sh3-h2", "How do you want to render?"),
      h("span.sh3-muted", "Each mode fills steps, size and turbo strength for you")));
    const cards = h("div.su-cards");
    const known = widget(this.node, "mode")?.options?.values || [];
    for (const [name, text] of MODES) {
      if (known.length && !known.includes(name)) continue;      // pulled but not restarted yet: the node can't take it
      const on = name === mode;
      const p = on ? { steps: widgetValue(this.node, "steps"), megapixels: widgetValue(this.node, "megapixels"),
        speedup_strength: widgetValue(this.node, "speedup_lora_strength") } : presets[name] || {};
      cards.appendChild(h("button.su-card", { type: "button", class: on ? "on" : null, onclick: () => this.setS("mode", name) },
        h("div.su-art", art(name), h("div.su-art-name", name), on ? h("span.su-check", icon("check", 15)) : null),
        h("div.su-card-b", h("div.su-card-t", text),
          h("div.su-kv", icon("stairs", 14), h("span", "Steps"), h("b", String(p.steps ?? "–"))),
          h("div.su-kv", icon("aspect", 14), h("span", "Size"), h("b", p.megapixels ? sizeFor(p.megapixels, aspect) : "–")),
          h("div.su-kv", icon("sparkles", 14), h("span", name === "PDMD" ? "PDMD LoRA" : name === OMNI || name === FLEX ? "Speed-up" : "Turbo"),
            h("b", name === "PDMD" ? "4-step" : name === OMNI ? "built in" : name === FLEX ? "6-step"
              : p.speedup_strength ? Number(p.speedup_strength).toFixed(2) : "off")))));
    }
    cards.style.gridTemplateColumns = `repeat(${cards.childNodes.length}, 1fr)`;   // 6, or fewer on a node from before
    panel.appendChild(cards);

    // fine-tuning
    const sv = (name) => Number(widgetValue(this.node, name, 0));
    const tune = (lab, name, min, max, step, fmt, locked = "") => {
      const o = widget(this.node, name)?.options || {};     // the node's own range
      if (Number.isFinite(o.min)) min = o.min;
      if (Number.isFinite(o.max)) max = o.max;
      const val = h("b", fmt(sv(name)));
      const s = slider({ min, max, step, value: sv(name), onInput: (v) => { val.textContent = fmt(v); }, onChange: (v) => this.setS(name, v) });
      if (locked) { s.disabled = true; s.title = locked; }
      return h("div.su-tune", { class: locked ? "locked" : null, title: locked || null }, h("div.su-tune-h", label(lab), val), s);
    };
    // PDMD runs its own LoRA at this strength (stubelius_h3_pipeline: the mode sets 1.00); a lower one under-samples.
    // FastH3 Omni has no LoRA to set. Pika H3 Flex's steps, sampler, strength and shift go with its sigma list
    const pdmdMode = mode === "PDMD";
    const omniMode = mode === OMNI;
    const flexLock = mode === FLEX ? FLEX_LOCK : "";
    const pick = (lab, options, name) => {
      const el = select(options, widgetValue(this.node, name), (v) => this.setS(name, v));
      if (flexLock) { el.disabled = true; el.title = flexLock; }
      return h("div.su-tune", { class: flexLock ? "locked" : null, title: flexLock || null }, label(lab), el);
    };
    const samplers = widget(this.node, "sampler")?.options?.values || [];
    const scheds = widget(this.node, "scheduler")?.options?.values || [];
    panel.appendChild(h("div.su-tunes",
      tune("Steps", "steps", 1, 40, 1, (v) => String(Math.round(v)), flexLock),
      tune("Size", "megapixels", 0.1, 2, 0.02, (v) => `${Number(v).toFixed(2)} MP`),
      tune(pdmdMode ? "PDMD LoRA strength" : "Turbo strength", "speedup_lora_strength", 0, 2, 0.05, (v) => Number(v).toFixed(2),
        pdmdMode ? "PDMD mode sets it: its 4-step LoRA runs at full strength" : omniMode ? OMNI_LOCK : flexLock),
      pick("Sampler", samplers, "sampler"),
      pick("Scheduler", scheds, "scheduler"),
      h("div.su-tune.su-seeds", label("Seeds to compare"),
        seg([[1, "1"], [2, "2"], [3, "3"], [4, "4"]], Number(widgetValue(this.node, "seeds", 1)), (v) => this.setS("seeds", v)))));

    // the flow shift: H3's own 12 / 3, or what the speed-up LoRA in use was trained on (a mode puts 12 / 3 back)
    if (widget(this.node, "shift_video")) {
      const want = shiftWanted(mode, widgetValue(this.models(), "speedup_lora"), sv("speedup_lora_strength"));
      const off = want && (sv("shift_video") !== want.v || sv("shift_audio") !== want.a);
      const fmt = (v) => Number(v).toFixed(1);
      panel.appendChild(h("div.su-shifts",
        tune("Video shift", "shift_video", 0.5, 30, 0.5, fmt, flexLock),
        tune("Audio shift", "shift_audio", 0.5, 30, 0.5, fmt, flexLock),
        h("div.su-shift-hint", { class: off ? "off" : null }, icon(off ? "alert" : "info", 15),
          h("span", want ? want.why : "H3's own is 12 / 3. Use what your speed-up LoRA or checkpoint was trained on"),
          off ? button(`Use ${want.v} / ${want.a}`, "check", "small", () => this.setShift(want.v, want.a)) : null)));
    }
    return panel;
  }

  modelsPanel() {
    const m = this.models();
    const panel = h("div.sh3-panel.su-models", h("div.su-ph", h("div.sh3-h2", "Models"), h("span.sh3-muted", "From your ComfyUI model folders")));
    if (!m) {
      panel.appendChild(h("div.sh3-muted", "Wire a Stubelius H3 Models node to this Setup."));
      return panel;
    }
    const grid = h("div.su-mgrid");
    for (const [name, title, ic] of MODEL_CARDS) {
      const w = widget(m, name);
      if (!w) continue;
      const opts = w.options?.values || [];
      const v = w.value;
      const found = opts.includes(v);
      const size = this.sizes[v];
      const tag = precision(v);
      const isPreview = name === "live_preview";
      const sel = select(opts, v, (x) => this.setM(name, x), "su-file");
      sel.title = String(v || "");
      // FastH3 Omni's checkpoint, Pika H3 Flex's LoRAs: only their own mode needs them
      const modeCard = !!MODE_ONLY[name], modeOn = widgetValue(this.node, "mode") === MODE_ONLY[name];
      const state = isPreview && v === "off" ? "Off"
        : modeCard && v === "none" ? (modeOn ? "Missing" : "Off")
        : !found ? "Missing" : isPreview ? "On" : name === "text_encoder" ? "Runs first"
        : modeCard && !modeOn ? "Its mode only" : "On disk";
      const quiet = (isPreview && v === "off") || (modeCard && state !== "Missing");
      grid.appendChild(h("div.su-mcard", { class: (found && state !== "Missing") || quiet ? null : "missing" },
        h("span.sh3-ico.ac.su-mic", icon(ic, 18)),
        h("div.su-mbody", h("b", title), sel,
          h("div.su-mbadges", tag ? badge(tag, "ac") : null, size ? badge(fmtBytes(size)) : null, isPreview && v !== "off" ? badge("while sampling") : null,
            h("div.sh3-spacer"), h("span.su-state", { class: state === "Missing" ? "bad" : state === "Off" ? "off" : null }, h("i"), state)))));
    }
    panel.appendChild(grid);
    return panel;
  }

  lorasPanel() {
    const m = this.models();
    const panel = h("div.sh3-panel.su-loras", h("div.su-ph", h("div.sh3-h2", "Speed-ups and LoRAs"), h("span.sh3-muted", "Global LoRAs apply to every chunk")));
    if (!m) return panel;
    const all = widget(m, "speedup_lora")?.options?.values || [];
    const current = widgetValue(m, "speedup_lora", "none");
    // H3 turbo LoRAs only (an H3 folder or "h3" in the name): other models' turbo LoRAs don't fit H3. The known kinds
    // first, so a folder full of test turbos doesn't push them off the list; any other LoRA from the dropdown below
    const kind = (n) => (/motion.?enhancer/i.test(n) ? 0 : /lightx2v|fl2v_turbo_8step/i.test(n) ? 1 : /taomate/i.test(n) ? 2 : 3);
    const turbos = all.filter((n) => n !== "none" && TURBO_RE.test(n) && /h3/i.test(n) && !/pdmd|nfe/i.test(n))
      .sort((a, b) => kind(a) - kind(b) || a.localeCompare(b, undefined, { sensitivity: "base" }));
    const shown = [current, ...turbos.filter((n) => n !== current)].filter((n) => n && n !== "none").slice(0, 4);
    const left = h("div.su-lcol", label("Turbo LoRA · Speed and Hybrid"));
    const infos = shown.map(turboInfo);
    const seen = {};
    for (const [name] of infos) seen[name] = (seen[name] || 0) + 1;
    for (const [i, n] of shown.entries()) {
      const name = infos[i][0];
      // two files of one kind: told apart by the file
      const text = seen[name] > 1 ? n.replace(/\.safetensors$/i, "") : infos[i][1];
      const on = n === current;
      const gone = !all.includes(n);             // the workflow names it, models/loras doesn't have it
      left.appendChild(h("button.su-turbo", { type: "button", class: [on ? "on" : "", gone ? "missing" : ""].join(" ").trim() || null,
        title: gone ? `${n}: not in models/loras on this machine` : n, onclick: () => this.setM("speedup_lora", n) },
      h("span.su-radio"), h("div", h("b", name), h("div.sh3-muted", gone ? "not on this machine" : text)),
      on ? badge(gone ? "missing" : "active", gone ? "bad" : "ac") : null));
    }
    // its strength, here as well as under the mode cards (the same setting: each mode fills it in)
    const sw = widget(this.node, "speedup_lora_strength");
    if (sw && current && current !== "none") {
      const o = sw.options || {};
      const pdmd = widgetValue(this.node, "mode") === "PDMD";
      const omni = widgetValue(this.node, "mode") === OMNI;
      const flex = widgetValue(this.node, "mode") === FLEX;
      const val = h("b.su-tstr-v", Number(sw.value ?? 1).toFixed(2));
      const s = slider({ min: Number.isFinite(o.min) ? o.min : 0, max: Number.isFinite(o.max) ? o.max : 2, step: 0.05, value: Number(sw.value ?? 1),
        title: "Turbo LoRA strength", onInput: (v) => { val.textContent = Number(v).toFixed(2); },
        onChange: (v) => this.setS("speedup_lora_strength", v) });
      if (pdmd) { s.disabled = true; s.title = "PDMD mode sets it: its 4-step LoRA runs at full strength"; }
      if (omni) { s.disabled = true; s.title = OMNI_LOCK; }
      if (flex) { s.disabled = true; s.title = FLEX_LOCK; }
      left.appendChild(h("div.su-tstr", { class: pdmd || omni || flex ? "off" : null },
        h("div.su-tstr-h", label("Strength"), h("span.sh3-muted", pdmd ? "PDMD mode uses its own LoRA here, at the strength the mode sets"
          : omni ? "FastH3 Omni mode leaves the turbo LoRA out" : flex ? "Pika H3 Flex mode uses its own two LoRAs instead"
          : "each mode sets it; slide to change"),
          h("div.sh3-spacer"), val), s));
    }
    left.appendChild(this.speedupPicker(all, turbos, current));
    const pd = widget(m, "pdmd_lora");
    if (pd) {
      left.appendChild(h("div.su-pdmd", icon("bolt", 18), h("div.su-pdmd-t", h("b", "PDMD 4-step LoRA"),
        select(pd.options?.values || [], pd.value, (x) => this.setM("pdmd_lora", x), "su-file")), h("span.sh3-muted", "used in PDMD mode")));
    }
    const right = h("div.su-lcol", label("Global LoRAs"));
    for (const i of [1, 2]) {
      const nameW = widget(m, `extra_lora_${i}`), strW = widget(m, `extra_lora_${i}_strength`);
      if (!nameW) continue;
      if (nameW.value === "none" && i === 2 && widgetValue(m, "extra_lora_1") === "none") continue;
      if (nameW.value === "none") {
        right.appendChild(h("button.su-addl", { type: "button", onclick: (e) => {
          const pick = select(nameW.options?.values || [], "none", (x) => this.setM(`extra_lora_${i}`, x), "su-file");
          e.currentTarget.replaceWith(pick);
          pick.focus();
        } }, icon("plus", 14), "Add a global LoRA"));
        continue;
      }
      // the slider covers ±2; the box takes slider LoRAs up to ±9, as the node does
      const strength = Number(strW?.value ?? 1);
      const num = h("input.sh3-input.su-gval", { type: "number", step: 0.05, min: -LORA_MAX, max: LORA_MAX, value: strength, title: "Strength (slider LoRAs run to ±9)" });
      num.addEventListener("change", () => {
        const v = parseFloat(num.value);
        this.setM(`extra_lora_${i}_strength`, Number.isFinite(v) ? Math.max(-LORA_MAX, Math.min(LORA_MAX, v)) : 1.0);
      });
      right.appendChild(h("div.su-glora",
        h("div.su-glora-h", icon("sliders", 16), select(nameW.options?.values || [], nameW.value, (x) => this.setM(`extra_lora_${i}`, x), "su-file"),
          iconButton("x", "Take it out", () => this.setM(`extra_lora_${i}`, "none"))),
        h("div.su-glora-s", slider({ min: -2, max: 2, step: 0.05, value: Math.max(-2, Math.min(2, strength)),
          onInput: (v) => { num.value = v; }, onChange: (v) => this.setM(`extra_lora_${i}_strength`, v) }), num)));
    }
    if (right.childNodes.length === 1) right.appendChild(h("div.sh3-muted", "None"));
    panel.appendChild(h("div.su-lgrid", left, right));
    return panel;
  }

  // Any LoRA file as the turbo LoRA: a dropdown of every LoRA (the ones named like speed-ups first, then by folder)
  speedupPicker(all, turbos, current) {
    const files = all.filter((n) => n && n !== "none");
    const open = h("button.su-addl", { type: "button", title: "Pick any LoRA file as the turbo LoRA" }, icon("folder", 14),
      `Choose another speed-up LoRA… (${turbos.length} found)`);
    open.addEventListener("click", () => {
      const filter = h("input.sh3-input.su-pick-filter", { type: "text", placeholder: "filter by name or folder…" });
      const sel = h("select.sh3-select.su-file.su-pick-sel");
      const fill = () => {
        clear(sel);
        const q = filter.value.trim().toLowerCase();
        const keep = (x) => !q || x.toLowerCase().includes(q);
        sel.appendChild(h("option", { value: "", text: "pick a LoRA…", selected: true, disabled: true }));
        const named = turbos.filter(keep);
        if (named.length) {
          const og = h("optgroup", { label: "Named like speed-ups" });
          named.forEach((x) => og.appendChild(h("option", { value: x, text: x.split(/[\\/]/).pop() + (x === current ? "  (active)" : "") })));
          sel.appendChild(og);
        }
        const groups = new Map();
        for (const x of files) {
          if (turbos.includes(x) || !keep(x)) continue;
          const i = Math.max(x.lastIndexOf("\\"), x.lastIndexOf("/"));
          const f = i > 0 ? x.slice(0, i).replace(/\\/g, " / ") : "(loras root)";
          if (!groups.has(f)) groups.set(f, []);
          groups.get(f).push(x);
        }
        [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).forEach((f) => {
          const og = h("optgroup", { label: f });
          groups.get(f).forEach((x) => og.appendChild(h("option", { value: x, text: x.split(/[\\/]/).pop() + (x === current ? "  (active)" : "") })));
          sel.appendChild(og);
        });
      };
      sel.addEventListener("change", () => { if (sel.value) this.setM("speedup_lora", sel.value); });
      filter.addEventListener("input", fill);
      fill();
      const row = h("div.su-pick", filter, sel, iconButton("x", "Close", () => row.replaceWith(open)));
      open.replaceWith(row);
      filter.focus();
    });
    return open;
  }

  memoryPanel() {
    const dev = this.stats?.devices?.[0];
    const panel = h("div.sh3-panel.su-mem");
    const name = dev ? String(dev.name || "").replace(/^cuda:\d+\s*/, "").replace(/NVIDIA GeForce /, "").replace(/ : .*$/, "") : "";
    const total = dev?.vram_total || 0;
    panel.appendChild(h("div.su-ph", h("div.sh3-h2", "Video memory"), dev ? badge(`${name} · ${(total / 1e9).toFixed(0)} GB`) : null));
    const m = this.models();
    const ref = this.director()?._sh3?.isReference;
    const video = this.sizes[widgetValue(m, ref ? "ref2va_model" : "fl2va_model")] || 0;
    const loras = ["speedup_lora", "extra_lora_1", "extra_lora_2"].reduce((a, n) => a + (this.sizes[widgetValue(m, n)] || 0), 0);
    const vaes = (this.sizes[widgetValue(m, "video_vae")] || 0) + (this.sizes[widgetValue(m, "audio_vae")] || 0);
    const free = dev?.vram_free || 0;
    const parts = [["Video model", video, "ac"], ["LoRAs", loras, "k"], ["VAEs", vaes, "snd"], ["Free on the card now", free, "free"]];
    const sum = Math.max(1, total || parts.reduce((a, p) => a + p[1], 0));
    const r = 74, c = 2 * Math.PI * r;
    let off = 0, arcs = "";
    for (const [, v, k] of parts.slice(0, 3)) {
      const len = (v / sum) * c;
      // a short arc (under 3 units) keeps no gap: a negative dash would draw the whole ring
      if (len > 0.5) arcs += `<circle cx="90" cy="90" r="${r}" fill="none" style="stroke:rgb(var(--${k}))" stroke-width="16" stroke-dasharray="${len > 3 ? len - 3 : len} ${c}" stroke-dashoffset="${-off}" stroke-linecap="round"/>`;
      off += len;
    }
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ring.setAttribute("viewBox", "0 0 180 180");
    ring.setAttribute("class", "su-ring");
    ring.innerHTML = `<circle cx="90" cy="90" r="${r}" fill="none" style="stroke:var(--glass3)" stroke-width="16"/><g transform="rotate(-90 90 90)">${arcs}</g>`;
    const weights = video + loras + vaes;
    panel.appendChild(h("div.su-mem-row",
      h("div.su-ring-wrap", ring, h("div.su-ring-c", h("b", weights ? (weights / 1e9).toFixed(1) : "–"),
        h("span", total ? `GB of weights · ${(total / 1e9).toFixed(0)} GB card` : "GB of weights"))),
      h("div.su-legend", ...parts.map(([n, v, k]) => h("div.su-leg", h("i", { class: k }), h("span", n), h("b", v ? `${(v / 1e9).toFixed(1)} GB` : "–"))))));
    panel.appendChild(h("div.sh3-muted.su-note", "The text encoder runs first and leaves the card before sampling starts."));
    return panel;
  }

  perfPanel() {
    const m = this.models();
    const panel = h("div.sh3-panel.su-perf", h("div.su-ph", h("div.sh3-h2", "Performance")));
    if (!m) return panel;
    const list = h("div.su-plist");
    for (const [name, title, ic, text] of PERF) {
      const w = widget(m, name);
      if (!w) continue;
      const control = typeof w.value === "boolean"
        ? toggle(w.value, (v) => this.setM(name, v), title)
        : select(w.options?.values || [], w.value, (v) => this.setM(name, v), "su-psel");
      list.appendChild(h("div.su-prow", icon(ic, 18), h("div.su-ptxt", h("b", title), text ? h("div.sh3-muted", text) : null), control));
    }
    panel.appendChild(list);
    return panel;
  }

  lookPanel() {
    const t = this.theme();
    const current = widgetValue(t, "theme", "ComfyUI default");
    const panel = h("div.sh3-panel.su-look", h("div.su-ph", h("div.sh3-h2", "Look"), h("span.sh3-muted", "Every window follows it")));
    const grid = h("div.su-themes");
    for (const name of THEME_NAMES) {
      const [stripe, dots] = THEME_SWATCHES[name];
      const on = t ? name === current : name === "ComfyUI default";
      grid.appendChild(h("button.su-theme", { type: "button", class: [on ? "on" : "", name === "Paper light" ? "light" : ""].join(" ").trim() || null,
        dataset: { theme: name }, onclick: () => this.setTheme(name) },
      h("span.su-stripe", { style: { background: stripe } }), h("span.su-dots", ...dots.map((c) => h("i", { style: { background: c } }))),
      h("b", name), on ? h("span.su-tcheck", icon("check", 13)) : null));
    }
    panel.appendChild(grid);
    panel.appendChild(h("div.su-tidy", icon("sparkles", 18),
      h("div.su-ptxt", h("b", "Tidy the canvas"),
        h("div.sh3-muted", "The small helper nodes go behind their windows and their wires hide; move a window to reach them.")),
      button("Tidy", null, "small", () => {
        const n = tidy();
        toast(this.root, n ? `${n} helper node${n === 1 ? "" : "s"} tucked behind the windows` : "Nothing to tidy");
      })));
    return panel;
  }

  setTheme(name) {
    let t = this.theme();
    if (!t) {
      t = window.LiteGraph?.createNode?.("StubeliusTheme");
      if (!t) return;
      app.graph.add(t);
      t.collapse?.(true);
      t.pos = [this.node.pos[0] + 48, this.node.pos[1] + 140];          // behind this window (stubelius_stage.js)
    }
    setWidget(t, "theme", name);
    setTimeout(() => { refreshThemes(); this.render(); }, 30);
  }

  renderFoot() {
    const f = clear(this.foot);
    const s = this.stats?.system || {};
    f.append(...[h("span.sh3-fi", icon("folder", 14), "Models ", h("b", "ComfyUI/models + extra paths")),
      s.pytorch_version ? h("span.sh3-fi", icon("cpu", 14), "PyTorch ", h("b", String(s.pytorch_version).split("+")[0])) : null,
      h("div.sh3-spacer"),
      h("button.sh3-link.sh3-fi", { type: "button", onclick: () => goToStep(2) }, icon("arrowRight", 14), "Next: build the video in the ", h("b", "Director"))]
      .filter(Boolean));          // append() would print a null
  }

  markSteps() {
    const done = new Set();
    if (this.models()) done.add(1);
    const dw = this.director()?._sh3;
    if (dw?.report && (dw.report.chunks || []).length === dw.report.chunks_total) done.add(2);
    const fin = nodesOfType("StubeliusH3Finish")[0];
    if (Number(widgetValue(fin, "winner", 0)) >= 1) done.add(3);
    if (fin?.properties?.sh3_final) done.add(4);
    markSteps(this.steps, done);
  }
}

let styled = false;
function injectSetupStyles() {
  if (styled) return;
  styled = true;
  document.head.appendChild(h("style", { id: "stubelius-uh3-setup", text: `
.sh3-u .su-main{display:grid;grid-template-columns:minmax(0,1fr) 604px;gap:20px;align-items:start}
.sh3-u.narrow .su-main{grid-template-columns:minmax(0,1fr)}
.sh3-u .su-left,.sh3-u .su-right{display:flex;flex-direction:column;gap:20px;min-width:0}
.sh3-u .sh3-panel{padding:20px 22px;display:flex;flex-direction:column;gap:16px}
.sh3-u .su-ph{display:flex;align-items:center;justify-content:space-between;gap:12px}
.sh3-u .su-tidy{display:flex;align-items:center;gap:14px;margin-top:14px;padding:12px 14px;border-radius:14px;background:var(--glass);
  border:1px solid var(--stroke);color:var(--text2)}
.sh3-u .su-tidy .su-ptxt{flex:1;min-width:0}
.sh3-u .su-tidy b{color:var(--text);font-weight:600}
.sh3-u .su-cards{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.sh3-u .su-card{border-radius:20px;overflow:hidden;background:var(--glass);border:1px solid var(--stroke);padding:0;text-align:left;display:flex;flex-direction:column;
  color:var(--text)}
.sh3-u .su-card:hover{border-color:var(--stroke2)}
.sh3-u .su-card.on{border:2px solid rgb(var(--ac));box-shadow:0 0 0 5px rgba(var(--ac),.15),0 18px 50px rgba(var(--ac),.28)}
.sh3-u .su-art{position:relative;height:150px;background:radial-gradient(120% 90% at 20% 0%,rgba(var(--ac),.20),transparent 60%),
  radial-gradient(90% 80% at 100% 100%,rgba(var(--ac2),.16),transparent 60%),var(--in-b);overflow:hidden}
.sh3-u[data-theme="paper"] .su-art{background:radial-gradient(120% 90% at 20% 0%,rgba(var(--ac),.45),transparent 60%),
  radial-gradient(90% 80% at 100% 100%,rgba(var(--ac2),.4),transparent 60%),#1c1f33}
.sh3-u .su-art-svg{position:absolute;inset:0;width:100%;height:100%}
.sh3-u .su-art-name{position:absolute;left:16px;bottom:12px;font-family:var(--fh);font-weight:700;font-size:26px;color:#fff;text-shadow:0 4px 20px rgba(0,0,0,.6)}
.sh3-u .su-check{position:absolute;right:12px;top:12px;width:28px;height:28px;border-radius:50%;background:var(--brand);color:var(--on);display:grid;place-items:center}
.sh3-u .su-card-b{padding:14px 16px 16px;display:flex;flex-direction:column;gap:8px}
.sh3-u .su-card-t{color:var(--text2);font-size:13px;line-height:1.4;min-height:36px}
.sh3-u .su-kv{display:flex;align-items:center;gap:8px;color:var(--text3);font-size:13px}
.sh3-u .su-kv span{flex:1;color:var(--text2)}
.sh3-u .su-kv b{font-family:var(--fh);color:var(--text);font-weight:600}
.sh3-u .su-tunes{display:grid;grid-template-columns:1fr 1fr 1fr 150px 150px 190px;gap:16px;align-items:end;padding:14px 16px;border-radius:16px;
  background:var(--well);border:1px solid var(--stroke)}
.sh3-u .su-tune{display:flex;flex-direction:column;gap:4px;min-width:0}
.sh3-u .su-tune.locked{opacity:.55}
.sh3-u .su-tune-h{display:flex;align-items:center;justify-content:space-between}
.sh3-u .su-tune-h b{font-family:var(--fh);font-weight:600}
.sh3-u .su-tune .sh3-select{width:100%}
.sh3-u .su-seeds .sh3-seg-opt{padding:7px 4px}
.sh3-u .su-shifts{display:grid;grid-template-columns:1fr 1fr 2fr;gap:16px;align-items:end;padding:14px 16px;border-radius:16px;
  background:var(--well);border:1px solid var(--stroke);margin-top:12px}
.sh3-u .su-shift-hint{display:flex;align-items:center;gap:8px;min-width:0;color:var(--text2);font-size:12.5px;line-height:1.35}
.sh3-u .su-shift-hint span{flex:1;min-width:0}
.sh3-u .su-shift-hint.off{color:var(--text)}
.sh3-u .su-shift-hint.off .sh3-ico{color:rgb(var(--cut))}
.sh3-u .su-mgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.sh3-u .su-mcard{display:flex;gap:12px;border-radius:16px;padding:14px;background:var(--glass);border:1px solid var(--stroke);min-width:0}
.sh3-u .su-mcard.missing{border-color:rgba(var(--bad),.55)}
.sh3-u .su-mic{width:38px;height:38px;border-radius:11px}
.sh3-u .su-mbody{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}
.sh3-u .su-file{height:28px;border:0;background-color:transparent;padding:0 22px 0 0;font-family:var(--fm);font-size:11.5px;font-weight:400;color:var(--text3);
  width:100%;background-position:right 2px center}
.sh3-u .su-file:hover{color:var(--text)}
.sh3-u .su-mbadges{display:flex;align-items:center;gap:6px}
.sh3-u .su-state{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2)}
.sh3-u .su-state i{width:7px;height:7px;border-radius:50%;background:rgb(var(--ok))}
.sh3-u .su-state.bad{color:rgb(var(--bad))} .sh3-u .su-state.bad i{background:rgb(var(--bad))}
.sh3-u .su-state.off i{background:var(--text3)}
.sh3-u .su-lgrid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.sh3-u .su-lcol{display:flex;flex-direction:column;gap:10px;min-width:0}
.sh3-u .su-turbo{display:flex;align-items:center;gap:14px;border-radius:16px;padding:12px 16px;background:var(--glass);border:1px solid var(--stroke);text-align:left;color:var(--text)}
.sh3-u .su-turbo>div{flex:1;min-width:0}
.sh3-u .su-turbo .sh3-muted{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sh3-u .su-turbo.on{background:linear-gradient(110deg,rgba(var(--ac),.2),rgba(var(--ac2),.06));border-color:rgba(var(--ac),.65)}
.sh3-u .su-turbo.missing{border-color:rgba(var(--bad),.6);background:rgba(var(--bad),.08)}
.sh3-u .su-radio{width:20px;height:20px;border-radius:50%;border:2px solid var(--stroke2);flex:none;position:relative}
.sh3-u .su-turbo.on .su-radio{border-color:rgb(var(--ac));background:rgb(var(--ac));box-shadow:0 0 12px rgba(var(--ac),.5)}
.sh3-u .su-turbo.on .su-radio:after{content:"";position:absolute;inset:4px;border-radius:50%;background:#fff}
.sh3-u .su-pdmd{display:flex;align-items:center;gap:12px;border-radius:16px;padding:12px 16px;background:var(--glass);border:1px solid var(--stroke)}
.sh3-u .su-pick{display:flex;align-items:center;gap:8px;border-radius:14px;padding:8px;border:1px solid rgba(var(--ac),.45);background:var(--glass)}
.sh3-u .su-tstr{display:flex;flex-direction:column;gap:8px;border-radius:14px;padding:10px 16px 12px;background:var(--well);border:1px solid var(--stroke)}
.sh3-u .su-tstr-h{display:flex;align-items:center;gap:10px}
.sh3-u .su-tstr-h .sh3-muted{font-size:12px}
.sh3-u .su-tstr-v{font-family:var(--fh);font-size:15px}
.sh3-u .su-tstr.off{opacity:.55}
.sh3-u .su-pick-filter{flex:0 0 38%;min-width:0}
.sh3-u .su-pick-sel{flex:1;min-width:0}
.sh3-u .su-pdmd .sh3-ic{color:rgb(var(--cut))}
.sh3-u .su-pdmd-t{flex:1;min-width:0;display:flex;flex-direction:column}
.sh3-u .su-pdmd .sh3-muted{font-size:12px;white-space:nowrap}
.sh3-u .su-glora{border-radius:16px;padding:12px 16px;background:var(--glass);border:1px solid var(--stroke);display:flex;flex-direction:column;gap:6px}
.sh3-u .su-glora-h{display:flex;align-items:center;gap:10px}
.sh3-u .su-glora-h .su-file{font-family:var(--ff);font-size:13.5px;font-weight:600;color:var(--text)}
.sh3-u .su-glora-h .sh3-ibtn{width:28px;height:28px;border-radius:9px}
.sh3-u .su-glora-s{display:flex;align-items:center;gap:12px}
.sh3-u .su-gval{font-family:var(--fh);width:78px;flex:none;text-align:right}
.sh3-u .su-addl{display:flex;align-items:center;justify-content:center;gap:8px;height:46px;border-radius:14px;border:1px dashed var(--stroke2);background:none;color:var(--text2)}
.sh3-u .su-addl:hover{color:var(--text);border-color:rgba(var(--ac),.5)}
.sh3-u .su-mem-row{display:flex;align-items:center;gap:24px}
.sh3-u .su-ring-wrap{position:relative;width:210px;height:210px;flex:none}
.sh3-u .su-ring{width:100%;height:100%}
.sh3-u .su-ring-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 40px}
.sh3-u .su-ring-c b{font-family:var(--fh);font-size:34px;font-weight:700}
.sh3-u .su-ring-c span{color:var(--text3);font-size:12px;line-height:1.3}
.sh3-u .su-legend{flex:1;display:flex;flex-direction:column;gap:12px}
.sh3-u .su-leg{display:flex;align-items:center;gap:10px}
.sh3-u .su-leg i{width:12px;height:12px;border-radius:4px;background:var(--glass3)}
.sh3-u .su-leg i.ac{background:rgb(var(--ac))} .sh3-u .su-leg i.k{background:rgb(var(--k))} .sh3-u .su-leg i.snd{background:rgb(var(--snd))}
.sh3-u .su-leg span{flex:1;color:var(--text2)}
.sh3-u .su-leg b{font-family:var(--fh);font-weight:600}
.sh3-u .su-note{font-size:12.5px}
.sh3-u .su-plist{display:flex;flex-direction:column;border-radius:16px;border:1px solid var(--stroke);overflow:hidden}
.sh3-u .su-prow{display:flex;align-items:center;gap:14px;padding:12px 16px;background:var(--glass)}
.sh3-u .su-prow+.su-prow{border-top:1px solid var(--stroke)}
.sh3-u .su-prow>.sh3-ic{color:var(--text3)}
.sh3-u .su-ptxt{flex:1;min-width:0}
.sh3-u .su-ptxt .sh3-muted{font-size:12px}
.sh3-u .su-psel{width:200px}
.sh3-u .su-themes{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.sh3-u .su-theme{position:relative;height:96px;border-radius:16px;padding:14px;display:flex;flex-direction:column;align-items:flex-start;gap:10px;
  background:#121116;border:1px solid var(--stroke2);color:#f0eef6;text-align:left}
.sh3-u .su-theme[data-theme="Paper light"]{background:#f6f5f1;color:#232327}
.sh3-u .su-theme[data-theme="Midnight blueprint"]{background:#0b1527}
.sh3-u .su-theme[data-theme="Film stock"]{background:#17120d}
.sh3-u .su-theme[data-theme="Studio slate"]{background:#16171b}
.sh3-u .su-theme[data-theme="ComfyUI default"]{background:#232323}
.sh3-u .su-theme.on{border:2px solid rgb(var(--ac));box-shadow:0 0 0 4px rgba(var(--ac),.18),0 10px 30px rgba(var(--ac),.3)}
.sh3-u .su-stripe{width:100%;height:6px;border-radius:4px}
.sh3-u .su-dots{display:flex;gap:6px}
.sh3-u .su-dots i{width:12px;height:12px;border-radius:50%}
.sh3-u .su-theme b{font-weight:600;font-size:13px}
.sh3-u .su-tcheck{position:absolute;right:10px;bottom:10px;width:22px;height:22px;border-radius:50%;background:var(--brand);color:var(--on);display:grid;place-items:center}
` }));
}

app.registerExtension({
  name: "Stubelius.UltimateH3.SetupWindow",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "StubeliusH3Setup") return;
    windowOrCompact(nodeType, { name: "sh3_setup", widgets: SETUP_WIDGETS, create: (node) => new SetupWindow(node), minHeight: 700 });
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => { this._sh3?.reload(false); refreshThemes(); }, 0);
      return r;
    };
  },
  async afterConfigureGraph() {
    // the Models, Theme and Director nodes arrive after the Setup: draw again once they are all there
    setTimeout(() => {
      for (const n of nodesOfType("StubeliusH3Setup")) n._sh3?.render();
    }, 50);
  },
});
