// Stubelius Ultimate H3 Director: the timeline across the whole video.
//
// Keyframes (First/Last Frame mode: the first frame or the clip it continues, middle frames, the last
// frame), shots (each chunk's shots, their edges dragged to time them), sound (sounds and clips pinned at
// a second; in Reference mode the Lip Sync recording) and chunks, with how each one joins the chunk
// before it. Pictures, sounds and clips dropped on it land at that second.
import { h, icon, clear, iconButton, menu, toast } from "./stubelius_ui.js";
import {
  MAX_MIDDLE_FRAMES, MIDDLE_GAP, defaultMiddleTime, clampMiddleTime, snapToNearest,
} from "./stubelius_middle_frames.js";
import { MAX_CUES, clipFrames, cueSeconds, isCueFile, cueKindOf, clampCueTime, clipGridOffset } from "./stubelius_cues.js";
import { CARRY } from "./stubelius_director_shared.js";
import {
  uploadFile, isVideoFile, isImageFile, pictureUrl, clipStill, extractAudioPeaks, videoSeconds, drawPeaks, pickFile, dropTarget,
} from "./stubelius_director_media.js";

let styled = false;
function injectStyles() {
  if (styled) return;
  styled = true;
  document.head.appendChild(h("style", { id: "stubelius-uh3-timeline", text: CSS }));
}

export function buildTimeline(d) {
  injectStyles();
  const box = clear(d.tl);
  const dur = Math.max(0.1, d.durationSeconds);
  const bounds = d.bounds();
  const pct = (t) => `${Math.max(0, Math.min(100, (t / dur) * 100))}%`;
  const grid = h("div.t-grid");
  const rows = [];
  const row = (headEl, laneEl, cls) => {
    grid.append(h(`div.t-head${cls ? "." + cls : ""}`, headEl), h(`div.t-area${cls ? "." + cls : ""}`, laneEl));
    rows.push(laneEl);
  };

  // ruler: whole seconds at a step that fits
  const step = dur <= 12 ? 1 : dur <= 30 ? 2 : dur <= 60 ? 5 : 10;
  const ruler = h("div.t-in.t-ruler");
  for (let t = 0; t <= dur + 1e-6; t += step) {
    const last = t + step > dur + 1e-6;
    ruler.appendChild(h("span.t-tick", { style: { left: pct(t) }, class: t === 0 ? "first" : last ? "last" : null },
      t === 0 ? "0s" : last && Math.abs(t - dur) < 0.01 ? `${Math.round(t)}s` : String(Math.round(t * 10) / 10)));
  }
  if (Math.abs((Math.floor(dur / step) * step) - dur) > 0.05) {
    ruler.appendChild(h("span.t-tick.last", { style: { left: "100%" } }, `${dur.toFixed(1)}s`));
  }
  ruler.addEventListener("pointerdown", (e) => {
    const r = ruler.getBoundingClientRect();
    d.preview.seek(((e.clientX - r.left) / r.width) * dur);
  });
  row(null, ruler, "ruler");

  // a middle frame, a sound or a clip lands at the playhead (or drop them on the lane at a second)
  const at = () => Math.max(0, Math.min(dur, Number(d.preview?.time) || 0));
  const plus = (title, fn) => {
    const b = iconButton("plus", title, fn);
    b.classList.add("t-add");
    return b;
  };
  if (!d.isReference) {
    const addMiddle = plus("Add a middle frame at the playhead (or drop pictures on the lane)", async () => {
      if (d.middleFrames().length >= MAX_MIDDLE_FRAMES) {
        toast(d.root, `Up to ${MAX_MIDDLE_FRAMES} middle frames: remove one first.`);
        return;
      }
      const f = await pickFile("image/*");
      const t = at();
      if (f) setMiddle(d, null, f, t > MIDDLE_GAP && t < dur - MIDDLE_GAP ? Math.round(t * 10) / 10 : null);
    });
    row(h("div.t-headin", trackHead("photo", "k", "Keyframes"), addMiddle), keyframeLane(d, dur, bounds, pct), "kf");
  }
  row(trackHead("lines", "ac", "Shots"), shotLane(d, dur, bounds, pct), "shots");
  if (!d.isReference) {
    const addSound = plus("Pin a sound or a short clip at the playhead (or drop it on the lane)", async () => {
      const f = await pickFile("audio/*,video/*");
      if (f && isCueFile(f)) addCue(d, f, at());
    });
    row(h("div.t-headin", trackHead("wave", "snd", "Sound"), addSound), soundLane(d, dur, bounds, pct), "snd");
  } else {
    row(trackHead("wave", "snd", "Sound"), soundLane(d, dur, bounds, pct), "snd");
  }
  const addChunk = iconButton("plus", "Add a chunk at the end (the length grows by one chunk size)", () => d.addChunk());
  addChunk.classList.add("t-add");
  row(h("div.t-headin", trackHead("columns", "cut", "Chunks"), addChunk), chunkLane(d, dur, bounds, pct), "chunks");

  // the lines behind every lane, one per ruler step
  const lines = h("div.t-lines", { style: { backgroundSize: `calc(100% / ${Math.max(1, dur / step)}) 100%` } });
  const playhead = h("div.t-playhead");
  box.append(h("div.t-wrap", grid, lines, playhead));
  d.onPlayhead = (t) => {
    playhead.style.left = `calc(148px + 24px + (100% - 148px - 48px) * ${Math.max(0, Math.min(1, t / dur))})`;
    playhead.style.display = "block";
  };
  d.onPlayhead(d.preview?.time || 0);
}

