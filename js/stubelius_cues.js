// Sounds and clips on the timeline (First/Last Frame mode): the rules for timeline_data.cues, kept
// apart from the Director so they can be tested on their own. A cue is
//   {kind: "sound" | "clip", file, fileName, time, seconds, peaks?, sound?}
// time = the second of the whole video it starts at, seconds = the file's own length. A clip is
// pinned from its first frame for as many frames as H3's grid allows (5, 22, 39, ... = 17k + 5),
// starts on one of H3's 17-frame groups and stays inside one chunk; a sound may run on into the next
// chunk. See stubelius_cues.py.

export const MAX_CUES = 8;
export const CLIP_GRID = 17;
const FPS = 24;

// The first group start on the video's clock, in frames: 0, or where the groups fall when the video
// continues a clip and opens on `carryFrames` carried-over frames (12 for 22 or 39)
export function clipGridOffset(carryFrames) {
  const n = Math.max(0, Math.round(Number(carryFrames) || 0));
  return (CLIP_GRID - (n % CLIP_GRID)) % CLIP_GRID;
}

// Frames of a clip `seconds` long that H3 pins: 5, 22, 39, ... (1 below 5)
export function clipFrames(seconds) {
  const n = Math.floor(Number(seconds) * FPS + 1e-6);
  if (!(n >= 5)) return 1;
  return n - ((n - 5) % 17);
}

// How long a cue plays on the timeline
export function cueSeconds(cue) {
  if (cue.kind === "clip") return clipFrames(cue.seconds) / FPS;
  return Math.max(0, Number(cue.seconds) || 0);
}

export function isCueFile(file) {
  const type = file?.type || "";
  return type.startsWith("audio/") || type.startsWith("video/")
    || /\.(wav|mp3|flac|ogg|m4a|aac|opus|mp4|webm|mov|mkv|m4v|avi)$/i.test(file?.name || "");
}

export function cueKindOf(file) {
  const type = file?.type || "";
  if (type.startsWith("audio/") || /\.(wav|mp3|flac|ogg|m4a|aac|opus)$/i.test(file?.name || "")) return "sound";
  return "clip";
}

// The cues that count, in time order: at most MAX_CUES, each with a file, a known kind and a start
// inside the video
export function normalizeCues(list, durationSeconds) {
  const dur = Number(durationSeconds) || 0;
  const kept = (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c === "object" && c.file && (c.kind === "sound" || c.kind === "clip")
      && Number.isFinite(Number(c.time)) && Number(c.time) >= 0 && Number(c.time) < dur)
    .map((c) => Object.assign(c, { time: Number(c.time) }))
    .sort((a, b) => a.time - b.time);
  return kept.slice(0, MAX_CUES);
}

// Where a cue may start when it is dragged to `t`: inside the video; a sound on tenths of a second,
// a clip on the nearest start of a 17-frame group (gridOffset = clipGridOffset) inside the chunk it
// starts in (bounds = [[start, end] per chunk]), as far as it fits
export function clampCueTime(cue, t, bounds, durationSeconds, gridOffset = 0) {
  const dur = Number(durationSeconds) || 0;
  const latest = Math.max(0, dur - 0.1);
  const at = Math.min(Math.max(0, Number(t) || 0), latest);
  if (cue.kind === "clip") {
    let [s, e] = [0, dur];
    if (Array.isArray(bounds) && bounds.length) {
      const k = Math.max(0, bounds.findIndex(([a, b]) => at >= a && at < b));
      [s, e] = bounds[k] || bounds[bounds.length - 1];
    }
    const g = CLIP_GRID;
    const o = Number(gridOffset) || 0;
    const first = Math.ceil((s * FPS - o) / g - 1e-6) * g + o;
    const last = Math.floor((e * FPS - clipFrames(cue.seconds) - o) / g + 1e-6) * g + o;
    const f = Math.round((at * FPS - o) / g) * g + o;
    return Math.max(0, last >= first ? Math.min(Math.max(f, first), last) : first) / FPS;
  }
  return Math.min(Math.round(at * 10) / 10, Math.floor(latest * 10 + 1e-6) / 10);
}
