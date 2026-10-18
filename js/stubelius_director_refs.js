// Stubelius Ultimate H3 Director: cast and references (Reference mode).
//
// Up to nine characters and a location (each a picture, a description, its retention), three reference
// videos (trimmed, with or without their sound, as motion, an editing source or a continuation source)
// and three reference sounds (Ref Audio N is Ref N's voice; set to Lip Sync it is the video's soundtrack,
// transcribed with Whisper into timed shots).
import { h, icon, clear, button, iconButton, label, select, toggle, toast } from "./stubelius_ui.js";
import { MAX_CHARACTER_SLOTS, REF_AV_SLOTS } from "./stubelius_director_shared.js";
import {
  uploadFile, inputUrl, pictureUrl, urlToB64, extractAudioPeaks, drawPeaks, pickFile, dropTarget, isImageFile,
} from "./stubelius_director_media.js";

const { api } = window.comfyAPI.api;

const VISUAL_RETENTION = [["fully_preserved", "Fully preserved"], ["partially_preserved", "Partially preserved"],
  ["attribute_transfer", "Attribute transfer"], ["weak_reference", "Weak reference"]];
const AUDIO_RETENTION = [["reference", "Voice reference: new lines, same voice"], ["fully_copy", "Lip Sync: this exact recording"],
  ["partially_copy", "Partial voice match"], ["weak_reference", "Weak reference: loose vibe only"]];
const VIDEO_RETENTION = [["partially_preserved", "Duplicate the video, replace the character"], ["fully_preserved", "Fully preserved"],
  ["attribute_transfer", "Attribute transfer"], ["weak_reference", "Weak reference: motion and camera only"]];
const VIDEO_ROLES = [["reference", "Reference: motion, style, camera"], ["editing_source", "Editing source: replace something in it"],
  ["continuation_source", "Continuation source: extend from it"]];

let styled = false;
function injectStyles() {
  if (styled) return;
  styled = true;
  document.head.appendChild(h("style", { id: "stubelius-uh3-refs", text: CSS }));
}

export function buildRefs(d) {
  injectStyles();
  const box = clear(d.refs);
  if (!d.isReference) return;
  const panel = h("div.sh3-panel.r-panel");
  const lang = h("input.sh3-input.r-lang", { type: "text", value: d.timeline.dialogue_language || "English",
    title: "The language of every spoken line" });
  lang.addEventListener("change", () => { d.timeline.dialogue_language = lang.value.trim() || "English"; d.touchAll(); });
  panel.appendChild(h("div.r-head",
    h("div", h("div.sh3-h2", "Cast and references"),
      h("div.sh3-muted", "Characters and a place the model keeps, reference clips, and the voices. Ref Audio N is Ref N's voice.")),
    h("div.sh3-spacer"),
    h("label.r-langrow", label("Dialogue language"), lang)));

  const cast = h("div.r-cast");
  for (let i = 0; i < MAX_CHARACTER_SLOTS; i++) cast.appendChild(charSlot(d, i));
  cast.appendChild(charSlot(d, "bg"));
  panel.appendChild(cast);

  const av = h("div.r-av",
    h("div.r-col", h("div.r-colh", h("span.sh3-ico.k", icon("movie", 15)), h("span.sh3-h3", "Reference video")),
      ...Array.from({ length: REF_AV_SLOTS }, (_, i) => avSlot(d, "video", i))),
    h("div.r-col", h("div.r-colh", h("span.sh3-ico.snd", icon("mic", 15)), h("span.sh3-h3", "Reference audio")),
      ...Array.from({ length: REF_AV_SLOTS }, (_, i) => avSlot(d, "audio", i))));
  panel.appendChild(av);
  box.appendChild(panel);
}

// ------------------------------------------------------------------------------------------- pictures