function trackHead(ic, kind, text) {
  return h("div.t-trk", h(`span.sh3-ico.${kind}`, icon(ic, 16)), text);
}

// ------------------------------------------------------------------------------------------- keyframes

function keyframeLane(d, dur, bounds, pct) {
  const lane = h("div.t-in.t-kf");
  const first = d.timeline.characters[0];
  const last = d.timeline.characters[1];
  const clip = d.timeline.source_clip;
  const thumb = (url, extra) => {
    const t = h("div.t-kf-t");
    if (url) t.appendChild(h("img", { src: url, draggable: false }));
    if (extra) t.appendChild(extra);
    return t;
  };

  // the first frame (or the clip the video continues), the last frame
  if (clip) {
    const m = h("button.t-kf-m.start.clip", { type: "button", title: `${clip.fileName || clip.file}: the video continues this clip from its last frame`,
      onclick: (e) => menu(e.currentTarget, [
        { label: "Another clip or a first frame…", icon: "upload", onClick: () => pickFirst(d) },
        { label: "Remove the clip", icon: "trash", danger: true, onClick: () => { delete d.timeline.source_clip; d.touched(0); d.refresh(); } },
      ]) }, thumb(null, clipStill(clip)), h("small", "Clip · continues it"));
    lane.appendChild(m);
  } else if (first && (first.file || first.image_b64)) {
    lane.appendChild(h("button.t-kf-m.start", { type: "button", title: "First frame",
      onclick: (e) => menu(e.currentTarget, [
        { label: "Another picture or a clip…", icon: "upload", onClick: () => pickFirst(d) },
        { label: "Remove the first frame", icon: "trash", danger: true, onClick: () => { d.timeline.characters[0] = null; d.touched(0); d.refresh(); } },
      ]) }, thumb(pictureUrl(first)), h("small", "First · 0.0 s")));
  } else {
    const slot = h("button.t-kf-slot.start", { type: "button", title: "The picture the video opens on, or a clip it continues",
      onclick: () => pickFirst(d) }, icon("plus", 16), "First frame");
    dropTarget(slot, (file) => setFirst(d, file));
    lane.appendChild(slot);
  }
  if (last && (last.file || last.image_b64)) {
    lane.appendChild(h("button.t-kf-m.end", { type: "button", title: "Last frame",
      onclick: (e) => menu(e.currentTarget, [
        { label: "Another picture…", icon: "upload", onClick: async () => { const f = await pickFile("image/*"); if (f) setPicture(d, 1, f); } },
        { label: "Remove the last frame", icon: "trash", danger: true, onClick: () => { d.timeline.characters[1] = null; d.touched(bounds.length - 1); d.refresh(); } },
      ]) }, thumb(pictureUrl(last)), h("small", `Last · ${dur.toFixed(1)} s`)));
  } else {
    const slot = h("button.t-kf-slot.end", { type: "button", title: "The picture the video ends on",
      onclick: async () => { const f = await pickFile("image/*"); if (f) setPicture(d, 1, f); } }, icon("plus", 16), "Last frame");
    dropTarget(slot, (file) => setPicture(d, 1, file));
    lane.appendChild(slot);
  }

  // middle frames; the one opening a new shot in the cut colour
  const list = d.middleFrames();
  const openers = new Set();
  bounds.forEach(([s], k) => {
    if (k === 0 || d.timeline.chunks[k]?.carry !== "new_shot") return;
    const hit = list.find((m) => m.time >= s - 0.25 && m.time <= s + 0.5);
    if (hit) openers.add(hit);
  });
  list.forEach((mf, i) => {
    const opener = openers.has(mf);
    const lab = h("small", opener ? `Opens new shot · ${mf.time.toFixed(1)} s` : `M${i + 1} · ${d.formatTime(mf.time)}`);
    const m = h("div.t-kf-m.mid", { class: opener ? "cutkf" : null, style: { left: pct(mf.time) },
      title: `Middle frame ${i + 1}: drag to change when the video reaches it, click for more` },
    thumb(pictureUrl(mf)), lab);
    let moved = false;
    m.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = lane.getBoundingClientRect();
      const x0 = e.clientX;
      moved = false;
      try { m.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic event */ }
      const onMove = (ev) => {
        if (Math.abs(ev.clientX - x0) > 3) moved = true;
        if (!moved) return;
        const t = ((ev.clientX - r.left) / r.width) * dur;
        mf.time = clampMiddleTime(list, i, Math.min(dur - MIDDLE_GAP, Math.max(MIDDLE_GAP, t)), dur);
        m.style.left = pct(mf.time);
        lab.textContent = `M${i + 1} · ${d.formatTime(mf.time)}`;
      };
      const onUp = () => {
        m.removeEventListener("pointermove", onMove);
        m.removeEventListener("pointerup", onUp);
        if (moved) {
          d.middleFrames();
          d.touched(d.chunkOf(mf.time));
          d.refresh(["tl", "insp"]);
        } else {
          middleMenu(d, m, mf, i);
        }
      };
      m.addEventListener("pointermove", onMove);
      m.addEventListener("pointerup", onUp);
    });
    dropTarget(m, (file) => isImageFile(file) && setMiddle(d, mf, file, null));
    lane.appendChild(m);
  });
  if (list.length < MAX_MIDDLE_FRAMES && !list.length) {
    lane.appendChild(h("div.t-hint", "Drop pictures here: middle frames the video passes through, at that second"));
  }
  dropTarget(lane, (file, e) => {
    const r = lane.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * dur;
    if (t < MIDDLE_GAP * 0.6) return setFirst(d, file);
    if (isCueFile(file)) return addCue(d, file, t);
    if (!isImageFile(file)) return;
    if (t > dur - MIDDLE_GAP * 0.6) return setPicture(d, 1, file);
    setMiddle(d, null, file, Math.round(Math.min(dur - MIDDLE_GAP, Math.max(MIDDLE_GAP, t)) * 10) / 10);
  });
  return lane;
}

