// Stubelius Ultimate H3 Director: what the window's parts share.
export const MAX_CHARACTER_SLOTS = 9;
export const REF_AV_SLOTS = 3;
export const MIN_CUT_SECONDS = 0.3;           // a typed shot length never goes under this
export const MODE_REFERENCE_PREFIX = "Reference (Omni)";
// The Setup mode on FastH3 Omni's checkpoint (stubelius_h3_pipeline.OMNI), not the Director's "Reference (Omni)" input
export const OMNI = "FastH3 Omni";
// The Setup mode on Pika's two LoRAs (stubelius_h3_pipeline.FLEX)
export const FLEX = "Pika H3 Flex";
// The Setup mode on TurboH3's checkpoint, the First/Last model distilled to 4 steps (stubelius_h3_pipeline.TURBOH3)
export const TURBOH3 = "TurboH3";
// The Director input a Setup mode renders (stubelius_h3_pipeline.MODE_INPUT): FastH3 Omni is the Reference model,
// TurboH3 the First/Last one; every other mode renders both. The Setup window and the Director's mode buttons show only
// the modes that fit the Director's input, and switching the input moves an unfitting mode to one that fits.
export const MODE_INPUT = { [OMNI]: "ref", [TURBOH3]: "fl" };
export function modeFits(mode, reference) {
  const only = MODE_INPUT[mode];
  return !only || only === (reference ? "ref" : "fl");
}
// What a mode that doesn't fit the new input becomes: the one used on that input last time (remembered on the Setup
// node), else PDMD (the fastest that renders both), else the first that fits.
export function fittingMode(setup, reference, values) {
  const known = (m) => m && (!values?.length || values.includes(m)) && modeFits(m, reference);
  const last = setup?.properties?.sh3_mode_by_input?.[reference ? "ref" : "fl"];
  if (known(last)) return last;
  if (known("PDMD")) return "PDMD";
  return (values || []).find((m) => modeFits(m, reference)) || "Hybrid";
}

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
export const FLEX_RE = /pika.?h3.?flex/i;

export function isSpeedupLora(name) {
  const file = String(name || "").split(/[\\/]/).pop();
  return SPEEDUP_RE.test(file) || PDMD_RE.test(file) || FLEX_RE.test(file);
}

export function newSeed() {
  return Math.floor(Math.random() * 2 ** 32);
}
