// Stubelius Ultimate H3 Director: the inspector of the chunk you picked.
//
// How it joins the chunk before it, its shots (what happens, timed), its style, soundscape and music,
// its LoRAs, and its takes: every render of it that is kept, the one playing in the video lit; Retake
// renders it again with a new seed, Hunt renders it with 2, 3 or 4, a click on a take picks it back.
import { h, icon, clear, seg, button, iconButton, label, menu, slider, toggle, toast } from "./stubelius_ui.js";
import { CARRY, MIN_CUT_SECONDS, MAX_CHARACTER_SLOTS } from "./stubelius_director_shared.js";

const { api } = window.comfyAPI.api;

const LORAS = { list: null, pending: null };
const LORA_SUM_WARN = 2.0;
const LORA_MAX = 9;
const TURBO_RE = /turbo|lightx2v|taomate|fasth3|distill|lightning|step|pdmd|nfe/i;
const shortName = (n) => (n || "").split(/[\\/]/).pop().replace(/\.safetensors$/i, "");
const folderOf = (n) => { const i = Math.max((n || "").lastIndexOf("\\"), (n || "").lastIndexOf("/")); return i > 0 ? n.slice(0, i).replace(/\\/g, " / ") : "(loras root)"; };

export async function loraList(force = false) {
  if (LORAS.list && !force) return LORAS.list;
  if (!LORAS.pending || force) {
    LORAS.pending = api.fetchApi("/models/loras").then((r) => (r.ok ? r.json() : [])).catch(() => []);
  }
  LORAS.list = await LORAS.pending;
  return LORAS.list;
}

let styled = false;
function injectStyles() {
  if (styled) return;
  styled = true;
  document.head.appendChild(h("style", { id: "stubelius-uh3-inspector", text: CSS }));
}

export function buildInspector(d) {
  injectStyles();
  const box = clear(d.insp);
  const k = d.sel;
  const chunk = d.timeline.chunks[k];
  if (!chunk) return;
  const [start, end] = d.bounds()[k] || [0, d.durationSeconds];
  const n = d.numChunks();

  // head
  const copyBtn = iconButton("copy", "Copy from the chunk before", (e) => menu(e.currentTarget, copyItems(d, k)));
  if (!k) copyBtn.disabled = true;
  box.appendChild(h("div.i-head",
    h("div.i-badge", String(k + 1)),
    h("div.i-headtxt", h("div.sh3-h2", `Chunk ${k + 1}`),
      h("div.sh3-muted", `${start.toFixed(1)} – ${end.toFixed(1)} s · ${chunk.segments.length} shot${chunk.segments.length > 1 ? "s" : ""}`)),
    h("div.sh3-spacer"),
    n > 1 ? h("div.i-nav",
      iconButton("chevronRight", "Next chunk", () => d.select(Math.min(n - 1, k + 1)))) : null,
    copyBtn,
    iconButton("dots", "More", (e) => menu(e.currentTarget, moreItems(d, k))),
  ));
  if (n > 1) box.querySelector(".i-nav").prepend(iconButton("chevronRight", "Chunk before", () => d.select(Math.max(0, k - 1))));

  // how it joins the chunk before it (or the clip the video continues)
  if (k > 0 || d.timeline.source_clip) {
    const sec = h("div.i-sec", label(k > 0 ? `How it joins chunk ${k}` : "How it joins your clip"));
    const grid = h("div.i-joins");
    const hint = h("div.i-hint");
    const draw = () => {
      clear(grid);
      for (const [id, text, ic, tip] of CARRY) {
        grid.appendChild(h("button.i-join", {
          type: "button", class: chunk.carry === id ? "on" : null, title: tip,
          onclick: () => { chunk.carry = id; d.touched(k); draw(); d.refresh(["tl"]); },
        }, icon(ic, 20), h("b", text)));
      }
      hint.textContent = CARRY.find((c) => c[0] === chunk.carry)?.[3] || "";
    };
    draw();
    sec.append(grid, hint);
    box.appendChild(sec);
  }

  box.appendChild(shotsSection(d, k, chunk, end - start));
  box.appendChild(textRows(d, k, chunk));
  if (d.node.comfyClass === "StubeliusH3DirectorV2") box.appendChild(lorasSection(d, k, chunk));
  box.appendChild(takesSection(d, k));
}