function middleMenu(d, anchor, mf, i) {
  menu(anchor, [
    { label: "Another picture…", icon: "upload", onClick: async () => { const f = await pickFile("image/*"); if (f) setMiddle(d, mf, f, null); } },
    { label: `Set the second… (now ${mf.time.toFixed(2)} s)`, icon: "clock", onClick: () => {
      const v = parseFloat(prompt(`When does the video reach middle frame ${i + 1}? Seconds from the start:`, mf.time.toFixed(2)));
      if (!Number.isFinite(v)) return;
      mf.time = Math.min(d.durationSeconds - MIDDLE_GAP, Math.max(MIDDLE_GAP, v));
      d.middleFrames();
      d.touched(d.chunkOf(mf.time));
      d.refresh(["tl", "insp"]);
    } },
    null,
    { label: "Remove this middle frame", icon: "trash", danger: true, onClick: () => {
      const live = d.middleFrames();
      const at = live.indexOf(mf);
      if (at >= 0) live.splice(at, 1);
      d.touched(d.chunkOf(mf.time));
      d.refresh(["tl", "insp", "foot"]);
    } },
  ]);
}

async function pickFirst(d) {
  const f = await pickFile("image/*,video/*");
  if (f) setFirst(d, f);
}

// The first frame: a picture opens the video, a video clip is continued from its last frame
async function setFirst(d, file) {
  try {
    if (isVideoFile(file)) {
      const up = await uploadFile(file);
      d.timeline.source_clip = { file: up.file, fileName: up.fileName };
      d.timeline.characters[0] = null;
      snapClipCues(d);
    } else if (isImageFile(file)) {
      if (d.timeline.source_clip) {
        delete d.timeline.source_clip;
        snapClipCues(d);
      }
      const up = await uploadFile(file);
      d.timeline.characters[0] = { ...up, description: "" };
    } else {
      return;
    }
    d.touched(0);
    d.refresh();
  } catch (err) {
    console.error("[Stubelius Director] upload failed", err);
    toast(d.root, "Upload failed: see the console", "bad");
  }
}

export async function setPicture(d, slot, file) {
  try {
    const up = await uploadFile(file);
    d.timeline.characters[slot] = { ...up, description: "" };
    d.touched(slot === 1 ? d.numChunks() - 1 : 0);
    d.refresh();
  } catch (err) {
    console.error("[Stubelius Director] upload failed", err);
    toast(d.root, "Upload failed: see the console", "bad");
  }
}

