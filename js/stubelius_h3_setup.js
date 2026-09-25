const { app } = window.comfyAPI.app;

// Stubelius H3 Setup: picking a mode fills the settings with that mode's preset. The presets
// come from the Python node (mode input's "presets" option), so there is one source of truth.
// Only a user change of the mode applies a preset; loading a saved workflow keeps its values.
// The Output node's size list follows the mode of the Setup wired into it ("per_mode": Speed
// goes up to 2K, Quality starts at its native ~768p). A mode change keeps the chosen size when
// the new mode offers it; otherwise it takes that mode's "fallback" (4K -> 2K on Speed).
const FIELDS = {
  steps: "steps",
  sampler: "sampler",
  scheduler: "scheduler",
  megapixels: "megapixels",
  speedup_strength: "speedup_lora_strength",
};
const SIZES = { perMode: null, fallback: null };

function getLink(graph, id) {
  if (id == null || !graph) return null;
  return graph.getLink?.(id) ?? graph.links?.get?.(id) ?? graph.links?.[id] ?? null;
}

// The Setup node wired into an Output node's "mode" input.
function setupOf(outputNode) {
  const input = outputNode.inputs?.find((i) => i.name === "mode");
  const link = getLink(outputNode.graph, input?.link);
  const src = link && outputNode.graph.getNodeById(link.origin_id);
  return src?.comfyClass === "StubeliusH3Setup" ? src : null;
}

function syncSizes(outputNode, mode) {
  const w = outputNode.widgets?.find((x) => x.name === "final_resolution");
  const list = SIZES.perMode?.[mode];
  if (!w || !list) return;
  w.options.values = [...list];
  if (!list.includes(w.value)) {
    w.value = SIZES.fallback?.[mode]?.[w.value] ?? (list.includes("1080p") ? "1080p" : list[0]);
    w.callback?.(w.value);
  }
  outputNode.setDirtyCanvas?.(true, true);
}

function syncAll(graph, setupNode) {
  for (const n of graph?._nodes || graph?.nodes || []) {
    if (n.comfyClass !== "StubeliusH3Output") continue;
    const s = setupOf(n);
    if (!s || (setupNode && s !== setupNode)) continue;
    const mode = s.widgets?.find((w) => w.name === "mode")?.value;
    if (mode) syncSizes(n, mode);
  }
}

app.registerExtension({
  name: "Stubelius.H3Setup",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === "StubeliusH3Output") {
      const opts = nodeData.input?.required?.final_resolution?.[1] || {};
      SIZES.perMode = opts.per_mode || null;
      SIZES.fallback = opts.fallback || null;
      // wiring a Setup into it narrows the list straight away
      const onConnectionsChange = nodeType.prototype.onConnectionsChange;
      nodeType.prototype.onConnectionsChange = function () {
        const r = onConnectionsChange?.apply(this, arguments);
        setTimeout(() => {
          const mode = setupOf(this)?.widgets?.find((w) => w.name === "mode")?.value;
          if (mode) syncSizes(this, mode);
        }, 0);
        return r;
      };
      return;
    }
    if (nodeData.name !== "StubeliusH3Setup") return;
    const presets = nodeData.input?.required?.mode?.[1]?.presets || {};

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const modeWidget = this.widgets?.find((w) => w.name === "mode");
      if (!modeWidget) return r;
      const original = modeWidget.callback;
      modeWidget.callback = (value, ...rest) => {
        const preset = presets[value];
        if (preset) {
          for (const [key, widgetName] of Object.entries(FIELDS)) {
            const w = this.widgets.find((x) => x.name === widgetName);
            if (w && preset[key] !== undefined) {
              w.value = preset[key];
              w.callback?.(w.value);
            }
          }
          this.setDirtyCanvas(true, true);
        }
        syncAll(this.graph, this);
        return original?.call(modeWidget, value, ...rest);
      };
      return r;
    };
  },
  async afterConfigureGraph() {
    setTimeout(() => syncAll(app.graph, null), 0);
  },
});
