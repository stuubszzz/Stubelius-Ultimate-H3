// Middle frames for the Director's First/Last Frame mode: up to two pictures the video passes through,
// each at its own time in seconds of the whole video, kept in timeline_data "middle_frames"
// ([{file, fileName, time}]). The rules for where they may sit, without any DOM: the Director's
// timeline (muse_minimax_director.js) uses them, and they can be checked outside the browser.

export const MAX_MIDDLE_FRAMES = 2;
export const MIDDLE_GAP = 0.5;   // seconds: from the first and last frame, and between the two

const tenths = (t) => Math.round(t * 10) / 10;

// The middle frames that count, in time order: at most two, each inside the video and at least
// MIDDLE_GAP from the first frame, the last frame and each other. Times are moved as little as
// that needs. Works on the entries themselves and returns them as a new array.
export function normalizeMiddleFrames(list, duration) {
  const kept = (Array.isArray(list) ? list : [])
    .filter((m) => m && typeof m === "object" && m.file && Number.isFinite(Number(m.time)))
    .map((m) => { m.time = Number(m.time); return m; })
    .sort((a, b) => a.time - b.time)
    .slice(0, MAX_MIDDLE_FRAMES);
  const lo = MIDDLE_GAP;
  const hi = duration - MIDDLE_GAP;
  if (hi - lo < MIDDLE_GAP * (kept.length - 1)) {
    // a video too short for them: keep the first one, in the middle
    kept.length = Math.min(kept.length, 1);
    kept.forEach((m) => { m.time = Math.round((duration / 2) * 100) / 100; });
    return kept;
  }
  let floor = lo;
  for (const m of kept) {
    m.time = Math.max(m.time, floor);
    floor = m.time + MIDDLE_GAP;
  }
  let ceiling = hi;
  for (let i = kept.length - 1; i >= 0; i--) {
    kept[i].time = Math.min(kept[i].time, ceiling);
    ceiling = kept[i].time - MIDDLE_GAP;
  }
  kept.forEach((m) => { m.time = Math.round(m.time * 100) / 100; });
  return kept;
}

// Where a new middle frame goes when it is added without a place on the timeline: the middle of the
// longest stretch between the first frame, the frames already there and the last frame.
export function defaultMiddleTime(list, duration) {
  const points = [0, ...list.map((m) => m.time).sort((a, b) => a - b), duration];
  let best = 0;
  for (let i = 1; i < points.length - 1; i++) {
    if (points[i + 1] - points[i] > points[best + 1] - points[best]) best = i;
  }
  return tenths((points[best] + points[best + 1]) / 2);
}

// A time for frame `index` of the sorted list, kept between its neighbours (MIDDLE_GAP away)
// and inside the video; on tenths of a second.
export function clampMiddleTime(list, index, time, duration) {
  const low = index > 0 ? list[index - 1].time + MIDDLE_GAP : MIDDLE_GAP;
  const high = index < list.length - 1 ? list[index + 1].time - MIDDLE_GAP : duration - MIDDLE_GAP;
  return Math.min(high, Math.max(low, tenths(time)));
}

// The chunk a time of the video falls in, by the Director's chunk bounds ([[start, end], ...]):
// a time on a boundary belongs to the chunk that starts there, the end of the video to the last.
export function chunkOfTime(bounds, time) {
  for (let i = 0; i < bounds.length; i++) {
    if (time < bounds[i][1] || i === bounds.length - 1) return i;
  }
  return 0;
}

// `value` moved onto the nearest of `targets` within `threshold`, or left where it is.
export function snapToNearest(value, targets, threshold) {
  let best = null;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d <= threshold && (best === null || d < Math.abs(best - value))) best = t;
  }
  return best === null ? value : best;
}
