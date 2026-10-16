// Stubelius Ultimate H3: the Output window (step 4 of 4), on the Finish node.
//
// What comes out: the winner against the finished picture (a divider to drag, a 2x loupe, the finished video's
// sound), the finish
// step by step (polish in Quality mode, de-stutter, the frame rate, the upscale, the encode), the Output
// node's settings (size, frame rate, upscaler, de-stutter, the Quality polish), the file it is saved as
// with its loudness, and the latest results. A setting changed here re-runs only the finish.
import {
  h, icon, clear, seg, button, iconButton, label, badge, toast, select, slider, windowFrame, markSteps, goToStep,
  injectStyles, widget, widgetValue, setWidget, sourceOf, targetsOf, nodesOfType, fmtClock, fmtBytes, refreshThemes,
  windowOrCompact, queueRun,
} from "./stubelius_ui.js";
import { viewUrl } from "./stubelius_director_media.js";
import { splitViewer } from "./stubelius_viewer.js";

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const SIZES = [["native (no upscale)", "Native"], ["720p", "720p"], ["1080p", "1080p"], ["2K (1440p)", "2K"], ["4K (2160p)", "4K"]];
const SHORT = { "native (no upscale)": 0, "720p": 720, "1080p": 1080, "2K (1440p)": 1440, "4K (2160p)": 2160 };
const STAGES = ["start", "polish", "destutter", "fps", "upscale", "clip", "done"];

class OutputWindow {
  constructor(node) {
    this.node = node;
    this.stage = node.properties?.sh3_stage || null;     // the last stage event (and the "done" summary)
    this.progress = null;                                 // {value, max} of the step running now
    this.mode = "split";
    this.loupe = false;
    this.recent = [];
    this.frames = {};                                     // prompt id -> its last frame (a Preview Image output)
    injectStyles();
    injectOutputStyles();
    const f = windowFrame({ title: "Ultimate H3 · Output", subtitle: "Upscale, smooth and export", step: 4, onStep: goToStep });
    Object.assign(this, f);
    this.root.classList.add("sh3-o");
    this.status = h("div.sh3-status", h("span.sh3-dot"), h("span", "Ready"));
    this.head.append(h("div.sh3-spacer"), this.status,
      iconButton("refresh", "Read the latest results again", () => this.loadRecent()));
    this.viewer = splitViewer({ labelA: "Finished", labelB: "Render" });
    this.left = h("div.o-left");
    this.right = h("div.o-right");
    this.body.appendChild(h("div.o-main", this.left, this.right));
    this.listen();
    this.render();
    this.loadRecent();
  }

  // ----------------------------------------------------------------------------------- the other nodes

  output() {
    const o = sourceOf(this.node, "output");
    return o?.comfyClass === "StubeliusH3Output" ? o : nodesOfType("StubeliusH3Output")[0] || null;
  }

  director() {
    const d = sourceOf(this.node, "takes");
    return d?.comfyClass === "StubeliusH3DirectorV2" ? d : nodesOfType("StubeliusH3DirectorV2")[0] || null;
  }

  seedsNode() {
    const d = this.director();
    return (d && targetsOf(d, "takes").find((n) => n.comfyClass === "StubeliusSeedPreviews")) || nodesOfType("StubeliusSeedPreviews")[0] || null;
  }

  saver() {
    return targetsOf(this.node, "images").find((n) => /VideoCombine|SaveVideo|CreateVideo/.test(n.comfyClass || n.type)) || null;
  }

  // The preview nodes that keep the finished video's last frame (Finish -> Image From Batch -> Preview Image), behind
  // this window: the Last frame card shows what they make
  lastFrameNodes() {
    const out = [];
    const isPreview = (n) => /PreviewImage|SaveImage/.test(n.comfyClass || n.type || "");
    for (const n of targetsOf(this.node, "images")) {
      if (isPreview(n)) out.push(n);
      else if (/ImageFromBatch/.test(n.comfyClass || n.type || "")) for (const p of targetsOf(n, "IMAGE")) if (isPreview(p)) out.push(p);
    }
    return out;
  }

  setupMode() {
    const setup = this.director()?._sh3?.setupNode() || nodesOfType("StubeliusH3Setup")[0];
    return widgetValue(setup, "mode", "Hybrid");
  }

  winner() {
    return Number(widgetValue(this.node, "winner", 0)) || 0;
  }

  winnerVideo() {
    const vids = this.seedsNode()?.properties?.sh3_seeds || [];
    return vids.find((v) => v.candidate === this.winner()) || null;
  }

  get final() {
    return this.node.properties?.sh3_final || null;
  }

  // ----------------------------------------------------------------------------------- actions

  async finish() {
    if (!this.winner()) {
      const vids = this.seedsNode()?.properties?.sh3_seeds || [];
      if (!vids.length) { toast(this.root, "Render the video first (Director)"); return; }
      setWidget(this.node, "winner", vids[0].candidate);
      window.dispatchEvent(new CustomEvent("stubelius-winner"));
    }
    const dw = this.director()?._sh3;
    if (dw && !(await dw.checkFinish(this.root))) return;          // settings changed since these seeds?
    const before = this.stage;
    this.stage = { stage: "queued" };
    this.renderStatus();
    const r = await queueRun();
    if (!r.ok) {                             // ComfyUI turned it down (and said why)
      this.stage = before;
      this.renderStatus();
      toast(this.root, "Not finished: " + r.why, "bad");
    }
  }

  // a finish queued or under way (its stages come from the Finish node)
  busy() {
    const s = this.stage?.stage;
    return !!s && s !== "done" && s !== "hold" && s !== "error";
  }

