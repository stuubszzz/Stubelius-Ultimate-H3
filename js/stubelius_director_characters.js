// Stubelius Ultimate H3 Director: characters saved from many pictures (RefMods, stubelius_refmods.py).
//
// The Characters lane holds the characters the whole video keeps: each one a set of pictures of one character
// encoded once and saved in the refmods folder, attached to every chunk in Reference and in First/Last Frame mode.
// Add one from the library, or make one from 8 to 16 pictures. H3's text side never sees them, so each keeps its
// description in words for the shots.
import { h, icon, clear, iconButton, button, label, menu, popover, closeMenus, toast, slider, seg, toggle, widgetValue }
  from "./stubelius_ui.js";
import { uploadFile, pickFiles, dropTargetMany, isImageFile } from "./stubelius_director_media.js";

const { api } = window.comfyAPI.api;
const MAKER = "stubelius_make_character";

export function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k tokens` : `${n} tokens`;
}

function shortName(name) {
  return String(name || "").split("/").pop();
}

export function fetchLibrary(d, force = false) {
  if (d.refmodLib && !force) return Promise.resolve(d.refmodLib);
  if (d.refmodFetch && !force) return d.refmodFetch;
  d.refmodFetch = (async () => {
    try {
      const r = await api.fetchApi("/stubelius_ultimate_h3/refmods/list");
      d.refmodLib = r.ok ? await r.json() : { items: [], folder: "" };
    } catch (e) {
      d.refmodLib = { items: [], folder: "" };
    }
    d.refmodFetch = null;
    return d.refmodLib;
  })();
  return d.refmodFetch;
}

export function libItem(d, name) {
  return (d.refmodLib?.items || []).find((x) => x.name === name) || null;
}

// the contact sheet; its file time keeps a replaced character from showing the old one
export function thumbUrl(name, item = null) {
  return api.apiURL(`/stubelius_ultimate_h3/refmods/thumb?name=${encodeURIComponent(name)}${item?.mtime ? `&v=${Math.round(item.mtime)}` : ""}`);
}

// The total reference tokens the characters add to every sampling step
export function characterTokens(d) {
  return d.refmods().filter((e) => e.enabled !== false).reduce((a, e) => a + (libItem(d, e.file)?.tokens || 0), 0);
}

// A popover over the anchor when there's no room under it (the lane is the window's last row); anchored by its
// bottom edge, so a list that gets shorter (the library's search) stays next to the anchor
function popUp(anchor, content, width) {
  return flipUp(anchor, popover(anchor, content, width));
}

function flipUp(anchor, el) {
  const root = anchor.closest(".sh3") || document.body;
  const a = anchor.getBoundingClientRect(), r = root.getBoundingClientRect();
  const zoom = r.width / (root.offsetWidth || r.width) || 1;
  const below = (a.bottom - r.top) / zoom + 6;
  const above = (a.top - r.top) / zoom - 6;
  if (below + el.offsetHeight > root.offsetHeight - 8 && above - el.offsetHeight >= 8) {
    el.style.top = "auto";
    el.style.bottom = `${root.offsetHeight - above}px`;
  }
  return el;
}

// ------------------------------------------------------------------------------------------- the lane

export function characterHead(d) {
  const add = iconButton("plus", "Add a character: a saved one, or make one from pictures", (e) => flipUp(e.currentTarget, menu(e.currentTarget, [
    { label: "Add a saved character…", icon: "users", onClick: () => openLibrary(d, add) },
    { label: "Make a character from pictures…", icon: "sparkles", onClick: () => openMaker(d) },
  ])));
  add.classList.add("t-add");
  return h("div.t-headin", h("div.t-trk", h("span.sh3-ico.ac", icon("users", 16)), "Characters"), add);
}

export function buildCharacterLane(d, lane) {
  injectStyles();
  lane.classList.add("t-chars");
  const list = d.refmods();
  if (list.length && !d.refmodLib && !d.refmodFetch) fetchLibrary(d).then(() => d.refresh(["tl", "foot"]));
  if (!list.length) {
    lane.appendChild(h("div.t-hint", d.isReference
      ? "A character made from many pictures adds to the cast below, in every chunk: + to add one or make one"
      : "A character made from many pictures holds the face across every chunk: + to add one or make one"));
    return;
  }
  list.forEach((entry, i) => {
    const item = libItem(d, entry.file);
    const chip = h("button.t-char", {
      type: "button", class: [entry.enabled === false ? "off" : "", d.refmodLib && !item ? "missing" : ""].join(" ").trim() || null,
      title: `${entry.file}: click for strength, description, remove`,
      onclick: (e) => characterPopover(d, i, e.currentTarget),
    },
    item?.thumb ? h("img", { src: thumbUrl(entry.file, item), draggable: false }) : h("span.t-char-ic", icon("user", 18)),
    h("div.t-char-t", h("b", shortName(entry.file)),
      h("small", item ? `${item.pictures} picture${item.pictures === 1 ? "" : "s"} · ${fmtTokens(item.tokens)}`
        : d.refmodLib ? "not in the refmods folder" : "…")),
    Number(entry.strength ?? 1) < 1 ? h("span.t-char-s", `${Math.round(Number(entry.strength) * 100)}%`) : null);
    lane.appendChild(chip);
  });
}

function characterPopover(d, i, anchor) {
  const entry = d.refmods()[i];
  if (!entry) return;
  const item = libItem(d, entry.file);
  const val = h("b", `${Math.round(Number(entry.strength ?? 1) * 100)}%`);
  const box = h("div.t-charpop",
    h("div.t-charpop-h", item?.thumb ? h("img", { src: thumbUrl(entry.file, item) }) : h("span.t-char-ic", icon("user", 22)),
      h("div", h("b", shortName(entry.file)), h("div.sh3-muted", item
        ? `${item.pictures} pictures at ${item.width}×${item.height} · ${fmtTokens(item.tokens)} in every step${item.tuned ? " · tuned" : ""}`
        : "not in the refmods folder"))),
    h("div.t-charpop-row", label("Strength"), slider({ min: 0, max: 1, step: 0.05, value: Number(entry.strength ?? 1),
      onInput: (v) => { val.textContent = `${Math.round(v * 100)}%`; }, onChange: (v) => d.setRefmod(i, { strength: v }) }), val),
    h("div.sh3-muted.t-charpop-note", "Below 100% the pictures are softened (blurred), not hidden: a looser likeness."));
  const desc = item?.description || "";
  if (desc) {
    const k = d.sel;
    box.append(label("In words"), h("div.t-charpop-desc", desc),
      button(`Add it to chunk ${k + 1}'s first shot`, "plus", "small", () => {
        const seg0 = d.timeline.chunks[k]?.segments?.[0];
        if (!seg0) return;
        const text = String(seg0.prompt || "");
        if (!text.toLowerCase().includes(desc.toLowerCase().slice(0, 24))) {
          seg0.prompt = text ? `${desc}. ${text}` : `${desc}. `;
          d.touched(k);
          d.refresh(["insp", "tl"]);
          toast(d.root, `Added to chunk ${k + 1}'s first shot`);
        }
        closeMenus();
      }, "H3 reads the shots, not the pictures: say who it is in words too"));
  }
  box.append(h("div.t-charpop-foot",
    h("label.i-inline", toggle(entry.enabled !== false, (v) => d.setRefmod(i, { enabled: v }), "On for the whole video"), "On"),
    h("div.sh3-spacer"),
    button("Remove", "trash", "small flat danger", () => { closeMenus(); d.removeRefmod(i); })));
  popUp(anchor, box, 380);
}