// entry = the middle frame whose picture is swapped (its second stays), or null for a new one at `time`
async function setMiddle(d, entry, file, time) {
  if (!entry && d.middleFrames().length >= MAX_MIDDLE_FRAMES) {
    toast(d.root, `Up to ${MAX_MIDDLE_FRAMES} middle frames: remove one first.`);
    return;
  }
  try {
    const up = await uploadFile(file);
    const list = d.middleFrames();
    if (entry && list.includes(entry)) Object.assign(entry, up);
    else if (list.length < MAX_MIDDLE_FRAMES) list.push({ ...up, time: time ?? defaultMiddleTime(list, d.durationSeconds) });
    d.middleFrames();
    d.touched(d.chunkOf(time ?? entry?.time ?? 0));
    d.refresh(["tl", "insp", "foot", "preview"]);
  } catch (err) {
    console.error("[Stubelius Director] middle frame upload failed", err);
    toast(d.root, "Upload failed: see the console", "bad");
  }
}

// ------------------------------------------------------------------------------------------- shots

function shotLane(d, dur, bounds, pct) {
  const lane = h("div.t-in.t-shots");
  bounds.forEach(([s, e], k) => {
    const chunk = d.timeline.chunks[k];
    if (!chunk) return;
    const total = chunk.segments.reduce((a, x) => a + (x.weight || 1), 0) || 1;
    let t = s;
    chunk.segments.forEach((seg, i) => {
      const len = ((seg.weight || 1) / total) * (e - s);
      const text = (seg.prompt || "").trim().split("\n")[0];
      const dialogue = /"[^"]+"|“[^”]+”/.test(text);
      const blk = h("div.t-blk.t-shot", {
        class: [k === d.sel ? "sel" : "", k === d.sel && d.selShot === i ? "focus" : ""].join(" ").trim() || null,
        style: { left: pct(t), width: `calc(${(len / dur) * 100}% - 6px)` },
        title: text || `Shot ${i + 1} of chunk ${k + 1}: empty`,
      }, icon(dialogue ? "message" : chunk.carry === "new_shot" && k > 0 && i === 0 ? "cut" : "lines", 14),
      h("span", text ? text.replace(/^"|"$/g, "") : `Shot ${i + 1}`));
      blk.addEventListener("click", () => {
        d.selShot = i;
        if (d.sel !== k) d.select(k);
        else d.refresh(["tl", "insp"]);
        setTimeout(() => d.insp.querySelectorAll(".i-cut-text")[i]?.focus(), 0);
      });
      if (i < chunk.segments.length - 1) {
        const handle = h("div.t-edge", { title: "Drag to time the cut between these shots" });
        handle.addEventListener("pointerdown", (ev) => startResize(d, ev, lane, k, i, dur));
        handle.addEventListener("click", (ev) => ev.stopPropagation());
        blk.appendChild(handle);
      }
      lane.appendChild(blk);
      t += len;
    });
  });
  return lane;
}

// The edge between shots i and i+1 of chunk k, dragged; in First/Last Frame mode it snaps to a middle frame
function startResize(d, e, lane, k, i, dur) {
  e.preventDefault();
  e.stopPropagation();
  const chunk = d.timeline.chunks[k];
  const [cs, ce] = d.bounds()[k];
  const span = Math.max(0.001, ce - cs);
  const a = chunk.segments[i], b = chunk.segments[i + 1];
  const total = chunk.segments.reduce((s, x) => s + (x.weight || 1), 0);
  const pair = (a.weight || 1) + (b.weight || 1);
  const before = chunk.segments.slice(0, i).reduce((s, x) => s + (x.weight || 1), 0);
  const snaps = d.isReference ? [] : d.middleFrames().map((m) => m.time - cs).filter((t) => t > 0 && t < span);
  const r = lane.getBoundingClientRect();
  const target = e.currentTarget;
  try { target.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic event */ }
  const onMove = (ev) => {
    let edge = ((ev.clientX - r.left) / r.width) * dur - cs;
    if (snaps.length) edge = snapToNearest(edge, snaps, (8 / r.width) * dur);
    let wa = (edge / span) * total - before;
    wa = Math.max(0.15, Math.min(pair - 0.15, wa));
    a.weight = wa;
    b.weight = pair - wa;
    buildTimelineFast(d);
  };
  const onUp = () => {
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", onUp);
    d.touched(k);
    d.refresh(["tl", "insp"]);
  };
  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", onUp);
}

// while dragging: move the shot blocks only
function buildTimelineFast(d) {
  const lane = d.tl.querySelector(".t-shots");
  if (!lane) return;
  const dur = Math.max(0.1, d.durationSeconds);
  const fresh = shotLane(d, dur, d.bounds(), (t) => `${Math.max(0, Math.min(100, (t / dur) * 100))}%`);
  const blocks = fresh.querySelectorAll(".t-blk");
  lane.querySelectorAll(".t-blk").forEach((old, j) => {
    if (blocks[j]) { old.style.left = blocks[j].style.left; old.style.width = blocks[j].style.width; }
  });
}