function copyItems(d, k) {
  const prev = d.timeline.chunks[k - 1];
  const chunk = d.timeline.chunks[k];
  const copy = (fields) => {
    for (const f of fields) chunk[f] = prev[f] || "";
    d.touched(k);
    d.refresh(["insp"]);
  };
  return [
    { label: `Style, sound and music from chunk ${k}`, icon: "palette", onClick: () => copy(["style_line", "overall_soundscape", "non_diegetic_music"]) },
    { label: "Style only", icon: "palette", onClick: () => copy(["style_line"]) },
    { label: "Soundscape only", icon: "wave", onClick: () => copy(["overall_soundscape"]) },
    { label: "Music only", icon: "music", onClick: () => copy(["non_diegetic_music"]) },
    { label: `LoRAs from chunk ${k}`, icon: "bolt", onClick: () => { chunk.loras = JSON.parse(JSON.stringify(prev.loras || [])); d.touched(k); d.refresh(["insp"]); } },
  ];
}

function moreItems(d, k) {
  const n = d.numChunks();
  return [
    { label: "Render up to this chunk", icon: "next", disabled: k === n - 1, onClick: () => d.queue({ until: k }) },
    { label: "Add a chunk at the end", icon: "plus", onClick: () => d.addChunk() },
    { label: `Delete chunk ${k + 1}`, icon: "trash", danger: true, disabled: n <= 1, onClick: () => d.deleteChunk(k) },
    null,
    { label: "Back to the Director's seed", icon: "dice", disabled: !d.hasOwnSeed(k), hint: d.hasOwnSeed(k) ? `own: ${d.seedOf(k)}` : "",
      onClick: () => d.clearOwnSeed(k) },
  ];
}

// ------------------------------------------------------------------------------------------- shots

function shotsSection(d, k, chunk, chunkSeconds) {
  const sec = h("div.i-sec");
  sec.appendChild(h("div.i-sech", label("Shots"),
    h("button.sh3-btn.small.flat", { type: "button", onclick: () => {
      chunk.segments.push({ prompt: "", weight: 1 });
      d.selShot = chunk.segments.length - 1;
      d.touched(k);
      d.refresh(["insp", "tl"]);
      setTimeout(() => d.insp.querySelectorAll(".i-cut textarea")[d.selShot]?.focus(), 0);
    } }, icon("plus", 14), "Add")));
  const list = h("div.i-cuts");
  const total = chunk.segments.reduce((s, x) => s + (x.weight || 1), 0) || 1;
  chunk.segments.forEach((s, i) => {
    const secs = ((s.weight || 1) / total) * chunkSeconds;
    s.duration_hint = secs.toFixed(1);
    list.appendChild(cutCard(d, k, chunk, s, i, secs, chunkSeconds));
  });
  sec.appendChild(list);
  return sec;
}

