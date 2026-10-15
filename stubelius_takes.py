"""Takes (Ultimate H3): every chunk the Director renders is kept, so one chunk can be rendered again (a
retake) without rendering the chunks before it, an older take picked back, one chunk hunted with several
seeds while the chunks before it render once, and a stopped or crashed render picked up where it stopped.

A take is found by its key: a hash of everything its chunk is made from (its prompt, pictures, sounds,
size, steps, models and LoRAs, how it joins the chunk before it) and, when the chunk starts from the
chunk before it, of that take's key. The base key leaves the seed out: a chunk's takes share it and
differ by seed alone, so a retake is a new seed and picking an older take back is setting its seed again.

timeline_data:
    takes_id        keep the takes on disk and report them for this node (none: nothing on disk)
    chunks[i].seed  the chunk's own seed (a retake, or a take picked back); none = the Director's seed
    render_until    render chunks 0 .. render_until only (0-based)
    hunt_chunk      {"chunk": k, "count": n}: n candidates that differ in chunk k alone, the video up to it

On disk, in ComfyUI's output folder under StubeliusH3/takes/<base>/<seed>/ (STUBELIUS_TAKES_DIR moves it):
    frames.mkv    every frame the chunk decoded to, lossless (FFV1, 8 bits a channel)
    data.pt       its sound, its finished latent (for the Quality polish), the frames its carry-over held
    meta.json     chunk number, seed, size, when it was made and last used
    thumb.jpg     a frame from its middle; preview.mp4, a small copy with its sound, for the panel
At most STUBELIUS_TAKES_GB of it (20 by default; 0 keeps no takes on disk): the takes used longest ago go
first. The takes of the render that is running are never removed by it.
"""
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid

import numpy as np
import torch

import folder_paths

log = logging.getLogger(__name__)

VERSION = 1                 # bump when the Director makes a chunk differently from the same recipe
DEFAULT_GB = 20.0
SEED_STRIDE = 1_000_003     # the Director's SEED_HUNT_SEED_STRIDE: candidate i adds i of these
SEED_MASK = 0xffffffffffffffff
FRAME_FORMAT = "ffv1"       # "pt" keeps the frames exactly as decoded (the CPU tests read their values)
PREVIEW_WIDTH = 512
THUMB_WIDTH = 320
STRIP_FRAMES = 8            # strip.jpg: this many frames across a take, for the Director's filmstrip
STRIP_WIDTH = 160
HASH_MEMO_BYTES = 8 << 20   # tensors this big are hashed once per render (the same object every chunk)
NODES = "_nodes"            # the last report of each node, next to the takes
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_BASE = re.compile(r"^[0-9a-f]{40}$")
_SEED = re.compile(r"^[0-9]{1,20}$")
_LOCK = threading.RLock()   # saves, prunes and the server's routes take turns


def root():
    return os.environ.get("STUBELIUS_TAKES_DIR") or os.path.join(
        folder_paths.get_output_directory(), "StubeliusH3", "takes")


def cap_bytes():
    try:
        gb = float(os.environ.get("STUBELIUS_TAKES_GB", DEFAULT_GB))
    except ValueError:
        gb = DEFAULT_GB
    return int(max(0.0, gb) * 1e9)