function charSlot(d, idx) {
  const isBg = idx === "bg";
  const data = isBg ? d.timeline.background : d.timeline.characters[idx];
  const filled = data && (data.file || data.image_b64);
  const name = isBg ? "Location" : `Ref ${idx + 1}`;
  const slot = h("div.r-slot", { class: [filled ? "filled" : "", isBg ? "bg" : ""].join(" ").trim() || null });
  const set = async (file) => {
    if (!isImageFile(file)) return;
    try {
      const up = await uploadFile(file);
      const entry = { ...up, description: "" };
      if (isBg) d.timeline.background = entry; else d.timeline.characters[idx] = entry;
      d.touchAll();
      d.refresh(["refs", "insp", "foot", "preview"]);
    } catch (err) {
      console.error("[Stubelius Director] upload failed", err);
      toast(d.root, "Upload failed: see the console", "bad");
    }
  };
  if (!filled) {
    const drop = h("button.sh3-drop.r-drop", { type: "button", onclick: async () => { const f = await pickFile("image/*"); if (f) set(f); } },
      icon(isBg ? "photo" : "user", 22), h("span", name), h("small", "Drop a picture"));
    dropTarget(drop, set);
    slot.appendChild(drop);
    return slot;
  }
  const pic = h("div.r-pic", h("img", { src: pictureUrl(data), draggable: false }), h("span.r-pic-name", name));
  const del = iconButton("x", "Remove", () => {
    if (isBg) d.timeline.background = {}; else d.timeline.characters[idx] = null;
    d.touchAll();
    d.refresh(["refs", "insp", "foot", "preview"]);
  });
  del.classList.add("r-del");
  pic.appendChild(del);
  dropTarget(pic, set);
  const desc = h("textarea.sh3-text.r-desc", { rows: 2, placeholder: isBg ? "The place, e.g. a sunlit beach at low tide" : "Who this is: look, clothes, age…" });
  desc.value = data.description || "";
  desc.addEventListener("input", () => { data.description = desc.value; d.touchAll(); });
  const analyze = button(data.description ? "Analyze again" : "Analyze", "sparkles", "small", () => runAnalysis(d, idx, isBg, analyze, desc),
    "Describe the picture with the Analyze backend (Settings)");
  slot.append(pic, desc, h("div.r-row", analyze,
    select(VISUAL_RETENTION, data.retention || "fully_preserved", (v) => { data.retention = v; d.touchAll(); }, "r-mini")));
  return slot;
}

async function runAnalysis(d, idx, isBg, btn, descInput) {
  if (btn.classList.contains("disabled")) return;
  btn.classList.add("disabled");
  btn.querySelector("span").textContent = "Analyzing…";
  const data = isBg ? d.timeline.background : d.timeline.characters[idx];
  try {
    const image = data.image_b64 || await urlToB64(data.file ? inputUrl(data.file) : data._blobUrl);
    const resp = await api.fetchApi("/stubelius_ultimate_h3/analyze_character", {
      method: "POST",
      body: JSON.stringify({ image_b64: [image], char_index: isBg ? MAX_CHARACTER_SLOTS : idx,
        provider: d.timeline.analyze_provider || "ollama", base_url: d.timeline.analyze_base_url || "",
        model: d.timeline.analyze_model || "" }),
    });
    const result = await resp.json();
    if (result.status === "success") {
      data.description = result.description;
      descInput.value = result.description;
      d.touchAll();
      btn.querySelector("span").textContent = "Analyze again";
    } else {
      toast(d.root, "Analyze: " + result.message, "bad");
      btn.querySelector("span").textContent = "Analyze";
    }
  } catch (err) {
    console.error("[Stubelius Director] analyze failed", err);
    toast(d.root, "Analyze failed: is the backend (Settings) reachable?", "bad");
    btn.querySelector("span").textContent = "Analyze";
  }
  btn.classList.remove("disabled");
}

// ------------------------------------------------------------------------------------------- clips and sounds

