// Stubelius Ultimate H3: the Seeds window (step 3 of 4), on the Seed Previews node.
//
// Every seed the Director rendered, side by side and in sync (with the Output node's de-stutter, as the
// finished video will move), with hints worth a look (held frames redrawn, a silent take) and never a
// ranking: your eye picks. Pick one as the winner; or pick chunk by chunk: keep a chunk, hunt the next one
// with four seeds on top of it, then render the rest. Finish the winner goes on to the Output window.
import {
  h, icon, clear, button, iconButton, label, badge, toast, windowFrame, markSteps, goToStep, glideTo, injectStyles,
  widget, widgetValue, setWidget, sourceOf, targetsOf, nodesOfType, fmtClock, fmtBytes, refreshThemes, windowOrCompact,
} from "./stubelius_ui.js";
import { viewUrl } from "./stubelius_director_media.js";
import { splitViewer } from "./stubelius_viewer.js";

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

class SeedsWindow {
  constructor(node) {
    this.node = node;
    this.solo = null;          // the tile whose sound plays (else the winner's, else the first)
    this.focus = null;         // a tile shown full size
    this.ab = false;           // A/B split: the winner against another seed
    this.abOther = null;
    this.loop = false;
    this.sync = true;
    injectStyles();
    injectSeedStyles();
    const f = windowFrame({ title: "Ultimate H3 · Seeds", subtitle: "Compare the takes, pick the winner", step: 3, onStep: goToStep });
    Object.assign(this, f);
    this.root.classList.add("sh3-s");
    this.status = h("div.sh3-status", h("span.sh3-dot"), h("span", "No seeds yet"));
    this.layoutBtn = iconButton("grid", "Grid of all seeds", () => { this.focus = null; this.ab = false; this.render(); });
    this.head.append(h("div.sh3-spacer"), this.status, this.layoutBtn);
    this.left = h("div.s-left");
    this.right = h("div.s-right");
    this.body.appendChild(h("div.s-main", this.left, this.right));
    this.listen();
    this.render();
  }

  get videos() {
    return this.node.properties?.sh3_seeds || [];
  }

  setVideos(list) {
    this.node.properties = this.node.properties || {};
    this.node.properties.sh3_seeds = list || [];
    this.solo = null;
    this.focus = null;
    this.render();
  }

  director() {
    const d = sourceOf(this.node, "takes");
    return d?.comfyClass === "StubeliusH3DirectorV2" ? d : nodesOfType("StubeliusH3DirectorV2")[0] || null;
  }

  dw() {
    return this.director()?._sh3 || null;
  }

  finish() {
    const d = this.director();
    return (d && targetsOf(d, "takes").find((n) => n.comfyClass === "StubeliusH3Finish")) || nodesOfType("StubeliusH3Finish")[0] || null;
  }

  winner() {
    return Number(widgetValue(this.finish(), "winner", 0)) || 0;
  }

  // The chunk the seeds differ in: the hunted one, else the first whose seed changes from seed to seed
  varying() {
    const vids = this.videos;
    if (vids[0]?.hunt != null) return vids[0].hunt;
    const n = Math.max(0, ...vids.map((v) => (v.chunk_seeds || []).length));
    for (let k = 0; k < n; k++) {
      if (new Set(vids.map((v) => v.chunk_seeds?.[k])).size > 1) return k;
    }
    return n ? n - 1 : null;
  }

  // The seed a tile stands for (of the chunk the seeds differ in)
  seedOf(v) {
    const k = this.varying();
    return k == null ? null : (v.chunk_seeds || [])[k] ?? null;
  }

  // A hunt's tile is picked when its seed is the hunted chunk's own seed; any other tile when it is the winner
  isPicked(v) {
    if (v.hunt != null) {
      const dw = this.dw();
      return !!dw && dw.hasOwnSeed(v.hunt) && dw.seedOf(v.hunt) === Number(v.chunk_seeds?.[v.hunt]);
    }
    return v.candidate === this.winner();
  }

  picked() {
    return this.videos.find((v) => this.isPicked(v))?.candidate || 0;
  }

