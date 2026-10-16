// Stubelius Ultimate H3 Director: what the window's parts share.
export const MAX_CHARACTER_SLOTS = 9;
export const REF_AV_SLOTS = 3;
export const MIN_CUT_SECONDS = 0.3;           // a typed shot length never goes under this
export const MODE_REFERENCE_PREFIX = "Reference (Omni)";

// How a chunk follows the one before it (muse_minimax_director.py CARRY_MODES): [id, name, icon, what it does]
export const CARRY = [
  ["picture_sound", "Picture + sound", "link", "The last 1.6 s of picture and sound run on into this chunk."],
  ["picture", "Picture, fresh sound", "photo", "The picture runs on and the sound is made fresh, so voices and breathing stay clear."],
  ["off", "Last frame only", "frame", "Starts from the last frame only: less look drift in PDMD, but motion joins less smoothly."],
  ["new_shot", "New shot", "cut", "A cut: nothing carried over. A middle frame in its first half second opens the shot."],
];
export const CARRY_IDS = new Set(CARRY.map((c) => c[0]));

// A speed-up LoRA by its name: "8step", "4-steps", a known kind; not a training step count ("V16-step00002250").
// One rule for the Setup window's speed-up list and the per-chunk LoRA lists (which leave speed-ups and PDMD out).
export const SPEEDUP_RE = /turbo|lightx2v|taomate|fasth3|distill|lightning|motion.?enhancer|(^|[^0-9])([1-9]|1[0-6])[-_ ]?steps?(?![0-9])/i;
export const PDMD_RE = /pdmd|[0-9]nfe/i;

export function isSpeedupLora(name) {
  const file = String(name || "").split(/[\\/]/).pop();
  return SPEEDUP_RE.test(file) || PDMD_RE.test(file);
}

export function newSeed() {
  return Math.floor(Math.random() * 2 ** 32);
}
