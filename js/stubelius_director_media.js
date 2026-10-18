// Stubelius Ultimate H3 Director: uploads and media helpers (pictures, clips, sounds, waveforms).
const { api } = window.comfyAPI.api;

// Reference videos, sounds, pictures and clips are uploaded files (ComfyUI's /upload/image takes any
// file type), so timeline_data holds a short path, never the picture itself.
export async function uploadFile(file) {
  const body = new FormData();
  body.append("image", file);
  body.append("subfolder", "musedirector");
  const resp = await api.fetchApi("/upload/image", { method: "POST", body });
  if (resp.status !== 200) throw new Error("Upload failed: " + resp.status);
  const data = await resp.json();
  const subfolder = data.subfolder || "";
  return { file: subfolder ? subfolder + "/" + data.name : data.name, fileName: file.name };
}

export function isVideoFile(file) {
  return (file?.type || "").startsWith("video/") || /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(file?.name || "");
}

export function isImageFile(file) {
  return (file?.type || "").startsWith("image/") || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file?.name || "");
}

export function isAudioFile(file) {
  return (file?.type || "").startsWith("audio/") || /\.(wav|mp3|flac|ogg|m4a|aac|opus)$/i.test(file?.name || "");
}

// /view URL of an input file (entry.file = "subfolder/name")
export function inputUrl(entryFile) {
  const idx = entryFile.lastIndexOf("/");
  const subfolder = idx >= 0 ? entryFile.slice(0, idx) : "";
  const name = idx >= 0 ? entryFile.slice(idx + 1) : entryFile;
  return api.apiURL(`/view?filename=${encodeURIComponent(name)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
}

// /view URL of a file ComfyUI wrote (output or temp)
export function viewUrl({ filename, subfolder = "", type = "output", v = "" }) {
  return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=${type}&subfolder=${encodeURIComponent(subfolder)}`
    + (v ? `&v=${v}` : ""));
}

// A picture entry's URL: the uploaded file wins over a same-session blob URL (dead after a reload)
export function pictureUrl(entry) {
  if (!entry) return null;
  return entry.file ? inputUrl(entry.file) : (entry._blobUrl || entry.image_b64 || null);
}

// The clip's last frame (where the video picks up), or its first (atStart), as a still <video>
export function clipStill(clip, onDuration, atStart = false) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.addEventListener("loadedmetadata", () => {
    if (!isFinite(video.duration)) return;
    video.currentTime = atStart ? Math.min(0.02, video.duration) : Math.max(0, video.duration - 0.02);
    onDuration?.(video.duration);
  });
  video.src = inputUrl(clip.file);
  return video;
}

export async function urlToB64(url) {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function extractAudioPeaks(file, numPeaks = 120) {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const channelData = audioBuffer.getChannelData(0);
  const peaks = [];
  const step = Math.max(1, Math.floor(channelData.length / numPeaks));
  for (let i = 0; i < numPeaks; i++) {
    let max = 0;
    for (let j = 0; j < step; j++) {
      const val = Math.abs(channelData[i * step + j] || 0);
      if (val > max) max = val;
    }
    peaks.push(max);
  }
  audioCtx.close?.();
  return { peaks, duration: audioBuffer.duration };
}

export function videoSeconds(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve(isFinite(v.duration) ? Math.round(v.duration * 1000) / 1000 : 0);
    v.onerror = () => resolve(0);
    v.src = URL.createObjectURL(file);
  });
}

// Bars of a waveform into a canvas, in the given CSS colour
export function drawPeaks(canvas, peaks, color) {
  if (!peaks || !peaks.length) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, hgt = canvas.height;
  ctx.clearRect(0, 0, w, hgt);
  ctx.fillStyle = color;
  const barW = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const amp = Math.max(1, peaks[i] * hgt * 0.9);
    ctx.fillRect(i * barW, (hgt - amp) / 2, Math.max(1, barW - 1), amp);
  }
}

// Ask for a file (accept = "image/*" ...) -> File or null
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

// Several files at once (the pictures a character is made from)
export function pickFiles(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.onchange = () => resolve(Array.from(input.files || []));
    input.click();
  });
}

// A drop target that takes every dropped file: onDrop(files, event)
export function dropTargetMany(el, onDrop, overClass = "over") {
  const isFile = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  el.addEventListener("dragover", (e) => {
    if (!isFile(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add(overClass);
  });
  el.addEventListener("dragleave", () => el.classList.remove(overClass));
  el.addEventListener("drop", (e) => {
    el.classList.remove(overClass);
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    onDrop(files, e);
  });
}

// Make an element a drop target for files from the desktop: onDrop(file, event)
export function dropTarget(el, onDrop, overClass = "over") {
  const isFile = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  el.addEventListener("dragover", (e) => {
    if (!isFile(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add(overClass);
  });
  el.addEventListener("dragleave", () => el.classList.remove(overClass));
  el.addEventListener("drop", (e) => {
    el.classList.remove(overClass);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    onDrop(file, e);
  });
}
