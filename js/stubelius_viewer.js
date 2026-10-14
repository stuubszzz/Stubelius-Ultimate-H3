// Stubelius Ultimate H3: a split viewer for two videos of the same moment (Seeds: A/B; Output: the render
// against the finished picture). B fills the frame, A shows left of a divider you drag; both play in sync.
// An optional loupe magnifies B twice under the pointer.
import { h, icon } from "./stubelius_ui.js";

const CSS = `
.sh3 .v-split{position:relative;overflow:hidden;background:var(--video);border-radius:inherit;isolation:isolate;user-select:none}
.sh3 .v-split video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:transparent}
.sh3 .v-split .v-a{clip-path:inset(0 calc(100% - var(--x,50%)) 0 0);z-index:1}
.sh3 .v-split .v-b{z-index:0}
.sh3 .v-line{position:absolute;top:0;bottom:0;left:var(--x,50%);width:2px;margin-left:-1px;background:#fff;z-index:2;
  box-shadow:0 0 18px rgba(255,255,255,.55);pointer-events:none}
.sh3 .v-handle{position:absolute;top:50%;left:var(--x,50%);width:62px;height:62px;margin:-31px 0 0 -31px;border-radius:50%;background:#fff;color:#14101a;
  display:grid;place-items:center;z-index:3;cursor:ew-resize;box-shadow:0 0 0 6px rgba(var(--ac),.35),0 12px 30px rgba(0,0,0,.45);touch-action:none}
.sh3 .v-lab{position:absolute;top:16px;z-index:3}
.sh3 .v-lab.a{left:16px} .sh3 .v-lab.b{right:16px}
.sh3 .v-loupe{position:absolute;width:220px;height:220px;border-radius:50%;z-index:4;pointer-events:none;display:none;
  border:4px solid #fff;box-shadow:0 0 0 6px rgba(var(--ac),.45),0 24px 60px rgba(0,0,0,.55);overflow:hidden;background:#000}
.sh3 .v-loupe canvas{width:100%;height:100%;display:block}
.sh3 .v-zoomtag{position:absolute;left:50%;bottom:-38px;transform:translateX(-50%)}
.sh3 .v-split.side .v-a{clip-path:none;width:50%;left:0;right:auto}
.sh3 .v-split.side .v-b{width:50%;left:50%}
.sh3 .v-split.side .v-line,.sh3 .v-split.side .v-handle{display:none}
.sh3 .v-split.single .v-a,.sh3 .v-split.single .v-line,.sh3 .v-split.single .v-handle,.sh3 .v-split.single .v-lab.a{display:none}
`;
let styled = false;

export function splitViewer({ labelA = "A", labelB = "B" } = {}) {
  if (!styled) {
    styled = true;
    document.head.appendChild(h("style", { id: "stubelius-uh3-viewer", text: CSS }));
  }
  const a = h("video.v-a", { muted: true, playsInline: true, preload: "auto", loop: true });
  const b = h("video.v-b", { muted: true, playsInline: true, preload: "auto", loop: true });
  a.muted = true;
  const line = h("div.v-line");
  const handle = h("div.v-handle", { title: "Drag to compare" }, icon("arrowsH", 26));
  const labA = h("div.v-lab.a.sh3-gchip", labelA);
  const labB = h("div.v-lab.b.sh3-gchip", labelB);
  const loupeCanvas = h("canvas", { width: 440, height: 440 });
  const loupe = h("div.v-loupe", loupeCanvas);
  const el = h("div.v-split", b, a, line, handle, labA, labB, loupe);
  let x = 50, loupeOn = false, loupeAt = null, raf = 0;

  const setX = (pct) => {
    x = Math.max(2, Math.min(98, pct));
    el.style.setProperty("--x", `${x}%`);
  };
  setX(50);
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture?.(e.pointerId);
    const r = el.getBoundingClientRect();
    const move = (ev) => setX(((ev.clientX - r.left) / r.width) * 100);
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });

  // A follows B
  const sync = () => {
    if (!a.src || !b.src) return;
    if (Math.abs(a.currentTime - b.currentTime) > 0.08) a.currentTime = b.currentTime;
    if (b.paused !== a.paused) (b.paused ? a.pause() : a.play().catch(() => {}));
  };
  b.addEventListener("timeupdate", sync);
  b.addEventListener("play", () => a.play().catch(() => {}));
  b.addEventListener("pause", () => a.pause());
  b.addEventListener("seeked", () => { a.currentTime = b.currentTime; });

  // the loupe: B, twice as big, under the pointer
  const contentRect = () => {
    const r = el.getBoundingClientRect();
    const vw = b.videoWidth || 16, vh = b.videoHeight || 9;
    const s = Math.min(r.width / vw, r.height / vh);
    return { r, s, ox: (r.width - vw * s) / 2, oy: (r.height - vh * s) / 2, vw, vh };
  };
  const drawLoupe = () => {
    raf = 0;
    if (!loupeOn || !loupeAt || !b.videoWidth) return;
    const { r, s, ox, oy, vw, vh } = contentRect();
    const scale = r.width / el.offsetWidth || 1;
    const px = (loupeAt.x - r.left - ox) / s, py = (loupeAt.y - r.top - oy) / s;     // video pixels
    // the side under the pointer: A left of the divider (or the left half side by side), else B
    const side = el.classList.contains("side") ? 50 : x;
    const src = !el.classList.contains("single") && ((loupeAt.x - r.left) / r.width) * 100 < side && a.videoWidth ? a : b;
    const k = src.videoWidth / vw || 1;                                                 // A may be bigger than B
    const size = (220 * scale / s / 2) * k;                                             // source region for 2x
    const ctx = loupeCanvas.getContext("2d");
    ctx.drawImage(src, Math.max(0, Math.min(src.videoWidth - size, px * k - size / 2)),
      Math.max(0, Math.min(src.videoHeight - size, py * k - size / 2)), size, size, 0, 0, 440, 440);
    loupe.style.left = `${(loupeAt.x - r.left) / scale - 110}px`;
    loupe.style.top = `${(loupeAt.y - r.top) / scale - 110}px`;
    if (!b.paused) raf = requestAnimationFrame(drawLoupe);
  };
  el.addEventListener("pointermove", (e) => {
    if (!loupeOn) return;
    loupeAt = { x: e.clientX, y: e.clientY };
    if (!raf) raf = requestAnimationFrame(drawLoupe);
  });
  el.addEventListener("pointerleave", () => { if (loupeOn) loupe.style.display = "none"; });
  el.addEventListener("pointerenter", () => { if (loupeOn) loupe.style.display = "block"; });

  return {
    el, a, b,
    setSources(srcA, srcB) {
      if (srcA && a.dataset.src !== srcA) { a.dataset.src = srcA; a.src = srcA; }
      if (srcB && b.dataset.src !== srcB) { b.dataset.src = srcB; b.src = srcB; }
    },
    setLabels(la, lb) { labA.textContent = la; labB.textContent = lb; },
    setMode(mode) {          // "split" | "side" | "single" (B alone)
      el.classList.toggle("side", mode === "side");
      el.classList.toggle("single", mode === "single");
    },
    setLoupe(on) {
      loupeOn = on;
      loupe.style.display = on && loupeAt ? "block" : "none";
      el.style.cursor = on ? "crosshair" : "";
    },
    setMuted(muted) { b.muted = muted; },
    play() { b.play().catch(() => {}); },
    pause() { b.pause(); },
    toggle() { if (b.paused) b.play().catch(() => {}); else b.pause(); },
    seek(t) { b.currentTime = Math.max(0, t); },
  };
}