  // Pick a seed: the winner for the Finish; in a chunk hunt that chunk's seed in the Director (the hunt is
  // only the video up to that chunk, so there is no winner to finish yet)
  pick(v) {
    const dw = this.dw();
    if (dw && v.hunt != null && v.chunk_seeds?.[v.hunt] != null) {
      dw.pickTake(v.hunt, v.chunk_seeds[v.hunt]);
      toast(this.root, `Chunk ${v.hunt + 1}: seed ${v.chunk_seeds[v.hunt]} kept. Hunt the next chunk or render the rest.`);
    } else {
      const f = this.finish();
      if (f) setWidget(f, "winner", v.candidate);
      toast(this.root, `Seed ${v.candidate} is the winner`);
    }
    window.dispatchEvent(new CustomEvent("stubelius-winner"));
    this.render();
    dw?.markSteps?.();
  }

  async finishWinner() {
    const vids = this.videos;
    if (!vids.length) { toast(this.root, "Render the video first (Director)"); return; }
    if (vids[0]?.partial) { toast(this.root, "This is the video up to one chunk: render the rest first"); return; }
    if (this.dw() && !(await this.dw().checkFinish(this.root))) return;     // settings changed since these seeds?
    if (!this.winner()) this.pick(vids[0]);
    try {
      await app.queuePrompt(0, 1);
    } catch (e) {
      toast(this.root, "Couldn't queue: " + (e?.message || e), "bad");
      return;
    }
    const out = nodesOfType("StubeliusH3Finish")[0];
    if (out) glideTo(out);
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
    const vids = this.videos;
    const s = this.status;
    if (!vids.length) {
      s.className = "sh3-status warn";
      s.lastChild.textContent = "No seeds yet: render in the Director";
      return;
    }
    const secs = Math.max(...vids.map((v) => v.seconds || 0));
    const total = vids.reduce((a, v) => a + (v.render_seconds || 0), 0);
    const part = vids[0].partial ? ` · chunks 1-${vids[0].chunks} of ${vids[0].of}` : "";
    const hunt = vids[0].hunt != null ? ` · hunting chunk ${vids[0].hunt + 1}` : "";
    s.className = "sh3-status";
    s.lastChild.textContent = `${vids.length} seed${vids.length > 1 ? "s" : ""} · ${secs.toFixed(1)} s each${part}${hunt}`
      + (total ? ` · rendered in ${fmtDuration(total)}` : "");
  }

  edges(v) {
    const dw = this.dw();
    const end = v.seconds || dw?.durationSeconds || 1;
    if (!dw) return [[0, end]];
    const b = dw.bounds().slice(0, v.partial ? v.chunks : undefined);
    const last = b[b.length - 1]?.[1] || end;
    return b.map(([s, e]) => [(s / last) * end, (e / last) * end]);
  }

  renderLeft() {
    const box = clear(this.left);
    const vids = this.videos;
    this.tiles = [];
    if (!vids.length) {
      box.appendChild(h("div.s-empty.sh3-panel", h("div.s-empty-ic", icon("grid", 34)), h("div.sh3-h3", "The seeds show up here"),
        h("div.sh3-muted", "Set Seeds to compare on the Setup (or Hunt ×4 on a chunk in the Director) and render. Every seed plays here, in sync.")));
      return;
    }
    if (this.ab && vids.length > 1) {
      const a = vids.find((v) => this.isPicked(v)) || vids[0];
      const b = vids.find((v) => v.candidate === this.abOther && v !== a) || vids.find((v) => v !== a);
      const viewer = splitViewer({ labelA: `Seed ${a.candidate}`, labelB: `Seed ${b.candidate}` });
      viewer.setSources(viewUrl(a), viewUrl(b));
      viewer.el.classList.add("s-ab");
      this.viewer = viewer;
      box.appendChild(viewer.el);
      this.master = viewer.b;
      viewer.setMuted(false);
    } else {
      this.viewer = null;
      const shown = this.focus ? vids.filter((v) => v.candidate === this.focus) : vids;
      const grid = h("div.s-grid", { class: shown.length === 1 ? "one" : null });
      for (const v of shown) grid.appendChild(this.tile(v));
      box.appendChild(grid);
      this.master = this.tiles[0]?.video || null;
    }
    box.appendChild(this.transport());
    this.applySound();
  }