function avSlot(d, kind, idx) {
  const isVideo = kind === "video";
  const key = isVideo ? "refVideos" : "refAudios";
  const entry = d.timeline[key][idx];
  const slot = h("div.r-av-slot", { class: [entry ? "filled" : "", isVideo ? "video" : "audio"].join(" ") });
  const title = `${isVideo ? "Ref Video" : "Ref Audio"} ${idx + 1}`;
  const set = async (file) => {
    try {
      const up = await uploadFile(file);
      const e = { ...up, trimStartSec: 0, trimEndSec: null, sourceDurationSec: null };
      if (isVideo) e.includeAudio = false;
      else {
        try {
          const { peaks, duration } = await extractAudioPeaks(file);
          e.waveformPeaks = peaks;
          e.sourceDurationSec = duration;
          e.trimEndSec = duration;
        } catch (err) {
          console.warn("[Stubelius Director] waveform failed", err);
        }
      }
      e._blobUrl = URL.createObjectURL(file);
      d.timeline[key][idx] = e;
      d.touchAll();
      d.refresh(["refs", "foot", "tl"]);
    } catch (err) {
      console.error("[Stubelius Director] upload failed", err);
      toast(d.root, "Upload failed: see the console", "bad");
    }
  };
  const headRow = h("div.r-av-head", h("span.r-av-title", title));
  if (entry) {
    headRow.appendChild(h("span.r-av-file", { title: entry.fileName || entry.file }, d.timeline.show_filenames === false ? "" : (entry.fileName || "")));
    headRow.appendChild(iconButton("x", "Remove", () => { d.timeline[key][idx] = null; d.touchAll(); d.refresh(["refs", "foot", "tl"]); }));
  }
  slot.appendChild(headRow);
  if (!entry) {
    const drop = h("button.sh3-drop.r-av-drop", { type: "button",
      onclick: async () => { const f = await pickFile(isVideo ? "video/*" : "audio/*"); if (f) set(f); } },
    icon("upload", 18), `Drop or click to add ${isVideo ? "a video" : "a sound"}`);
    dropTarget(drop, set);
    slot.appendChild(drop);
    return slot;
  }
  dropTarget(slot, set);
  slot.appendChild(media(d, kind, entry));
  if (isVideo) {
    slot.append(
      h("label.r-inline", toggle(!!entry.includeAudio, (v) => { entry.includeAudio = v; d.touchAll(); }), "Send its sound too (as its own reference)"),
      descField(entry, "If it shows a person or thing to reuse, describe it (blank = motion and camera only)", d),
      h("div.r-row", select(VIDEO_ROLES, entry.role || "reference", (v) => { entry.role = v; d.touchAll(); }, "r-mini"),
        select(VIDEO_RETENTION, entry.retention || (entry.description ? "fully_preserved" : entry.role === "editing_source" ? "partially_preserved" : "weak_reference"),
          (v) => { entry.retention = v; d.touchAll(); }, "r-mini")));
  } else {
    const paired = d.timeline.characters[idx];
    const pairedOk = paired && (paired.file || paired.image_b64);
    slot.append(
      h("div.r-pair", icon(pairedOk ? "link" : "info", 13), pairedOk ? `Ref ${idx + 1}'s voice` : `No character in Ref ${idx + 1}: describe the voice below`),
      descField(entry, "Only used without a character in its Ref, e.g. Sarah: warm, mid-range", d),
      h("div.r-row", select(AUDIO_RETENTION, entry.retention || "reference", (v) => {
        entry.retention = v;
        d.touchAll();
        d.refresh(["refs", "foot", "tl"]);
      }, "r-mini r-wide")));
    if (entry.retention === "fully_copy") slot.appendChild(lipSyncBox(d, entry, idx));
  }
  return slot;
}

function descField(entry, placeholder, d) {
  const t = h("textarea.sh3-text.r-desc", { rows: 2, placeholder });
  t.value = entry.description || "";
  t.addEventListener("input", () => { entry.description = t.value; d.touchAll(); });
  return t;
}