  async openFolder() {
    const f = this.final;
    const sub = f?.subfolder ?? String(widgetValue(this.saver(), "filename_prefix", "") || "").split(/[\\/]/).slice(0, -1).join("/");
    try {
      const r = await api.fetchApi("/stubelius_ultimate_h3/open_folder", { method: "POST", body: JSON.stringify({ subfolder: sub || "" }) });
      const j = await r.json();
      if (!j.opened) toast(this.root, j.why || "Couldn't open the folder", "bad");
    } catch (e) {
      toast(this.root, "Couldn't open the folder", "bad");
    }
  }

  // The latest finished videos: the save node's outputs in ComfyUI's history
  async loadRecent() {
    const saver = this.saver();
    const prefix = String(widgetValue(saver, "filename_prefix", "") || "").split(/[\\/]/).pop();
    const frameIds = new Set(this.lastFrameNodes().map((n) => String(n.id)));
    try {
      const r = await api.fetchApi("/history?max_items=60");
      const hist = r.ok ? await r.json() : {};
      const found = [];
      for (const item of Object.values(hist).reverse()) {
        // the same run's last frame, when the workflow keeps one
        const frame = Object.entries(item.outputs || {}).filter(([id]) => frameIds.has(String(id)))
          .map(([, o]) => (o.images || [])[0]).find(Boolean) || null;
        for (const out of Object.values(item.outputs || {})) {
          for (const g of [...(out.gifs || []), ...(out.videos || [])]) {
            const name = g.filename || "";
            if (!/\.(mp4|webm|mov|mkv)$/i.test(name)) continue;
            if (prefix && !name.startsWith(prefix)) continue;
            if (!found.some((x) => x.filename === name && x.subfolder === g.subfolder)) found.push(frame ? { ...g, lastFrame: frame } : g);
          }
        }
      }
      // the video on show gets its last frame from the history too (a reload keeps the video, not always its frame)
      const fin = this.final;
      const same = fin && found.find((x) => x.filename === fin.filename && x.subfolder === fin.subfolder);
      if (same?.lastFrame && !fin.lastFrame) fin.lastFrame = same.lastFrame;
      this.recent = found.slice(0, 3);
    } catch (e) {
      this.recent = [];
    }
    this.renderRecent();
  }

  // ----------------------------------------------------------------------------------- drawing

  render() {
    this.renderStatus();
    this.renderLeft();
    this.renderRight();
    this.renderFoot();
    this.markSteps();
  }

  renderStatus() {
    const s = this.status;
    const st = this.stage;
    const out = this.output();
    const res = widgetValue(out, "final_resolution", "1080p");
    const size = SIZES.find((x) => x[0] === res)?.[1] || res;
    const fps = Math.round(Number(widgetValue(out, "final_fps", 24)));
    let text = `Ready to finish · ${size} · ${fps} fps`, cls = "";
    if (!this.winner()) { text = "Waiting for a winner (Seeds)"; cls = "warn"; }
    if (st?.stage === "queued") { text = "Finishing · queued"; cls = "busy"; }
    else if (st?.stage === "error") { text = `Not finished: ${st.why || "stopped"}`; cls = "bad"; }
    else if (st?.stage === "hold") {
      text = st.why === "partial" ? `Waiting: chunks 1-${st.chunks} of ${st.of} rendered, render the rest` : "Waiting for a winner (Seeds)";
      cls = "warn";
    } else if (st && st.stage !== "done" && STAGES.includes(st.stage)) {
      const pct = this.progress ? ` · ${Math.round((this.progress.value / Math.max(1, this.progress.max)) * 100)}%` : "";
      text = `Finishing · ${stageName(st.stage)}${pct}`;
      cls = "busy";
    } else if (st?.stage === "done" && this.final) {
      text = `Finished · ${st.width}×${st.height} · ${Math.round(st.fps)} fps` + (st.lufs != null ? ` · ${st.lufs.toFixed(1)} LUFS` : "");
    }
    s.className = "sh3-status" + (cls ? " " + cls : "");
    s.lastChild.textContent = text;
  }