def _seed(value):
    """A seed from the timeline (an int, or digits in a string), or None."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        if not _SEED.match(value):
            return None
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None
    return value & SEED_MASK if value >= 0 else None


def _index(value, count):
    """A 0-based chunk index from the timeline that is inside the video, or None."""
    if isinstance(value, bool) or value is None or value == "":
        return None
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None
    return value if 0 <= value < count else None


def hunt_request(tdata):
    """(chunk, count) when the timeline asks to hunt one chunk, else None. Read before the chunks are
    known (the Director V2 sets its candidate count from it); Plan checks the chunk is in the video."""
    hunt = (tdata or {}).get("hunt_chunk")
    if isinstance(hunt, dict):
        chunk, count = hunt.get("chunk"), hunt.get("count", 4)
    else:
        chunk, count = hunt, 4
    if isinstance(chunk, bool) or chunk is None or chunk == "":
        return None
    try:
        chunk, count = int(chunk), int(count)
    except (TypeError, ValueError):
        return None
    return (chunk, max(2, min(4, count))) if chunk >= 0 else None


class Plan:
    """What the timeline asks of this render: each chunk's own seed, how far to render, which chunk
    to hunt, and whether to keep takes on disk (takes_id)."""

    def __init__(self, tdata, num_chunks):
        tdata = tdata or {}
        self.num_chunks = num_chunks
        takes_id = str(tdata.get("takes_id") or "").strip()
        self.takes_id = takes_id if _ID.match(takes_id) else None
        self.seeds = {}
        for k, chunk in enumerate((tdata.get("chunks") or [])[:num_chunks]):
            own = _seed((chunk or {}).get("seed")) if isinstance(chunk, dict) else None
            if own is not None:
                self.seeds[k] = own
        hunt = hunt_request(tdata)
        self.hunt = hunt[0] if hunt and hunt[0] < num_chunks else None
        if hunt and self.hunt is None:
            log.warning("[StubeliusTakes] hunt_chunk %d is past the video's %d chunks: left out", hunt[0] + 1, num_chunks)
        until = _index(tdata.get("render_until"), num_chunks)
        last = num_chunks - 1 if until is None else until
        if self.hunt is not None:
            last = max(self.hunt, last if until is not None else self.hunt)
        self.last = last
        # Every chunk it renders keeps its own seed (no hunt): the other candidates vary the last of them, so a second
        # seed is a second video (it was the first one again) and the picked chunks before it stay as they are
        self.vary_last = self.hunt is None and all(k in self.seeds for k in range(self.last + 1))

    @property
    def partial(self):
        return self.last < self.num_chunks - 1

    def chunk_seeds(self, seed, candidate):
        """Every chunk's seed in candidate `candidate` (0 = the main one). A chunk with its own seed keeps
        it in every candidate, and candidates vary the others, as whole-video seeds always did; a hunt
        varies the hunted chunk alone; when every rendered chunk has its own seed, they vary the last one."""
        out = []
        for k in range(self.num_chunks):
            own = self.seeds.get(k)
            base = int(seed) if own is None else own
            varies = (k == self.hunt) if self.hunt is not None else (own is None or (self.vary_last and k == self.last))
            out.append((base + candidate * SEED_STRIDE) & SEED_MASK if varies and candidate else base & SEED_MASK)
        return out

    def shared(self, candidates):
        """How many chunks from the start every candidate of this render shares (same seeds), so the
        later candidates take them from the first instead of rendering them again."""
        if candidates < 2:
            return 0
        rows = [self.chunk_seeds(0, i) for i in range(candidates)]
        count = 0
        while count < self.num_chunks and len({row[count] for row in rows}) == 1:
            count += 1
        return count


def file_stamp(path):
    """(size, modified) of a file, so a file replaced under the same name is a different recipe."""
    try:
        st = os.stat(path)
        return [int(st.st_size), int(st.st_mtime_ns)]
    except (OSError, TypeError, ValueError):
        return None


_MODEL_FOLDERS = {"ref2va_model": ("diffusion_models", "unet_gguf"), "fl2va_model": ("diffusion_models", "unet_gguf"),
                  "text_encoder": ("text_encoders", "clip_gguf"), "video_vae": ("vae",), "audio_vae": ("vae",)}


def models_key(cfg):
    """The Models node's settings as a recipe part (with each file's stamp); the live preview's tiny VAE
    doesn't change the video, so it is left out."""
    out = []
    for name, value in sorted((cfg or {}).items()):
        if name == "live_preview":
            continue
        stamp = None
        if isinstance(value, str) and value and value != "none":
            folders = _MODEL_FOLDERS.get(name) or (("loras",) if "lora" in name else ())
            for folder in folders:
                try:
                    path = folder_paths.get_full_path(folder, value)
                except Exception:
                    path = None
                if path:
                    stamp = file_stamp(path)
                    break
        out.append([name, value if isinstance(value, (str, int, float, bool)) or value is None else repr(value), stamp])
    return out


