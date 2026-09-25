const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

// Stubelius Live Preview: a display-only panel. The Models node attaches KJ's Model Preview
// Override to whichever node samples (Director, or Finish for the Quality polish); KJ sends
// "kj_preview_override" events addressed to that node id, and KJ's own UI only draws them on
// its own node type. This panel shows every such frame, labelled with the node that sent it.
// KJ sends a JPEG for a single frame, an animated WebP, or an MP4 (NVENC) for multi-frame
// previews, so both an <img> and a looping muted <video> are kept and one is shown at a time.
app.registerExtension({
  name: "Stubelius.LivePreview",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "StubeliusLivePreview") return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      // The node keeps the size it has in the workflow. The media sits absolutely positioned
      // inside a fixed-size stage, so a big frame or video never pushes the node taller
      // (Vue nodes size themselves to their content); it is scaled down to fit instead.
      const root = document.createElement("div");
      root.className = "stb-live-preview";
      root.style.cssText = "display:flex;flex-direction:column;gap:6px;width:100%;height:100%;" +
        "min-height:0;overflow:hidden;box-sizing:border-box;";
      const label = document.createElement("div");
      label.style.cssText = "flex:0 0 16px;font:12px/16px sans-serif;color:#9a9aa8;" +
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      label.textContent = "Waiting for the next render…";
      const stage = document.createElement("div");
      stage.className = "stb-live-preview-stage";
      stage.style.cssText = "position:relative;flex:1 1 0;min-height:0;overflow:hidden;" +
        "background:#0e0e12;border-radius:6px;";
      const media = "position:absolute;inset:0;width:100%;height:100%;max-width:100%;max-height:100%;" +
        "object-fit:contain;display:block;";
      const img = document.createElement("img");
      img.style.cssText = media + "display:none;";
      const video = document.createElement("video");
      video.style.cssText = media + "display:none;";
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      stage.append(img, video);
      root.append(label, stage);
      const node = this;
      // The widget asks for the room the node already has, never for the media's natural size.
      const fit = () => Math.max(120, (node.size?.[1] ?? 400) - 40);
      this.addDOMWidget("live_preview", "stubelius_live_preview", root, {
        serialize: false,
        getMinHeight: () => 120,
        getHeight: fit,
        getMaxHeight: fit,
      });
      this._stubeliusPreview = { label, img, video, url: null };
      // Only a freshly added node gets the default size; a loaded workflow keeps its own.
      this.setSize([Math.max(this.size?.[0] ?? 0, 520), Math.max(this.size?.[1] ?? 0, 400)]);
      return r;
    };
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const p = this._stubeliusPreview;
      if (p?.url) URL.revokeObjectURL(p.url);
      return onRemoved?.apply(this, arguments);
    };
  },
});

function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function show(p, b64, mime) {
  const url = URL.createObjectURL(b64ToBlob(b64, mime));
  const old = p.url;
  p.url = url;
  if (mime.startsWith("video/")) {
    p.img.style.display = "none";
    p.video.style.display = "block";
    p.video.src = url;
    p.video.play?.().catch(() => {});
  } else {
    p.video.pause?.();
    p.video.removeAttribute("src");
    p.video.style.display = "none";
    p.img.style.display = "block";
    p.img.src = url;
  }
  if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
}

api.addEventListener("kj_preview_override", (e) => {
  const d = e.detail;
  if (!d) return;
  const graph = app.graph;
  const nodes = graph?._nodes || graph?.nodes || [];
  const leafId = String(d.node_id ?? "").split(":").pop();
  const source = graph?.getNodeById?.(Number(leafId)) || graph?.getNodeById?.(leafId);
  const who = source?.title || `node ${d.node_id}`;
  for (const n of nodes) {
    if (n.comfyClass !== "StubeliusLivePreview" || !n._stubeliusPreview) continue;
    const p = n._stubeliusPreview;
    if (typeof d.image === "string" && d.image) {
      try { show(p, d.image, typeof d.mime === "string" ? d.mime : "image/jpeg"); }
      catch (err) { console.warn("[Stubelius Live Preview] could not decode frame", err); }
    }
    const step = d.step != null && d.total ? ` — step ${d.step}/${d.total}` : "";
    p.label.textContent = `${who}${step}`;
  }
});