// The clip or sound with play, a scrub bar and Set In / Set Out (the part that is sent)
function media(d, kind, entry) {
  const src = entry.file ? inputUrl(entry.file) : entry._blobUrl;
  const wrap = h("div.r-media");
  let el;
  if (kind === "video") {
    el = h("video.r-video", { src, playsInline: true, preload: "metadata" });
    wrap.appendChild(el);
  } else {
    el = h("audio", { src, preload: "metadata" });
    const canvas = h("canvas.r-wave", { width: 520, height: 46 });
    wrap.append(el, canvas);
    requestAnimationFrame(() => {
      const snd = getComputedStyle(d.root).getPropertyValue("--snd").trim() || "63,213,255";
      drawPeaks(canvas, entry.waveformPeaks, `rgba(${snd},.75)`);
    });
  }
  const play = h("button.r-play", { type: "button", title: "Play / pause" }, icon("play", 14));
  const scrub = h("input.sh3-range.r-scrub", { type: "range", min: 0, max: entry.sourceDurationSec || 100, step: 0.05, value: 0 });
  const readout = h("div.r-readout");
  const showTrim = () => {
    const a = (entry.trimStartSec || 0).toFixed(2);
    const b = entry.trimEndSec != null ? Number(entry.trimEndSec).toFixed(2) : "end";
    readout.textContent = `In ${a} s · Out ${b} s`;
  };
  play.addEventListener("click", () => { if (el.paused) el.play(); else el.pause(); });
  el.addEventListener("play", () => { clear(play); play.appendChild(icon("pause", 14)); });
  el.addEventListener("pause", () => { clear(play); play.appendChild(icon("play", 14)); });
  el.addEventListener("timeupdate", () => {
    scrub.value = el.currentTime;
    scrub.style.setProperty("--pct", `${(el.currentTime / (el.duration || 1)) * 100}%`);
  });
  el.addEventListener("loadedmetadata", () => {
    if (!el.duration || !isFinite(el.duration)) return;
    const atEnd = entry.trimEndSec === null || entry.trimEndSec === entry.sourceDurationSec;
    entry.sourceDurationSec = el.duration;
    if (atEnd) entry.trimEndSec = el.duration;
    scrub.max = String(el.duration);
    d.touchAll();
    showTrim();
  });
  scrub.addEventListener("input", () => { el.currentTime = parseFloat(scrub.value); });
  const setIn = button("Set in", null, "small", () => {
    entry.trimStartSec = Math.max(0, Math.min(el.currentTime, (entry.trimEndSec ?? el.duration ?? el.currentTime + 1) - 0.05));
    d.touchAll();
    showTrim();
    d.refresh(["tl"]);
  });
  const setOut = button("Set out", null, "small", () => {
    entry.trimEndSec = Math.max(el.currentTime, (entry.trimStartSec || 0) + 0.05);
    d.touchAll();
    showTrim();
    d.refresh(["tl"]);
  });
  showTrim();
  wrap.append(h("div.r-scrubrow", play, scrub), h("div.r-trimrow", setIn, setOut, readout));
  return wrap;
}

