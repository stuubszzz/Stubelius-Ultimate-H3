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
  autoHeight, fmtSeconds, fmtBytes, refreshThemes, confirmIn, chooseIn, queueRun,
} from "./stubelius_ui.js";
import { normalizeMiddleFrames } from "./stubelius_middle_frames.js";
import { normalizeCues } from "./stubelius_cues.js";
import { buildPreview } from "./stubelius_director_preview.js";
import { buildInspector } from "./stubelius_director_inspector.js";
import { buildTimeline } from "./stubelius_director_timeline.js";
import { buildRefs } from "./stubelius_director_refs.js";
import { characterTokens, fmtTokens } from "./stubelius_director_characters.js";
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
    this.pendingFlags = null;       // render_until / hunt_chunk for the next prompt only (see queue())
    this.hookPrompt();
    this.timeline = this.loadState();
    if (this.freshId || this.hadFlags) this.commit();
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
    // characters made from many pictures (RefMods, stubelius_refmods.py), for the whole video
    parsed.refmods = (Array.isArray(parsed.refmods) ? parsed.refmods : [])
      .filter((e) => e && typeof e.file === "string" && e.file)
      .map((e) => ({ ...e, strength: Math.max(0, Math.min(1, Number(e.strength ?? 1) || 0)) }));
    if (parsed.source_clip && (typeof parsed.source_clip !== "object" || !parsed.source_clip.file)) delete parsed.source_clip;
    // a render-until or a hunt goes with one prompt only (see queue()); an older one saved with it gets it taken out
    this.hadFlags = "render_until" in parsed || "hunt_chunk" in parsed;
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

  // The takes belong to one saved workflow file: a copy of it (Save As) starts its own takes report and seed previews
  // at its first render instead of writing over the original's. Only a hash of the file's path is kept.
  ownTakes() {
    const wf = this.workflowFile();
    if (!wf?.path || wf.isTemporary) return;
    let h = 0x811c9dc5;
    for (const ch of String(wf.path)) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
    const owner = h.toString(16);
    if (this.timeline.takes_owner && this.timeline.takes_owner !== owner) {
      this.timeline.takes_id = newTakesId();
      this.report = null;
    }
    this.timeline.takes_owner = owner;
  }

  workflowFile() {
    return app.extensionManager?.workflow?.activeWorkflow || null;
  }

  // Render to chunk N and a hunt go with one prompt only: they're added to the timeline while ComfyUI builds that
  // prompt (it can build it later, after another queue call has sent), never to the widget the workflow saves
  hookPrompt() {
    const tw = this.tw;
    if (!tw || tw.__sh3Prompt) return;
    tw.__sh3Prompt = true;
    const base = tw.serializeValue;
    const win = this;
    tw.serializeValue = async function (...args) {
      let value = base ? await base.apply(this, args) : this.value;
      const flags = win.pendingFlags;
      if (flags) {
        win.pendingFlags = null;
        try {
          value = JSON.stringify(Object.assign(JSON.parse(value), flags));
        } catch (e) {
          // not a timeline: sent as it is
        }
      }
      return value;
    };
  }

  // a chunk the user changed since the takes report (its takes there are from before the change)
  touched(k) {
    const first = !this.edited.size;
    this.markEdited(k);
    this.commit();
    if (first) this.renderStatus();
  }

  // when chunk k was edited (a count): a takes report clears only the edits made before its render was queued
  markEdited(k) {
    this.editSeq = (this.editSeq || 0) + 1;
    (this.editedAt ||= new Map()).set(k, this.editSeq);
    this.edited.add(k);
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

  // After the length or chunk size changed: drop the chunks past the end, asking first (in the window) when they hold text
  async applyLengthChange(revert) {
    const n = this.numChunks();
    if (this.timeline.chunks.length > n) {
      const dropping = this.timeline.chunks.slice(n);
      const hasText = dropping.some((c) => c.segments.some((s) => (s.prompt || "").trim()));
      if (hasText && !(await confirmIn(this.root, {
        title: `Drop ${dropping.length === 1 ? "the last chunk" : `the last ${dropping.length} chunks`}?`,
        text: `The new length ends before ${dropping.length === 1 ? "a chunk that still has" : "chunks that still have"} shots in it. `
          + "They go, with their shots, style, sound and LoRAs.",
        ok: "Drop them", danger: true }))) {
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
  async deleteChunk(k) {
    if (this.timeline.chunks.length <= 1) {
      toast(this.root, "A video keeps at least one chunk: clear its shots instead.");
      return;
    }
    const chunk = this.timeline.chunks[k];
    if (chunk?.segments.some((s) => (s.prompt || "").trim()) && !(await confirmIn(this.root, {
      title: `Delete chunk ${k + 1}?`, text: "It still has shots in it. The chunks after it move up and the video gets one chunk shorter.",
      ok: "Delete it", danger: true }))) return;
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

  // Characters made from many pictures (RefMods): [{file, strength, enabled}], every chunk carries them
  refmods() {
    if (!Array.isArray(this.timeline.refmods)) this.timeline.refmods = [];
    return this.timeline.refmods;
  }

  // a character goes into every chunk, so every chunk's takes are from before the change
  touchAll() {
    for (let k = 0; k < this.numChunks(); k++) this.touched(k);
  }

  addRefmod(name) {
    const list = this.refmods();
    if (!name || list.some((e) => e.file === name)) return;
    list.push({ file: name, strength: 1 });
    this.touchAll();
    this.refresh(["tl", "foot"]);
  }

  setRefmod(i, patch) {
    const e = this.refmods()[i];
    if (!e) return;
    Object.assign(e, patch);
    if (e.enabled !== false) delete e.enabled;
    this.touchAll();
    this.refresh(["tl", "foot"]);
  }

  removeRefmod(i) {
    this.refmods().splice(i, 1);
    this.touchAll();
    this.refresh(["tl", "foot"]);
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

  // The seed chunk k had in the video on show: the last render's, for the picked seed. The seed box may have moved on
  // since (randomize or increment after queueing), and a picked seed's chunks aren't the first seed's.
  renderedSeed(k) {
    const rc = this.reportChunk(k);
    if (!rc) return null;
    const w = Number(widgetValue(this.finishNode(), "winner", 0)) || 0;
    const c = (w >= 1 && rc.candidates?.[w - 1]) || rc.candidates?.[0];
    const s = Number(c?.seed ?? rc.seed);
    return Number.isFinite(s) ? s : null;
  }

  // The takes of chunk k (the main video's), oldest first; `current` = the one in the video now: its own seed's, else
  // the one the last render used
  takesOf(k) {
    const rc = this.reportChunk(k);
    const list = rc?.takes || [];
    const seed = !this.hasOwnSeed(k) && rc ? (this.renderedSeed(k) ?? this.seedOf(k)) : this.seedOf(k);
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
    if (fresh) {
      // edits made while that render ran aren't in it (a render queued from ComfyUI's own button: all of them)
      const upTo = this.queuedSeq ?? Infinity;
      for (const k of [...this.edited]) {
        if ((this.editedAt?.get(k) || 0) <= upTo) { this.edited.delete(k); this.editedAt?.delete(k); }
      }
      this.queuedSeq = null;
    }
    // the seeds now in Seeds were made with the settings of the render that brought them
    if (fresh && this.pendingRecipe) {
      this.node.properties = this.node.properties || {};
      this.node.properties.sh3_seeds_recipe = this.pendingRecipe;
      this.pendingRecipe = null;
    }
    this.refresh(["preview", "insp", "tl", "status"]);
    this.fetchUsage();
    window.dispatchEvent(new CustomEvent("stubelius-takes", { detail: { node: this.node.id } }));   // the other windows
  }

  // The render settings (the Setup and Models nodes' values): the seeds in Seeds were made with the ones of their render
  recipeNow() {
    const out = {};
    for (const [part, node] of [["Setup", this.setupNode()], ["Models", this.modelsNode()]]) {
      for (const w of node?.widgets || []) {
        if (w.serialize === false || w.type === "button" || /^sh3_|^control_after/.test(w.name || "")) continue;
        if (w.value === undefined || (w.value && typeof w.value === "object")) continue;
        out[`${part}:${w.name}`] = w.value;
      }
    }
    return out;
  }

  // What changed since the seeds were rendered: [[part:name, then, now], ...] ([] when nothing did or it isn't known)
  changedSinceSeeds() {
    const was = this.node.properties?.sh3_seeds_recipe;
    if (!was) return [];
    const now = this.recipeNow();
    return Object.keys({ ...was, ...now }).filter((k) => String(was[k]) !== String(now[k])).map((k) => [k, was[k], now[k]]);
  }

  // Before a Finish (Seeds or Output): Setup and Models feed the Director, so with other settings than the seeds had,
  // a Finish renders the seeds again. Ask: put the settings back (their takes are on disk: quick) and finish the
  // seeds as they are, render them again with the new settings, or not now. True = go on.
  async checkFinish(root) {
    const changed = this.changedSinceSeeds();
    if (!changed.length) {
      this.pendingRecipe = this.recipeNow();
      return true;
    }
    const NAMES = { speedup_lora_strength: "Turbo strength", speedup_lora: "Speed-up LoRA", megapixels: "Size", steps: "Steps",
      sampler: "Sampler", scheduler: "Scheduler", mode: "Mode", seeds: "Seeds to compare", extra_lora_1: "Global LoRA 1",
      extra_lora_2: "Global LoRA 2", extra_lora_1_strength: "Global LoRA 1 strength", extra_lora_2_strength: "Global LoRA 2 strength",
      fl2va_model: "First/Last model", ref2va_model: "Reference model", text_encoder: "Text encoder", pdmd_lora: "PDMD LoRA" };
    const name = (k) => { const n = k.split(":")[1]; return NAMES[n] || n.replace(/_/g, " "); };
    const val = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v).split(/[\\/]/).pop().replace(/\.safetensors$/i, ""));
    // two numbers side by side with the same decimals (0.75 → 1.00, not 0.75 → 1)
    const pair = (a, b) => (typeof a === "number" && typeof b === "number" && !(Number.isInteger(a) && Number.isInteger(b))
      ? [a.toFixed(2), b.toFixed(2)] : [val(a), val(b)]);
    const list = changed.slice(0, 4).map(([k, a, b]) => `${name(k)} ${pair(a, b).join(" → ")}`).join(", ")
      + (changed.length > 4 ? ` and ${changed.length - 4} more` : "");
    const choice = await chooseIn(root || this.root, {
      title: "The settings changed since these seeds",
      text: `${list}. Finishing now renders the seeds again with the new settings. Put them back to finish the seeds you picked from.`,
      choices: [{ label: "Put them back and finish", value: "back", icon: "history" },
        { label: "Render again", value: "again", icon: "refresh" }, { label: "Cancel", value: null }],
    });
    if (choice === "again") {
      this.pendingRecipe = this.recipeNow();
      return true;
    }
    if (choice !== "back") return false;
    const nodes = { Setup: this.setupNode(), Models: this.modelsNode() };
    // the mode first: its preset fills the other Setup values, which then go back to theirs
    for (const [k, then] of changed.sort(([a], [b]) => (a === "Setup:mode" ? -1 : b === "Setup:mode" ? 1 : 0))) {
      const [part, wname] = k.split(":");
      if (nodes[part] && then !== undefined) setWidget(nodes[part], wname, then);
    }
    this.pendingRecipe = this.recipeNow();
    this.setupNode()?._sh3?.render?.();
    this.renderCmd();
    toast(this.root, "Settings put back as they were for these seeds");
    return true;
  }

  // Keep the chunks before k as they are (their seeds written down), so a retake or a hunt of chunk k
  // can only change k and what comes after it.
  keepBefore(k) {
    for (let j = 0; j < k; j++) {
      if (!this.hasOwnSeed(j)) this.timeline.chunks[j].seed = this.renderedSeed(j) ?? this.seedOf(j);
    }
  }

  // Keep these seeds for these chunks (a pick in Seeds): [[k, seed], ...]
  pickSeeds(pairs) {
    if (!pairs.length) return;
    for (const [k, seed] of pairs) if (this.timeline.chunks[k]) this.timeline.chunks[k].seed = Number(seed);
    this.keepBefore(Math.max(...pairs.map(([k]) => k)));
    this.commit();
    this.refresh(["preview", "insp", "tl"]);
  }

  // A render brings new takes, so an older pick doesn't hold: the Finish waits for one in Seeds (winner 0).
  // One seed with "Finish it right away" on (the Output window) finishes it straight away. A Finish shown as
  // a plain node keeps the winner it was given, as before the windows.
  holdFinish(whole) {
    const fin = this.finishNode();
    if (!fin?._sh3) return;
    const seeds = Number(widgetValue(this.setupNode(), "seeds", 1)) || 1;
    const want = whole && seeds === 1 && fin.properties?.sh3_autofinish ? 1 : 0;
    if (Number(widgetValue(fin, "winner", 0)) === want) return;
    setWidget(fin, "winner", want);
    window.dispatchEvent(new CustomEvent("stubelius-winner"));
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

  // How many seeds a hunt renders (2, 3 or 4): the Director's and the Seeds window's Hunt buttons share it
  huntCount() {
    const n = Number(this.fold?.hunt);
    return [2, 3, 4].includes(n) ? n : 4;
  }

  setHuntCount(n) {
    this.fold.hunt = n;
    this.saveUi();
    this.refresh(["insp"]);
    window.dispatchEvent(new CustomEvent("stubelius-takes", { detail: { node: this.node.id } }));   // the Seeds window's button
  }

  hunt(k, count = this.huntCount()) {
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
    if (!(await confirmIn(this.root, { title: "Remove every kept take?", text: "The next render starts from scratch.",
      ok: "Remove them", danger: true }))) return;
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

  // Anything for H3 to go on: typed text (a shot, a style, sound or music line, the prompt override), a picture, a
  // clip to continue, a pinned sound or clip, a reference. Without any of it H3 makes up a video of its own.
  // (The node checks the same before it renders: stubelius_v2.py _has_content.)
  hasContent() {
    const t = this.timeline;
    const typed = (s) => !!String(s ?? "").trim();
    const filed = (p) => !!(p && (p.file || p.image_b64));
    if ((t.chunks || []).some((c) => (c.segments || []).some((s) => typed(s?.prompt))
      || typed(c.style_line) || typed(c.overall_soundscape) || typed(c.non_diegetic_music))) return true;
    if ((t.refmods || []).some((e) => e?.file && e.enabled !== false)) return true;
    const override = sourceOf(this.node, "prompt_override");
    if (override) {
      const w = widget(override, "value");
      if (!w || typed(w.value)) return true;     // a text from another node is only known when it runs
    }
    if (this.isReference) {
      return (t.characters || []).some(filed) || filed(t.background)
        || [...(t.refVideos || []), ...(t.refAudios || [])].some(filed);
    }
    return (t.characters || []).slice(0, 2).some(filed) || this.middleFrames().some(filed)
      || filed(t.source_clip) || this.cues().some(filed);
  }

  // Queue the workflow. `until` (a chunk index) and `hunt` go into this one prompt only.
  async queue({ until = null, hunt = null, label = null } = {}) {
    if (this.submitting) return;                // a second click while this one is being sent
    if (!this.hasContent()) {
      toast(this.root, "Nothing to render yet: type what happens in a shot, or add a picture", "warn");
      this.select(0);
      setTimeout(() => this.insp.querySelector(".i-cut-text")?.focus(), 60);
      return;
    }
    if (until !== null && until >= this.numChunks() - 1 && !hunt) until = null;
    const flags = {};
    if (until !== null) flags.render_until = until;
    if (hunt) flags.hunt_chunk = hunt;
    this.ownTakes();
    this.commit();
    this.pendingRecipe = this.recipeNow();
    this.queuedSeq = this.editSeq || 0;
    this.holdFinish(until === null && !hunt);
    this.run = { state: "queued", label: label || (until !== null ? `Rendering to chunk ${until + 1}` : "Rendering") };
    this.renderStatus();
    this.preview.render();                   // the old video stops: the new one is on its way
    this.pendingFlags = Object.keys(flags).length ? flags : null;
    this.submitting = true;
    let r;
    try {
      r = await queueRun();
    } finally {
      this.submitting = false;
    }
    if (!r.ok) {                             // ComfyUI turned it down (and said why): nothing is on its way
      this.pendingFlags = null;
      this.run = { state: "error", label: "Not rendered: " + r.why };
      this.live = null;
      this.refresh(["status", "cmd", "preview"]);
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
    this.renderStatus();                 // a picture or a shot can turn "nothing to render" into ready
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
    const file = name.split(/[\\/]/).pop();            // the file's own name: a "turbo" folder says nothing about it
    if (/motion.?enhancer/i.test(file)) return "Motion Enhancer";
    if (/lightx2v/i.test(file)) return "LightX2V";
    if (/taomate/i.test(file)) return "TaoMate";
    if (/turbo.?8.?step|fl2v_turbo/i.test(file)) return "Turbo 8-step";
    return file.replace(/\.safetensors$/i, "").slice(0, 22);
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
    else if (!this.hasContent()) {
      text = "Nothing to render yet · type a shot or add a picture";
      cls = "warn";
    } else if (this.edited.size) {
      text = `Changed since the last render · ${n} chunk${n > 1 ? "s" : ""}`;
      cls = "warn";
    } else if (this.report && run.state === "done") {
      const reused = (this.report.chunks || []).filter((c) => c.candidates?.[0]?.reused).length;
      const rendered = (this.report.chunks || []).length;
      text = `Rendered ${rendered} of ${this.report.chunks_total} chunk${this.report.chunks_total > 1 ? "s" : ""}`
        + (reused ? ` · ${reused} kept` : "");
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
    const chars = this.refmods().filter((e) => e.enabled !== false).length;
    if (chars) {
      const tokens = characterTokens(this);
      f.appendChild(h("span.sh3-fi", { title: "Characters made from many pictures: the reference tokens they add to every step" },
        icon("user", 14), "Characters ", h("b", tokens ? `${chars} · ${fmtTokens(tokens)}` : String(chars))));
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
    const on = (type, fn, target = api) => {
      target.addEventListener(type, fn);
      (this._off ||= []).push(() => target.removeEventListener(type, fn));
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
      if (!this.live) this.preview.render();
    });
    on("executing", (e) => {
      const d = e.detail;
      const id = typeof d === "object" && d !== null ? d.node : d;
      if (this.isMe(id)) {
        const started = this.run.state !== "running";
        if (started) this.run = { state: "running", label: this.run.label, text: this.run.label || "Rendering" };
        this.renderStatus();
        this.renderCmd();
        if (started) this.preview.render();       // a render queued from elsewhere (ComfyUI's Queue button) too
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
      const mine = this.isMe(d.node_id);
      // a node before the Director failing stops the render it waits in (the Models node, a missing pack...)
      if (!mine && this.run.state !== "queued") return;
      const where = mine ? "" : `${app.graph?.getNodeById?.(d.node_id)?.title || d.node_type || "a node before it"}: `;
      this.run = { state: "error", label: `Stopped: ${where}${String(d.exception_message || "error").split("\n")[0].slice(0, 120)}` };
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
    on("stubelius-winner", () => { this.preview.render(); this.markSteps(); }, window);
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
      // a clone made for a copy (Ctrl+C) never joins a graph: its window lets go of its listeners
      setTimeout(() => { if (!this.graph) d.dispose(); }, 0);
      return r;
    };

    // a loaded workflow's widget values arrive after onNodeCreated
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      const d = this._sh3;
      if (d) {
        d.timeline = d.loadState();
        // a pasted or duplicated Director gets its own takes (report, live events, seed previews)
        const twin = (this.graph?._nodes || []).some((n) => n !== this && n.comfyClass === "StubeliusH3DirectorV2"
          && n._sh3?.timeline?.takes_id === d.timeline.takes_id);
        if (twin) { d.timeline.takes_id = newTakesId(); delete d.timeline.takes_owner; d.freshId = true; }
        if (d.freshId || d.hadFlags) d.commit();
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