// ------------------------------------------------------------------------------------------- the library

export async function openLibrary(d, anchor) {
  const lib = await fetchLibrary(d, true);
  const search = h("input.sh3-input.t-lib-search", { type: "text", placeholder: "Search characters…" });
  const list = h("div.t-lib-list");
  const fill = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const items = (lib.items || []).filter((x) => !q || x.name.toLowerCase().includes(q) || (x.description || "").toLowerCase().includes(q));
    if (!items.length) {
      list.appendChild(h("div.sh3-muted.t-lib-empty", (lib.items || []).length ? "Nothing matches."
        : "No characters yet. Make one from 8 to 16 pictures of one character."));
    }
    for (const x of items) {
      const used = d.refmods().some((e) => e.file === x.name);
      list.appendChild(h("button.t-lib-item", { type: "button", class: used ? "used" : null, disabled: used || null,
        onclick: () => { closeMenus(); d.addRefmod(x.name); } },
      x.thumb ? h("img", { src: thumbUrl(x.name, x), draggable: false }) : h("span.t-char-ic", icon("user", 20)),
      h("div.t-lib-t", h("b", x.name), h("small", `${x.pictures} pictures · ${fmtTokens(x.tokens)}${x.tuned ? " · tuned" : ""}${used ? " · in this video" : ""}`),
        x.description ? h("small.t-lib-d", x.description) : null)));
    }
  };
  search.addEventListener("input", fill);
  fill();
  popUp(anchor, h("div.t-lib", h("div.t-lib-head", search, iconButton("refresh", "Read the refmods folder again", async () => {
    await fetchLibrary(d, true);
    closeMenus();
    openLibrary(d, anchor);
  })), list, h("div.t-lib-foot", h("span.sh3-muted", lib.folder ? `Folder: ${lib.folder}` : ""),
    h("div.sh3-spacer"), button("Make a character…", "sparkles", "small", () => { closeMenus(); openMaker(d); }))), 460);
  setTimeout(() => search.focus(), 30);
}