// Lip Sync: the words, timed (Whisper on the CPU), corrected by hand, then put in as timed shots
function lipSyncBox(d, entry, idx) {
  const box = h("div.r-lip");
  box.appendChild(h("div.r-lip-head", icon("mic", 15), h("b", "Lip Sync"),
    h("span.sh3-muted", "The recording is the video's sound; the lips follow it in every chunk.")));
  const model = select(["tiny", "base", "small", "medium"], entry.whisper_model || "small", (v) => { entry.whisper_model = v; d.commit(); }, "r-mini");
  const has = Array.isArray(entry.transcript_segments) && entry.transcript_segments.length;
  const go = button(has ? "Transcribe again" : "Transcribe", "type", "small", async () => {
    if (go.classList.contains("disabled")) return;            // still transcribing: one at a time
    if (!entry.file) { toast(d.root, "The upload is still saving: try again in a second."); return; }
    go.classList.add("disabled");
    go.querySelector("span").textContent = "Transcribing…";
    try {
      const resp = await api.fetchApi("/stubelius_ultimate_h3/transcribe_audio", {
        method: "POST", body: JSON.stringify({ file: entry.file, whisper_model: entry.whisper_model || "small" }),
      });
      const result = await resp.json();
      if (result.status === "success") {
        entry.transcript_segments = result.segments;
        d.touchAll();
        d.refresh(["refs"]);
        return;
      }
      toast(d.root, "Transcription: " + result.message, "bad");
    } catch (err) {
      console.error("[Stubelius Director] transcription failed", err);
      toast(d.root, "Transcription failed: see the console", "bad");
    }
    go.classList.remove("disabled");
    go.querySelector("span").textContent = has ? "Transcribe again" : "Transcribe";
  }, "Whisper on the CPU: no video memory");
  box.appendChild(h("div.r-row", h("span.sh3-muted", "Whisper"), model, go));
  if (has) {
    const list = h("div.r-lines");
    entry.transcript_segments.forEach((seg, i) => {
      const m = Math.floor(seg.start / 60), s = (seg.start % 60).toFixed(1);
      const input = h("input.sh3-input.r-line", { type: "text", value: seg.text });
      input.addEventListener("input", () => { entry.transcript_segments[i].text = input.value; d.touchAll(); });
      list.appendChild(h("div.r-line-row", h("span.r-ts", `${m}:${s.padStart(4, "0")}`), input));
    });
    box.appendChild(list);
    box.appendChild(button("Insert as timed shots", "lines", "small brand", () => insertTranscript(d, entry, idx),
      `One shot per line, timed to the recording and spoken by Ref ${idx + 1}; the length grows to the recording's if needed`));
  }
  return box;
}

function insertTranscript(d, entry, charIdx) {
  const segments = entry.transcript_segments || [];
  if (!segments.length) return;
  const realEnd = Math.max(...segments.map((s) => s.end || 0));
  if (realEnd > d.durationSeconds) d.setWidgetValue("duration_seconds", Math.ceil(realEnd * 10) / 10);
  d.syncChunkCount();
  const bounds = d.bounds();
  let count = 0;
  for (const seg of segments) {
    const text = (seg.text || "").trim();
    if (!text) continue;
    const at = seg.start || 0;
    let k = bounds.findIndex((b) => at >= b[0] && at < b[1]);
    if (k === -1) k = bounds.length - 1;
    const chunk = d.timeline.chunks[k];
    if (chunk.segments.length === 1 && !chunk.segments[0].prompt) chunk.segments = [];
    chunk.segments.push({ prompt: `"${text}"`, weight: Math.max(0.3, (seg.end || at) - at), speakerCharIdxs: [charIdx] });
    d.markEdited(k);
    count++;
  }
  d.commit();
  d.refresh();
  if (count) toast(d.root, `${count} line${count > 1 ? "s" : ""} put in across ${bounds.length} chunk${bounds.length > 1 ? "s" : ""}, timed to the recording`);
}