  tile(v) {
    const video = h("video.s-video", { src: viewUrl(v), muted: true, loop: true, playsInline: true, preload: "auto" });
    video.muted = true;
    const isWin = this.isPicked(v);
    const flags = v.flags || [];
    const flagChip = flags.length
      ? h("div.sh3-gchip.s-flag.warn", icon("alert", 15), flags.map((f) => f.text).join(" · "))
      : h("div.sh3-gchip.s-flag", icon("circleCheck", 15), "No flags");
    const seed = this.seedOf(v);
    const tick = h("div.s-tick");
    const scrub = h("div.s-tscrub");
    for (const [s, e] of this.edges(v)) {
      scrub.appendChild(h("span", { style: { left: `${(s / (v.seconds || 1)) * 100}%`, width: `calc(${((e - s) / (v.seconds || 1)) * 100}% - 4px)` } }));
    }
    scrub.appendChild(tick);
    const soloBtn = button("Solo", "headphones", "small", () => { this.solo = this.solo === v.candidate ? null : v.candidate; this.applySound(); this.renderLeftButtons(); },
      "Hear this seed (the others stay quiet)");
    soloBtn.classList.add("s-solo");
    soloBtn.dataset.cand = String(v.candidate);
    const pickBtn = button(isWin ? "Picked" : "Pick", "crown", isWin ? "small s-picked" : "small", () => this.pick(v),
      v.hunt != null ? `Keep this seed for chunk ${v.hunt + 1}` : "Finish this seed");
    const el = h("div.s-tile", { class: isWin ? "win" : null },
      h("div.s-vwrap", video,
        h("div.s-tchips", isWin ? h("div.sh3-gchip.brand.s-winchip", icon(v.hunt != null ? "lock" : "crown", 15), v.hunt != null ? "Kept" : "Winner") : null,
          h("div.sh3-gchip", icon("dice", 15), `Seed ${v.candidate}${seed != null ? " · " + seed : ""}`)),
        h("div.s-tchips-r", flagChip),
        scrub),
      h("div.s-tfoot", h("b", seed != null ? String(seed) : `Seed ${v.candidate}`),
        h("span.sh3-muted", v.render_seconds ? fmtDuration(v.render_seconds) : `${(v.seconds || 0).toFixed(1)} s`),
        h("div.sh3-spacer"), soloBtn, pickBtn));
    video.addEventListener("timeupdate", () => { tick.style.left = `${(video.currentTime / (video.duration || 1)) * 100}%`; });
    video.addEventListener("dblclick", () => { this.focus = this.focus ? null : v.candidate; this.render(); });
    this.tiles.push({ v, video, el });
    return el;
  }

  renderLeftButtons() {
    this.left.querySelectorAll(".s-solo").forEach((b) => b.classList.toggle("on", Number(b.dataset.cand) === this.solo));
    this.left.querySelectorAll(".s-snd-src").forEach((el) => { el.lastChild.textContent = this.soundLabel(); });
  }

  soundLabel() {
    if (this.ab) return "Sound: seed B";
    if (this.solo) return `Sound: seed ${this.solo}`;
    return this.picked() ? `Sound: seed ${this.picked()}` : "Sound: seed 1";
  }

  // one seed's sound at a time: the solo one, else the picked one's, else the first
  applySound() {
    const want = this.solo || this.picked() || this.tiles[0]?.v.candidate;
    for (const t of this.tiles || []) t.video.muted = t.v.candidate !== want;
  }

