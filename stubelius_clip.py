"""Continue a clip: in First/Last Frame mode the First Frame box takes a video as well as a picture,
and the new video starts where that clip ends.

timeline_data "source_clip": {"file", "fileName"} (uploaded like the other references). The
Director reads the clip on H3's 24 fps clock and starts its first chunk from the clip's last frames
and their sound, exactly the way a chunk of a long video starts from the chunk before it: those
frames are carried in and cut off again after decoding, so the take holds only new frames, and its
first one comes right after the clip's last. The render takes the clip's shape. The Quality polish
starts from the clip's frames in the same way, and the Finish puts the clip itself in front of the
take (only resized, never rendered again), unless the Output node leaves it out.
"""
import logging
import math
import os
from fractions import Fraction

import av
import numpy as np
import torch

import comfy.utils

log = logging.getLogger(__name__)

FPS = 24
VIDEO_EXTENSIONS = (".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi")


def is_video_name(name):
    return str(name or "").lower().endswith(VIDEO_EXTENSIONS)


class Clip:
    """An uploaded clip, as the video continues it: on the 24 fps clock, `frames` frames from
    `first` to `last` (seconds on the file's own clock), the last one being the clip's last."""

    def __init__(self, path, name, first, last, width, height, rotation, source_fps, has_audio):
        self.path, self.name = path, name
        self.first, self.last = float(first), float(last)
        self.width, self.height, self.rotation = int(width), int(height), int(rotation)
        self.source_fps, self.has_audio = float(source_fps), bool(has_audio)
        self.frames = int(round((self.last - self.first) * FPS)) + 1
        self.seconds = self.frames / FPS

    def info(self):
        """What a take keeps about its clip, for the polish and the Finish."""
        return {"file": self.path, "name": self.name, "first": self.first, "last": self.last,
                "width": self.width, "height": self.height, "rotation": self.rotation,
                "source_fps": self.source_fps, "has_audio": self.has_audio}

    @classmethod
    def from_info(cls, info):
        return cls(info["file"], info.get("name") or os.path.basename(info["file"]), info["first"], info["last"],
                   info["width"], info["height"], info.get("rotation", 0), info.get("source_fps", FPS),
                   info.get("has_audio", False))

    def times(self, count=None, from_start=False):
        """File times of the clip's frames on the 24 fps clock: the last `count` of them, the first
        `count` with from_start, all when None."""
        count = self.frames if count is None else max(1, min(int(count), self.frames))
        if from_start:
            return [self.first + k / FPS for k in range(count)]
        return [self.last - (count - 1 - k) / FPS for k in range(count)]


def _frame_time(frame, stream):
    if frame.time is not None:
        return float(frame.time)
    if frame.pts is not None and stream.time_base:
        return float(frame.pts * stream.time_base)
    return None


def _rotation(frame):
    """Degrees a frame has to turn to stand upright (phone clips carry it as side data)."""
    try:
        return int(round(float(getattr(frame, "rotation", 0) or 0))) % 360
    except (TypeError, ValueError):
        return 0