function cutCard(d, k, chunk, seg, i, secs, chunkSeconds) {
  const card = h("div.i-cut", { class: d.selShot === i ? "sel" : null });
  card.addEventListener("pointerdown", () => {
    if (d.selShot !== i) { d.selShot = i; d.refresh(["tl"]); d.insp.querySelectorAll(".i-cut").forEach((c, j) => c.classList.toggle("sel", j === i)); }
  });
  // its length: typed, the difference shared out over the other shots (the chunk keeps its length)
  let dur;
  if (chunk.segments.length > 1) {
    dur = h("input.i-dur", { type: "text", inputMode: "decimal", value: secs.toFixed(1),
      title: "This shot's length in seconds; the other shots in the chunk give or take the difference" });
    dur.addEventListener("keydown", (e) => { if (e.key === "Enter") dur.blur(); });
    dur.addEventListener("change", () => {
      const others = chunk.segments.filter((_, j) => j !== i);
      const live = chunk.segments.reduce((s, x) => s + (x.weight || 1), 0);
      const minW = (MIN_CUT_SECONDS / chunkSeconds) * live;
      const othersW = others.reduce((s, x) => s + (x.weight || 1), 0);
      const maxSecs = ((live - others.length * minW) / live) * chunkSeconds;
      let want = parseFloat(String(dur.value).replace(",", "."));
      if (!Number.isFinite(want)) want = secs;
      want = Math.max(MIN_CUT_SECONDS, Math.min(Math.max(MIN_CUT_SECONDS, maxSecs), want));
      const wantW = (want / chunkSeconds) * live;
      const delta = wantW - (seg.weight || 1);
      if (othersW > 0) for (const o of others) o.weight = Math.max(minW, (o.weight || 1) - delta * ((o.weight || 1) / othersW));
      seg.weight = wantW;
      d.touched(k);
      d.refresh(["insp", "tl"]);
    });
  } else {
    dur = h("span.i-dur.one", { title: "The only shot: as long as the chunk" }, `${secs.toFixed(1)}`);
  }
  const text = h("textarea.i-cut-text", { rows: 1, placeholder: "What happens in this shot: action, dialogue in quotes, camera move…" });
  text.value = seg.prompt || "";
  const grow = () => { text.style.height = "auto"; text.style.height = `${Math.max(24, text.scrollHeight)}px`; };
  let timer = 0;
  const speakers = d.isReference ? speakerRow(d, k, seg) : null;
  text.addEventListener("input", () => {
    seg.prompt = text.value;
    grow();
    d.touched(k);
    if (speakers) speakers.style.display = text.value.includes('"') ? "flex" : "none";
    clearTimeout(timer);
    timer = setTimeout(() => d.refresh(["tl"]), 350);
  });
  setTimeout(grow, 0);
  const actions = h("div.i-cut-act",
    i > 0 ? iconButton("chevronUp", "Move up", () => move(d, k, chunk, i, -1)) : null,
    i < chunk.segments.length - 1 ? iconButton("chevronDown", "Move down", () => move(d, k, chunk, i, 1)) : null,
    chunk.segments.length > 1 ? iconButton("trash", "Delete this shot", () => {
      chunk.segments.splice(i, 1);
      d.selShot = null;
      d.touched(k);
      d.refresh(["insp", "tl"]);
    }) : null);
  card.append(h("div.i-cut-main", h("div.i-dur-wrap", dur, h("span", "s")), text, actions));
  if (speakers) {
    speakers.style.display = (seg.prompt || "").includes('"') ? "flex" : "none";
    card.appendChild(speakers);
  }
  return card;
}

function move(d, k, chunk, i, by) {
  const [s] = chunk.segments.splice(i, 1);
  chunk.segments.splice(i + by, 0, s);
  d.selShot = i + by;
  d.touched(k);
  d.refresh(["insp", "tl"]);
}

// Reference mode, a shot with a quoted line: which characters speak (their paired voice is used)
function speakerRow(d, k, seg) {
  if (!Array.isArray(seg.speakerCharIdxs)) seg.speakerCharIdxs = [];
  const row = h("div.i-speakers", h("span.sh3-muted", "Who speaks:"));
  for (let i = 0; i < MAX_CHARACTER_SLOTS; i++) {
    const ch = d.timeline.characters[i];
    if (!ch || !(ch.file || ch.image_b64)) continue;
    const chip = h("button.i-spk", { type: "button", class: seg.speakerCharIdxs.includes(i) ? "on" : null }, `Ref ${i + 1}`);
    chip.addEventListener("click", () => {
      const at = seg.speakerCharIdxs.indexOf(i);
      if (at < 0) seg.speakerCharIdxs.push(i); else seg.speakerCharIdxs.splice(at, 1);
      chip.classList.toggle("on");
      d.touched(k);
    });
    row.appendChild(chip);
  }
  if (row.childNodes.length === 1) row.appendChild(h("span.sh3-muted", "add characters in Cast below"));
  return row;
}

// ------------------------------------------------------------------------------------------- style, sound, music

const TEXT_ROWS = [
  ["style_line", "Style", "palette", "Lighting, palette, lens and camera feel (the place belongs in the shots), e.g. cinematic, golden hour, soft lens flare"],
  ["overall_soundscape", "Soundscape", "wave", "Ambience and physical sound, e.g. waves rolling in, wind, footsteps on wet sand"],
  ["non_diegetic_music", "Music", "music", "Score the characters can't hear: instruments, tempo, dynamics. Blank or N/A for none"],
];