  transport() {
    const play = h("button.s-play", { type: "button", title: "Play / pause every seed" });
    const time = h("div.d-time.s-time");
    const scrub = h("div.s-scrub");
    const knob = h("div.s-knob");
    const vids = this.videos;
    const v0 = vids[0];
    const dw = this.dw();
    const loopK = dw ? dw.sel : 0;
    for (const [i, [s, e]] of this.edges(v0).entries()) {
      scrub.appendChild(h("span", { class: this.loop && i === loopK ? "loop" : null,
        style: { left: `${(s / (v0.seconds || 1)) * 100}%`, width: `calc(${((e - s) / (v0.seconds || 1)) * 100}% - 6px)` } }));
    }
    scrub.appendChild(knob);
    const all = () => (this.viewer ? [this.viewer.b] : (this.tiles || []).map((t) => t.video));
    const drawPlay = () => { clear(play); play.appendChild(icon(this.master && !this.master.paused ? "pause" : "play", 22)); };
    play.addEventListener("click", () => {
      const m = this.master;
      if (!m) return;
      if (m.paused) all().forEach((x) => x.play().catch(() => {}));
      else all().forEach((x) => x.pause());
      setTimeout(drawPlay, 30);
    });
    scrub.addEventListener("pointerdown", (e) => {
      const r = scrub.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width) * (this.master?.duration || 0);
      all().forEach((x) => { x.currentTime = t; });
    });
    const m = this.master;
    if (m) {
      m.addEventListener("timeupdate", () => {
        clear(time);
        time.append(fmtClock(m.currentTime), h("span", ` / ${fmtClock(m.duration || v0.seconds || 0)}`));
        knob.style.left = `calc(${(m.currentTime / (m.duration || 1)) * 100}% - 12px)`;
        if (this.sync) for (const x of all()) if (x !== m && Math.abs(x.currentTime - m.currentTime) > 0.1) x.currentTime = m.currentTime;
        if (this.loop && dw) {
          const [s, e] = this.edges(v0)[loopK] || [0, m.duration];
          if (m.currentTime >= e || m.currentTime < s - 0.05) all().forEach((x) => { x.currentTime = s; });
        }
      });
      m.addEventListener("play", drawPlay);
      m.addEventListener("pause", drawPlay);
    }
    drawPlay();
    clear(time);
    time.append(fmtClock(0), h("span", ` / ${fmtClock(v0.seconds || 0)}`));
    const toggleBtn = (text, ic, on, fn, title) => {
      const b = button(text, ic, "small s-tbtn", fn, title);
      if (on) b.classList.add("on");
      return b;
    };
    const sound = h("div.sh3-badge.s-snd-src", icon("speaker", 13), this.soundLabel());
    return h("div.s-transport.sh3-panel",
      h("div.s-trow", play, time, scrub),
      h("div.s-trow.s-tbtns",
        toggleBtn("All in sync", "link", this.sync, () => { this.sync = !this.sync; this.renderLeft(); }, "Every seed plays at the same moment"),
        dw && dw.numChunks() > 1 ? toggleBtn(`Loop chunk ${loopK + 1}`, "repeat", this.loop, () => { this.loop = !this.loop; this.renderLeft(); },
          "Loop the chunk picked in the Director") : null,
        vids.length > 1 ? toggleBtn("A/B split", "columns", this.ab, () => { this.ab = !this.ab; this.focus = null; this.renderLeft(); },
          "The winner (or seed 1) against another seed, a divider between them") : null,
        toggleBtn("Full size", "maximize", !!this.focus, () => {
          this.focus = this.focus ? null : (this.solo || this.picked() || vids[0].candidate);
          this.ab = false;
          this.renderLeft();
        }, "One seed, as big as it goes (double-click a seed too)"),
        h("div.sh3-spacer"), sound));
  }

  renderRight() {
    const box = clear(this.right);
    box.appendChild(this.pickByChunk());
    box.appendChild(this.winnerPanel());
    const vids = this.videos;
    const cta = button("Finish the winner", "sparkles", "cta s-cta", () => this.finishWinner(),
      "Upscale, smooth and encode the winner (the seeds come from cache)");
    cta.appendChild(icon("arrowRight", 20));
    if (!vids.length || vids[0]?.partial) cta.classList.add("disabled");
    box.appendChild(cta);
  }

  pickByChunk() {
    const panel = h("div.sh3-panel.s-pbc");
    panel.appendChild(h("div.s-ph", h("div.sh3-h2", "Pick by chunk"), badge("takes", "ac")));
    panel.appendChild(h("div.sh3-muted.s-psub", "Keep a chunk you like, then hunt the next one on top of it."));
    const dw = this.dw();
    if (!dw) {
      panel.appendChild(h("div.sh3-muted", "Connect the Director's takes to this node."));
      return panel;
    }
    const v0 = this.videos[0];
    const hunt = v0?.hunt;
    const n = dw.numChunks();
    const bounds = dw.bounds();
    const list = h("div.s-chunks");
    for (let k = 0; k < n; k++) {
      const [s, e] = bounds[k];
      const t = dw.takesOf(k);
      const own = dw.hasOwnSeed(k);
      const isHunt = hunt === k;
      const waits = hunt != null && k > hunt;
      const head = h("div.s-ch-head", h("span.s-ch-n", String(k + 1)), h("b", `Chunk ${k + 1}`), h("span.sh3-muted", `${s.toFixed(0)} – ${e.toFixed(0)} s`),
        h("div.sh3-spacer"),
        isHunt ? badge(`hunting · ${this.videos.length} of 4`, "ac") : own ? h("span.sh3-badge.ok", icon("lock", 11), "kept")
          : dw.timeline.chunks[k]?.carry === "new_shot" && k > 0 ? h("span.sh3-badge.cut", icon("cut", 11), "new shot") : null);
      const row = h("div.s-ch", { class: [isHunt ? "hunt" : "", waits ? "waits" : "", k === dw.sel ? "sel" : ""].join(" ").trim() || null,
        onclick: () => { dw.select(k); this.renderRight(); } }, head);
      if (isHunt) {
        const thumbs = h("div.s-ch-thumbs");
        for (const v of this.videos) {
          const seed = v.chunk_seeds?.[k];
          const take = t.list.find((x) => Number(x.seed) === Number(seed));
          const pickedNow = Number(dw.seedOf(k)) === Number(seed) && own;
          const th = h("button.s-th", { type: "button", class: pickedNow ? "on" : null, title: `Seed ${seed}: keep it for chunk ${k + 1}`,
            onclick: (ev) => { ev.stopPropagation(); this.pick(v); } },
          take && t.base ? h("img", { src: dw.takeUrl(t.base, take.seed, "thumb.jpg"), draggable: false }) : null,
          h("span", String(seed ?? "")));
          thumbs.appendChild(th);
        }
        for (let i = this.videos.length; i < 4; i++) thumbs.appendChild(h("div.s-th.empty", h("div.sh3-spin")));
        row.appendChild(thumbs);
        row.appendChild(h("div.sh3-progress", h("span", { style: { width: `${(this.videos.length / 4) * 100}%` } })));
      } else if (waits) {
        row.appendChild(h("div.sh3-muted.s-ch-note", `Renders once chunk ${hunt + 1} is picked.`));
      } else if (t.current && t.base) {
        row.appendChild(h("div.s-ch-take", h("img", { src: dw.takeUrl(t.base, t.current.seed, "thumb.jpg"), draggable: false }),
          h("div", h("b", `Seed ${t.current.seed}`), h("div.sh3-muted", own ? "kept" : "the Director's seed"))));
      } else {
        row.appendChild(h("div.sh3-muted.s-ch-note", dw.report ? "Not rendered with these settings yet" : "Not rendered yet"));
      }
      list.appendChild(row);
    }
    panel.appendChild(list);
    const k = dw.sel;
    panel.appendChild(h("div.s-pbtns",
      button(`Hunt chunk ${k + 1} ×4`, "dice", "brand", () => dw.hunt(k, 4), "Four seeds for this chunk, the chunks before it kept"),
      button("Render the rest", "next", "", () => dw.queue({ label: "Rendering the rest" }), "Render the whole video: kept chunks come from their takes")));
    return panel;
  }

  winnerPanel() {
    const panel = h("div.sh3-panel.s-win");
    const vids = this.videos;
    const hunt = vids[0]?.hunt;
    const v = vids.find((x) => this.isPicked(x));
    const sub = hunt != null ? (v ? `seed ${v.chunk_seeds[hunt]} kept` : "pick one to keep")
      : v ? `seed ${v.candidate} of ${vids.length}` : "not picked yet";
    panel.appendChild(h("div.s-ph", h("div.sh3-h2", hunt != null ? `Chunk ${hunt + 1}` : "Winner"), h("span.sh3-muted", sub)));
    if (!v) {
      panel.appendChild(h("div.sh3-muted.s-psub", !vids.length ? "Render first." : hunt != null
        ? "Pick the seed to keep for this chunk, then hunt the next one or render the rest."
        : "Pick a seed on the left. The Finish renders only the winner."));
      return panel;
    }
    const dw = this.dw();
    const thumb = h("video.s-win-thumb", { src: viewUrl(v), muted: true, playsInline: true, preload: "metadata" });
    thumb.addEventListener("loadedmetadata", () => { thumb.currentTime = Math.min(1, (thumb.duration || 2) / 3); });
    const setup = dw?.setupNode(), models = dw?.modelsNode();
    const mode = widgetValue(setup, "mode", "");
    const desc = [mode, dw && setup && models ? dw.turboLabel(setup, models) : null, v.width && v.height ? `${v.width}×${v.height}` : null].filter(Boolean).join(" · ");
    const flags = v.flags || [];
    panel.appendChild(h("div.s-win-row", thumb, h("div",
      h("div.sh3-h3", `Seed ${this.seedOf(v) ?? v.candidate}`), h("div.sh3-muted", desc),
      h("div.s-win-badges", flags.length ? badge(flags.map((f) => f.text).join(" · "), "cut") : badge("no flags", "ok"),
        badge(`${(v.chunk_seeds || []).length || 1} chunk${(v.chunk_seeds || []).length === 1 ? "" : "s"}`)))));
    const stat = (value, name) => h("div.s-stat", h("b", value), h("span", name));
    panel.appendChild(h("div.s-stats", stat(`${(v.seconds || 0).toFixed(1)} s`, "length"), stat(String(v.frames || "–"), "frames"),
      stat("24", "fps"), stat(v.render_seconds ? fmtDuration(v.render_seconds) : "–", "render")));
    return panel;
  }

  renderFoot() {
    const f = clear(this.foot);
    const usage = this.dw()?.usage;
    f.append(h("span.sh3-fi", icon("database", 14), "Takes kept ", h("b", usage ? fmtBytes(usage.bytes) : "–")),
      h("span.sh3-fi", icon("eye", 14), "Flags are hints, ", h("b", "your eye decides")),
      h("div.sh3-spacer"),
      h("button.sh3-link.sh3-fi", { type: "button", onclick: () => goToStep(4) }, icon("arrowRight", 14), "Next: upscale and export in ", h("b", "Output")));
  }

  markSteps() {
    const done = new Set();
    const dw = this.dw();
    if (dw) {
      if (dw.setupNode() && dw.modelsNode()) done.add(1);
      if (dw.report && (dw.report.chunks || []).length === dw.report.chunks_total) done.add(2);
    }
    if (this.winner() >= 1) done.add(3);
    if (this.finish()?.properties?.sh3_final) done.add(4);
    markSteps(this.steps, done);
  }

  listen() {
    const on = (type, fn, target = api) => {
      target.addEventListener(type, fn);
      (this._off ||= []).push(() => target.removeEventListener(type, fn));
    };
    on("stubelius_ultimate_h3.takes", () => setTimeout(() => this.renderRight(), 50));
    on("stubelius-winner", () => this.render(), window);
    on("stubelius-takes", () => { this.renderRight(); this.renderFoot(); this.markSteps(); }, window);
  }

  dispose() {
    for (const off of this._off || []) off();
  }
}