def bundle_key(models):
    """The Models node's bundle as a recipe part, or None (plain model sockets: unknown, so no takes on disk)."""
    if models is None:
        return None
    cfg = getattr(models, "cfg", None)
    if isinstance(cfg, dict):
        return models_key(cfg)
    key = getattr(models, "key", None)
    return [["key", repr(key)]] if key is not None else None


def tensor_digest(t, memo=None):
    if memo is not None:
        hit = memo.get(id(t))
        if hit is not None and hit[0] is t:
            return hit[1]
    b = t.detach()
    if b.device.type != "cpu":
        b = b.cpu()
    b = b.contiguous()
    if b.dtype == torch.bfloat16:
        b = b.view(torch.int16)
    h = hashlib.sha1(f"{tuple(b.shape)}|{b.dtype}|".encode())
    if b.numel():
        h.update(memoryview(b.numpy()).cast("B"))
    digest = h.hexdigest()
    if memo is not None and b.numel() * b.element_size() >= HASH_MEMO_BYTES:
        memo[id(t)] = (t, digest)
    return digest


class Recipe:
    """A chunk's recipe, hashed as it is written: plain values, lists, dicts, tensors (by content)."""

    def __init__(self, memo=None):
        self._h = hashlib.sha1()
        self._memo = memo

    def add(self, label, value):
        self._h.update(f"<{label}>".encode())
        self._feed(value)
        return self

    def _feed(self, v):
        h = self._h
        if v is None or isinstance(v, (bool, int, float, str)):
            h.update(f"{type(v).__name__}:{v!r};".encode())
        elif torch.is_tensor(v):
            h.update(f"T{tensor_digest(v, self._memo)};".encode())
        elif getattr(v, "is_nested", False):
            self._feed(list(v.unbind()))
        elif isinstance(v, dict):
            h.update(f"{{{len(v)}".encode())
            for k in sorted(v, key=str):
                self._feed(str(k))
                self._feed(v[k])
            h.update(b"}")
        elif isinstance(v, (list, tuple)):
            h.update(f"[{len(v)}".encode())
            for x in v:
                self._feed(x)
            h.update(b"]")
        elif isinstance(v, np.ndarray):
            self._feed(torch.from_numpy(np.ascontiguousarray(v)))
        else:
            h.update(f"?{type(v).__name__}:{v!r};".encode())

    def hexdigest(self):
        return self._h.hexdigest()


def take_key(base, seed):
    """The key of one take: its chunk's base key and its seed."""
    return hashlib.sha1(f"{base}:{int(seed)}".encode()).hexdigest()


class Take:
    """One chunk as the Director decoded it, before it cut its opening frames or smoothed its seam."""

    def __init__(self, images, audio, latent, carry_trim, lip_sync_locked):
        self.images = images                    # [frames, height, width, 3] float32, 0-1
        self.audio = audio                      # AUDIO
        self.latent = latent                    # the finished latent (the Quality polish renders from it)
        self.carry_trim = carry_trim            # frames the carry-over held (cut again), or None
        self.lip_sync_locked = bool(lip_sync_locked)

    def handed_out(self):
        """The take for one more use: the frames are never changed in place, the sound may be."""
        audio = {"waveform": self.audio["waveform"].clone(), "sample_rate": self.audio["sample_rate"]}
        return Take(self.images, audio, self.latent, self.carry_trim, self.lip_sync_locked)


# ------------------------------------------------------------------------ files

def _plain(value):
    """A latent dict as plain tensors, lists and dicts (torch.load with weights_only reads it back)."""
    if getattr(value, "is_nested", False):
        return {"__nested__": [_plain(t) for t in value.unbind()]}
    if torch.is_tensor(value):
        return value.detach().cpu()
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return None


