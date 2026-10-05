// Sounds and clips on the timeline (First/Last Frame mode): the rules for timeline_data.cues, kept
// apart from the Director so they can be tested on their own. A cue is
//   {kind: "sound" | "clip", file, fileName, time, seconds, peaks?, sound?}
// time = the second of the whole video it starts at, seconds = the file's own length. A clip is
// pinned from its first frame for as many frames as H3's grid allows (5, 22, 39, ... = 17k + 5) and
// stays inside one chunk; a sound may run on into the next chunk. See stubelius_cues.py.

export const MAX_CUES = 8;
const FPS = 24;

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

// Where a cue may start when it is dragged to `t` (tenths of a second): inside the video, and a clip
// inside the chunk it starts in (bounds = [[start, end] per chunk]), as far as it fits
export function clampCueTime(cue, t, bounds, durationSeconds) {
  const dur = Number(durationSeconds) || 0;
  let latest = Math.max(0, dur - 0.1);
  let at = Math.min(Math.max(0, Number(t) || 0), latest);
  if (cue.kind === "clip" && Array.isArray(bounds) && bounds.length) {
    const k = Math.max(0, bounds.findIndex(([s, e]) => at >= s && at < e));
    const [s, e] = bounds[k] || bounds[bounds.length - 1];
    latest = Math.max(s, e - cueSeconds(cue));
    at = Math.min(Math.max(at, s), latest);
  }
  // tenths of a second, never past the latest start (a clip would run out of its chunk)
  return Math.min(Math.round(at * 10) / 10, Math.floor(latest * 10 + 1e-6) / 10);
}
