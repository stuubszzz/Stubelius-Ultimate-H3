// Stubelius Ultimate H3 Director: the big preview.
//
// It plays the latest video the workflow made (the Seed Previews node writes one per seed), a chunk's
// take while you point at it in the inspector, and the live sampling frames while the Director renders.
// Under it: play, the time, a scrub bar in chunks (the picked chunk lit) and a filmstrip of the takes.
import { h, icon, clear, fmtClock } from "./stubelius_ui.js";
import { viewUrl, pictureUrl } from "./stubelius_director_media.js";

function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const CSS = `
.sh3-d .d-preview{position:relative;border-radius:24px;overflow:hidden;border:1px solid var(--stroke2);box-shadow:var(--panel-shadow);
  background:var(--video);min-height:600px;isolation:isolate}
.sh3-d .d-pv-bg{position:absolute;inset:-40px;background-size:cover;background-position:center;filter:blur(36px) saturate(1.3) brightness(.55);
  transform:scale(1.1);z-index:0}
.sh3-d .d-pv-video,.sh3-d .d-pv-live{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:1;display:none;background:transparent}
.sh3-d .d-vig{position:absolute;inset:0;z-index:2;pointer-events:none;
  background:linear-gradient(180deg,rgba(0,0,0,.35) 0%,transparent 22%,transparent 62%,rgba(5,4,10,.92) 100%)}
.sh3-d .d-pv-tl{position:absolute;left:20px;top:18px;display:flex;gap:8px;z-index:3;flex-wrap:wrap;right:120px}
.sh3-d .d-pv-tr{position:absolute;right:18px;top:18px;display:flex;gap:8px;z-index:3}
.sh3-d .d-pv-tr .sh3-gchip{padding:8px 10px;border:1px solid rgba(255,255,255,.16)}
.sh3-d .d-pv-empty{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
  text-align:center;padding:40px;color:#f3f1f8}
.sh3-d .d-pv-empty .sh3-muted{max-width:440px;color:rgba(243,241,248,.7)}
.sh3-d .d-pv-empty-ic{width:76px;height:76px;border-radius:22px;display:grid;place-items:center;background:rgba(255,255,255,.08);
  border:1px solid rgba(255,255,255,.16);color:rgba(255,255,255,.85);backdrop-filter:blur(10px)}
.sh3-d .d-controls{position:absolute;left:22px;right:22px;bottom:96px;display:flex;align-items:center;gap:14px;color:#f3f1f8;z-index:3}
.sh3-d .d-play{width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.92);color:#120a12;display:grid;place-items:center;border:0;
  box-shadow:0 10px 30px rgba(0,0,0,.45);flex:none;padding:0}
.sh3-d .d-play:hover{transform:scale(1.05)}
.sh3-d .d-time{font-family:var(--fh);font-size:16px;font-weight:600;white-space:nowrap}
.sh3-d .d-time span{color:#9d9aae;font-weight:500}
.sh3-d .d-scrub{flex:1;height:34px;position:relative;cursor:pointer}
.sh3-d .d-sg{position:absolute;top:12px;height:10px;border-radius:6px;background:rgba(255,255,255,.4)}
.sh3-d .d-sg.on{background:var(--brand);box-shadow:0 0 16px rgba(var(--ac),.6)}
.sh3-d .d-sg.cut{background:rgba(var(--cut),.45)}
.sh3-d .d-knob{position:absolute;top:5px;width:24px;height:24px;border-radius:50%;background:#fff;pointer-events:none;
  box-shadow:0 0 0 5px rgba(var(--ac),.35),0 0 24px rgba(var(--ac),.8)}
.sh3-d .d-film{position:absolute;left:22px;right:22px;bottom:18px;height:62px;display:flex;gap:6px;z-index:3}
.sh3-d .d-film-cell{flex:1;border-radius:9px;overflow:hidden;border:1px solid rgba(255,255,255,.14);background-color:rgba(255,255,255,.05);
  background-size:cover;background-position:center;padding:0;position:relative}
.sh3-d .d-film-cell.blank{background:rgba(255,255,255,.04);border-style:dashed}
.sh3-d .d-film-cell.sel{border-color:rgba(var(--ac),.55)}
.sh3-d .d-film-cell.cutmark{border:2px solid rgb(var(--cut))}
.sh3-d .d-film-cell:hover{filter:brightness(1.15)}
.sh3-d .d-live-dot{width:8px;height:8px;border-radius:50%;background:#ff4d6a;box-shadow:0 0 10px #ff4d6a;animation:sh3-pulse 1s infinite}
`;
let styled = false;