  renderLeft() {
    const box = clear(this.left);
    const v = this.viewer;
    const fin = this.final;
    const win = this.winnerVideo();
    const out = this.output();
    const st = this.stage?.stage === "done" ? this.stage : this.node.properties?.sh3_done;
    v.setSources(fin ? viewUrl(fin) : null, win ? viewUrl(win) : (fin ? viewUrl(fin) : null));
    const upLabel = String(widgetValue(out, "upscaler", "RTX VSR")).startsWith("DLSS") ? "DLSS 5 + Color Lock" : "RTX VSR";
    v.setLabels(st ? `${SIZES.find((x) => SHORT[x[0]] && SHORT[x[0]] === Math.min(st.width, st.height))?.[1] || `${st.width}×${st.height}`} · ${st.upscaler ? upLabel : "native"}` : "Finished",
      win ? `Render · ${win.width}×${win.height}` : "Render");
    v.setMode(fin && win ? this.mode : "single");
    v.setLoupe(this.loupe);
    // the sound: the finished video's (A beside the render, else B on its own), the render's before a finish
    const muted = !!this.node.properties?.sh3_muted;
    v.setSound(muted ? null : fin && win ? "a" : "b");
    const stage = h("div.o-stage.sh3-panel", v.el);
    if (!fin && !win) {
      stage.appendChild(h("div.o-empty", h("div.o-empty-ic", icon("sparkles", 34)), h("div.sh3-h3", "The finished video shows up here"),
        h("div.sh3-muted", "Pick a winner in Seeds, then Finish: the render and the finished picture side by side, a loupe for the detail.")));
    }
    const play = h("button.o-play", { type: "button", title: "Play / pause" });
    const time = h("div.d-time.o-time");
    const bar = h("div.o-bar", h("span"));
    const drawPlay = () => { clear(play); play.appendChild(icon(v.b.paused ? "play" : "pause", 22)); };
    play.addEventListener("click", () => { v.toggle(); setTimeout(drawPlay, 30); });
    v.b.onplay = drawPlay;
    v.b.onpause = drawPlay;
    v.b.ontimeupdate = () => {
      clear(time);
      time.append(fmtClock(v.b.currentTime), h("span", ` / ${fmtClock(v.b.duration || 0)}`));
      bar.firstChild.style.width = `${(v.b.currentTime / (v.b.duration || 1)) * 100}%`;
    };
    bar.addEventListener("pointerdown", (e) => {
      const r = bar.getBoundingClientRect();
      v.seek(((e.clientX - r.left) / r.width) * (v.b.duration || 0));
    });
    drawPlay();
    clear(time);
    time.append(fmtClock(0), h("span", " / 00:00.00"));
    const modeBtn = (name, ic, m) => {
      const b = button(name, ic, "small o-mbtn", () => { this.mode = m; v.setMode(fin && win ? m : "single"); this.renderLeft(); });
      if (this.mode === m) b.classList.add("on");
      if (!fin || !win) b.classList.add("disabled");
      return b;
    };
    const loupeBtn = button("Loupe", "zoom", "small o-mbtn", () => { this.loupe = !this.loupe; v.setLoupe(this.loupe); this.renderLeft(); },
      "Twice as big under the pointer");
    if (this.loupe) loupeBtn.classList.add("on");
    const soundBtn = button("Sound", muted ? "volumeOff" : "volume", "small o-mbtn", () => {
      this.node.properties = this.node.properties || {};
      this.node.properties.sh3_muted = !muted;
      this.renderLeft();
    }, fin ? "Sound on/off: the finished video's sound" : "Sound on/off");
    if (!muted) soundBtn.classList.add("on");
    stage.appendChild(h("div.o-controls", play, time, bar, soundBtn, modeBtn("Split", "columns", "split"), modeBtn("Side by side", "columns", "side"), loupeBtn));
    box.appendChild(stage);
    box.appendChild(this.pipeline());
  }

  // The finish, step by step
  pipeline() {
    const out = this.output();
    const mode = this.setupMode();
    const res = widgetValue(out, "final_resolution", "1080p");
    const size = SIZES.find((x) => x[0] === res)?.[1] || res;
    const fps = Math.round(Number(widgetValue(out, "final_fps", 24)));
    const up = String(widgetValue(out, "upscaler", "RTX VSR"));
    const saver = this.saver();
    const st = this.stage;
    const at = st && STAGES.includes(st.stage) ? STAGES.indexOf(st.stage) : -1;
    const running = (name) => st?.stage === name;
    const passed = (name) => at > STAGES.indexOf(name) || st?.stage === "done";
    const win = this.winnerVideo();
    const steps = [];
    steps.push({ ic: "crown", name: "Winner", text: win ? `Seed ${this.winner()}, ${(win.chunk_seeds || []).length || 1} chunk${(win.chunk_seeds || []).length === 1 ? "" : "s"}, its own sound` : "Pick one in Seeds",
      state: win ? "done" : "wait" });
    if (mode === "Quality" && res !== "native (no upscale)") {
      steps.push({ ic: "diamond", name: "Quality polish", text: `Rendered again ${widgetValue(out, "quality_polish_scale", "1.5x")} bigger, ${widgetValue(out, "quality_polish_steps", 12)} steps`,
        state: running("polish") ? "run" : passed("polish") ? "done" : "next" });
    }
    steps.push({ ic: "aspect", name: res === "native (no upscale)" ? "Native size" : `Upscale to ${size}`,
      text: res === "native (no upscale)" ? "No upscale: the render's own size" : up.startsWith("DLSS") ? "DLSS 5 with Color Lock holds the colours" : "RTX VSR: fast and clean",
      state: res === "native (no upscale)" ? "skip" : running("upscale") ? "run" : passed("upscale") ? "done" : "next" });
    steps.push({ ic: "wave", name: fps > 24 ? `Smooth to ${fps} fps` : "24 fps", text: fps > 24 ? "RIFE in-betweens, de-stutter first if needed" : "Frames as rendered, de-stutter if needed",
      state: running("fps") || running("destutter") ? "run" : passed("fps") ? "done" : "next" });
    const fmt = String(widgetValue(saver, "format", "video/h264-mp4"));
    const crf = widgetValue(saver, "crf", null);
    steps.push({ ic: "film", name: "Encode", text: `${fmt.includes("mp4") ? "MP4" : fmt.split("/").pop()} · ${fmt.includes("265") ? "H.265" : fmt.includes("av1") ? "AV1" : "H.264"}${crf != null ? ` · CRF ${crf}` : ""}, sound untouched`,
      state: this.final && st?.stage === "done" ? "done" : st?.stage === "done" ? "run" : "next" });
    const grid = h("div.o-steps");
    for (const s of steps) {
      const pct = s.state === "run" && this.progress ? Math.round((this.progress.value / Math.max(1, this.progress.max)) * 100) : null;
      grid.appendChild(h("div.o-step", { class: s.state },
        h("div.o-step-h", h("span.sh3-ico.ac", icon(s.ic, 16)), h("b", s.name), s.state === "run" ? h("div.sh3-spin") : null),
        h("div.sh3-muted.o-step-t", s.text),
        h("div.o-step-s", s.state === "done" ? h("span.ok", icon("circleCheck", 15), "Ready")
          : s.state === "run" ? h("span", pct != null ? `${pct}%` + (this.progress ? ` · ${this.progress.value} of ${this.progress.max}` : "") : "Working…")
            : s.state === "skip" ? h("span.sh3-muted", "Skipped") : s.state === "wait" ? h("span.warn", icon("alert", 14), "Waiting")
              : h("span.sh3-muted", icon("clock", 14), "Next"))));
    }
    return h("div.o-pipe.sh3-panel", h("div.o-ph", h("div.sh3-h2", "Finishing"), h("span.sh3-muted", this.etaText())), grid);
  }