def _rebuilt(value):
    if isinstance(value, dict):
        if set(value) == {"__nested__"}:
            import comfy.nested_tensor
            return comfy.nested_tensor.NestedTensor(tuple(_rebuilt(t) for t in value["__nested__"]))
        return {k: _rebuilt(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_rebuilt(v) for v in value]
    return value


def _ffv1_options(width, height):
    return {"level": "3", "slices": "16" if width * height >= 200_000 else "4"}


def _write_frames(folder, images):
    if FRAME_FORMAT == "pt":
        torch.save(images.detach().cpu().contiguous(), os.path.join(folder, "frames.pt"))
        return
    import av
    n, height, width = int(images.shape[0]), int(images.shape[1]), int(images.shape[2])
    with av.open(os.path.join(folder, "frames.mkv"), "w") as out:
        stream = out.add_stream("ffv1", rate=24)
        stream.width, stream.height, stream.pix_fmt = width, height, "bgr0"
        stream.codec_context.thread_count = 0
        stream.codec_context.options = _ffv1_options(width, height)
        for i in range(0, n, 16):
            part = images[i:i + 16].detach().cpu().mul(255.0).round_().clamp_(0, 255).to(torch.uint8).numpy()
            for frame in part:
                out.mux(stream.encode(av.VideoFrame.from_ndarray(frame, format="rgb24")))
        out.mux(stream.encode(None))


def _read_frames(folder):
    path = os.path.join(folder, "frames.pt")
    if os.path.isfile(path):
        return torch.load(path, weights_only=True)
    import av
    frames = []
    with av.open(os.path.join(folder, "frames.mkv")) as source:
        stream = source.streams.video[0]
        stream.thread_type = "AUTO"
        for frame in source.decode(stream):
            frames.append(frame.to_ndarray(format="rgb24"))
    return torch.from_numpy(np.stack(frames)).to(torch.float32).div_(255.0)


def _uint8(frame):
    return frame.detach().cpu().mul(255.0).round().clamp(0, 255).to(torch.uint8).numpy()


def write_mp4(path, frames, audio=None, audio_from=0.0, fps=24, max_width=None, crf=23):
    """frames (IMAGE) and their sound as an H.264 + AAC mp4 (even size, at most max_width wide)."""
    import av
    height, width = int(frames.shape[1]), int(frames.shape[2])
    pw = width if not max_width else min(int(max_width), width)
    pw = max(2, pw // 2 * 2)
    ph = max(2, round(height * pw / width) // 2 * 2)
    with av.open(path, "w", options={"movflags": "+faststart"}) as out:
        video = out.add_stream("libx264", rate=int(round(fps)))
        video.width, video.height, video.pix_fmt = pw, ph, "yuv420p"
        video.options = {"crf": str(crf), "preset": "veryfast"}
        sound = wave = None
        if audio is not None and audio.get("waveform") is not None and audio["waveform"].shape[-1] > 0:
            rate = int(audio["sample_rate"])
            wave = audio["waveform"][0].detach().cpu().float()[:2]
            wave = wave[:, int(round(float(audio_from) * rate)):]
            wave = wave[:, :int(round(frames.shape[0] / fps * rate)) + rate // 10]
            layout = "mono" if wave.shape[0] == 1 else "stereo"
            sound = out.add_stream("aac", rate=rate, layout=layout)
        for i in range(0, int(frames.shape[0]), 16):
            part = frames[i:i + 16].detach().cpu()
            if (pw, ph) != (width, height):
                part = torch.nn.functional.interpolate(part.movedim(-1, 1), size=(ph, pw), mode="area").movedim(1, -1)
            for frame in part.mul(255.0).round_().clamp_(0, 255).to(torch.uint8).numpy():
                out.mux(video.encode(av.VideoFrame.from_ndarray(frame, format="rgb24")))
        out.mux(video.encode(None))
        if sound is not None and wave.shape[-1] > 0:
            frame = av.AudioFrame.from_ndarray(wave.clamp(-1, 1).contiguous().numpy(), format="fltp", layout=layout)
            frame.sample_rate, frame.pts = rate, 0
            out.mux(sound.encode(frame))
            out.mux(sound.encode(None))


def write_stills(folder, frames, strip=STRIP_FRAMES):
    """thumb.jpg (a frame from the middle) and strip.jpg (`strip` frames across it, side by side)."""
    from PIL import Image
    n = int(frames.shape[0])
    picture = Image.fromarray(_uint8(frames[n // 2]))
    width = min(THUMB_WIDTH, picture.width)
    size = (width, max(2, round(picture.height * width / picture.width)))
    picture.resize(size, Image.LANCZOS).save(os.path.join(folder, "thumb.jpg"), quality=85)
    cell = (STRIP_WIDTH, max(2, round(picture.height * STRIP_WIDTH / picture.width)))
    sheet = Image.new("RGB", (cell[0] * strip, cell[1]))
    for i in range(strip):
        k = min(n - 1, int((i + 0.5) / strip * n))
        sheet.paste(Image.fromarray(_uint8(frames[k])).resize(cell, Image.BILINEAR), (i * cell[0], 0))
    sheet.save(os.path.join(folder, "strip.jpg"), quality=78)


def _write_preview(folder, images, audio, trim):
    """thumb.jpg, strip.jpg and preview.mp4 (small, with its sound) of the frames the chunk adds to the
    video. Best effort: a take without them still works."""
    frames = images[int(trim):] if int(trim) < int(images.shape[0]) else images[-1:]
    try:
        write_stills(folder, frames)
    except Exception as e:
        log.warning("[StubeliusTakes] no thumbnail for this take: %s", e)
    try:
        write_mp4(os.path.join(folder, "preview.mp4"), frames, audio, audio_from=int(trim) / 24.0,
                  max_width=PREVIEW_WIDTH, crf=26)
    except Exception as e:
        log.warning("[StubeliusTakes] no preview video for this take: %s", e)
        try:
            os.remove(os.path.join(folder, "preview.mp4"))
        except OSError:
            pass


def _folder_bytes(folder):
    total = 0
    for name in os.listdir(folder):
        try:
            total += os.path.getsize(os.path.join(folder, name))
        except OSError:
            pass
    return total


def _read_meta(folder):
    try:
        with open(os.path.join(folder, "meta.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write_json(path, data):
    tmp = f"{path}.{uuid.uuid4().hex[:8]}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _take_folder(base, seed, top=None):
    return os.path.join(top or root(), base, str(int(seed)))


def save(base, seed, take, info, top=None):
    """Write one take (atomically: a half-written take is never found)."""
    folder = _take_folder(base, seed, top)
    if os.path.isfile(os.path.join(folder, "meta.json")):
        return folder
    os.makedirs(os.path.dirname(folder), exist_ok=True)
    tmp = f"{folder}.part-{uuid.uuid4().hex[:8]}"
    os.makedirs(tmp)
    try:
        _write_frames(tmp, take.images)
        torch.save({"audio": {"waveform": take.audio["waveform"].detach().cpu(),
                              "sample_rate": int(take.audio["sample_rate"])},
                    "latent": _plain(take.latent), "carry_trim": take.carry_trim,
                    "lip_sync_locked": take.lip_sync_locked}, os.path.join(tmp, "data.pt"))
        trim = int(info.get("trim") or 0)
        _write_preview(tmp, take.images, take.audio, trim)
        now = time.time()
        frames, height, width = (int(x) for x in take.images.shape[:3])
        meta = {"version": VERSION, "base": base, "seed": int(seed), "key": take_key(base, seed),
                "chunk": int(info.get("chunk", 0)), "carry": info.get("carry"), "frames": frames,
                "new_frames": max(0, frames - trim), "trim": trim, "width": width, "height": height,
                "seconds": round(max(0, frames - trim) / 24.0, 3), "made": now, "used": now}
        meta["bytes"] = _folder_bytes(tmp) + 512
        _write_json(os.path.join(tmp, "meta.json"), meta)
        with _LOCK:
            if os.path.isfile(os.path.join(folder, "meta.json")):     # made by another render meanwhile
                shutil.rmtree(tmp, ignore_errors=True)
            else:
                if os.path.isdir(folder):
                    shutil.rmtree(folder, ignore_errors=True)            # a broken take: replaced
                os.replace(tmp, folder)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return folder


def load(base, seed, top=None):
    """The take, or None when there is none (or it can't be read)."""
    folder = _take_folder(base, seed, top)
    meta = _read_meta(folder)
    if not meta or meta.get("version") != VERSION:
        return None
    images = _read_frames(folder)
    data = torch.load(os.path.join(folder, "data.pt"), weights_only=True)
    take = Take(images, data["audio"], _rebuilt(data.get("latent")), data.get("carry_trim"),
                data.get("lip_sync_locked", False))
    meta["used"] = time.time()
    try:
        _write_json(os.path.join(folder, "meta.json"), meta)
    except OSError:
        pass
    return take


def listing(base, top=None):
    """The takes of one chunk base, oldest first: [meta]."""
    if not _BASE.match(str(base or "")):
        return []
    folder = os.path.join(top or root(), base)
    out = []
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    for name in names:
        if not _SEED.match(name):
            continue
        meta = _read_meta(os.path.join(folder, name))
        if meta and meta.get("version") == VERSION:
            meta["thumb"] = os.path.isfile(os.path.join(folder, name, "thumb.jpg"))
            meta["preview"] = os.path.isfile(os.path.join(folder, name, "preview.mp4"))
            meta["strip"] = STRIP_FRAMES if os.path.isfile(os.path.join(folder, name, "strip.jpg")) else 0
            out.append(meta)
    return sorted(out, key=lambda m: m.get("made", 0))


def _all_takes(top):
    """[(used, bytes, folder, (base, seed))] of every take on disk."""
    found = []
    try:
        bases = os.listdir(top)
    except OSError:
        return found
    for base in bases:
        if not _BASE.match(base):
            continue
        try:
            names = os.listdir(os.path.join(top, base))
        except OSError:
            continue
        for name in names:
            folder = os.path.join(top, base, name)
            if ".part-" in name:
                try:
                    if time.time() - os.path.getmtime(folder) > 3600:    # left by a render that crashed
                        shutil.rmtree(folder, ignore_errors=True)
                except OSError:
                    pass
                continue
            if not _SEED.match(name):
                continue
            meta = _read_meta(folder) or {}
            found.append((float(meta.get("used", 0)), int(meta.get("bytes") or _folder_bytes(folder)), folder,
                          (base, int(name))))
    return found


def usage(top=None):
    takes = _all_takes(top or root())
    return {"takes": len(takes), "bytes": sum(t[1] for t in takes), "cap": cap_bytes(), "dir": top or root()}


def prune(keep=(), top=None):
    """Remove the takes used longest ago until the folder fits in STUBELIUS_TAKES_GB; never those in `keep`."""
    top = top or root()
    cap = cap_bytes()
    with _LOCK:
        takes = sorted(_all_takes(top))
        total = sum(t[1] for t in takes)
        removed = 0
        for used, size, folder, key in takes:
            if total <= cap:
                break
            if key in keep:
                continue
            shutil.rmtree(folder, ignore_errors=True)
            total -= size
            removed += 1
            try:
                os.rmdir(os.path.dirname(folder))      # its base, once it holds no take
            except OSError:
                pass
    if removed:
        log.info("[StubeliusTakes] %d older take(s) removed: the takes folder holds at most %.0f GB "
                 "(STUBELIUS_TAKES_GB)", removed, cap / 1e9)
    return removed


def delete(base, seed, top=None):
    if not (_BASE.match(str(base)) and _SEED.match(str(seed))):
        return False
    folder = _take_folder(base, seed, top)
    with _LOCK:
        if not os.path.isdir(folder):
            return False
        shutil.rmtree(folder, ignore_errors=True)
        try:
            os.rmdir(os.path.dirname(folder))
        except OSError:
            pass
    return True


def clear(top=None):
    """Remove every take (the node reports go with them)."""
    top = top or root()
    count = 0
    with _LOCK:
        for used, size, folder, key in _all_takes(top):
            shutil.rmtree(folder, ignore_errors=True)
            count += 1
        for name in os.listdir(top) if os.path.isdir(top) else []:
            path = os.path.join(top, name)
            if _BASE.match(name) or name == NODES:
                shutil.rmtree(path, ignore_errors=True)
    return count


# ------------------------------------------------------------------------ one render

class Store:
    """The takes of one Director run: on disk when the timeline has a takes_id (and the models are known),
    and in memory for the chunks every candidate of this run shares."""

    def __init__(self, plan, models, candidates):
        self.plan = plan
        self.disk = (root() if plan.takes_id and models is not None and cap_bytes() > 0 else None)
        self.models = models
        self.shared = plan.shared(candidates)
        self.memory = {}
        self.used = set()
        self.rows = []
        self.memo = {}
        if plan.takes_id and models is None:
            log.info("[StubeliusTakes] takes are kept with the Models node only (its settings are part of a "
                     "take's key): this run keeps none on disk")

    def active(self, chunk_idx):
        """Is this chunk's take looked up and kept? (keys cost a hash of its pictures)"""
        return self.disk is not None or chunk_idx < self.shared

    def recipe(self):
        r = Recipe(self.memo)
        r.add("version", VERSION)
        r.add("models", self.models)
        return r

    def find(self, base, seed, chunk_idx):
        seed = int(seed)
        take = self.memory.get((base, seed))
        if take is not None:
            self.used.add((base, seed))
            return take.handed_out()
        if self.disk is None:
            return None
        try:
            take = load(base, seed, self.disk)
        except Exception as e:
            log.warning("[StubeliusTakes] a kept take couldn't be read (%s): rendering it again", e)
            take = None
        if take is not None:
            self.used.add((base, seed))
            if chunk_idx < self.shared:
                self.memory[(base, seed)] = take.handed_out()
        return take

    def keep(self, base, seed, take, chunk_idx, info):
        seed = int(seed)
        if chunk_idx < self.shared:
            self.memory[(base, seed)] = take.handed_out()
        if self.disk is None:
            return
        try:
            save(base, seed, take, dict(info, chunk=chunk_idx), self.disk)
            self.used.add((base, int(seed)))
            prune(self.used, self.disk)
        except Exception as e:
            log.warning("[StubeliusTakes] chunk %d's take couldn't be kept (%s): the render goes on", chunk_idx + 1, e)

    def note(self, candidate, chunk_idx, base, seed, reused):
        self.rows.append({"candidate": candidate, "chunk": chunk_idx, "base": base, "seed": int(seed),
                          "reused": bool(reused)})

    def report(self, seed, candidates):
        """What this run rendered and found, per chunk, with each chunk's takes on disk (main candidate)."""
        if self.disk is None:
            return None
        chunks = []
        for k in range(self.plan.last + 1):
            rows = sorted((r for r in self.rows if r["chunk"] == k), key=lambda r: r["candidate"])
            if not rows:
                break
            main = rows[0]
            chunks.append({"chunk": k, "base": main["base"], "seed": main["seed"], "own_seed": k in self.plan.seeds,
                           "candidates": [{"seed": r["seed"], "base": r["base"], "reused": r["reused"]} for r in rows]})
        report = {"takes_id": self.plan.takes_id, "made": time.time(), "seed": int(seed), "candidates": int(candidates),
                  "chunks_total": self.plan.num_chunks, "render_until": self.plan.last,
                  "hunt": self.plan.hunt, "chunks": chunks}
        try:
            os.makedirs(os.path.join(self.disk, NODES), exist_ok=True)
            _write_json(os.path.join(self.disk, NODES, f"{self.plan.takes_id}.json"), report)
        except OSError as e:
            log.warning("[StubeliusTakes] the takes report couldn't be written: %s", e)
        return with_listings(report, self.disk)

    def close(self):
        self.memory.clear()
        self.memo.clear()


def with_listings(report, top=None):
    """The report with each chunk's takes as they are on disk now."""
    if not report:
        return report
    out = dict(report)
    out["chunks"] = [dict(c, takes=listing(c.get("base"), top)) for c in report.get("chunks") or []]
    return out


def read_report(takes_id, top=None):
    if not _ID.match(str(takes_id or "")):
        return None
    try:
        with open(os.path.join(top or root(), NODES, f"{takes_id}.json"), encoding="utf-8") as f:
            return with_listings(json.load(f), top)
    except (OSError, ValueError):
        return None


def progress(event):
    """Tell the open windows where a render is (a chunk started, found as a take, ...)."""
    try:
        from server import PromptServer
        send = getattr(PromptServer.instance, "send_sync", None)
        if send is not None:
            send("stubelius_ultimate_h3.chunk", event)
    except Exception:
        pass


def announce(report):
    """Tell the open panels this node's takes changed."""
    if not report:
        return
    try:
        from server import PromptServer
        send = getattr(PromptServer.instance, "send_sync", None)
        if send is not None:
            send("stubelius_ultimate_h3.takes", report)
    except Exception:
        pass


# ------------------------------------------------------------------------ server routes

def open_in_file_manager(path):
    import subprocess
    import sys
    if sys.platform.startswith("win"):
        os.startfile(path)                  # a folder inside the output folder, see the route
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


def _routes():
    try:
        import asyncio
        from aiohttp import web
        from server import PromptServer
        routes = PromptServer.instance.routes
    except Exception:
        return

    async def off_loop(fn, *args):
        """Disk work (reading every take, removing gigabytes) off the server's event loop."""
        return await asyncio.get_running_loop().run_in_executor(None, fn, *args)

    async def body_of(request):
        """The request's JSON object, or None for anything else (the route then answers 400)."""
        try:
            body = await request.json()
        except Exception:
            return None
        return body if isinstance(body, dict) else None

    @routes.get("/stubelius_ultimate_h3/takes/report")
    async def _report(request):
        return web.json_response(await off_loop(read_report, request.query.get("id")) or {})

    @routes.get("/stubelius_ultimate_h3/takes/list")
    async def _list(request):
        return web.json_response({"takes": await off_loop(listing, request.query.get("base"))})

    @routes.get("/stubelius_ultimate_h3/takes/file")
    async def _file(request):
        base, seed, name = request.query.get("base", ""), request.query.get("seed", ""), request.query.get("name", "")
        if not (_BASE.match(base) and _SEED.match(seed) and name in ("thumb.jpg", "strip.jpg", "preview.mp4")):
            return web.Response(status=400)
        path = os.path.join(_take_folder(base, seed), name)
        if not os.path.isfile(path):
            return web.Response(status=404)
        return web.FileResponse(path, headers={"Cache-Control": "max-age=86400"})

    @routes.get("/stubelius_ultimate_h3/takes/usage")
    async def _usage(request):
        return web.json_response(await off_loop(usage))

    @routes.post("/stubelius_ultimate_h3/takes/delete")
    async def _delete(request):
        body = await body_of(request)
        if body is None:
            return web.Response(status=400)
        return web.json_response({"deleted": await off_loop(delete, str(body.get("base", "")), str(body.get("seed", "")))})

    @routes.post("/stubelius_ultimate_h3/takes/clear")
    async def _clear(request):
        return web.json_response({"cleared": await off_loop(clear)})

    # The Setup window's model cards: each file's size (folder = a ComfyUI model folder name)
    @routes.post("/stubelius_ultimate_h3/model_info")
    async def _model_info(request):
        body = await body_of(request)
        if body is None:
            return web.Response(status=400)

        def sizes():
            out = []
            for item in (body.get("items") or [])[:32]:
                if not (isinstance(item, (list, tuple)) and len(item) == 2):
                    continue
                folder, name = item
                size = None
                try:
                    path = folder_paths.get_full_path(str(folder), str(name))
                    size = os.path.getsize(path) if path else None
                except Exception:
                    pass
                out.append({"folder": folder, "name": name, "size": size, "found": size is not None})
            return out
        return web.json_response({"items": await off_loop(sizes)})

    # The Output window's Open folder: a folder inside ComfyUI's output folder, in the file manager of the
    # machine ComfyUI runs on, and only for a browser on that same machine.
    @routes.post("/stubelius_ultimate_h3/open_folder")
    async def _open_folder(request):
        if request.remote not in ("127.0.0.1", "::1", "localhost"):
            return web.json_response({"opened": False, "why": "only from the machine ComfyUI runs on"}, status=403)
        body = await body_of(request)
        if body is None:
            return web.Response(status=400)
        top = os.path.abspath(folder_paths.get_output_directory())
        path = os.path.abspath(os.path.join(top, str(body.get("subfolder") or "")))
        if os.path.commonpath([path, top]) != top or not os.path.isdir(path):
            return web.json_response({"opened": False, "why": "not a folder in the output folder"}, status=400)
        await off_loop(open_in_file_manager, path)
        return web.json_response({"opened": True})


_routes()