// ------------------------------------------------------------------------------------------- sound

function soundLane(d, dur, bounds, pct) {
  const lane = h("div.t-in.t-snd");
  if (d.isReference) {
    const rec = (d.timeline.refAudios || []).find((a) => a && a.retention === "fully_copy");
    if (rec && Array.isArray(rec.waveformPeaks)) {
      const from = Number(rec.trimStartSec) || 0;
      const to = rec.trimEndSec ?? rec.sourceDurationSec ?? from + 1;
      const len = Math.max(0.1, to - from);
      const all = rec.waveformPeaks;
      const src = Number(rec.sourceDurationSec) || len;
      const peaks = all.slice(Math.floor((from / src) * all.length), Math.ceil((to / src) * all.length));
      const canvas = h("canvas.t-wave", { width: 1200, height: 40 });
      const blk = h("div.t-blk.t-sound.rec", { style: { left: "0%", width: `calc(${Math.min(100, (len / dur) * 100)}% - 4px)` },
        title: `Lip Sync: ${rec.fileName || rec.file}` }, canvas, icon("mic", 14), h("span", `Lip Sync · ${rec.fileName || "recording"}`));
      requestAnimationFrame(() => drawPeaks(canvas, peaks, `rgba(${getComputedStyle(d.root).getPropertyValue("--snd").trim() || "63,213,255"},.6)`));
      lane.appendChild(blk);
    } else {
      lane.appendChild(h("div.t-hint", "Voices and a Lip Sync recording come from the reference audio in Cast below"));
    }
    return lane;
  }
  const list = d.cues();
  list.forEach((cue) => {
    const k = d.chunkOf(cue.time);
    const end = bounds[k][1];
    const runsOn = cue.time + cueSeconds(cue) > end + 0.01;
    const blk = h("div.t-blk.t-sound", { class: [cue.kind === "clip" ? "clip" : "", runsOn ? "runs-on" : ""].join(" ").trim() || null,
      style: { left: pct(cue.time), width: `calc(${Math.max(1.2, (cueSeconds(cue) / dur) * 100)}% - 2px)` },
      title: `${cue.fileName || cue.file}: drag to move it`
        + (cue.kind === "clip" ? " (a clip starts on H3's 17-frame grid, every 0.71 s)" : "")
        + (runsOn ? " (it plays on into the next chunk)" : "") });
    if (cue.kind === "sound" && Array.isArray(cue.peaks)) {
      const canvas = h("canvas.t-wave", { width: 240, height: 40 });
      blk.appendChild(canvas);
      requestAnimationFrame(() => drawPeaks(canvas, cue.peaks, "rgba(255,255,255,.35)"));
    }
    if (cue.kind === "clip") {
      const still = clipStill(cue, null, true);
      still.className = "t-still";
      blk.appendChild(still);
    }
    const lab = h("span", `${cue.kind === "clip" ? `${clipFrames(cue.seconds)} frames` : `${cueSeconds(cue).toFixed(1)} s`} · ${cue.fileName || "sound"}`);
    blk.append(icon(cue.kind === "clip" ? "movie" : "mic", 14), lab);
    const del = h("button.t-x", { type: "button", title: "Remove" }, icon("x", 12));
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const at = list.indexOf(cue);
      if (at >= 0) list.splice(at, 1);
      d.touched(k);
      d.refresh(["tl", "foot"]);
    });
    blk.appendChild(del);
    if (cue.kind === "clip") {
      const snd = h("button.t-x.t-snd-btn", { type: "button", title: cue.sound === false ? "Its own sound is off: click to pin it too" : "Its own sound is pinned with it: click to leave it out" },
        icon(cue.sound === false ? "volumeOff" : "volume", 12));
      snd.addEventListener("pointerdown", (e) => e.stopPropagation());
      snd.addEventListener("click", (e) => { e.stopPropagation(); cue.sound = cue.sound === false; d.touched(k); d.refresh(["tl"]); });
      blk.appendChild(snd);
    }
    blk.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = lane.getBoundingClientRect();
      const grab = ((e.clientX - r.left) / r.width) * dur - cue.time;
      try { blk.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic event */ }
      const onMove = (ev) => {
        const t = ((ev.clientX - r.left) / r.width) * dur - grab;
        cue.time = clampCueTime(cue, Math.max(0, Math.min(dur - 0.1, t)), d.bounds(), dur, gridOffset(d));
        blk.style.left = pct(cue.time);
      };
      const onUp = () => {
        blk.removeEventListener("pointermove", onMove);
        blk.removeEventListener("pointerup", onUp);
        d.cues();
        d.touched(d.chunkOf(cue.time));
        d.refresh(["tl"]);
      };
      blk.addEventListener("pointermove", onMove);
      blk.addEventListener("pointerup", onUp);
    });
    lane.appendChild(blk);
  });
  if (!list.length) lane.appendChild(h("div.t-hint", "Drop a sound (a line, an effect, music) or a short clip here to pin it at that second"));
  dropTarget(lane, (file, e) => {
    const r = lane.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * dur;
    if (isCueFile(file)) return addCue(d, file, t);
    if (isImageFile(file)) return setMiddle(d, null, file, Math.round(Math.min(dur - MIDDLE_GAP, Math.max(MIDDLE_GAP, t)) * 10) / 10);
  });
  return lane;
}