  etaText() {
    const p = this.progress;
    if (!p || !p.t0 || !p.value) return this.stage?.stage === "done" ? "done" : "";
    const rate = p.value / ((performance.now() - p.t0) / 1000);
    const left = (p.max - p.value) / Math.max(0.001, rate);
    return left > 2 ? `about ${left > 90 ? `${Math.round(left / 60)} min` : `${Math.round(left)} s`} left in this step` : "";
  }

  renderRight() {
    const box = clear(this.right);
    box.appendChild(this.settings());
    box.appendChild(this.exportPanel());
    box.appendChild(this.lastFramePanel());
    this.recentBox = h("div.o-recent.sh3-panel");
    box.appendChild(this.recentBox);
    this.renderRecent();
  }

  settings() {
    const out = this.output();
    const panel = h("div.o-set.sh3-panel", h("div.o-ph", h("div.sh3-h2", "Output"), h("span.sh3-muted", "re-runs only this part")));
    if (!out) {
      panel.appendChild(h("div.sh3-muted", "Connect a Stubelius H3 Output node to the Finish."));
      return panel;
    }
    const w = (name) => widget(out, name);
    const set = (name, value) => { setWidget(out, name, value); this.render(); this.director()?._sh3?.renderCmd?.(); };
    const offered = w("final_resolution")?.options?.values || SIZES.map((x) => x[0]);
    panel.appendChild(h("div.o-sec", label("Final size"),
      seg(SIZES.filter(([v]) => offered.includes(v)), w("final_resolution")?.value, (v) => set("final_resolution", v))));
    // any rate from 24 up (the node's own range): above 24 RIFE draws the frames in between, length and sync kept
    const fpsW = w("final_fps");
    const lo = Number.isFinite(fpsW?.options?.min) ? fpsW.options.min : 24;
    const hi = Number.isFinite(fpsW?.options?.max) ? fpsW.options.max : 120;
    const fps = Math.round(Number(fpsW?.value ?? 24));
    const fpsVal = h("b.o-fps-val");
    const fpsHint = h("span.sh3-muted.o-fps-hint");
    const showFps = (v) => {
      fpsVal.textContent = `${Math.round(v)} fps`;
      fpsHint.textContent = v > 24 ? "RIFE draws the frames in between" : "untouched, as rendered";
    };
    showFps(fps);
    const picks = h("div.o-fps-picks", ...[24, 30, 48, 60, 120].filter((v) => v >= lo && v <= hi).map((v) =>
      h("button.o-fps-pick", { type: "button", class: v === fps ? "on" : null, title: `${v} fps`, onclick: () => set("final_fps", v) }, String(v))));
    panel.appendChild(h("div.o-sec", h("div.o-fps-h", label("Frame rate"), fpsVal),
      slider({ min: lo, max: hi, step: 1, value: fps, title: "Frame rate of the finished video", onInput: showFps,
        onChange: (v) => set("final_fps", v) }),
      h("div.o-fps-foot", fpsHint, picks)));
    const up = String(w("upscaler")?.value || "RTX VSR");
    const card = (value, name, ic, text) => h("button.o-card", { type: "button", class: up === value ? "on" : null,
      onclick: () => set("upscaler", value) }, h("div.o-card-h", icon(ic, 16), h("b", name)), h("div.sh3-muted", text));
    const dlss = !!window.LiteGraph?.registered_node_types?.DLSS5EnhanceImages;
    panel.appendChild(h("div.o-sec", label("Upscaler"), h("div.o-cards",
      card("DLSS5 + Color Lock", "DLSS 5 + Color Lock", "sparkles", dlss ? "Sharpest; Color Lock keeps the colours the render had" : "Needs ComfyUI-DLSS5-Enhancer"),
      card("RTX VSR", "RTX VSR", "bolt", "Fast and clean, a little softer"))));
    panel.appendChild(h("div.o-sec", label("De-stutter"),
      seg([["auto", "Auto"], ["on", "On"], ["off", "Off"]], w("de_stutter")?.value || "auto", (v) => set("de_stutter", v))));
    // the Director's Render waits for a pick in Seeds; with one seed it can go straight on to the finish
    panel.appendChild(h("div.o-sec", label("After a render with one seed"),
      seg([[false, "Wait for my pick"], [true, "Finish it right away"]], !!this.node.properties?.sh3_autofinish, (v) => {
        this.node.properties = this.node.properties || {};
        this.node.properties.sh3_autofinish = v;
        this.render();
      })));
    const mode = this.setupMode();
    const polishOn = mode === "Quality";
    const pol = h("div.o-polish", h("span.sh3-ico.k", icon("diamond", 16)),
      h("div.o-polish-t", h("b", "Quality polish"), h("div.sh3-muted",
        `Runs in Quality mode · ${w("quality_polish_scale")?.value || "1.5x"} · ${w("quality_polish_steps")?.value ?? 12} steps · strength ${Number(w("quality_polish_strength")?.value ?? 0.3).toFixed(2)}`)),
      polishOn ? null : badge(`off in ${mode}`));
    panel.appendChild(pol);
    if (polishOn) {
      const strength = slider({ min: 0.05, max: 1, step: 0.05, value: Number(w("quality_polish_strength")?.value ?? 0.3),
        onChange: (v) => set("quality_polish_strength", v) });
      panel.appendChild(h("div.o-polish-ed",
        h("div.o-row", h("span.sh3-muted", "Scale"), seg([["1.5x", "1.5×"], ["2x", "2×"]], w("quality_polish_scale")?.value || "1.5x", (v) => set("quality_polish_scale", v))),
        h("div.o-row", h("span.sh3-muted", "Strength"), strength, h("b", Number(w("quality_polish_strength")?.value ?? 0.3).toFixed(2))),
        h("div.o-row", h("span.sh3-muted", "Steps"), select(
          Array.from({ length: Math.max(24, Number(w("quality_polish_steps")?.value) || 0) }, (_, i) => [String(i + 1), String(i + 1)]),
          String(w("quality_polish_steps")?.value ?? 12), (v) => set("quality_polish_steps", Number(v))))));
    }
    if (this.director()?._sh3?.timeline?.source_clip) {
      const clipIn = w("clip_in_output");
      panel.appendChild(h("div.o-sec", label("The clip it continues"),
        seg([[true, "Clip + new part"], [false, "New part only"]], clipIn?.value !== false, (v) => set("clip_in_output", v))));
    }
    return panel;
  }