export function buildPreview(d) {
  if (!styled) {
    styled = true;
    document.head.appendChild(h("style", { id: "stubelius-uh3-preview", text: CSS }));
  }
  const video = h("video.d-pv-video", { playsInline: true, preload: "metadata" });
  video.muted = !!d.node.properties?.sh3_muted;
  const live = h("img.d-pv-live");
  const liveVideo = h("video.d-pv-live", { muted: true, loop: true, autoplay: true, playsInline: true });
  liveVideo.muted = true;
  const bg = h("div.d-pv-bg");
  const empty = h("div.d-pv-empty");
  const tl = h("div.d-pv-tl");
  const muteBtn = h("button.sh3-gchip", { type: "button", title: "Sound on/off" });
  const fullBtn = h("button.sh3-gchip", { type: "button", title: "Full screen" }, icon("maximize", 16));
  const tr = h("div.d-pv-tr", fullBtn, muteBtn);
  const playBtn = h("button.d-play", { type: "button", title: "Play / pause" });
  const time = h("div.d-time");
  const scrub = h("div.d-scrub");
  const knob = h("div.d-knob");
  const controls = h("div.d-controls", playBtn, time, scrub);
  const film = h("div.d-film");
  const el = h("div.d-preview", bg, video, live, liveVideo, empty, h("div.d-vig"), tl, tr, controls, film);

  const st = {
    videos: null,         // the Seed Previews' last videos (else the ones saved on that node)
    hover: null,          // {base, seed, k}: a take shown instead of the video
    liveUrl: null,
  };

  const drawMute = () => {
    clear(muteBtn);
    muteBtn.appendChild(icon(video.muted ? "volumeOff" : "volume", 16));
  };
  muteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    video.muted = !video.muted;
    d.node.properties = d.node.properties || {};
    d.node.properties.sh3_muted = video.muted;
    drawMute();
  });
  fullBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  });
  const drawPlay = () => {
    clear(playBtn);
    playBtn.appendChild(icon(video.paused ? "play" : "pause", 22));
  };
  playBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!video.src) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  video.addEventListener("play", drawPlay);
  video.addEventListener("pause", drawPlay);
  video.addEventListener("ended", drawPlay);
  video.addEventListener("loadedmetadata", () => { drawTime(); drawScrub(); });
  video.addEventListener("timeupdate", () => { drawTime(); moveKnob(); d.onPlayhead?.(currentTime()); });
  drawMute();
  drawPlay();

  // the video's clock -> the timeline's (a take of one chunk plays from that chunk's start)
  const offset = () => (st.hover ? (d.bounds()[st.hover.k]?.[0] || 0) : 0);
  const currentTime = () => offset() + (video.currentTime || 0);
  const total = () => {
    if (st.hover) return video.duration || 0;
    return Math.max(video.duration || 0, 0) || d.durationSeconds;
  };

  function drawTime() {
    clear(time);
    time.append(fmtClock(video.currentTime || 0), h("span", ` / ${fmtClock(total())}`));
  }

  // the chunks along the scrub bar: the takes' real lengths when the report has them
  function chunkEdges() {
    const b = d.bounds();
    const rep = d.report;
    if (!rep || st.hover) return b;
    let t = 0;
    const out = [];
    for (let k = 0; k < b.length; k++) {
      const cur = d.takesOf(k).current;
      if (!cur) return b;
      const len = Number(cur.seconds) || (b[k][1] - b[k][0]);
      out.push([t, t + len]);
      t += len;
    }
    return out;
  }

  function drawScrub() {
    clear(scrub);
    const edges = chunkEdges();
    const end = edges[edges.length - 1]?.[1] || 1;
    edges.forEach(([s, e], k) => {
      const seg = h("div.d-sg", { class: k === d.sel ? "on" : (d.timeline.chunks[k]?.carry === "new_shot" && k ? "cut" : null),
        style: { left: `${(s / end) * 100}%`, width: `calc(${((e - s) / end) * 100}% - 4px)` } });
      seg.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const r = scrub.getBoundingClientRect();
        seek(((ev.clientX - r.left) / r.width) * end);
      });
      scrub.appendChild(seg);
    });
    scrub.appendChild(knob);
    moveKnob();
  }

  function moveKnob() {
    const edges = chunkEdges();
    const end = st.hover ? (video.duration || 1) : (edges[edges.length - 1]?.[1] || 1);
    const t = st.hover ? (video.currentTime || 0) : currentTime();
    knob.style.left = `calc(${Math.min(100, (t / end) * 100)}% - 12px)`;
  }

  function seek(t) {
    if (!video.src) return;
    video.currentTime = Math.max(0, Math.min((video.duration || t) - 0.02, t - offset()));
  }

  // which video plays: a take pointed at, the latest seed preview, or nothing yet
  function source() {
    if (st.hover) return { url: d.takeUrl(st.hover.base, st.hover.seed, "preview.mp4"), kind: "take" };
    const list = st.videos || d.seedsNode()?.properties?.sh3_seeds;     // saved with the workflow
    if (list && list.length) {
      const winner = Number(d.finishNode()?.widgets?.find((w) => w.name === "winner")?.value || 0);
      const pick = list.find((v) => v.candidate === winner) || list[0];
      return { url: viewUrl(pick), kind: "full", seed: pick };
    }
    return null;
  }

  function poster() {
    const k = d.sel;
    const t = d.takesOf(k);
    if (t.current && t.base) return d.takeUrl(t.base, t.current.seed, "thumb.jpg");
    for (let j = 0; j < d.numChunks(); j++) {
      const tj = d.takesOf(j);
      if (tj.current && tj.base) return d.takeUrl(tj.base, tj.current.seed, "thumb.jpg");
    }
    if (!d.isReference) return pictureUrl(d.timeline.characters[0]);
    return pictureUrl(d.timeline.characters.find((c) => c && (c.file || c.image_b64)));
  }

  function drawFilm() {
    clear(film);
    const rep = d.report;
    film.style.display = rep && (rep.chunks || []).length ? "flex" : "none";
    const edges = chunkEdges();
    const end = edges[edges.length - 1]?.[1] || 1;
    const cells = 10;
    for (let i = 0; i < cells; i++) {
      const t = ((i + 0.5) / cells) * end;
      const k = Math.max(0, edges.findIndex(([s, e]) => t >= s && t < e));
      const tk = rep ? d.takesOf(k) : null;
      const cell = h("button.d-film-cell", { type: "button", title: `${t.toFixed(1)} s · chunk ${k + 1}` });
      if (tk?.current && tk.base) {
        const [s, e] = edges[k];
        const frac = Math.max(0, Math.min(0.999, (t - s) / Math.max(0.001, e - s)));
        if (tk.current.strip) {
          cell.style.backgroundImage = `url("${d.takeUrl(tk.base, tk.current.seed, "strip.jpg")}")`;
          const n = Number(tk.current.strip) || 8;
          cell.style.backgroundSize = `${n * 100}% 100%`;
          cell.style.backgroundPosition = `${(Math.floor(frac * n) / Math.max(1, n - 1)) * 100}% 0`;
        } else {
          cell.style.backgroundImage = `url("${d.takeUrl(tk.base, tk.current.seed, "thumb.jpg")}")`;
        }
      } else {
        cell.classList.add("blank");
      }
      if (k > 0 && d.timeline.chunks[k]?.carry === "new_shot" && edges[k] && Math.abs(t - edges[k][0]) < end / cells / 2 + 0.01) {
        cell.classList.add("cutmark");
      }
      if (k === d.sel) cell.classList.add("sel");
      cell.addEventListener("click", (e) => { e.stopPropagation(); seek(t); });
      cell.addEventListener("dblclick", (e) => { e.stopPropagation(); d.select(k); });
      film.appendChild(cell);
    }
  }

  function drawChips() {
    clear(tl);
    const k = d.sel;
    if (st.hover) {
      tl.append(h("div.sh3-gchip.brand", icon("movie", 15), `Chunk ${st.hover.k + 1} · a take`),
        h("div.sh3-gchip", icon("dice", 15), `seed ${st.hover.seed}`));
      return;
    }
    const src = source();
    if (src?.kind === "full") {
      const v = src.seed;
      tl.append(h("div.sh3-gchip.brand", icon("movie", 15),
        v.partial ? `Chunks 1-${v.chunks} of ${v.of}` : `Whole video · seed ${v.candidate || 1}`));
    }
    const t = d.takesOf(k);
    tl.append(h("div.sh3-gchip", icon("dice", 15), `chunk ${k + 1} · seed ${d.seedOf(k)}${t.current ? "" : " · not rendered"}`));
  }

  function render() {
    const src = source();
    const p = poster();
    d.ambient.style.backgroundImage = p ? `url("${p}")` : "none";
    bg.style.backgroundImage = p ? `url("${p}")` : "none";
    if (d.live && (d.run.state === "running")) {
      showLive(d.live);
    } else {
      live.style.display = "none";
      liveVideo.style.display = "none";
      if (!liveVideo.paused) liveVideo.pause();
    }
    if (src) {
      if (video.dataset.src !== src.url) {
        const wasPlaying = !video.paused;
        video.dataset.src = src.url;
        video.src = src.url;
        video.poster = p || "";
        if (wasPlaying || src.kind === "take") video.play().catch(() => {});
      }
      video.style.display = "block";
      empty.style.display = "none";
      controls.style.display = "flex";
    } else {
      video.removeAttribute("src");
      video.dataset.src = "";
      video.style.display = "none";
      controls.style.display = "none";
      empty.style.display = "flex";
      clear(empty);
      empty.append(h("div.d-pv-empty-ic", icon("movie", 34)),
        h("div.sh3-h3", "Render to see it here"),
        h("div.sh3-muted", "Every chunk you render is kept as a take: render one chunk again with Retake, or a few at once with Hunt."));
      if (p) empty.classList.add("over-poster"); else empty.classList.remove("over-poster");
    }
    drawChips();
    drawScrub();
    drawTime();
    drawFilm();
  }

  function showLive(lv) {
    if (!lv?.image) return;
    const url = URL.createObjectURL(b64ToBlob(lv.image, lv.mime));
    const old = st.liveUrl;
    st.liveUrl = url;
    if (lv.mime.startsWith("video/")) {
      live.style.display = "none";
      liveVideo.style.display = "block";
      liveVideo.src = url;
      liveVideo.play?.().catch(() => {});
    } else {
      liveVideo.style.display = "none";
      live.style.display = "block";
      live.src = url;
    }
    empty.style.display = "none";
    clear(tl);
    const step = lv.step != null && lv.total ? ` · step ${lv.step}/${lv.total}` : "";
    const chunk = d.run.chunk != null ? ` · chunk ${d.run.chunk + 1}` : "";
    tl.append(h("div.sh3-gchip.brand", h("span.d-live-dot"), `Live${chunk}${step}`));
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
  }

  return {
    el,
    render,
    showLive,
    setVideos(list) {
      st.videos = list;
      const seeds = d.seedsNode();
      if (seeds) {
        seeds.properties = seeds.properties || {};
        seeds.properties.sh3_seeds = list;
      }
      st.hover = null;
      render();
    },
    showTake(k, base, seed) {
      st.hover = base ? { k, base, seed } : null;
      render();
    },
    onChunk() {},
    get time() { return currentTime(); },
    seek,
  };
}
