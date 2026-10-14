// Stubelius Ultimate H3 Director: the Director window (step 2 of 4).
//
// One timeline the video is made from, in the pack's look: a header with the step bar and the input
// mode, a command bar (shape, length, chunk size, the Setup mode, turbo and output, Render), a big
// preview of the takes, an inspector for the chunk you picked (how it joins the one before it, its
// shots, style, sound, music, LoRAs and takes), a timeline across the whole video (keyframes, shots,
// sounds, chunks) and, in Reference mode, the cast and reference clips.
//
// Everything the video is lives in timeline_data (the one hidden widget) plus the node's own mode,
// aspect, duration, chunk size and seed widgets; the Python side compiles it (muse_minimax_director.py)
// and keeps each chunk as a take (stubelius_takes.py). The window only edits that data.
import {
  h, icon, clear, seg, button, iconButton, badge, label, menu, closeMenus, toast, windowFrame, markSteps, goToStep,
  injectStyles, widget, widgetValue, setWidget, sourceOf, targetsOf, nodesOfType, hideWidget, mountWindow,
  autoHeight, fmtSeconds, fmtBytes, refreshThemes,
} from "./stubelius_ui.js";
import { normalizeMiddleFrames } from "./stubelius_middle_frames.js";
import { normalizeCues } from "./stubelius_cues.js";
import { buildPreview } from "./stubelius_director_preview.js";
import { buildInspector } from "./stubelius_director_inspector.js";
import { buildTimeline } from "./stubelius_director_timeline.js";
import { buildRefs } from "./stubelius_director_refs.js";
import { openSettings, openFileMenu } from "./stubelius_director_settings.js";
import {
  MAX_CHARACTER_SLOTS, REF_AV_SLOTS, MIN_CUT_SECONDS, MODE_REFERENCE_PREFIX, CARRY, CARRY_IDS, newSeed,
} from "./stubelius_director_shared.js";

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

export const VERSION = "0.13";
export { MAX_CHARACTER_SLOTS, REF_AV_SLOTS, MIN_CUT_SECONDS, MODE_REFERENCE_PREFIX, CARRY, CARRY_IDS, newSeed };
const OWN_WIDGETS = ["mode", "aspect_ratio", "duration_seconds", "chunk_duration_seconds", "seed",
  "control_after_generate", "timeline_data"];
const MODES = [   // display order; the Setup node's mode values
  ["PDMD", "fastest"], ["Speed", "drafts"], ["Hybrid", "fluid"], ["Quality", "finals"],
];
const SIZE_LABEL = { "native (no upscale)": "Native", "720p": "720p", "1080p": "1080p", "2K (1440p)": "2K", "4K (2160p)": "4K" };