  exportPanel() {
    const saver = this.saver();
    const fin = this.final;
    const st = this.stage?.stage === "done" ? this.stage : this.node.properties?.sh3_done;
    const panel = h("div.o-exp.sh3-panel");
    const sizeBadge = h("span.sh3-badge.ok.o-size", "–");
    panel.appendChild(h("div.o-ph", h("div.sh3-h2", "Export"), fin ? sizeBadge : null));
    if (fin) {
      fetch(viewUrl(fin), { method: "HEAD" }).then((r) => {
        const n = Number(r.headers.get("content-length"));
        if (n) sizeBadge.textContent = `≈ ${fmtBytes(n)}`;
      }).catch(() => {});
    }
    const prefix = widget(saver, "filename_prefix");
    const name = h("input.sh3-input.o-name", { type: "text", value: fin?.filename || prefix?.value || "UltimateH3/UltimateH3",
      title: fin ? "The file the last finish was saved as" : "Saved under this name in the output folder" });
    if (prefix) name.addEventListener("change", () => { setWidget(saver, "filename_prefix", name.value.replace(/\.(mp4|webm|mov)$/i, "")); });
    panel.appendChild(name);
    const fmt = String(widgetValue(saver, "format", "video/h264-mp4"));
    const crf = widgetValue(saver, "crf", null);
    const tags = h("div.o-tags",
      badge(fmt.includes("mp4") ? "MP4" : (fmt.split("/").pop() || "video").toUpperCase(), "ac"),
      badge(`${fmt.includes("265") ? "H.265" : fmt.includes("av1") ? "AV1" : "H.264"}${crf != null ? ` · CRF ${crf}` : ""}`),
      st ? badge(`${st.width}×${st.height}`) : null, st ? badge(`${Math.round(st.fps)} fps`) : null,
      st?.rate ? badge(`${Math.round(st.rate / 1000)} kHz ${st.channels > 1 ? "stereo" : "mono"}`) : null);
    panel.appendChild(tags);
    if (st?.lufs != null) {
      const pos = Math.max(0, Math.min(100, ((st.lufs + 36) / 30) * 100));
      panel.appendChild(h("div.o-loud", label("Loudness"), h("div.o-meter", h("span.o-mark", { style: { left: `${pos}%` } })),
        h("b", `${st.lufs.toFixed(1)} LUFS`)));
    }
    const exp = button(fin ? "Finish again" : "Finish", "download", "cta o-cta", () => this.finish(),
      "Run the finish (the Director's takes and the seeds come from cache)");
    panel.appendChild(h("div.o-ebtns", button("Open folder", "folder", "ghost", () => this.openFolder(), "Open the output folder on this machine"), exp));
    return panel;
  }