function textRows(d, k, chunk) {
  const rows = h("div.i-rows");
  for (const [field, name, ic, placeholder] of TEXT_ROWS) {
    const open = !!d.fold[`text:${field}`];
    const value = (chunk[field] || "").trim();
    const row = h("div.i-row", { class: open ? "open" : null });
    const headRow = h("button.i-row-head", { type: "button", onclick: () => {
      d.fold[`text:${field}`] = !open;
      d.saveUi();
      d.refresh(["insp"]);
    } }, icon(ic, 16), h("span.i-row-k", name),
    h("span.i-row-v", { class: value ? null : "muted" }, value || "None"), icon(open ? "chevronUp" : "chevronDown", 16));
    row.appendChild(headRow);
    if (open) {
      const ta = h("textarea.sh3-text", { rows: 3, placeholder });
      ta.value = chunk[field] || "";
      ta.addEventListener("input", () => { chunk[field] = ta.value; d.touched(k); headRow.querySelector(".i-row-v").textContent = ta.value.trim() || "None"; });
      const bar = h("div.i-row-bar");
      if (k > 0) bar.appendChild(button(`Copy from chunk ${k}`, "copy", "small flat", () => {
        chunk[field] = d.timeline.chunks[k - 1]?.[field] || "";
        d.touched(k);
        d.refresh(["insp"]);
      }));
      row.append(h("div.i-row-body", ta, bar));
    }
    rows.appendChild(row);
  }
  return rows;
}

// ------------------------------------------------------------------------------------------- LoRAs

function lorasSection(d, k, chunk) {
  const sec = h("div.i-sec");
  const on = chunk.loras.filter((l) => l.enabled !== false && l.name);
  const sum = on.reduce((a, l) => a + Math.abs(Number(l.strength) || 0), 0);
  sec.appendChild(h("div.i-sech", label("LoRAs"),
    on.length ? h("span.sh3-badge", { class: sum > LORA_SUM_WARN ? "cut" : null,
      title: sum > LORA_SUM_WARN ? "A high combined strength may break the render (slider LoRAs are made for it)" : "" }, `sum ${sum.toFixed(2)}`) : null));
  const chips = h("div.i-loras");
  chunk.loras.forEach((row, i) => {
    const open = d.fold.lora === `${k}:${i}`;
    const strength = Number(row.strength ?? 1);
    const pct = Math.min(100, (Math.abs(strength) / 2) * 100);
    chips.appendChild(h("button.i-lora", {
      type: "button", class: [open ? "open" : "", row.enabled === false ? "off" : ""].join(" ").trim() || null,
      title: row.name || "pick a LoRA",
      onclick: () => { d.fold.lora = open ? null : `${k}:${i}`; d.saveUi(); d.refresh(["insp"]); },
    }, icon("bolt", 15), h("span.i-lora-name", row.name ? shortName(row.name) : "pick a LoRA"),
    h("span.i-bar", h("span", { style: { width: `${pct}%` } })), h("b", strength.toFixed(2))));
  });
  chips.appendChild(h("button.i-addl", { type: "button", onclick: async () => {
    const list = await loraList();
    const first = list.find((x) => !TURBO_RE.test(x)) || "";
    chunk.loras.push({ name: first, strength: 1.0, enabled: true });
    d.fold.lora = `${k}:${chunk.loras.length - 1}`;
    d.touched(k);
    d.refresh(["insp"]);
  } }, icon("plus", 14), "Add LoRA"));
  sec.appendChild(chips);

  if (k > 0) {
    const before = (d.timeline.chunks[k - 1]?.loras || []).filter((l) => l.enabled !== false && l.name).map((l) => l.name);
    const here = new Set(on.map((l) => l.name));
    const dropped = before.filter((x) => !here.has(x));
    if (dropped.length) sec.appendChild(h("div.i-note", icon("alert", 14), `A LoRA change at this join may shift the look (dropped: ${dropped.map(shortName).join(", ")})`));
  }
  const openIdx = typeof d.fold.lora === "string" && d.fold.lora.startsWith(`${k}:`) ? Number(d.fold.lora.split(":")[1]) : -1;
  if (openIdx >= 0 && chunk.loras[openIdx]) sec.appendChild(loraEditor(d, k, chunk, chunk.loras[openIdx], openIdx));
  return sec;
}