function newTakesId() {
  const r = crypto?.randomUUID?.() || `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return "d" + r.replace(/-/g, "").slice(0, 15);
}

export class DirectorWindow {
  constructor(node) {
    this.node = node;
    this.tw = widget(node, "timeline_data");
    this.w = {};
    for (const name of OWN_WIDGETS) this.w[name] = widget(node, name);
    this.timeline = this.loadState();
    if (this.freshId) this.commit();
    this.sel = Math.max(0, Math.min(this.numChunks() - 1, Number(node.properties?.sh3_sel) || 0));
    this.selShot = null;            // shot index highlighted in the selected chunk
    this.report = null;             // the last takes report of this node (stubelius_takes.py)
    this.edited = new Set();        // chunks edited since that report
    this.run = { state: "idle" };   // idle | queued | running | done | error
    this.live = null;               // live sampling frames while the Director runs
    this.stats = null;              // /system_stats
    this.usage = null;              // takes on disk
    this.fold = node.properties?.sh3_fold || {};

    injectStyles();
    injectDirectorStyles();
    const f = windowFrame({
      title: "Ultimate H3 Director", subtitle: `Stubelius · MiniMax H3 · v${VERSION}`, step: 2,
      onStep: (n) => goToStep(n),
    });
    Object.assign(this, f);
    this.root.classList.add("sh3-d");

    this.modeSwitch = h("div.d-hdr-mode");
    this.status = h("div.sh3-status", h("span.sh3-dot"), h("span", "Ready"));
    this.head.append(this.modeSwitch, h("div.sh3-spacer"), this.status,
      iconButton("folder", "Timeline file: save, load", (e) => openFileMenu(this, e.currentTarget)),
      iconButton("settings", "Settings", (e) => openSettings(this, e.currentTarget)));

    this.cmd = h("div.d-cmd");
    this.preview = buildPreview(this);
    this.insp = h("div.d-insp.sh3-panel");
    this.main = h("div.d-main", this.preview.el, this.insp);
    this.tl = h("div.d-tl.sh3-panel");
    this.refs = h("div.d-refs");
    this.body.append(this.cmd, this.main, this.tl, this.refs);

    this.refresh();
    this.listen();
    this.fetchReport();
    this.fetchStats();
  }

  // ----------------------------------------------------------------------------------- state

  loadState() {
    let parsed = {};
    try {
      parsed = JSON.parse(this.tw?.value || "{}");
    } catch (e) {
      parsed = {};
    }
    // An older workflow whose widget values slid out of place can hold a number here
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("[Stubelius Director] timeline_data wasn't a timeline (the workflow's widget values may be "
        + "out of place): starting from a blank timeline");
      parsed = {};
    }
    if (!Array.isArray(parsed.characters)) parsed.characters = [];
    if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
      const old = Array.isArray(parsed.segments) && parsed.segments.length ? parsed.segments : [{ prompt: "", weight: 1 }];
      parsed.chunks = [{ segments: old }];
    }
    for (const key of ["segments", "prompt_gen_enabled", "prompt_gen_brief", "prompt_gen_draft_text", "prompt_gen_committed_text"]) {
      delete parsed[key];
    }
    for (const key of ["style_line", "overall_soundscape", "non_diegetic_music"]) {
      if (typeof parsed[key] === "string" && parsed[key] && !parsed.chunks[0][key]) parsed.chunks[0][key] = parsed[key];
      delete parsed[key];
    }
    parsed.chunks.forEach((c) => this.tidyChunk(c));
    if (typeof parsed.background !== "object" || parsed.background === null) parsed.background = {};
    for (const key of ["refVideos", "refAudios"]) {
      if (!Array.isArray(parsed[key])) parsed[key] = [];
      while (parsed[key].length < REF_AV_SLOTS) parsed[key].push(null);
    }
    if (typeof parsed.dialogue_language !== "string" || !parsed.dialogue_language) parsed.dialogue_language = "English";
    if (typeof parsed.prompt_gen_provider !== "string") parsed.prompt_gen_provider = "ollama";
    if (typeof parsed.prompt_gen_base_url !== "string") parsed.prompt_gen_base_url = "";
    if (typeof parsed.prompt_gen_model !== "string") parsed.prompt_gen_model = "";
    if (!Array.isArray(parsed.middle_frames)) parsed.middle_frames = [];
    if (!Array.isArray(parsed.cues)) parsed.cues = [];
    if (parsed.source_clip && (typeof parsed.source_clip !== "object" || !parsed.source_clip.file)) delete parsed.source_clip;
    // a render-until or a hunt is asked for one queue at a time (see queue()); never left on
    delete parsed.render_until;
    delete parsed.hunt_chunk;
    // takes are kept for every Director the window shows (stubelius_takes.py)
    this.freshId = false;
    if (!parsed.takes_id || !/^[A-Za-z0-9_-]{1,64}$/.test(String(parsed.takes_id))) {
      parsed.takes_id = newTakesId();
      this.freshId = true;
    }
    return parsed;
  }

  tidyChunk(c) {
    if (!Array.isArray(c.segments) || !c.segments.length) c.segments = [{ prompt: "", weight: 1 }];
    c.segments.forEach((s) => { if (!s.weight) s.weight = 1; if (typeof s.prompt !== "string") s.prompt = ""; });
    if (typeof c.prompt_gen_enabled !== "boolean") c.prompt_gen_enabled = false;
    for (const key of ["prompt_gen_brief", "prompt_gen_draft_text", "prompt_gen_committed_text", "style_line",
      "overall_soundscape", "non_diegetic_music"]) {
      if (typeof c[key] !== "string") c[key] = "";
    }
    if (!Array.isArray(c.loras)) c.loras = [];
    if (!CARRY_IDS.has(c.carry)) c.carry = "picture_sound";
    return c;
  }

  blankChunk() {
    return this.tidyChunk({ segments: [{ prompt: "", weight: 1 }] });
  }

  commit() {
    if (this.tw) this.tw.value = JSON.stringify(this.timeline);
    this.node.setDirtyCanvas?.(true, true);
  }

  // a chunk the user changed since the takes report (its takes there are from before the change)
  touched(k) {
    this.edited.add(k);
    this.commit();
  }

  saveUi() {
    this.node.properties = this.node.properties || {};
    this.node.properties.sh3_sel = this.sel;
    this.node.properties.sh3_fold = this.fold;
  }

  select(k) {
    const n = this.numChunks();
    k = Math.max(0, Math.min(n - 1, k));
    if (k !== this.sel) this.selShot = null;
    this.sel = k;
    this.saveUi();
    this.refresh(["cmd", "preview", "insp", "tl"]);
  }

  // ----------------------------------------------------------------------------------- widgets and math

  get isReference() {
    return String(this.w.mode?.value || "").startsWith(MODE_REFERENCE_PREFIX);
  }

  setInputMode(reference) {
    const values = this.w.mode?.options?.values || [];
    const v = values.find((x) => String(x).startsWith(MODE_REFERENCE_PREFIX) === reference);
    if (!v || v === this.w.mode.value) return;
    this.w.mode.value = v;
    this.w.mode.callback?.(v);
    this.commit();
    this.refresh();
  }

  get durationSeconds() {
    return Number(this.w.duration_seconds?.value) || 10;
  }

  get chunkSizeSeconds() {
    return Math.min(15, Number(this.w.chunk_duration_seconds?.value) || 10);
  }

  numChunks() {
    return this.bounds().length;
  }

  // The chunks as the Python side cuts them (_bucket_segments_into_chunks): uniform slices of the
  // length, the last one taking the rest, a last piece under 4 s folded into the one before it.
  bounds() {
    const duration = this.durationSeconds;
    const size = this.chunkSizeSeconds;
    const n = Math.max(1, Math.ceil(duration / size));
    const out = [];
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const end = i === n - 1 ? duration : Math.min(duration, cursor + size);
      out.push([cursor, end]);
      cursor = end;
    }
    while (out.length > 1 && out[out.length - 1][1] - out[out.length - 1][0] < 4.0) {
      out[out.length - 2][1] = out[out.length - 1][1];
      out.pop();
    }
    return out;
  }

  chunkOf(t) {
    const b = this.bounds();
    const i = b.findIndex(([s, e]) => t >= s && t < e);
    return i < 0 ? b.length - 1 : i;
  }

  // Only grows timeline.chunks to the chunk count (never asks, never removes)
  syncChunkCount() {
    const n = this.numChunks();
    while (this.timeline.chunks.length < n) this.timeline.chunks.push(this.blankChunk());
    if (this.sel >= n) this.sel = n - 1;
  }

  // After the length or chunk size changed: drop the chunks past the end, asking first when they hold text
  applyLengthChange(revert) {
    const n = this.numChunks();
    if (this.timeline.chunks.length > n) {
      const dropping = this.timeline.chunks.slice(n);
      const hasText = dropping.some((c) => c.segments.some((s) => (s.prompt || "").trim()));
      if (hasText && !confirm(`The new length drops ${dropping.length} chunk(s) at the end that still have shots in them. Continue?`)) {
        revert?.();
        this.commit();
        this.refresh();
        return;
      }
      this.timeline.chunks.length = n;
    }
    this.syncChunkCount();
    this.middleFrames();
    this.cues();
    this.commit();
    this.refresh();
  }

  setWidgetValue(name, value) {
    const w = this.w[name];
    if (!w) return;
    w.value = value;
    w.callback?.(value);
    this.node.setDirtyCanvas?.(true, true);
  }

  setLength(seconds) {
    const before = this.w.duration_seconds?.value;
    const opts = this.w.duration_seconds?.options || {};
    const v = Math.max(opts.min ?? 1, Math.min(opts.max ?? 120, Math.round(seconds * 2) / 2));
    this.setWidgetValue("duration_seconds", v);
    this.applyLengthChange(() => this.setWidgetValue("duration_seconds", before));
  }

  setChunkSize(seconds) {
    const before = this.w.chunk_duration_seconds?.value;
    const opts = this.w.chunk_duration_seconds?.options || {};
    const v = Math.max(opts.min ?? 3, Math.min(opts.max ?? 15, Math.round(seconds * 2) / 2));
    this.setWidgetValue("chunk_duration_seconds", v);
    this.applyLengthChange(() => this.setWidgetValue("chunk_duration_seconds", before));
  }

  // One more chunk at the end: the length grows by one chunk size
  addChunk() {
    this.setWidgetValue("duration_seconds", Math.round((this.durationSeconds + this.chunkSizeSeconds) * 10) / 10);
    this.syncChunkCount();
    this.sel = this.numChunks() - 1;
    this.saveUi();
    this.commit();
    this.refresh();
  }

  // This chunk out (its content; the chunks after it move up) and the length shrinks by one chunk size
  deleteChunk(k) {
    if (this.timeline.chunks.length <= 1) {
      toast(this.root, "A video keeps at least one chunk: clear its shots instead.");
      return;
    }
    const chunk = this.timeline.chunks[k];
    if (chunk?.segments.some((s) => (s.prompt || "").trim()) && !confirm(`Chunk ${k + 1} has shots in it. Delete it anyway?`)) return;
    this.timeline.chunks.splice(k, 1);
    this.setWidgetValue("duration_seconds",
      Math.max(this.chunkSizeSeconds, Math.round((this.durationSeconds - this.chunkSizeSeconds) * 10) / 10));
    this.syncChunkCount();
    this.sel = Math.min(this.sel, this.numChunks() - 1);
    this.saveUi();
    this.commit();
    this.refresh();
  }

  // Middle frames in time order inside the length; always the same array, tidied in place
  middleFrames() {
    if (!Array.isArray(this.timeline.middle_frames)) this.timeline.middle_frames = [];
    const list = this.timeline.middle_frames;
    const kept = normalizeMiddleFrames(list, this.durationSeconds);
    list.length = 0;
    list.push(...kept);
    return list;
  }

  cues() {
    if (!Array.isArray(this.timeline.cues)) this.timeline.cues = [];
    const list = this.timeline.cues;
    const kept = normalizeCues(list, this.durationSeconds);
    list.length = 0;
    list.push(...kept);
    return list;
  }

  formatTime(seconds) {
    return this.timeline.display_mode === "frames" ? `${Math.round(seconds * 24)}f` : `${seconds.toFixed(1)} s`;
  }

  // ----------------------------------------------------------------------------------- the other windows

  setupNode() {
    const s = sourceOf(this.node, "setup");
    return s?.comfyClass === "StubeliusH3Setup" ? s : nodesOfType("StubeliusH3Setup")[0] || null;
  }

  modelsNode() {
    const m = sourceOf(this.node, "models");
    return m?.comfyClass === "StubeliusH3Models" ? m : nodesOfType("StubeliusH3Models")[0] || null;
  }

  finishNode() {
    return targetsOf(this.node, "takes").find((n) => n.comfyClass === "StubeliusH3Finish")
      || nodesOfType("StubeliusH3Finish")[0] || null;
  }

  seedsNode() {
    return targetsOf(this.node, "takes").find((n) => n.comfyClass === "StubeliusSeedPreviews")
      || nodesOfType("StubeliusSeedPreviews")[0] || null;
  }

  outputNode() {
    const f = this.finishNode();
    const o = f && sourceOf(f, "output");
    return o?.comfyClass === "StubeliusH3Output" ? o : nodesOfType("StubeliusH3Output")[0] || null;
  }

  // ----------------------------------------------------------------------------------- takes

  // The seed chunk k renders with now (its own, or the Director's)
  seedOf(k) {
    const own = this.timeline.chunks[k]?.seed;
    if (own !== undefined && own !== null && own !== "") return Number(own);
    return Number(this.w.seed?.value) || 0;
  }

  hasOwnSeed(k) {
    const own = this.timeline.chunks[k]?.seed;
    return own !== undefined && own !== null && own !== "";
  }

  reportChunk(k) {
    return this.report?.chunks?.find((c) => c.chunk === k) || null;
  }

  // The takes of chunk k (the main video's), oldest first; `current` = the one with its seed now
  takesOf(k) {
    const rc = this.reportChunk(k);
    const list = rc?.takes || [];
    const seed = this.seedOf(k);
    return { list, base: rc?.base || null, current: list.find((t) => Number(t.seed) === seed) || null, stale: this.edited.has(k) };
  }

  takeUrl(base, seed, name) {
    return api.apiURL(`/stubelius_ultimate_h3/takes/file?base=${base}&seed=${seed}&name=${name}`);
  }

  async fetchReport() {
    try {
      const r = await api.fetchApi(`/stubelius_ultimate_h3/takes/report?id=${encodeURIComponent(this.timeline.takes_id)}`);
      const data = r.ok ? await r.json() : null;
      if (data && data.chunks) this.onReport(data, false);
    } catch (e) {
      // the takes routes come with the pack; an older install answers 404
    }
  }

  async fetchUsage() {
    try {
      const r = await api.fetchApi("/stubelius_ultimate_h3/takes/usage");
      this.usage = r.ok ? await r.json() : null;
    } catch (e) {
      this.usage = null;
    }
    this.renderFoot();
    window.dispatchEvent(new CustomEvent("stubelius-takes", { detail: { node: this.node.id } }));
  }

  async fetchStats() {
    try {
      const r = await api.fetchApi("/system_stats");
      this.stats = r.ok ? await r.json() : null;
    } catch (e) {
      this.stats = null;
    }
    this.renderFoot();
  }

  onReport(report, fresh = true) {
    this.report = report;
    if (fresh) this.edited.clear();
    this.refresh(["preview", "insp", "tl", "status"]);
    this.fetchUsage();
    window.dispatchEvent(new CustomEvent("stubelius-takes", { detail: { node: this.node.id } }));   // the other windows
  }

  // Keep the chunks before k as they are (their seeds written down), so a retake or a hunt of chunk k
  // can only change k and what comes after it.
  keepBefore(k) {
    for (let j = 0; j < k; j++) {
      if (!this.hasOwnSeed(j)) this.timeline.chunks[j].seed = this.seedOf(j);
    }
  }

  pickTake(k, seed) {
    this.timeline.chunks[k].seed = Number(seed);
    this.keepBefore(k);
    this.commit();
    this.refresh(["preview", "insp", "tl"]);
  }

  clearOwnSeed(k) {
    delete this.timeline.chunks[k].seed;
    this.commit();
    this.refresh(["preview", "insp", "tl"]);
  }

  retake(k) {
    this.keepBefore(k);
    this.timeline.chunks[k].seed = newSeed();
    this.commit();
    this.queue({ until: k, label: `Retake of chunk ${k + 1}` });
  }

  hunt(k, count = 4) {
    this.keepBefore(k);
    if (!this.hasOwnSeed(k)) this.timeline.chunks[k].seed = this.seedOf(k);
    this.commit();
    this.queue({ until: k, hunt: { chunk: k, count }, label: `Hunting chunk ${k + 1} ×${count}` });
  }

  async deleteTake(base, seed) {
    try {
      await api.fetchApi("/stubelius_ultimate_h3/takes/delete", { method: "POST", body: JSON.stringify({ base, seed }) });
    } catch (e) {
      return;
    }
    if (this.report) {
      for (const c of this.report.chunks || []) {
        if (c.base === base) c.takes = (c.takes || []).filter((t) => Number(t.seed) !== Number(seed));
      }
    }
    this.refresh(["insp", "preview"]);
    this.fetchUsage();
  }

  async clearTakes() {
    if (!confirm("Remove every kept take? The next render starts from scratch.")) return;
    try {
      await api.fetchApi("/stubelius_ultimate_h3/takes/clear", { method: "POST", body: "{}" });
    } catch (e) {
      return;
    }
    this.report = null;
    this.refresh(["preview", "insp", "tl"]);
    this.fetchUsage();
  }

  // ----------------------------------------------------------------------------------- render

  // Queue the workflow. `until` (a chunk index) and `hunt` go into this one prompt only.
  async queue({ until = null, hunt = null, label = null } = {}) {
    if (until !== null && until >= this.numChunks() - 1 && !hunt) until = null;
    if (until !== null) this.timeline.render_until = until;
    if (hunt) this.timeline.hunt_chunk = hunt;
    this.commit();
    this.run = { state: "queued", label: label || (until !== null ? `Rendering to chunk ${until + 1}` : "Rendering") };
    this.renderStatus();
    try {
      await app.queuePrompt(0, 1);
    } catch (e) {
      this.run = { state: "error", label: "Couldn't queue: " + (e?.message || e) };
    } finally {
      delete this.timeline.render_until;
      delete this.timeline.hunt_chunk;
      this.commit();
      this.renderStatus();
    }
  }

  interrupt() {
    api.interrupt?.();
  }

  // ----------------------------------------------------------------------------------- drawing

  refresh(parts = null) {
    const all = !parts;
    const has = (p) => all || parts.includes(p);
    this.syncChunkCount();
    if (has("head")) this.renderHead();
    if (has("cmd")) this.renderCmd();
    if (has("preview")) this.preview.render();
    if (has("insp")) buildInspector(this);
    if (has("tl")) buildTimeline(this);
    if (has("refs")) buildRefs(this);
    if (has("foot")) this.renderFoot();
    if (has("status") || all) this.renderStatus();
    this.markSteps();
  }

  renderHead() {
    clear(this.modeSwitch);
    this.modeSwitch.appendChild(seg([
      ["fl", "First / Last frame", "frame", "Pictures (and a clip to continue) open and end the video, middle frames on the way"],
      ["ref", "Reference", "users", "Characters, a place, reference clips and voices: the model builds the scene from them"],
    ], this.isReference ? "ref" : "fl", (v) => this.setInputMode(v === "ref")));
  }

  renderCmd() {
    const c = clear(this.cmd);
    // shape, length, chunk size, seed
    const aspect = this.w.aspect_ratio;
    const aspectSel = h("select.d-val-select", {
      title: "Picture shape", onchange: () => { this.setWidgetValue("aspect_ratio", aspectSel.value); this.commit(); },
    });
    for (const v of aspect?.options?.values || []) aspectSel.appendChild(h("option", { value: v, text: String(v).split(" ")[0], selected: v === aspect.value }));
    const numField = (value, title, onSet) => {
      const input = h("input.d-val", { type: "text", inputMode: "decimal", value: Number(value).toFixed(1), title });
      input.addEventListener("change", () => {
        const v = parseFloat(String(input.value).replace(",", "."));
        if (Number.isFinite(v)) onSet(v);
        else input.value = Number(value).toFixed(1);
      });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      return input;
    };
    const seedInput = h("input.d-val.d-seed", { type: "text", inputMode: "numeric", value: String(this.w.seed?.value ?? 0),
      title: "The Director's seed: every chunk without a seed of its own renders with it" });
    seedInput.addEventListener("change", () => {
      const digits = seedInput.value.replace(/[^0-9]/g, "") || "0";
      seedInput.value = digits;
      this.setWidgetValue("seed", Number(digits));
      this.refresh(["insp", "tl", "preview"]);
    });
    const ctrl = this.w.control_after_generate;
    const fixed = !ctrl || ctrl.value === "fixed";
    const lockBtn = iconButton(fixed ? "lock" : "dice", fixed
      ? "Seed stays the same after each render (takes are found again). Click: a new seed every render"
      : "A new seed after each render. Click: keep this seed", () => {
      if (!ctrl) return;
      ctrl.value = fixed ? "randomize" : "fixed";
      this.renderCmd();
    });
    lockBtn.classList.add("d-seed-lock");
    if (!fixed) lockBtn.classList.add("on");
    const fields = h("div.sh3-grp.d-fields",
      h("div.d-field", label("Aspect"), aspectSel), h("div.d-vsep"),
      h("div.d-field", label("Length"), h("div.d-valrow", numField(this.durationSeconds, "Length of the video in seconds",
        (v) => this.setLength(v)), h("span.d-unit", "s"))), h("div.d-vsep"),
      h("div.d-field", label("Chunk"), h("div.d-valrow", numField(this.chunkSizeSeconds, "Length of one H3 call (3-15 s)",
        (v) => this.setChunkSize(v)), h("span.d-unit", "s"))), h("div.d-vsep"),
      h("div.d-field", label("Seed"), h("div.d-valrow", seedInput, lockBtn,
        iconButton("dice", "A new seed", () => { this.setWidgetValue("seed", newSeed()); this.renderCmd(); this.refresh(["insp", "tl", "preview"]); }))));
    c.appendChild(fields);

    // the Setup node's mode
    const setup = this.setupNode();
    if (setup) {
      const presets = setup.constructor?.nodeData?.input?.required?.mode?.[1]?.presets || {};
      const mode = widgetValue(setup, "mode");
      const cards = h("div.d-modes");
      for (const [name, tag] of MODES) {
        const steps = name === mode ? widgetValue(setup, "steps") : presets[name]?.steps;
        cards.appendChild(h("button.d-mode", {
          type: "button", class: name === mode ? "on" : null, title: `${name} mode (Setup): click to switch`,
          onclick: () => { setWidget(setup, "mode", name); this.renderCmd(); },
        }, h("b", name), h("i", `${steps ?? "?"} steps · ${tag}`)));
      }
      c.appendChild(h("div.sh3-grp", cards));
    }

    // turbo and output
    const chips = h("div.sh3-grp.d-chips");
    const models = this.modelsNode();
    if (models) {
      chips.appendChild(h("button.sh3-chip", { type: "button", title: "Turbo LoRA (Setup)", onclick: () => goToStep(1) },
        h("div.sh3-ico.ac", icon("sparkles", 16)), h("div", label("Turbo"), h("div.d-chipval", this.turboLabel(setup, models)))));
    }
    const output = this.outputNode();
    if (output) {
      chips.appendChild(h("button.sh3-chip", { type: "button", title: "Final size, frame rate, upscaler (Output)", onclick: () => goToStep(4) },
        h("div.sh3-ico.snd", icon("aspect", 16)), h("div", label("Output"), h("div.d-chipval", this.outputLabel(output)))));
    }
    if (chips.childNodes.length) c.appendChild(chips);

    // render
    const n = this.numChunks();
    const running = this.run.state === "running" || this.run.state === "queued";
    const r = h("div.d-render");
    if (n > 1 && this.sel < n - 1 && !running) {
      r.appendChild(button(`Render to chunk ${this.sel + 1}`, "next", "ghost", () => this.queue({ until: this.sel }),
        "Render the video up to this chunk only (the chunks before it come from their takes)"));
    }
    r.appendChild(running
      ? button("Stop", "x", "ghost", () => this.interrupt(), "Stop the render (the chunks it finished are kept)")
      : button("Render", "play", "cta", () => this.queue(), "Render the whole video"));
    c.appendChild(r);
  }

  turboLabel(setup, models) {
    const mode = widgetValue(setup, "mode");
    if (mode === "PDMD") return "PDMD 4-step";
    const strength = Number(widgetValue(setup, "speedup_lora_strength", 1));
    if (!strength) return "off";
    const name = String(widgetValue(models, "speedup_lora", "") || "");
    if (!name || name === "none") return "none";
    if (/motion.?enhancer/i.test(name)) return "Motion Enhancer";
    if (/lightx2v/i.test(name)) return "LightX2V";
    if (/taomate/i.test(name)) return "TaoMate";
    if (/turbo/i.test(name)) return "Turbo 8-step";
    return name.split(/[\\/]/).pop().replace(/\.safetensors$/i, "").slice(0, 22);
  }

  outputLabel(output) {
    const res = widgetValue(output, "final_resolution", "1080p");
    const fps = Math.round(Number(widgetValue(output, "final_fps", 24)));
    const up = widgetValue(output, "upscaler", "RTX VSR");
    const size = SIZE_LABEL[res] || res;
    const parts = [size, `${fps} fps`];
    if (size !== "Native") parts.push(String(up).startsWith("DLSS5") ? "DLSS 5" : "RTX VSR");
    return parts.join(" · ");
  }

  renderStatus() {
    const s = this.status;
    const n = this.numChunks();
    const len = this.durationSeconds;
    let text = `Ready · ${n} chunk${n > 1 ? "s" : ""} · ${len.toFixed(1)} s`;
    let cls = "";
    const run = this.run;
    if (run.state === "queued") { text = `${run.label || "Rendering"} · queued`; cls = "busy"; }
    else if (run.state === "running") { text = run.text || run.label || "Rendering"; cls = "busy"; }
    else if (run.state === "error") { text = run.label || "Stopped"; cls = "bad"; }
    else if (this.report && run.state === "done") {
      const reused = (this.report.chunks || []).filter((c) => c.candidates?.[0]?.reused).length;
      const rendered = (this.report.chunks || []).length;
      text = `Rendered ${rendered} of ${this.report.chunks_total} chunk${this.report.chunks_total > 1 ? "s" : ""}`
        + (reused ? ` · ${reused} kept` : "");
    } else if (this.edited.size) {
      text = `Changed since the last render · ${n} chunk${n > 1 ? "s" : ""}`;
      cls = "warn";
    }
    s.className = "sh3-status" + (cls ? " " + cls : "");
    s.lastChild.textContent = text;
    s.title = text;
  }

  renderFoot() {
    const f = clear(this.foot);
    const usage = this.usage;
    const takesItem = h("button.sh3-link.sh3-fi", {
      type: "button", title: "Kept takes: click for the folder's size and to clear it",
      onclick: (e) => menu(e.currentTarget, [
        { label: usage ? `${usage.takes} takes · ${fmtBytes(usage.bytes)} of ${fmtBytes(usage.cap)}` : "No takes kept yet", icon: "database", disabled: true },
        { label: "Clear every take", icon: "trash", danger: true, onClick: () => this.clearTakes() },
      ]),
    }, icon("database", 14), "Takes kept ", h("b", usage ? fmtBytes(usage.bytes) : "–"));
    f.appendChild(takesItem);
    if (this.isReference) {
      const filled = this.timeline.characters.filter((c) => c && (c.file || c.image_b64)).length
        + (this.timeline.background?.file || this.timeline.background?.image_b64 ? 1 : 0);
      f.appendChild(h("span.sh3-fi", icon("users", 14), "Cast and references ", h("b", `${filled} picture${filled === 1 ? "" : "s"}`)));
      const lip = (this.timeline.refAudios || []).some((a) => a && a.retention === "fully_copy");
      f.appendChild(h("span.sh3-fi", icon("mic", 14), "Lip Sync ", h("b", lip ? "on" : "off")));
    } else {
      const mids = this.middleFrames().length, cues = this.cues().length;
      f.appendChild(h("span.sh3-fi", icon("photo", 14), "Middle frames ", h("b", String(mids))));
      f.appendChild(h("span.sh3-fi", icon("wave", 14), "Sounds and clips ", h("b", String(cues))));
    }
    f.appendChild(h("div.sh3-spacer"));
    const dev = this.stats?.devices?.[0];
    if (dev) {
      const name = String(dev.name || "").replace(/^cuda:\d+\s*/, "").replace(/NVIDIA GeForce /, "").replace(/ : .*$/, "");
      f.appendChild(h("span.sh3-fi", icon("cpu", 14), `${name} · `,
        h("b", `${(dev.vram_free / 1e9).toFixed(1)} GB free`)));
    }
  }

  markSteps() {
    const done = new Set();
    if (this.setupNode() && this.modelsNode()) done.add(1);
    if (this.report && (this.report.chunks || []).length === this.report.chunks_total) done.add(2);
    const finish = this.finishNode();
    if (finish && Number(widgetValue(finish, "winner", 0)) >= 1) done.add(3);
    if (finish?.properties?.sh3_final) done.add(4);
    markSteps(this.steps, done);
  }

  // ----------------------------------------------------------------------------------- live events

  isMe(id) {
    if (id === null || id === undefined) return false;
    const s = String(id);
    return s === String(this.node.id) || s.endsWith(":" + this.node.id);
  }

  listen() {
    const on = (type, fn) => {
      api.addEventListener(type, fn);
      (this._off ||= []).push(() => api.removeEventListener(type, fn));
    };
    on("stubelius_ultimate_h3.takes", (e) => {
      if (e.detail?.takes_id === this.timeline.takes_id) this.onReport(e.detail);
    });
    on("stubelius_ultimate_h3.chunk", (e) => {
      const d = e.detail || {};
      if (d.takes_id !== this.timeline.takes_id && !this.isMe(d.node)) return;
      const cand = d.candidates > 1 ? ` · seed ${d.candidate + 1} of ${d.candidates}` : "";
      this.run = { state: "running", label: this.run.label, chunk: d.chunk,
        text: `${d.reused ? "Kept" : "Rendering"} chunk ${d.chunk + 1} of ${d.of}${cand}` };
      this.renderStatus();
      this.preview.onChunk?.(d);
    });
    on("executing", (e) => {
      const d = e.detail;
      const id = typeof d === "object" && d !== null ? d.node : d;
      if (this.isMe(id)) {
        if (this.run.state !== "running") this.run = { state: "running", label: this.run.label, text: this.run.label || "Rendering" };
        this.renderStatus();
        this.renderCmd();
      } else if (this.run.state === "running" && id !== undefined) {
        this.run = { state: "done" };
        this.live = null;
        this.preview.render();
        this.renderStatus();
        this.renderCmd();
      }
    });
    on("progress", (e) => {
      const d = e.detail || {};
      if (!this.isMe(d.node) || this.run.state !== "running") return;
      const base = this.run.text || "Rendering";
      this.status.lastChild.textContent = `${base.replace(/ · step .*$/, "")} · step ${d.value}/${d.max}`;
    });
    on("execution_error", (e) => {
      const d = e.detail || {};
      if (!this.isMe(d.node_id)) return;
      this.run = { state: "error", label: `Stopped: ${String(d.exception_message || "error").split("\n")[0].slice(0, 120)}` };
      this.live = null;
      this.refresh(["status", "cmd", "preview"]);
    });
    on("execution_interrupted", () => {
      if (this.run.state !== "running" && this.run.state !== "queued") return;
      this.run = { state: "error", label: "Stopped · the chunks it finished are kept" };
      this.live = null;
      this.refresh(["status", "cmd", "preview"]);
      this.fetchReport();
    });
    on("execution_success", () => {
      if (this.run.state === "running" || this.run.state === "queued") {
        this.run = { state: "done" };
        this.live = null;
        this.refresh(["status", "cmd", "preview"]);
      }
      this.fetchStats();
    });
    on("kj_preview_override", (e) => {
      const d = e.detail;
      if (!d || !this.isMe(String(d.node_id ?? "").split(":").pop())) return;
      this.live = { image: d.image, mime: typeof d.mime === "string" ? d.mime : "image/jpeg", step: d.step, total: d.total };
      this.preview.showLive(this.live);
    });
    on("executed", (e) => {
      const d = e.detail || {};
      const seeds = this.seedsNode();
      if (seeds && String(d.node) === String(seeds.id) && d.output?.stubelius_seeds) {
        this.preview.setVideos(d.output.stubelius_seeds);
      }
    });
  }

  dispose() {
    for (const off of this._off || []) off();
    this._off = [];
    closeMenus();
  }
}

// ------------------------------------------------------------------------------------------- styles

function injectDirectorStyles() {
  if (document.getElementById("stubelius-uh3-director")) return;
  document.head.appendChild(h("style", { id: "stubelius-uh3-director", text: DIRECTOR_CSS }));
}

const DIRECTOR_CSS = `
.sh3-d .d-hdr-mode .sh3-seg{background:var(--glass);border-radius:14px}
.sh3-d .d-hdr-mode .sh3-seg-opt{padding:8px 16px;font-weight:500}
.sh3-d .d-hdr-mode .sh3-seg-opt.on{background:var(--glass3);box-shadow:inset 0 1px 0 rgba(255,255,255,.08);color:var(--text)}
.sh3-d .d-cmd{display:flex;align-items:stretch;gap:12px;flex-wrap:wrap}
.sh3-d .d-cmd>.sh3-grp{min-height:78px;flex:none}
.sh3-d .d-cmd>.d-chips{flex:1 1 0;min-width:0;overflow:hidden}
.sh3-d .d-chips .sh3-chip{flex:1 1 0;min-width:0}
.sh3-d .d-chips .sh3-chip>div:last-child{min-width:0}
.sh3-d .d-chipval{overflow:hidden;text-overflow:ellipsis}
.sh3-d.narrow .d-cmd>.d-chips{flex:1 1 100%;order:5}
.sh3-d .d-field{display:flex;flex-direction:column;gap:3px;padding:0 6px}
.sh3-d .d-valrow{display:flex;align-items:center;gap:4px}
.sh3-d .d-val,.sh3-d .d-val-select{font-family:var(--fh);font-size:20px;font-weight:600;background:none;border:0;color:var(--text);
  padding:0;width:62px;outline:none;-moz-appearance:textfield;border-bottom:1px solid transparent;border-radius:0}
.sh3-d .d-val::-webkit-outer-spin-button,.sh3-d .d-val::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.sh3-d .d-val:hover,.sh3-d .d-val:focus{border-bottom-color:rgba(var(--ac),.6)}
.sh3-d .d-val-select{width:auto;cursor:pointer;-webkit-appearance:none;appearance:none}
.sh3-d .d-val-select option{background:var(--menu);color:var(--text);font-size:14px}
.sh3-d .d-seed{width:84px;font-size:17px;text-overflow:ellipsis}
.sh3-d .d-seed:focus{width:170px}
.sh3-d .d-seed-lock{width:28px;height:28px;border-radius:9px}
.sh3-d .d-valrow .sh3-ibtn{width:28px;height:28px;border-radius:9px}
.sh3-d .d-unit{color:var(--text2);font-size:12px;margin-left:-2px}
.sh3-d .d-vsep{width:1px;height:40px;background:var(--stroke)}
.sh3-d .d-modes{display:flex;gap:6px}
.sh3-d .d-mode{width:108px;height:56px;border-radius:13px;padding:9px 12px;background:var(--glass);border:1px solid var(--stroke);
  display:flex;flex-direction:column;justify-content:center;align-items:flex-start;text-align:left}
.sh3-d .d-mode:hover{border-color:var(--stroke2)}
.sh3-d .d-mode b{font-family:var(--fh);font-weight:600;font-size:15px}
.sh3-d .d-mode i{font-style:normal;color:var(--text3);font-size:11px;margin-top:2px;white-space:nowrap}
.sh3-d .d-mode.on{background:linear-gradient(160deg,rgba(var(--ac),.28),rgba(var(--ac2),.14) 60%,rgba(var(--ac2),.06));border-color:rgba(var(--ac),.7);
  box-shadow:0 0 28px rgba(var(--ac),.28),inset 0 1px 0 rgba(255,255,255,.12)}
.sh3-d .d-mode.on i{color:var(--text2)}
.sh3-d .d-chips{gap:10px;padding:0 12px}
.sh3-d .d-chipval{font-weight:600;white-space:nowrap}
.sh3-d .d-render{margin-left:auto;display:flex;gap:10px;align-items:center;flex:none}
.sh3-d .d-render .sh3-btn.ghost{padding:0 16px}
.sh3-d .d-main{display:grid;grid-template-columns:minmax(0,1fr) 554px;gap:18px;align-items:stretch}
.sh3-d.narrow .d-main{grid-template-columns:minmax(0,1fr)}
.sh3-d .d-insp{padding:18px 22px;display:flex;flex-direction:column;gap:14px;min-width:0}
.sh3-d .d-refs:empty{display:none}
`;

// ------------------------------------------------------------------------------------------- the node

app.registerExtension({
  name: "Stubelius.UltimateH3.DirectorWindow",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "StubeliusH3DirectorV2") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      for (const w of this.widgets || []) {
        if (OWN_WIDGETS.includes(w.name)) hideWidget(w);
      }
      // a fresh Director keeps its seed (takes are found again); a loaded one keeps what it had
      const ctrl = widget(this, "control_after_generate");
      if (ctrl) ctrl.value = "fixed";
      const d = new DirectorWindow(this);
      this._sh3 = d;
      mountWindow(this, "sh3_director", d.root, { minWidth: 1200, minHeight: 900 });
      d.fit = autoHeight(this, d.root, { minHeight: 900, extra: 46, minWidth: 1200 });
      if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => d.root.classList.toggle("narrow", d.root.offsetWidth < 1500)).observe(d.root);
      }
      return r;
    };

    // a loaded workflow's widget values arrive after onNodeCreated
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      const d = this._sh3;
      if (d) {
        d.timeline = d.loadState();
        if (d.freshId) d.commit();
        d.fold = this.properties?.sh3_fold || {};
        d.sel = Math.max(0, Math.min(d.numChunks() - 1, Number(this.properties?.sh3_sel) || 0));
        d.report = null;
        d.refresh();
        d.fetchReport();
        refreshThemes();
      }
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._sh3?.dispose();
      return onRemoved?.apply(this, arguments);
    };
  },
  async afterConfigureGraph() {
    setTimeout(refreshThemes, 0);
  },
});