// Clips start on H3's 17-frame groups; a video that continues a clip opens on carried frames
function gridOffset(d) {
  return d.timeline.source_clip ? clipGridOffset(22) : 0;
}

function snapClipCues(d) {
  const b = d.bounds();
  for (const cue of d.cues()) {
    if (cue.kind === "clip") cue.time = clampCueTime(cue, cue.time, b, d.durationSeconds, gridOffset(d));
  }
}

async function addCue(d, file, t) {
  const list = d.cues();
  if (list.length >= MAX_CUES) {
    toast(d.root, `Up to ${MAX_CUES} sounds and clips: remove one first.`);
    return;
  }
  try {
    const kind = cueKindOf(file);
    const up = await uploadFile(file);
    const cue = { kind, file: up.file, fileName: up.fileName, time: 0, seconds: 0 };
    if (kind === "sound") {
      try {
        const { peaks, duration } = await extractAudioPeaks(file, 60);
        cue.peaks = peaks.map((p) => Math.round(p * 1000) / 1000);
        cue.seconds = Math.round(duration * 1000) / 1000;
      } catch (err) {
        console.warn("[Stubelius Director] could not read the sound's length", err);
      }
    } else {
      cue.sound = true;
      cue.seconds = await videoSeconds(file);
    }
    cue.time = clampCueTime(cue, t, d.bounds(), d.durationSeconds, gridOffset(d));
    list.push(cue);
    d.cues();
    d.touched(d.chunkOf(cue.time));
    d.refresh(["tl", "foot"]);
  } catch (err) {
    console.error("[Stubelius Director] sound/clip upload failed", err);
    toast(d.root, "Upload failed: see the console", "bad");
  }
}

// ------------------------------------------------------------------------------------------- chunks

function chunkLane(d, dur, bounds, pct) {
  const lane = h("div.t-in.t-chunks");
  bounds.forEach(([s, e], k) => {
    const chunk = d.timeline.chunks[k];
    const t = d.takesOf(k);
    let state = "";
    if (t.current) {
      const n = t.list.indexOf(t.current) + 1;
      state = t.list.length > 1 ? `take ${n}` : "";
    } else if (d.report) {
      state = "not rendered";
    }
    if (k > 0 && chunk?.carry === "new_shot") state = state ? `new shot · ${state}` : "new shot";
    const blk = h("button.t-chk", { type: "button", class: k === d.sel ? "sel" : null,
      style: { left: k ? `calc(${pct(s)} + 22px)` : "0%", width: `calc(${((e - s) / dur) * 100}% - ${k ? 44 : 22}px)` },
      title: `Chunk ${k + 1}: ${s.toFixed(1)} – ${e.toFixed(1)} s` + (d.hasOwnSeed(k) ? ` · own seed ${d.seedOf(k)}` : ""),
      onclick: () => d.select(k) },
    h("b", String(k + 1)), h("span", `Chunk ${k + 1}${state ? " · " + state : ""}`),
    d.hasOwnSeed(k) ? icon("lock", 13, "t-lock") : null);
    if (k === bounds.length - 1) blk.style.width = `calc(${((e - s) / dur) * 100}% - ${k ? 22 : 0}px)`;
    lane.appendChild(blk);
    if (k > 0) {
      const mode = CARRY.find((c) => c[0] === chunk?.carry) || CARRY[0];
      const badge = h("button.t-jb", { type: "button", class: mode[0] === "new_shot" ? "a" : mode[0] === "off" ? "o" : "c",
        style: { left: `calc(${pct(s)} - 17px)` }, title: `How chunk ${k + 1} joins chunk ${k}: ${mode[1]} (click to change)` }, icon(mode[2], 17));
      badge.addEventListener("click", (ev) => {
        ev.stopPropagation();
        menu(badge, CARRY.map(([id, text, ic, tip]) => ({ label: text, icon: ic, hint: id === chunk.carry ? "now" : "",
          onClick: () => { chunk.carry = id; d.touched(k); d.refresh(["tl", "insp"]); } })));
      });
      lane.appendChild(badge);
    }
  });
  return lane;
}