function fmtDuration(s) {
  s = Math.round(Number(s) || 0);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

let styled = false;
function injectSeedStyles() {
  if (styled) return;
  styled = true;
  document.head.appendChild(h("style", { id: "stubelius-uh3-seeds", text: `
.sh3-s .s-main{display:grid;grid-template-columns:minmax(0,1fr) 544px;gap:20px;align-items:start}
.sh3-s.narrow .s-main{grid-template-columns:minmax(0,1fr)}
.sh3-s .s-left{display:flex;flex-direction:column;gap:20px;min-width:0}
.sh3-s .s-right{display:flex;flex-direction:column;gap:20px;min-width:0}
.sh3-s .s-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.sh3-s .s-grid.one{grid-template-columns:1fr}
.sh3-s .s-tile{border-radius:24px;overflow:hidden;border:1px solid var(--stroke2);background:linear-gradient(180deg,var(--glass2),var(--glass));
  box-shadow:var(--panel-shadow)}
.sh3-s .s-tile.win{border:2px solid rgb(var(--ac));box-shadow:0 0 0 5px rgba(var(--ac),.16),0 20px 60px rgba(var(--ac),.25)}
.sh3-s .s-vwrap{position:relative;aspect-ratio:16/9;background:var(--video)}
.sh3-s .s-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.sh3-s .s-grid.one .s-video{object-fit:contain}
.sh3-s .s-tchips{position:absolute;left:16px;top:16px;display:flex;gap:8px}
.sh3-s .s-tchips-r{position:absolute;right:16px;top:16px}
.sh3-s .s-flag.warn{border-color:rgba(var(--cut),.65);color:#fff}
.sh3-s .s-flag.warn .sh3-ic{color:rgb(var(--cut))}
.sh3-s .s-flag .sh3-ic{color:rgb(var(--ok))}
.sh3-s .s-tscrub{position:absolute;left:18px;right:18px;bottom:14px;height:8px}
.sh3-s .s-tscrub span{position:absolute;top:2px;height:4px;border-radius:3px;background:rgba(255,255,255,.35)}
.sh3-s .s-tile.win .s-tscrub span{background:var(--brand)}
.sh3-s .s-tick{position:absolute;top:-5px;width:2px;height:18px;background:#fff;border-radius:2px;box-shadow:0 0 8px rgba(0,0,0,.6)}
.sh3-s .s-tfoot{display:flex;align-items:center;gap:10px;padding:12px 16px}
.sh3-s .s-tfoot b{font-family:var(--fh);font-size:18px;font-weight:600}
.sh3-s .s-solo.on{border-color:rgba(var(--snd),.7);color:rgb(var(--snd))}
.sh3-s .s-picked{background:var(--brand);color:var(--on);border:0}
.sh3-s .s-ab{position:relative;aspect-ratio:16/9;border-radius:24px;border:1px solid var(--stroke2)}
.sh3-s .s-transport{padding:16px 20px;display:flex;flex-direction:column;gap:12px}
.sh3-s .s-trow{display:flex;align-items:center;gap:14px}
.sh3-s .s-play{width:52px;height:52px;border-radius:50%;background:var(--brand);color:var(--on);display:grid;place-items:center;border:0;flex:none;
  box-shadow:0 10px 30px rgba(var(--ac),.4);padding:0}
.sh3-s .s-time{color:var(--text)}
.sh3-s .s-scrub{flex:1;height:34px;position:relative;cursor:pointer}
.sh3-s .s-scrub span{position:absolute;top:12px;height:10px;border-radius:6px;background:var(--glass3)}
.sh3-s .s-scrub span.loop{background:var(--brand);box-shadow:0 0 0 2px rgba(var(--snd),.8)}
.sh3-s .s-knob{position:absolute;top:5px;width:24px;height:24px;border-radius:50%;background:#fff;pointer-events:none;
  box-shadow:0 0 0 5px rgba(var(--ac),.35),0 0 24px rgba(var(--ac),.8)}
.sh3-s .s-tbtns{gap:8px;flex-wrap:wrap}
.sh3-s .s-tbtn.on{border-color:rgba(var(--ac),.6);background:linear-gradient(100deg,rgba(var(--ac),.2),rgba(var(--ac2),.1))}
.sh3-s .s-pbc,.sh3-s .s-win{padding:20px 22px;display:flex;flex-direction:column;gap:12px}
.sh3-s .s-ph{display:flex;align-items:center;justify-content:space-between}
.sh3-s .s-psub{margin-top:-6px}
.sh3-s .s-chunks{display:flex;flex-direction:column;gap:10px}
.sh3-s .s-ch{border-radius:16px;background:var(--glass);border:1px solid var(--stroke);padding:12px 14px;display:flex;flex-direction:column;gap:10px;cursor:pointer}
.sh3-s .s-ch:hover{border-color:var(--stroke2)}
.sh3-s .s-ch.sel{border-color:rgba(var(--ac),.35)}
.sh3-s .s-ch.hunt{border-color:rgba(var(--ac),.6);background:linear-gradient(170deg,rgba(var(--ac),.10),var(--glass))}
.sh3-s .s-ch.waits{opacity:.6}
.sh3-s .s-ch-head{display:flex;align-items:center;gap:10px}
.sh3-s .s-ch-n{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:var(--glass3);font-family:var(--fh);font-weight:600;font-size:13px}
.sh3-s .s-ch.hunt .s-ch-n{background:var(--brand);color:var(--on)}
.sh3-s .s-ch-thumbs{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.sh3-s .s-th{position:relative;height:70px;border-radius:11px;overflow:hidden;border:1px solid var(--stroke2);background:#000;padding:0}
.sh3-s .s-th img{width:100%;height:100%;object-fit:cover;display:block}
.sh3-s .s-th span{position:absolute;left:6px;bottom:5px;font-size:11px;font-weight:600;padding:2px 6px;border-radius:6px;background:rgba(8,6,12,.6);color:#fff}
.sh3-s .s-th.on{border:2px solid rgb(var(--ac));box-shadow:0 0 18px rgba(var(--ac),.4)}
.sh3-s .s-th.empty{display:grid;place-items:center;background:var(--glass);border-style:dashed}
.sh3-s .s-ch-take{display:flex;align-items:center;gap:14px}
.sh3-s .s-ch-take img{width:124px;height:70px;border-radius:11px;object-fit:cover;border:1.5px solid rgba(var(--ok),.6)}
.sh3-s .s-ch-note{font-size:12.5px}
.sh3-s .s-pbtns{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.sh3-s .s-pbtns .sh3-btn{height:46px}
.sh3-s .s-win-row{display:flex;gap:16px;align-items:center}
.sh3-s .s-win-thumb{width:168px;height:94px;border-radius:14px;object-fit:cover;border:2px solid rgb(var(--ac));background:#000;flex:none}
.sh3-s .s-win-badges{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.sh3-s .s-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.sh3-s .s-stat{border-radius:14px;background:var(--glass);border:1px solid var(--stroke);padding:10px;text-align:center;display:flex;flex-direction:column;gap:2px}
.sh3-s .s-stat b{font-family:var(--fh);font-size:19px;font-weight:600}
.sh3-s .s-stat span{color:var(--text3);font-size:11.5px}
.sh3-s .s-cta{height:72px;font-size:21px;width:100%;border-radius:20px}
.sh3-s .s-cta.disabled{opacity:.5}
.sh3-s .s-empty{padding:60px 40px;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center}
.sh3-s .s-empty-ic{width:76px;height:76px;border-radius:22px;display:grid;place-items:center;background:var(--glass3);color:var(--text2)}
.sh3-s .s-empty .sh3-muted{max-width:520px}
` }));
}

app.registerExtension({
  name: "Stubelius.UltimateH3.SeedsWindow",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "StubeliusSeedPreviews") return;
    windowOrCompact(nodeType, { name: "sh3_seeds", create: (node) => new SeedsWindow(node), minHeight: 700 });
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      setTimeout(() => { this._sh3?.render(); refreshThemes(); }, 0);
      return r;
    };
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (output) {
      const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      if (output?.stubelius_seeds) {
        this.properties = this.properties || {};
        this.properties.sh3_seeds = output.stubelius_seeds;
        this._sh3?.setVideos(output.stubelius_seeds);
      }
      return r;
    };
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._sh3?.dispose();
      return onRemoved?.apply(this, arguments);
    };
  },
});