def _upright(array, rotation):
    # the display matrix angle is counterclockwise; numpy's rot90 turns counterclockwise too
    return np.ascontiguousarray(np.rot90(array, k=(rotation // 90) % 4)) if rotation % 360 else array


def _decode(path, start=0.0):
    """(time, frame) for every frame from about `start` seconds to the end of the file."""
    with av.open(path) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        if start > 0 and stream.time_base:
            container.seek(int(max(0.0, start) / float(stream.time_base)), stream=stream, backward=True)
        for frame in container.decode(stream):
            t = _frame_time(frame, stream)
            if t is not None:
                yield t, frame


def open_clip(entry, resolve_path):
    """The clip in timeline_data "source_clip", or None (no clip, not a video, can't be read)."""
    if not isinstance(entry, dict) or not entry.get("file"):
        return None
    name = entry.get("fileName") or entry["file"]
    path = resolve_path(entry["file"])
    if not path or not os.path.exists(path):
        log.warning("[StubeliusClip] the clip to continue was not found: %s", name)
        return None
    try:
        with av.open(path) as container:
            if not container.streams.video:
                log.warning("[StubeliusClip] %s has no video in it", name)
                return None
            stream = container.streams.video[0]
            rate = stream.average_rate or stream.guessed_rate or Fraction(FPS)
            has_audio = bool(container.streams.audio)
            seconds = (float(container.duration) / av.time_base) if container.duration else None
        first = None
        for t, frame in _decode(path):
            first, rotation = t, _rotation(frame)
            width, height = frame.width, frame.height
            break
        if first is None:
            log.warning("[StubeliusClip] %s has no frames", name)
            return None
        last = first
        for t, _ in _decode(path, (seconds or 0.0) - 2.0):
            last = max(last, t)
        if rotation in (90, 270):
            width, height = height, width
    except Exception as exc:
        log.warning("[StubeliusClip] could not read the clip %s: %s", name, exc)
        return None
    clip = Clip(path, name, first, last, width, height, rotation, float(rate), has_audio)
    log.info("[StubeliusClip] continuing %s: %dx%d, %.3g fps, %.2f s = %d frames at 24 fps%s", name,
             clip.width, clip.height, clip.source_fps, clip.seconds, clip.frames,
             "" if has_audio else ", no sound")
    return clip


def render_size(clip, megapixels, multiple):
    """The render size at the clip's own shape: the same formula as the aspect-ratio presets."""
    multiple = max(1, int(multiple))
    scale = math.sqrt(float(megapixels) * 1024 * 1024 / (clip.width * clip.height))
    return (max(multiple, round(clip.width * scale / multiple) * multiple),
            max(multiple, round(clip.height * scale / multiple) * multiple))


def _fit(batch, width, height):
    """uint8 [n, h, w, 3] -> float [n, height, width, 3], cover-cropped at the centre."""
    samples = torch.from_numpy(batch).float().div_(255.0)
    if tuple(samples.shape[1:3]) == (height, width):
        return samples
    return comfy.utils.common_upscale(samples.movedim(-1, 1), width, height, "lanczos", "center").movedim(1, -1)


def read(clip, width, height, count=None, out=None, batch=16, from_start=False):
    """The clip's frames on the 24 fps clock (the last `count`, the first with from_start, or all),
    fitted to width x height: IMAGE [n, height, width, 3]. With `out` (a float tensor of that shape)
    they are written into it."""
    targets = clip.times(count, from_start)
    n = len(targets)
    given = out is not None
    if not given:
        out = torch.empty((n, height, width, 3), dtype=torch.float32)
    start = targets[0] - 1.0 / max(1.0, clip.source_fps) - 0.5
    picks, k, pending, done = {}, 0, [], 0
    previous = None
    for t, frame in _decode(clip.path, start if count is not None and not from_start else 0.0):
        # each 24 fps time takes the frame nearest to it (a 24 fps clip: every frame once)
        while k < n and previous is not None and abs(previous[0] - targets[k]) <= abs(t - targets[k]):
            pending.append(previous[1])
            k += 1
        previous = (t, frame)
        if len(pending) >= batch:
            arrays = np.stack([_upright(f.to_ndarray(format="rgb24"), clip.rotation) for f in pending])
            out[done:done + len(pending)] = _fit(arrays, width, height)
            done += len(pending)
            pending = []
        if k >= n:
            break
    while k < n and previous is not None:       # the clip's last frames
        pending.append(previous[1])
        k += 1
    if pending:
        arrays = np.stack([_upright(f.to_ndarray(format="rgb24"), clip.rotation) for f in pending])
        out[done:done + len(pending)] = _fit(arrays, width, height)
        done += len(pending)
    if done < n:
        log.warning("[StubeliusClip] %s: %d of %d frames read", clip.name, done, n)
        if given and done:
            out[done:] = out[done - 1]          # the slot is the clip's length: hold its last frame
        else:
            out = out[:done]
    return out


def tail(clip, width, height, count, rate=None):
    """What a video continuing the clip starts from: its last `count` frames on the 24 fps clock,
    fitted to width x height, and their sound (AUDIO at `rate`). A clip shorter than that holds its
    first frame, and silence, at the front. A clip without sound gives silence: the carry-over
    (MiniMaxH3GeneratedAVMaskedContext) needs picture and sound."""
    frames = read(clip, width, height, count=count)
    under = sound(clip, seconds=count / FPS, rate=rate)
    short = int(count) - int(frames.shape[0])
    if short > 0:
        frames = torch.cat([frames[:1].expand(short, -1, -1, -1), frames])
        if under is not None:
            pad = round(short / FPS * under["sample_rate"])
            under["waveform"] = torch.nn.functional.pad(under["waveform"], (pad, 0))
    if under is None:
        rate = int(rate or 48000)
        under = {"waveform": torch.zeros((1, 2, round(int(count) / FPS * rate))), "sample_rate": rate}
    return frames, under


def decode_sound(path, rate=None, name=None):
    """A file's sound, stereo: (waveform [2, samples], sample rate, file time of its first sample), or
    None when it has none."""
    try:
        with av.open(path) as container:
            if not container.streams.audio:
                return None
            stream = container.streams.audio[0]
            rate = int(rate or stream.sample_rate or 48000)
            begin = float(stream.start_time * stream.time_base) if stream.start_time is not None else 0.0
            resampler = av.AudioResampler(format="fltp", layout="stereo", rate=rate)
            parts = []
            for frame in container.decode(stream):
                for out in resampler.resample(frame):
                    parts.append(torch.from_numpy(out.to_ndarray()))
            for out in resampler.resample(None):
                parts.append(torch.from_numpy(out.to_ndarray()))
    except Exception as exc:
        log.warning("[StubeliusClip] could not read the sound of %s: %s", name or os.path.basename(path), exc)
        return None
    if not parts:
        return None
    return torch.cat(parts, dim=1).float(), rate, begin


def sound(clip, seconds=None, rate=None, from_start=False):
    """The clip's sound under its 24 fps frames (the last `seconds` of it, the first with from_start,
    or all): AUDIO {"waveform": [1, 2, samples], "sample_rate"}, padded with silence where the file's
    sound is shorter. None for a clip without sound."""
    if not clip.has_audio:
        return None
    decoded = decode_sound(clip.path, rate, clip.name)
    if decoded is None:
        return None
    wave, rate, begin = decoded
    total = int(round(clip.seconds * rate))
    span = torch.zeros((2, total), dtype=torch.float32)
    offset = int(round((clip.first - begin) * rate))       # where the clip's first frame is in the sound
    src0, dst0 = max(0, offset), max(0, -offset)
    length = max(0, min(wave.shape[1] - src0, total - dst0))
    span[:, dst0:dst0 + length] = wave[:, src0:src0 + length]
    if seconds is not None:
        keep = max(1, min(total, int(round(float(seconds) * rate))))
        span = span[:, :keep] if from_start else span[:, -keep:]
    return {"waveform": span.unsqueeze(0), "sample_rate": rate}