const CSS = `
.sh3-d .d-tl{padding:0;overflow:hidden}
.sh3-d .t-wrap{position:relative}
.sh3-d .t-grid{display:grid;grid-template-columns:148px minmax(0,1fr);position:relative;z-index:1}
.sh3-d .t-head{border-right:1px solid var(--stroke);background:var(--well);display:flex;align-items:center;padding:0 14px 0 18px;min-width:0}
.sh3-d .t-area{position:relative;min-width:0}
.sh3-d .t-area.ruler,.sh3-d .t-head.ruler{height:40px}
.sh3-d .t-area.kf,.sh3-d .t-head.kf{height:96px}
.sh3-d .t-area.shots,.sh3-d .t-head.shots{height:56px}
.sh3-d .t-area.snd,.sh3-d .t-head.snd{height:58px}
.sh3-d .t-area.chunks,.sh3-d .t-head.chunks{height:70px}
.sh3-d .t-in{position:absolute;left:24px;right:24px;top:0;bottom:0}
.sh3-d .t-trk{display:flex;align-items:center;gap:10px;color:var(--text2);font-weight:500;white-space:nowrap}
.sh3-d .t-headin{display:flex;align-items:center;justify-content:space-between;width:100%;gap:6px}
.sh3-d .t-add{width:28px;height:28px;border-radius:9px}
.sh3-d .t-ruler{top:14px;height:22px;cursor:pointer}
.sh3-d .t-tick{position:absolute;top:0;transform:translateX(-50%);color:var(--text3);font-family:var(--fh);font-size:12px;white-space:nowrap}
.sh3-d .t-tick.first{transform:none}
.sh3-d .t-tick.last{transform:translateX(-100%)}
.sh3-d .t-lines{position:absolute;left:172px;right:24px;top:40px;bottom:10px;z-index:0;pointer-events:none;
  background-image:linear-gradient(90deg,var(--stroke) 1px,transparent 1px)}
.sh3-d .t-playhead{position:absolute;top:36px;bottom:12px;width:2px;margin-left:-1px;z-index:3;pointer-events:none;display:none;
  background:linear-gradient(180deg,#fff,rgb(var(--ac)));box-shadow:0 0 14px rgb(var(--ac))}
.sh3-d .t-playhead:before{content:"";position:absolute;top:-8px;left:-6px;width:14px;height:14px;border-radius:4px;background:#fff;transform:rotate(45deg);
  box-shadow:0 0 16px rgb(var(--ac))}
.sh3-d .t-hint{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;color:var(--text3);font-size:12px;pointer-events:none}
.sh3-d .t-in.over{background:rgba(var(--ac),.06);outline:1.5px dashed rgba(var(--ac),.6);outline-offset:2px;border-radius:12px}
/* keyframes */
.sh3-d .t-kf{top:6px;bottom:6px}
.sh3-d .t-kf-m{position:absolute;top:0;display:flex;flex-direction:column;align-items:center;gap:5px;background:none;border:0;padding:0;
  transform:translateX(-50%);z-index:2;cursor:pointer;color:var(--text2)}
.sh3-d .t-kf-m.start{left:0;transform:none;align-items:flex-start}
.sh3-d .t-kf-m.end{right:0;left:auto;transform:none;align-items:flex-end}
.sh3-d .t-kf-m.mid{cursor:grab;touch-action:none}
.sh3-d .t-kf-m.mid:active{cursor:grabbing;z-index:4}
.sh3-d .t-kf-t{width:96px;height:56px;border-radius:11px;overflow:hidden;border:1.5px solid rgba(var(--k),.75);background:#000;
  box-shadow:0 8px 24px rgba(0,0,0,.35),0 0 18px rgba(var(--k),.25)}
.sh3-d .t-kf-t img,.sh3-d .t-kf-t video{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.sh3-d .t-kf-m small{font-size:11px;color:var(--text2);font-weight:500;white-space:nowrap}
.sh3-d .t-kf-m.cutkf .t-kf-t{border-color:rgb(var(--cut));box-shadow:0 8px 24px rgba(0,0,0,.35),0 0 22px rgba(var(--cut),.35)}
.sh3-d .t-kf-m.cutkf small{color:rgb(var(--cut))}
.sh3-d .t-kf-m.clip .t-kf-t{border-color:rgba(var(--ok),.8);box-shadow:0 8px 24px rgba(0,0,0,.35),0 0 18px rgba(var(--ok),.25)}
.sh3-d .t-kf-m:hover .t-kf-t{filter:brightness(1.12)}
.sh3-d .t-kf-slot{position:absolute;top:0;width:96px;height:56px;border-radius:11px;border:1.5px dashed var(--stroke2);background:var(--well);
  color:var(--text3);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:11px;font-weight:500}
.sh3-d .t-kf-slot.start{left:0} .sh3-d .t-kf-slot.end{right:0}
.sh3-d .t-kf-slot:hover,.sh3-d .t-kf-slot.over{border-color:rgba(var(--k),.8);color:var(--text)}
/* blocks */
.sh3-d .t-shots,.sh3-d .t-snd{top:8px;bottom:8px}
.sh3-d .t-blk{position:absolute;top:0;height:40px;border-radius:11px;padding:0 12px;display:flex;align-items:center;gap:8px;white-space:nowrap;
  overflow:hidden;font-weight:500;min-width:8px}
.sh3-d .t-blk>span{overflow:hidden;text-overflow:ellipsis;min-width:0}
.sh3-d .t-blk .sh3-ic{opacity:.85}
.sh3-d .t-shot{background:linear-gradient(180deg,rgba(var(--ac),.16),rgba(var(--ac),.08));border:1px solid rgba(var(--ac),.38);cursor:pointer;overflow:visible}
.sh3-d .t-shot>span{overflow:hidden}
.sh3-d .t-shot.sel{background:linear-gradient(180deg,rgba(var(--ac),.30),rgba(var(--ac2),.14));border-color:rgba(var(--ac),.8)}
.sh3-d .t-shot.focus{box-shadow:0 0 0 2px rgba(var(--ac),.55),0 0 22px rgba(var(--ac),.35)}
.sh3-d .t-edge{position:absolute;top:-2px;bottom:-2px;right:-7px;width:10px;cursor:ew-resize;z-index:3;border-radius:4px;touch-action:none}
.sh3-d .t-edge:hover{background:rgba(var(--ac),.5)}
.sh3-d .t-sound{background:color-mix(in srgb,rgb(var(--snd)) 16%,var(--in-b));border:1px solid rgba(var(--snd),.5);cursor:grab;touch-action:none}
.sh3-d .t-sound.clip{background:color-mix(in srgb,rgb(var(--k)) 16%,var(--in-b));border-color:rgba(var(--k),.55);padding-left:52px}
.sh3-d .t-sound.runs-on{border-right-style:dashed}
.sh3-d .t-sound.rec{cursor:default;--snd-line:rgba(var(--snd),.55)}
.sh3-d .t-sound .t-wave{position:absolute;inset:0;width:100%;height:100%;opacity:.7;pointer-events:none}
.sh3-d .t-sound>.sh3-ic,.sh3-d .t-sound>span{position:relative}
.sh3-d .t-still{position:absolute;left:0;top:0;height:100%;width:46px;object-fit:cover;pointer-events:none}
.sh3-d .t-x{position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;border:0;background:rgba(0,0,0,.6);color:#fff;
  display:none;place-items:center;padding:0;z-index:2}
.sh3-d .t-snd-btn{right:24px}
.sh3-d .t-sound:hover .t-x{display:grid}
/* chunks */
.sh3-d .t-chunks{top:8px;bottom:12px}
.sh3-d .t-chk{position:absolute;top:0;height:46px;border-radius:13px;display:flex;align-items:center;justify-content:center;gap:9px;
  font-family:var(--fh);font-weight:600;font-size:15px;background:var(--glass);border:1px solid var(--stroke2);color:var(--text);padding:0 10px;
  white-space:nowrap;overflow:hidden}
.sh3-d .t-chk>span{overflow:hidden;text-overflow:ellipsis}
.sh3-d .t-chk:hover{border-color:rgba(var(--ac),.5)}
.sh3-d .t-chk.sel{background:linear-gradient(110deg,rgba(var(--ac),.24),rgba(var(--ac2),.12));border:1.5px solid rgba(var(--ac),.85);box-shadow:0 0 30px rgba(var(--ac),.25)}
.sh3-d .t-chk b{font-weight:600;color:var(--text2)}
.sh3-d .t-lock{color:var(--text3)}
.sh3-d .t-jb{position:absolute;top:6px;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;z-index:2;background:var(--in-b);padding:0}
.sh3-d .t-jb.c{border:1.5px solid rgb(var(--snd));color:rgb(var(--snd));box-shadow:0 0 16px rgba(var(--snd),.5)}
.sh3-d .t-jb.a{border:1.5px solid rgb(var(--cut));color:rgb(var(--cut));box-shadow:0 0 16px rgba(var(--cut),.5)}
.sh3-d .t-jb.o{border:1.5px solid var(--stroke2);color:var(--text2)}
.sh3-d .t-jb:hover{transform:scale(1.08)}
`;