// ------------------------------------------------------------------------------------------- making one

export function openMaker(d) {
  injectStyles();
  closeMenus();
  d.root.querySelector(".t-maker-wrap")?.remove();
  const files = [];
  let mp = 0.5;
  const name = h("input.sh3-input", { type: "text", placeholder: "e.g. liquidator, or characters/liquidator" });
  const desc = h("textarea.sh3-text.t-maker-desc", { rows: 2, placeholder: "How the character looks, in words (H3's text side can't see the pictures)" });
  const thumbs = h("div.t-maker-thumbs");
  const est = h("div.sh3-muted.t-maker-est");
  const status = h("div.t-maker-status");
  const make = button("Make", "sparkles", "cta", () => run());
  const updateEst = () => {
    const per = Math.round(mp * 1e6 / 1024);
    est.textContent = files.length
      ? `${files.length} picture${files.length === 1 ? "" : "s"} × ~${per} = ~${fmtTokens(files.length * per)} in every sampling step`
      : "8 to 16 pictures of one character: face and shoulders, different angles and light, nothing else in focus.";
    const taken = !!libItem(d, safeName(name.value));
    status.className = taken ? "t-maker-status warn" : "t-maker-status";
    status.textContent = taken ? `A character called ${safeName(name.value)} is saved already: this replaces it` : "";
    make.querySelector("span").textContent = taken ? "Replace" : "Make";
    make.disabled = !files.length || !name.value.trim();
  };
  const drawThumbs = () => {
    clear(thumbs);
    files.forEach((f, i) => {
      const url = URL.createObjectURL(f);
      thumbs.appendChild(h("div.t-maker-th", h("img", { src: url }),
        h("button.t-x", { type: "button", title: "Leave it out", onclick: () => { files.splice(i, 1); drawThumbs(); } }, icon("x", 12))));
    });
    updateEst();
  };
  const addFiles = (list) => {
    for (const f of list) if (isImageFile(f) && files.length < 24) files.push(f);
    if (!name.value.trim() && files[0]) name.value = files[0].name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 40);
    drawThumbs();
  };
  const drop = h("div.t-maker-drop", icon("photo", 26), h("b", "Drop pictures here"), h("span.sh3-muted", "or"),
    button("Choose pictures…", "upload", "small", async () => addFiles(await pickFiles("image/*"))));
  dropTargetMany(drop, (list) => addFiles(list));
  name.addEventListener("input", updateEst);
  const close = () => wrap.remove();
  const panel = h("div.t-maker",
    h("div.t-maker-h", h("div.sh3-h2", "Make a character"), h("div.sh3-spacer"), iconButton("x", "Close", close)),
    drop, thumbs, est,
    h("div.t-maker-row", label("Name"), name),
    h("div.t-maker-row", label("Size"), seg([[0.5, "0.5 MP · lighter"], [1.0, "1 MP · more detail"]], mp, (v) => { mp = v; updateEst(); })),
    h("div.t-maker-row", label("In words"), desc),
    h("div.t-maker-foot", status, h("div.sh3-spacer"), button("Cancel", null, "ghost", close), make));
  const wrap = h("div.t-maker-wrap", { onclick: (e) => { if (e.target === wrap) close(); } }, panel);
  d.root.appendChild(wrap);
  updateEst();

  async function run() {
    if (!files.length || !name.value.trim()) return;
    make.disabled = true;
    status.className = "t-maker-status busy";
    try {
      status.textContent = "Uploading the pictures…";
      const uploaded = [];
      for (const f of files) uploaded.push((await uploadFile(f)).file);
      const vae = widgetValue(d.modelsNode(), "video_vae");
      if (!vae) throw new Error("no Models node with a video VAE");
      const prompt = { [MAKER]: { class_type: "StubeliusH3RefModMaker", inputs: {
        video_vae: vae, pictures: JSON.stringify(uploaded), name: name.value.trim(), megapixels: mp, description: desc.value.trim() } } };
      const q = await (await api.fetchApi("/queue")).json().catch(() => ({}));
      const busy = (q.queue_running || []).length + (q.queue_pending || []).length;
      status.textContent = busy ? "Making… (after the render in progress)" : "Making…";
      const res = await api.fetchApi("/prompt", { method: "POST", body: JSON.stringify({ prompt, client_id: api.clientId }) });
      const body = await res.json();
      if (!res.ok || !body.prompt_id) throw new Error(body?.error?.message || `the queue said ${res.status}`);
      const info = await waitFor(body.prompt_id);
      await fetchLibrary(d, true);
      if (d.refmods().some((e) => e.file === info.name)) {      // replaced one the video has: its chunks change
        d.touchAll();
        d.refresh(["tl", "foot"]);
      } else {
        d.addRefmod(info.name);
      }
      close();
      toast(d.root, `${info.name}: ${info.pictures} pictures, ${fmtTokens(info.tokens)}. Added to the Characters lane`);
    } catch (e) {
      status.className = "t-maker-status bad";
      status.textContent = "Couldn't make it: " + (e?.message || e);
      make.disabled = false;
    }
  }
}