  // The frame the finished video ends on (to start the next video from, or to keep): the run's own PNG when the
  // workflow keeps one, else taken from the saved video. Click to see it big, Save to keep it.
  lastFramePanel() {
    const fin = this.final;
    const panel = h("div.o-last.sh3-panel");
    const base = String(fin?.filename || "video").replace(/\.[^.]+$/, "");
    const png = fin?.lastFrame ? viewUrl({ ...fin.lastFrame, type: fin.lastFrame.type || "temp" }) : null;
    const save = button("Save", "download", "small", async () => {
      try {
        const blob = png ? await (await fetch(png)).blob() : await this.grabLastFrame(fin);
        if (!blob) throw new Error("no frame");
        const a = h("a", { href: URL.createObjectURL(blob), download: `${base}_last_frame.png` });
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      } catch (e) {
        toast(this.root, "Couldn't get the last frame", "bad");
      }
    }, "Save the last frame as a PNG");
    panel.appendChild(h("div.o-ph", h("div.sh3-h2", "Last frame"), fin ? save : h("span.sh3-muted", "after a finish")));
    if (!fin) {
      panel.appendChild(h("div.sh3-muted", "The frame the finished video ends on shows up here: save it to start the next video from it."));
      return panel;
    }
    const shot = h("button.o-lframe", { type: "button", title: "See it big" });
    const show = (src) => { clear(shot); shot.appendChild(h("img", { src, draggable: false })); };
    const fromVideo = () => {
      this.grabLastFrame(fin).then((blob) => { if (blob) show(URL.createObjectURL(blob)); }).catch(() => {});
    };
    if (png) {
      const img = h("img", { src: png, draggable: false });
      img.addEventListener("error", fromVideo, { once: true });          // a temp file goes when ComfyUI restarts
      shot.appendChild(img);
    } else {
      fromVideo();
    }
    shot.addEventListener("click", () => {
      const src = shot.querySelector("img")?.src;
      if (!src) return;
      const wrap = h("div.o-lbox", { onclick: () => wrap.remove(), title: "Click to close" }, h("img", { src, draggable: false }),
        h("div.o-lbox-cap", `${base} · last frame`));
      this.root.appendChild(wrap);
      const esc = (e) => { if (e.key === "Escape") { wrap.remove(); document.removeEventListener("keydown", esc, true); } };
      document.addEventListener("keydown", esc, true);
    });
    panel.appendChild(shot);
    return panel;
  }

  // The last frame of a saved video, from the file itself (a frame drawn into a canvas, as a PNG blob)
  grabLastFrame(fin) {
    return new Promise((resolve) => {
      if (!fin) return resolve(null);
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.crossOrigin = "anonymous";
      v.addEventListener("loadedmetadata", () => { v.currentTime = Math.max(0, (v.duration || 0) - 0.02); });
      v.addEventListener("seeked", () => {
        const c = document.createElement("canvas");
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext("2d").drawImage(v, 0, 0);
        c.toBlob((b) => resolve(b), "image/png");
      }, { once: true });
      v.addEventListener("error", () => resolve(null), { once: true });
      v.src = viewUrl(fin);
    });
  }

  renderRecent() {
    const box = this.recentBox;
    if (!box) return;
    clear(box);
    const saver = this.saver();
    const sub = String(widgetValue(saver, "filename_prefix", "") || "").split(/[\\/]/).slice(0, -1).join("/");
    box.appendChild(h("div.o-ph", h("div.sh3-h2", "Recent"), h("span.sh3-muted", `output/${sub || ""}`)));
    if (!this.recent.length) {
      box.appendChild(h("div.sh3-muted", "Finished videos show up here."));
      return;
    }
    const row = h("div.o-recents");
    for (const g of this.recent) {
      const vid = h("video", { src: viewUrl(g), muted: true, preload: "metadata", playsInline: true });
      const dur = h("span.o-dur", "");
      vid.addEventListener("loadedmetadata", () => {
        vid.currentTime = Math.min(1, (vid.duration || 2) / 3);
        dur.textContent = fmtClock(vid.duration).replace(/^00:/, "0:").replace(/\.\d+$/, "");
      });
      const tile = h("button.o-rtile", { type: "button", title: g.filename,
        onclick: () => { this.node.properties = this.node.properties || {}; this.node.properties.sh3_final = g; this.render(); } }, vid, dur);
      tile.addEventListener("mouseenter", () => vid.play().catch(() => {}));
      tile.addEventListener("mouseleave", () => vid.pause());
      row.appendChild(tile);
    }
    box.appendChild(row);
  }

  renderFoot() {
    const f = clear(this.foot);
    const saver = this.saver();
    const sub = String(widgetValue(saver, "filename_prefix", "") || "").split(/[\\/]/).slice(0, -1).join("/");
    const types = window.LiteGraph?.registered_node_types || {};
    f.append(h("span.sh3-fi", icon("folder", 14), "Saves to ", h("b", `output/${sub}`)),
      h("span.sh3-fi", icon("cpu", 14), "DLSS 5 ", h("b", types.DLSS5EnhanceImages ? "ready" : "not installed")),
      h("span.sh3-fi", icon("cpu", 14), "RTX VSR ", h("b", types.RTXVideoSuperResolution ? "ready" : "not installed")),
      h("div.sh3-spacer"),
      h("span.sh3-fi", icon("refresh", 14), "Change a setting here and only the finish runs again"));
  }

  markSteps() {
    const done = new Set();
    const dw = this.director()?._sh3;
    if (dw) {
      if (dw.setupNode() && dw.modelsNode()) done.add(1);
      if (dw.report && (dw.report.chunks || []).length === dw.report.chunks_total) done.add(2);
    }
    if (this.winner() >= 1) done.add(3);
    markSteps(this.steps, done);
  }

  // ----------------------------------------------------------------------------------- events

  isMe(id) {
    return id != null && (String(id) === String(this.node.id) || String(id).endsWith(":" + this.node.id));
  }