function loraEditor(d, k, chunk, row, i) {
  const ed = h("div.i-lora-ed");
  const sel = h("select.sh3-select.i-lora-sel");
  const filter = h("input.sh3-input.i-lora-filter", { type: "text", placeholder: "filter by name or folder…" });
  const fill = (list) => {
    clear(sel);
    const q = filter.value.trim().toLowerCase();
    const names = list.filter((x) => !TURBO_RE.test(x));
    if (row.name && !names.includes(row.name)) names.push(row.name);
    if (!row.name) sel.appendChild(h("option", { value: "", text: "pick a LoRA", selected: true }));
    const groups = new Map();
    for (const x of names) {
      if (q && !x.toLowerCase().includes(q) && x !== row.name) continue;
      const f = folderOf(x);
      if (!groups.has(f)) groups.set(f, []);
      groups.get(f).push(x);
    }
    [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).forEach((f) => {
      const og = h("optgroup", { label: f });
      groups.get(f).sort((a, b) => shortName(a).localeCompare(shortName(b))).forEach((x) =>
        og.appendChild(h("option", { value: x, text: shortName(x), selected: x === row.name })));
      sel.appendChild(og);
    });
    sel.value = row.name || "";
  };
  loraList().then(fill);
  filter.addEventListener("input", () => loraList().then(fill));
  sel.addEventListener("change", () => { row.name = sel.value; d.touched(k); d.refresh(["insp"]); });
  const num = h("input.sh3-input.i-lora-num", { type: "number", step: 0.05, min: -LORA_MAX, max: LORA_MAX, value: Number(row.strength ?? 1) });
  const range = slider({ min: -2, max: 2, step: 0.05, value: Math.max(-2, Math.min(2, Number(row.strength ?? 1))),
    onInput: (v) => { num.value = v; }, onChange: (v) => { row.strength = v; d.touched(k); d.refresh(["insp"]); } });
  num.addEventListener("change", () => {
    const v = parseFloat(num.value);
    row.strength = Number.isFinite(v) ? Math.max(-LORA_MAX, Math.min(LORA_MAX, v)) : 1.0;
    d.touched(k);
    d.refresh(["insp"]);
  });
  const missing = LORAS.list && row.name && !LORAS.list.includes(row.name);
  ed.append(
    h("div.i-lora-line", filter, iconButton("refresh", "Read models/loras again", () => loraList(true).then(fill))),
    h("div.i-lora-line", sel),
    h("div.i-lora-line", h("span.sh3-muted", "Strength"), range, num),
    h("div.i-lora-line",
      h("label.i-inline", toggle(row.enabled !== false, (v) => { row.enabled = v; d.touched(k); d.refresh(["insp"]); }, "On for this chunk"), "On"),
      h("div.sh3-spacer"),
      button("Every chunk", "copy", "small flat", () => {
        if (!row.name) return;
        d.timeline.chunks.forEach((c, j) => {
          const hit = c.loras.find((l) => l.name === row.name);
          if (hit) { hit.strength = row.strength; hit.enabled = row.enabled !== false; } else c.loras.push({ name: row.name, strength: row.strength ?? 1, enabled: row.enabled !== false });
          d.edited.add(j);
        });
        d.commit();
        toast(d.root, `${shortName(row.name)} on every chunk`);
        d.refresh(["insp"]);
      }, "This LoRA, at this strength, on every chunk"),
      button("Remove", "trash", "small flat danger", () => { chunk.loras.splice(i, 1); d.fold.lora = null; d.touched(k); d.refresh(["insp"]); })),
    missing ? h("div.i-note.bad", icon("alert", 14), "Not found in models/loras on this machine") : null,
  );
  return ed;
}

// ------------------------------------------------------------------------------------------- takes

