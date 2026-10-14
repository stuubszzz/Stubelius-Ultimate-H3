// Stubelius Ultimate H3 Director: the timeline file menu (save, load) and the settings popover
// (time display, file names, the Analyze backend, kept takes).
import { h, icon, label, seg, toggle, select, button, menu, popover, closeMenus, fmtBytes, toast } from "./stubelius_ui.js";

const PROVIDERS = [["ollama", "Ollama (local)"], ["lmstudio", "LM Studio (local)"], ["gemini", "Gemini / Google"],
  ["custom", "Custom (OpenAI-compatible)"], ["off", "Off: describe by hand"]];

export function openFileMenu(d, anchor) {
  menu(anchor, [
    { label: "Save the timeline…", icon: "download", onClick: () => saveTimeline(d) },
    { label: "Load a timeline…", icon: "upload", onClick: () => loadTimeline(d) },
  ]);
}

async function saveTimeline(d) {
  const text = JSON.stringify(d.timeline, null, 2);
  const name = "ultimate_h3_timeline.json";
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name,
        types: [{ description: "JSON file", accept: { "application/json": [".json"] } }] });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function loadTimeline(d) {
  const input = h("input", { type: "file", accept: ".json,application/json" });
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a timeline");
      const keep = d.timeline.takes_id;
      d.tw.value = JSON.stringify(parsed);
      d.timeline = d.loadState();
      d.timeline.takes_id = keep;
      d.commit();
      d.edited = new Set(d.timeline.chunks.map((_, k) => k));
      d.refresh();
      toast(d.root, `Loaded ${file.name}`);
    } catch (err) {
      console.error("[Stubelius Director] couldn't load the timeline", err);
      toast(d.root, "That file isn't a timeline", "bad");
    }
  };
  input.click();
}

export function openSettings(d, anchor) {
  const t = d.timeline;
  const body = h("div.s-body");
  body.appendChild(h("div.s-sec", label("Time on the timeline"),
    seg([["seconds", "Seconds"], ["frames", "Frames (24 fps)"]], t.display_mode === "frames" ? "frames" : "seconds", (v) => {
      t.display_mode = v;
      d.commit();
      d.refresh(["tl", "insp"]);
    })));
  body.appendChild(h("div.s-sec.s-line", h("div", h("b", "File names"), h("div.sh3-muted", "Under reference clips and sounds")),
    toggle(t.show_filenames !== false, (v) => { t.show_filenames = v; d.commit(); d.refresh(["refs"]); })));

  const url = h("input.sh3-input", { type: "text", value: t.analyze_base_url || "", placeholder: "blank = the provider's default" });
  const model = h("input.sh3-input", { type: "text", value: t.analyze_model || "", placeholder: "blank = the provider's default" });
  url.addEventListener("change", () => { t.analyze_base_url = url.value.trim(); d.commit(); });
  model.addEventListener("change", () => { t.analyze_model = model.value.trim(); d.commit(); });
  body.appendChild(h("div.s-sec", label("Analyze (describes reference pictures)"),
    select(PROVIDERS, t.analyze_provider || "ollama", (v) => { t.analyze_provider = v; d.commit(); }),
    h("div.s-grid", h("span.sh3-muted", "Base URL"), url, h("span.sh3-muted", "Model"), model),
    h("div.sh3-muted.s-small", "Ollama and LM Studio run here, no key needed. Gemini needs GEMINI_API_KEY set before ComfyUI starts. Custom = any OpenAI-compatible /chat/completions.")));

  const usage = d.usage;
  body.appendChild(h("div.s-sec", label("Kept takes"),
    h("div.s-line", h("div", h("b", usage ? `${usage.takes} takes · ${fmtBytes(usage.bytes)}` : "None yet"),
      h("div.sh3-muted", usage ? `At most ${fmtBytes(usage.cap)}; the oldest go first (STUBELIUS_TAKES_GB)` : "Every chunk you render is kept")),
    button("Clear", "trash", "small danger", () => { closeMenus(); d.clearTakes(); }))));
  popover(anchor, body, 400);
}

const style = document.createElement("style");
style.id = "stubelius-uh3-settings";
style.textContent = `
.sh3 .sh3-pop{padding:16px;cursor:default}
.sh3 .s-body{display:flex;flex-direction:column;gap:16px}
.sh3 .s-sec{display:flex;flex-direction:column;gap:8px}
.sh3 .s-line{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-direction:row}
.sh3 .s-grid{display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center}
.sh3 .s-small{font-size:11.5px;line-height:1.45}
`;
if (!document.getElementById(style.id)) document.head.appendChild(style);