  listen() {
    const on = (type, fn, target = api) => {
      target.addEventListener(type, fn);
      (this._off ||= []).push(() => target.removeEventListener(type, fn));
    };
    on("stubelius_ultimate_h3.finish", (e) => {
      const d = e.detail || {};
      if (!this.isMe(d.node)) return;
      this.stage = d;
      this.progress = null;
      this.node.properties = this.node.properties || {};
      this.node.properties.sh3_stage = d.stage === "done" || d.stage === "hold" ? d : null;
      if (d.stage === "done") this.node.properties.sh3_done = d;
      this.render();
    });
    on("progress", (e) => {
      const d = e.detail || {};
      if (!this.isMe(d.node) || !this.stage || this.stage.stage === "done") return;
      if (!this.progress || this.progress.max !== d.max || d.value < (this.progress.value || 0)) this.progress = { t0: performance.now(), value: 0, max: d.max };
      this.progress.value = d.value;
      this.renderStatus();
      const pipe = this.left.querySelector(".o-pipe");
      if (pipe) pipe.replaceWith(this.pipeline());
    });
    on("executed", (e) => {
      const d = e.detail || {};
      const saver = this.saver();
      // the last frame and the saved video come from the same run, in either order
      if (this.lastFrameNodes().some((n) => String(n.id) === String(d.node))) {
        const img = (d.output?.images || [])[0];
        if (img) {
          this.frames[d.prompt_id] = img;
          const fin = this.final;
          if (fin && fin.prompt_id === d.prompt_id) { fin.lastFrame = img; this.renderRight(); }
        }
      }
      if (saver && String(d.node) === String(saver.id)) {
        const g = [...(d.output?.gifs || []), ...(d.output?.videos || []), ...(d.output?.images || [])]
          .find((x) => /\.(mp4|webm|mov|mkv)$/i.test(x.filename || ""));
        if (g) {
          this.node.properties = this.node.properties || {};
          this.node.properties.sh3_final = { ...g, prompt_id: d.prompt_id, ...(this.frames[d.prompt_id] ? { lastFrame: this.frames[d.prompt_id] } : {}) };
          this.render();
          this.loadRecent();
        }
      }
    });
    // a Finish that doesn't run sends no stages: nothing changed (cached), it failed, or it was stopped
    const settle = (stage) => { this.stage = stage; this.progress = null; this.render(); };
    on("execution_cached", (e) => {
      if (this.stage?.stage === "queued" && (e.detail?.nodes || []).some((id) => this.isMe(id))) settle(this.node.properties?.sh3_done || null);
    });
    on("execution_error", (e) => {
      if (!this.busy()) return;
      const d = e.detail || {};
      const where = this.isMe(d.node_id) ? "" : `${app.graph?.getNodeById?.(d.node_id)?.title || d.node_type || "a node before it"}: `;
      settle({ stage: "error", why: where + String(d.exception_message || "error").split("\n")[0].slice(0, 140) });
    });
    on("execution_interrupted", () => { if (this.busy()) settle(this.node.properties?.sh3_done || null); });
    on("stubelius-winner", () => this.render(), window);
    on("stubelius-takes", () => this.markSteps(), window);
  }

  dispose() {
    for (const off of this._off || []) off();
  }
}

function stageName(stage) {
  return { start: "starting", polish: "Quality polish", destutter: "de-stutter", fps: "smoothing", upscale: "upscale",
    clip: "the clip in front", done: "done" }[stage] || stage;
}