// the name the node saves it under (stubelius_refmods.py _safe_name)
function safeName(name) {
  const parts = String(name || "").replace(/\\/g, "/").split("/")
    .map((p) => p.replace(/[^A-Za-z0-9 _.()-]/g, "").replace(/^[ .]+|[ .]+$/g, "")).filter(Boolean);
  return parts.join("/") || "character";
}

function waitFor(promptId) {
  return new Promise((resolve, reject) => {
    const done = (e) => {
      const det = e.detail || {};
      if (det.prompt_id !== promptId) return;
      if (e.type === "executed" && det.output?.stubelius_refmod?.[0]) { off(); resolve(det.output.stubelius_refmod[0]); }
      if (e.type === "execution_error") { off(); reject(new Error(String(det.exception_message || "error").split("\n")[0])); }
      if (e.type === "execution_interrupted") { off(); reject(new Error("stopped")); }
    };
    const off = () => ["executed", "execution_error", "execution_interrupted"].forEach((t) => api.removeEventListener(t, done));
    ["executed", "execution_error", "execution_interrupted"].forEach((t) => api.addEventListener(t, done));
  });
}

let styled = false;
function injectStyles() {
  if (styled) return;
  styled = true;
  document.head.appendChild(h("style", { id: "stubelius-uh3-characters", text: `
.sh3-d .t-area.chars,.sh3-d .t-head.chars{height:60px;border-top:1px solid var(--stroke)}
.sh3-d .t-chars{display:flex;align-items:center;gap:8px;overflow:hidden}
.sh3-d .t-char{display:flex;align-items:center;gap:10px;height:46px;padding:4px 12px 4px 5px;border-radius:12px;background:var(--glass);
  border:1px solid var(--stroke);color:var(--text);text-align:left;min-width:0;max-width:280px;flex:0 1 auto}
.sh3-d .t-char:hover{border-color:rgba(var(--ac),.55)}
.sh3-d .t-char img,.sh3 .t-char-ic,.sh3 .t-charpop-h img,.sh3 .t-lib-item img{width:36px;height:36px;border-radius:9px;object-fit:cover;flex:none}
.sh3 .t-char-ic{display:grid;place-items:center;background:var(--glass2);color:var(--text3)}
.sh3-d .t-char-t{display:flex;flex-direction:column;min-width:0}
.sh3-d .t-char-t b{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sh3-d .t-char-t small{font-size:11px;color:var(--text3);white-space:nowrap}
.sh3-d .t-char-s{font-family:var(--fh);font-size:12px;color:rgb(var(--ac))}
.sh3-d .t-char.off{opacity:.45}
.sh3-d .t-char.missing{border-color:rgba(var(--bad),.6)}
.sh3 .t-charpop{display:flex;flex-direction:column;gap:10px;padding:6px}
.sh3 .t-charpop-h{display:flex;gap:12px;align-items:center}
.sh3 .t-charpop-h img{width:56px;height:56px}
.sh3 .t-charpop-row{display:grid;grid-template-columns:70px 1fr 44px;align-items:center;gap:10px}
.sh3 .t-charpop-note{font-size:11.5px}
.sh3 .t-charpop-desc{font-size:12.5px;color:var(--text2);background:var(--well);border-radius:10px;padding:8px 10px}
.sh3 .t-charpop-foot{display:flex;align-items:center;gap:8px}
.sh3 .t-lib{display:flex;flex-direction:column;gap:10px;padding:4px}
.sh3 .t-lib-head{display:flex;gap:8px}
.sh3 .t-lib-search{flex:1}
.sh3 .t-lib-list{display:flex;flex-direction:column;gap:6px;max-height:360px;overflow:auto}
.sh3 .t-lib-item{display:flex;gap:10px;align-items:center;padding:6px 8px;border-radius:12px;background:var(--glass);border:1px solid var(--stroke);
  color:var(--text);text-align:left}
.sh3 .t-lib-item:hover{border-color:rgba(var(--ac),.55)}
.sh3 .t-lib-item.used{opacity:.5}
.sh3 .t-lib-item img{width:48px;height:48px}
.sh3 .t-lib-t{display:flex;flex-direction:column;min-width:0}
.sh3 .t-lib-t small{font-size:11.5px;color:var(--text3)}
.sh3 .t-lib-d{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:330px}
.sh3 .t-lib-empty{padding:18px 8px;text-align:center}
.sh3 .t-lib-foot{display:flex;align-items:center;gap:8px;font-size:11.5px}
.sh3 .t-maker-wrap{position:absolute;inset:0;z-index:70;background:rgba(0,0,0,.55);display:grid;place-items:center;border-radius:inherit}
.sh3 .t-maker{width:640px;max-width:calc(100% - 40px);display:flex;flex-direction:column;gap:14px;padding:22px;border-radius:22px;
  background:var(--menu);border:1px solid var(--stroke2);box-shadow:var(--shadow)}
.sh3 .t-maker-h{display:flex;align-items:center}
.sh3 .t-maker-drop{display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px;border:1.5px dashed var(--stroke2);border-radius:16px;
  color:var(--text2)}
.sh3 .t-maker-drop.over{border-color:rgb(var(--ac));background:rgba(var(--ac),.08)}
.sh3 .t-maker-thumbs{display:flex;flex-wrap:wrap;gap:8px}
.sh3 .t-maker-th{position:relative;width:64px;height:64px}
.sh3 .t-maker-th img{width:64px;height:64px;object-fit:cover;border-radius:10px}
.sh3 .t-maker-th .t-x{position:absolute;right:-7px;top:-7px;width:22px;height:22px;border-radius:11px;display:grid;place-items:center;padding:0;
  background:var(--menu);border:1px solid var(--stroke2);color:var(--text2);cursor:pointer}
.sh3 .t-maker-th .t-x:hover{color:rgb(var(--bad));border-color:rgba(var(--bad),.6)}
.sh3 .t-maker-row{display:grid;grid-template-columns:90px 1fr;align-items:center;gap:12px}
.sh3 .t-maker-desc{resize:vertical;min-height:52px}
.sh3 .t-maker-est{font-size:12px}
.sh3 .t-maker-foot{display:flex;align-items:center;gap:10px}
.sh3 .t-maker-status{font-size:12.5px;color:var(--text2)}
.sh3 .t-maker-status.bad{color:rgb(var(--bad))}
.sh3 .t-maker-status.warn{color:rgb(var(--k))}
` }));
}