const CSS = `
.sh3-d .r-panel{padding:20px 22px;display:flex;flex-direction:column;gap:16px}
.sh3-d .r-head{display:flex;align-items:flex-end;gap:16px}
.sh3-d .r-langrow{display:flex;flex-direction:column;gap:4px}
.sh3-d .r-lang{width:170px}
.sh3-d .r-cast{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.sh3-d .r-slot{display:flex;flex-direction:column;gap:7px;min-width:0}
.sh3-d .r-drop{flex-direction:column;height:150px;gap:4px;font-weight:600}
.sh3-d .r-drop small{font-weight:500;color:var(--text3)}
.sh3-d .r-slot.bg .r-drop{border-color:rgba(var(--cut),.4)}
.sh3-d .r-pic{position:relative;height:150px;border-radius:14px;overflow:hidden;border:1.5px solid rgba(var(--k),.6);background:#000;
  box-shadow:0 10px 28px rgba(0,0,0,.3)}
.sh3-d .r-slot.bg .r-pic{border-color:rgba(var(--cut),.6)}
.sh3-d .r-pic img{width:100%;height:100%;object-fit:cover;display:block}
.sh3-d .r-pic-name{position:absolute;left:8px;top:8px;padding:3px 8px;border-radius:8px;background:rgba(8,6,12,.6);color:#f3f1f8;
  font-family:var(--fh);font-weight:600;font-size:12px;backdrop-filter:blur(8px)}
.sh3-d .r-del{position:absolute;right:6px;top:6px;width:26px;height:26px;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;border:0;display:none}
.sh3-d .r-pic:hover .r-del{display:grid}
.sh3-d .r-pic.over{outline:2px dashed rgba(var(--ac),.8);outline-offset:-2px}
.sh3-d .r-desc{min-height:52px;font-size:12.5px}
.sh3-d .r-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sh3-d .r-mini{height:30px;font-size:12px;padding:0 26px 0 9px;border-radius:9px;min-width:0;flex:1}
.sh3-d .r-wide{flex:1 1 100%}
.sh3-d .r-av{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.sh3-d .r-col{display:flex;flex-direction:column;gap:10px;min-width:0}
.sh3-d .r-colh{display:flex;align-items:center;gap:10px}
.sh3-d .r-av-slot{border-radius:16px;background:var(--glass);border:1px solid var(--stroke);padding:12px;display:flex;flex-direction:column;gap:9px}
.sh3-d .r-av-slot.filled.video{border-color:rgba(var(--k),.45)}
.sh3-d .r-av-slot.filled.audio{border-color:rgba(var(--snd),.45)}
.sh3-d .r-av-slot.over{border-color:rgba(var(--ac),.8)}
.sh3-d .r-av-head{display:flex;align-items:center;gap:10px}
.sh3-d .r-av-head .sh3-ibtn{width:28px;height:28px;border-radius:9px;margin-left:auto}
.sh3-d .r-av-title{font-weight:600;font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:var(--text2)}
.sh3-d .r-av-file{color:var(--text3);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sh3-d .r-av-drop{height:64px;font-weight:600}
.sh3-d .r-media{display:flex;flex-direction:column;gap:6px}
.sh3-d .r-video{width:100%;max-height:170px;border-radius:10px;background:#000;display:block}
.sh3-d .r-wave{width:100%;height:46px;border-radius:10px;background:var(--well);display:block}
.sh3-d .r-scrubrow{display:flex;align-items:center;gap:8px}
.sh3-d .r-play{width:28px;height:28px;border-radius:50%;border:1px solid var(--stroke2);background:var(--glass2);color:var(--text);display:grid;place-items:center;padding:0;flex:none}
.sh3-d .r-scrub{margin:0}
.sh3-d .r-trimrow{display:flex;align-items:center;gap:8px}
.sh3-d .r-readout{margin-left:auto;color:var(--text3);font-size:12px;font-family:var(--fm)}
.sh3-d .r-inline{display:flex;align-items:center;gap:10px;color:var(--text2);font-size:12.5px;cursor:pointer}
.sh3-d .r-pair{display:flex;align-items:center;gap:6px;font-size:12px;color:rgb(var(--ok))}
.sh3-d .r-lip{border-radius:14px;padding:10px 12px;background:rgba(var(--ac),.06);border:1px solid rgba(var(--ac),.3);display:flex;flex-direction:column;gap:8px}
.sh3-d .r-lip-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sh3-d .r-lip-head .sh3-ic{color:rgb(var(--ac))}
.sh3-d .r-lines{display:flex;flex-direction:column;gap:5px;max-height:none}
.sh3-d .r-line-row{display:flex;align-items:center;gap:8px}
.sh3-d .r-ts{width:46px;flex:none;color:var(--text3);font-family:var(--fm);font-size:12px}
.sh3-d .r-line{height:32px;flex:1;font-size:12.5px}
`;