let styled = false;
function injectOutputStyles() {
  if (styled) return;
  styled = true;
  document.head.appendChild(h("style", { id: "stubelius-uh3-output", text: `
.sh3-o .o-main{display:grid;grid-template-columns:minmax(0,1fr) 548px;gap:20px;align-items:start}
.sh3-o.narrow .o-main{grid-template-columns:minmax(0,1fr)}
.sh3-o .o-left,.sh3-o .o-right{display:flex;flex-direction:column;gap:20px;min-width:0}
.sh3-o .o-stage{position:relative;overflow:hidden;aspect-ratio:16/9.6;padding:0}
.sh3-o .o-stage .v-split{position:absolute;inset:0}
.sh3-o .o-empty{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;
  padding:40px;background:radial-gradient(600px 300px at 50% 40%,rgba(var(--ac),.10),transparent 70%)}
.sh3-o .o-empty .sh3-muted{max-width:460px}
.sh3-o .o-empty-ic{width:76px;height:76px;border-radius:22px;display:grid;place-items:center;background:var(--glass3);color:var(--text2)}
.sh3-o .o-controls{position:absolute;left:22px;right:22px;bottom:20px;display:flex;align-items:center;gap:14px;z-index:6;color:#f3f1f8}
.sh3-o .o-play{width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.92);color:#120a12;display:grid;place-items:center;border:0;flex:none;
  box-shadow:0 10px 30px rgba(0,0,0,.45);padding:0}
.sh3-o .o-time span{color:#9d9aae}
.sh3-o .o-bar{flex:1;height:6px;border-radius:4px;background:rgba(255,255,255,.25);cursor:pointer;position:relative}
.sh3-o .o-bar span{position:absolute;left:0;top:0;bottom:0;background:var(--brand);border-radius:4px}
.sh3-o .o-mbtn{background:rgba(10,8,16,.55);backdrop-filter:blur(12px);border-color:rgba(255,255,255,.18);color:#f3f1f8;height:38px}
.sh3-o .o-mbtn.on{border-color:rgba(var(--ac),.8);box-shadow:0 0 16px rgba(var(--ac),.35)}
.sh3-o .o-pipe,.sh3-o .o-set,.sh3-o .o-exp,.sh3-o .o-recent,.sh3-o .o-last{padding:20px 22px;display:flex;flex-direction:column;gap:14px}
.sh3-o .o-lframe{display:block;width:100%;aspect-ratio:16/9;border-radius:13px;overflow:hidden;border:1px solid var(--stroke2);background:#000;
  padding:0;cursor:zoom-in}
.sh3-o .o-lframe img{width:100%;height:100%;object-fit:contain;display:block}
.sh3-o .o-lbox{position:absolute;inset:0;z-index:90;background:rgba(0,0,0,.82);display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:12px;padding:30px;cursor:zoom-out;border-radius:inherit}
.sh3-o .o-lbox img{max-width:100%;max-height:calc(100% - 40px);object-fit:contain;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.sh3-o .o-lbox-cap{color:#ddd;font-size:13px}
.sh3-o .o-ph{display:flex;align-items:center;justify-content:space-between;gap:10px}
.sh3-o .o-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.sh3-o .o-step{border-radius:16px;background:var(--glass);border:1px solid var(--stroke);padding:14px;display:flex;flex-direction:column;gap:8px;min-height:140px}
.sh3-o .o-step.run{border-color:rgba(var(--ac),.65);background:linear-gradient(170deg,rgba(var(--ac),.12),var(--glass));box-shadow:0 0 30px rgba(var(--ac),.18)}
.sh3-o .o-step.skip,.sh3-o .o-step.next{opacity:.75}
.sh3-o .o-step-h{display:flex;align-items:center;gap:10px}
.sh3-o .o-step-h b{font-family:var(--fh);font-size:15px;font-weight:600}
.sh3-o .o-step-h .sh3-spin{margin-left:auto}
.sh3-o .o-step-t{font-size:12.5px;line-height:1.4;flex:1}
.sh3-o .o-step-s span{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:13px}
.sh3-o .o-step-s .ok{color:rgb(var(--ok))}
.sh3-o .o-step-s .warn{color:rgb(var(--cut))}
.sh3-o .o-sec{display:flex;flex-direction:column;gap:8px}
.sh3-o .o-fps-h{display:flex;align-items:center;justify-content:space-between}
.sh3-o .o-fps-val{font-family:var(--fh);font-weight:600;font-size:15px}
.sh3-o .o-fps-foot{display:flex;align-items:center;justify-content:space-between;gap:10px}
.sh3-o .o-fps-hint{font-size:12px}
.sh3-o .o-fps-picks{display:flex;gap:4px}
.sh3-o .o-fps-pick{min-width:38px;height:26px;padding:0 8px;border-radius:8px;border:1px solid var(--stroke);background:var(--glass);
  color:var(--text2);font-family:var(--fh);font-size:12px}
.sh3-o .o-fps-pick:hover{color:var(--text);border-color:var(--stroke2)}
.sh3-o .o-fps-pick.on{color:var(--text);border-color:rgba(var(--ac),.7);background:rgba(var(--ac),.15)}
.sh3-o .o-cards{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.sh3-o .o-card{border-radius:14px;padding:12px;background:var(--glass);border:1px solid var(--stroke);text-align:left;display:flex;flex-direction:column;gap:5px}
.sh3-o .o-card:hover{border-color:var(--stroke2)}
.sh3-o .o-card.on{background:linear-gradient(160deg,rgba(var(--ac),.22),rgba(var(--ac2),.08));border-color:rgba(var(--ac),.7);box-shadow:0 0 22px rgba(var(--ac),.2)}
.sh3-o .o-card-h{display:flex;align-items:center;gap:8px}
.sh3-o .o-card .sh3-muted{font-size:12px;line-height:1.35}
.sh3-o .o-polish{display:flex;align-items:center;gap:12px;border-radius:14px;padding:12px;background:var(--glass);border:1px solid var(--stroke)}
.sh3-o .o-polish-t{flex:1;min-width:0}
.sh3-o .o-polish-t .sh3-muted{font-size:12px}
.sh3-o .o-polish-ed{display:flex;flex-direction:column;gap:8px;padding:0 4px}
.sh3-o .o-row{display:grid;grid-template-columns:80px 1fr auto;align-items:center;gap:12px}
.sh3-o .o-row .sh3-seg{grid-column:2 / 4}
.sh3-o .o-row .sh3-select{grid-column:2 / 4;width:110px}
.sh3-o .o-name{width:100%;font-family:var(--fm);font-size:13px}
.sh3-o .o-tags{display:flex;gap:6px;flex-wrap:wrap}
.sh3-o .o-loud{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px}
.sh3-o .o-meter{position:relative;height:8px;border-radius:5px;background:linear-gradient(90deg,rgba(var(--ok),.25) 0%,rgb(var(--ok)) 55%,rgb(var(--cut)) 80%,rgb(var(--bad)) 100%)}
.sh3-o .o-mark{position:absolute;top:-5px;width:3px;height:18px;border-radius:2px;background:#fff;box-shadow:0 0 8px rgba(0,0,0,.6);margin-left:-1px}
.sh3-o .o-ebtns{display:grid;grid-template-columns:1fr 1.3fr;gap:12px}
.sh3-o .o-ebtns .sh3-btn{height:58px}
.sh3-o .o-recents{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.sh3-o .o-rtile{position:relative;height:96px;border-radius:13px;overflow:hidden;border:1px solid var(--stroke2);background:#000;padding:0}
.sh3-o .o-rtile video{width:100%;height:100%;object-fit:cover;display:block}
.sh3-o .o-dur{position:absolute;left:7px;bottom:6px;font-size:11.5px;font-weight:600;padding:2px 7px;border-radius:7px;background:rgba(8,6,12,.65);color:#fff}
` }));
}

app.registerExtension({
  name: "Stubelius.UltimateH3.OutputWindow",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "StubeliusH3Finish") return;
    windowOrCompact(nodeType, { name: "sh3_output", widgets: ["winner"], create: (node) => new OutputWindow(node), minHeight: 700 });
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => {
        const o = this._sh3;
        if (!o) return;
        o.stage = this.properties?.sh3_stage || null;
        o.render();
        o.loadRecent();
        refreshThemes();
      }, 0);
      return r;
    };
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._sh3?.dispose();
      return onRemoved?.apply(this, arguments);
    };
  },
});