function takesSection(d, k) {
  const sec = h("div.i-sec.i-takes-sec");
  const t = d.takesOf(k);
  const own = d.hasOwnSeed(k);
  const note = t.list.length ? `${t.list.length} kept · the lit one plays in the video` : "No takes of it yet";
  sec.appendChild(h("div.i-sech", label("Takes"), h("span.sh3-muted", note)));
  const row = h("div.i-takes");
  for (const take of t.list.slice().reverse()) {
    const isCur = t.current && Number(take.seed) === Number(t.current.seed);
    const tile = h("button.i-take", { type: "button", class: isCur ? "on" : null,
      title: `Seed ${take.seed}: ${isCur ? "plays in the video" : "click to use it"} (${Number(take.seconds || 0).toFixed(1)} s)` });
    if (take.thumb) tile.appendChild(h("img", { src: d.takeUrl(t.base, take.seed, "thumb.jpg"), draggable: false }));
    tile.appendChild(h("span.i-take-s", String(take.seed)));
    if (isCur) tile.appendChild(h("span.i-take-pick", icon("check", 14)));
    const del = h("span.i-take-del", { title: "Delete this take" }, icon("x", 12));
    del.addEventListener("click", (e) => { e.stopPropagation(); d.deleteTake(t.base, take.seed); });
    tile.appendChild(del);
    tile.addEventListener("mouseenter", () => { if (take.preview) d.preview.showTake(k, t.base, take.seed); });
    tile.addEventListener("mouseleave", () => d.preview.showTake(null));
    tile.addEventListener("click", () => { d.pickTake(k, take.seed); toast(d.root, `Chunk ${k + 1}: seed ${take.seed} picked. Render to rebuild what follows it.`); });
    row.appendChild(tile);
  }
  row.appendChild(h("button.i-take.new", { type: "button", title: "Retake: render this chunk again with a new seed",
    onclick: () => d.retake(k) }, icon("plus", 22)));
  sec.appendChild(row);
  if (t.stale && t.list.length) sec.appendChild(h("div.i-note", icon("info", 14), "You changed this chunk since: these takes are from before. Render it to get one with the change."));
  else if (t.list.length && !t.current) sec.appendChild(h("div.i-note", icon("info", 14), `Seed ${d.seedOf(k)} isn't rendered with these settings yet.`));
  // Hunt with 2, 3 or 4 seeds: the button repeats the last count, the arrow picks another (remembered with the workflow)
  const huntN = [2, 3, 4].includes(Number(d.fold?.hunt)) ? Number(d.fold.hunt) : 4;
  const huntMore = iconButton("chevronDown", "How many seeds to hunt with: 2, 3 or 4", (e) => menu(e.currentTarget, [2, 3, 4].map((n) => ({
    label: `Hunt with ${n} seeds`, icon: n === huntN ? "check" : null,
    onClick: () => { d.fold.hunt = n; d.saveUi(); d.refresh(["insp"]); d.hunt(k, n); },
  }))));
  huntMore.classList.add("i-hunt-n");
  sec.appendChild(h("div.i-tbtns",
    button("Retake", "refresh", "", () => d.retake(k), "Render this chunk again with a new seed (the chunks before it stay as they are)"),
    h("div.i-hunt", button(`Hunt ×${huntN}`, "dice", "brand", () => d.hunt(k, huntN),
      `Render this chunk with ${huntN} seeds side by side; pick one in Seeds (the arrow: 2, 3 or 4 seeds)`), huntMore)));
  if (own) sec.appendChild(h("div.i-own", icon("lock", 13), `Own seed ${d.seedOf(k)}`,
    h("button.sh3-link", { type: "button", onclick: () => d.clearOwnSeed(k) }, "back to the Director's seed")));
  return sec;
}

const CSS = `
.sh3-d .i-head{display:flex;align-items:center;gap:12px}
.sh3-d .i-headtxt{min-width:0}
.sh3-d .i-nav{display:flex;gap:6px}
.sh3-d .i-nav .sh3-ibtn:first-child svg{transform:rotate(180deg)}
.sh3-d .i-badge{width:40px;height:40px;border-radius:12px;background:var(--brand);color:var(--on);display:grid;place-items:center;
  font-family:var(--fh);font-weight:700;font-size:18px;box-shadow:0 6px 24px rgba(var(--ac),.4);flex:none}
.sh3-d .i-sec{display:flex;flex-direction:column;gap:9px}
.sh3-d .i-sech{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:22px}
.sh3-d .i-joins{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.sh3-d .i-join{border-radius:14px;padding:11px 10px;background:var(--glass);border:1px solid var(--stroke);display:flex;flex-direction:column;
  align-items:flex-start;gap:6px;min-height:80px;text-align:left;color:var(--text2)}
.sh3-d .i-join:hover{border-color:var(--stroke2);color:var(--text)}
.sh3-d .i-join b{font-weight:600;font-size:12.5px;line-height:1.25;color:var(--text)}
.sh3-d .i-join.on{background:linear-gradient(165deg,rgba(var(--snd),.18),rgba(var(--k),.10));border-color:rgba(var(--snd),.6);box-shadow:0 0 24px rgba(var(--snd),.22)}
.sh3-d .i-join.on .sh3-ic{color:rgb(var(--snd))}
.sh3-d .i-hint{font-size:12px;color:var(--text2);line-height:1.45}
.sh3-d .i-cuts{display:flex;flex-direction:column;gap:7px}
.sh3-d .i-cut{border-radius:13px;background:var(--glass);border:1px solid var(--stroke);padding:8px 8px 8px 12px}
.sh3-d .i-cut.sel{border-color:rgba(var(--ac),.55);background:linear-gradient(180deg,rgba(var(--ac),.08),var(--glass))}
.sh3-d .i-cut-main{display:flex;gap:10px;align-items:flex-start}
.sh3-d .i-dur-wrap{display:flex;align-items:baseline;gap:1px;flex:none;padding-top:3px;color:rgb(var(--ac));font-family:var(--fh);font-weight:600}
.sh3-d .i-dur-wrap span{font-size:12px;opacity:.8}
.sh3-d .i-dur{width:40px;background:none;border:0;border-bottom:1px dashed rgba(var(--ac),.35);color:rgb(var(--ac));font-family:var(--fh);
  font-weight:600;font-size:14px;padding:0;text-align:right;-moz-appearance:textfield;outline:none}
.sh3-d .i-dur::-webkit-outer-spin-button,.sh3-d .i-dur::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.sh3-d .i-dur.one{border:0;display:inline-block}
.sh3-d .i-cut-text{flex:1;min-width:0;background:none;border:0;color:var(--text);resize:none;outline:none;font-size:13.5px;line-height:1.45;
  padding:2px 0;overflow:hidden;min-height:24px}
.sh3-d .i-cut-text::placeholder{color:var(--text3)}
.sh3-d .i-cut-act{display:flex;gap:2px;flex:none;opacity:0;transition:opacity .15s}
.sh3-d .i-cut:hover .i-cut-act,.sh3-d .i-cut.sel .i-cut-act{opacity:1}
.sh3-d .i-cut-act .sh3-ibtn{width:28px;height:28px;border-radius:8px}
.sh3-d .i-speakers{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:6px 0 2px 50px;font-size:12px}
.sh3-d .i-spk{padding:3px 10px;border-radius:20px;background:var(--well);border:1px solid var(--stroke2);color:var(--text2);font-size:12px}
.sh3-d .i-spk.on{background:rgba(var(--ac),.18);border-color:rgba(var(--ac),.6);color:var(--text)}
.sh3-d .i-rows{display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--stroke);overflow:hidden}
.sh3-d .i-row+.i-row{border-top:1px solid var(--stroke)}
.sh3-d .i-row-head{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--glass);width:100%;border:0;text-align:left;color:var(--text)}
.sh3-d .i-row-head:hover{background:var(--glass2)}
.sh3-d .i-row-head .sh3-ic{color:var(--text3)}
.sh3-d .i-row-k{width:88px;color:var(--text2);flex:none}
.sh3-d .i-row-v{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sh3-d .i-row-v.muted{color:var(--text3)}
.sh3-d .i-row-body{padding:8px 12px 10px;background:var(--glass)}
.sh3-d .i-row-bar{display:flex;justify-content:flex-end;margin-top:4px}
.sh3-d .i-loras{display:flex;gap:8px;flex-wrap:wrap}
.sh3-d .i-lora{display:flex;align-items:center;gap:9px;padding:7px 11px;border-radius:12px;background:rgba(var(--ac),.08);border:1px solid rgba(var(--ac),.35);
  color:var(--text);max-width:100%}
.sh3-d .i-lora .sh3-ic{color:rgb(var(--ac))}
.sh3-d .i-lora.open{border-color:rgba(var(--ac),.8);box-shadow:0 0 18px rgba(var(--ac),.25)}
.sh3-d .i-lora.off{opacity:.5}
.sh3-d .i-lora-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
.sh3-d .i-bar{width:54px;height:5px;border-radius:3px;background:var(--glass3);position:relative;overflow:hidden;flex:none}
.sh3-d .i-bar span{position:absolute;left:0;top:0;bottom:0;background:var(--brand)}
.sh3-d .i-addl{display:flex;align-items:center;gap:6px;padding:7px 11px;border-radius:12px;border:1px dashed var(--stroke2);color:var(--text2);background:none}
.sh3-d .i-addl:hover{color:var(--text);border-color:rgba(var(--ac),.5)}
.sh3-d .i-lora-ed{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:14px;background:var(--well);border:1px solid var(--stroke)}
.sh3-d .i-lora-line{display:flex;align-items:center;gap:10px}
.sh3-d .i-lora-sel{flex:1;width:100%}
.sh3-d .i-lora-filter{flex:1}
.sh3-d .i-lora-num{width:78px;text-align:right}
.sh3-d .i-inline{display:flex;align-items:center;gap:8px;color:var(--text2)}
.sh3-d .i-note{display:flex;align-items:flex-start;gap:7px;font-size:12px;color:rgb(var(--cut));line-height:1.4}
.sh3-d .i-note .sh3-ic{margin-top:1px}
.sh3-d .i-note.bad{color:rgb(var(--bad))}
.sh3-d .i-takes{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.sh3-d .i-take{position:relative;height:84px;border-radius:14px;overflow:hidden;border:1px solid var(--stroke2);background:#000;padding:0}
.sh3-d .i-take img{width:100%;height:100%;object-fit:cover;opacity:.92;display:block}
.sh3-d .i-take-s{position:absolute;left:8px;bottom:7px;font-family:var(--fh);font-weight:600;font-size:12px;padding:3px 8px;border-radius:8px;
  background:rgba(8,6,12,.6);color:#f3f1f8;backdrop-filter:blur(8px)}
.sh3-d .i-take.on{border:2px solid rgb(var(--ac));box-shadow:0 0 0 4px rgba(var(--ac),.18),0 10px 30px rgba(var(--ac),.35)}
.sh3-d .i-take-pick{position:absolute;right:8px;top:8px;width:24px;height:24px;border-radius:50%;background:var(--brand);color:var(--on);display:grid;place-items:center}
.sh3-d .i-take-del{position:absolute;right:6px;top:6px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.65);color:#fff;display:none;place-items:center}
.sh3-d .i-take:not(.on):hover .i-take-del{display:grid}
.sh3-d .i-take.new{background:var(--glass);display:grid;place-items:center;border-style:dashed;color:var(--text3)}
.sh3-d .i-take.new:hover{color:var(--text);border-color:rgba(var(--ac),.6)}
.sh3-d .i-tbtns{display:flex;gap:8px}
.sh3-d .i-tbtns .sh3-btn{flex:1}
.sh3-d .i-hunt{flex:1;display:flex;gap:0;min-width:0}
.sh3-d .i-hunt .sh3-btn{border-top-right-radius:0;border-bottom-right-radius:0}
.sh3-d .i-hunt .i-hunt-n{height:40px;width:36px;border-radius:0 12px 12px 0;border:1px solid rgba(var(--ac),.5);border-left:0;
  background:linear-gradient(100deg,rgba(var(--ac),.16),rgba(var(--ac2),.1))}
.sh3-d .i-own{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text2)}
.sh3-d .i-own .sh3-link{text-decoration:underline;text-underline-offset:2px}
`;
