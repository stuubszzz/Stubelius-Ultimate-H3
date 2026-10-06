# Stubelius Ultimate H3

One MiniMax H3 workflow for ComfyUI. You decide up front **how** the video is made
(Speed, Hybrid, Quality or PDMD) and **what comes out** (resolution, frame rate, upscaler). The
Director holds **what the video is**. Render 1–4 full seeds with sound, pick the winner, and
only the winner gets finished.

The workflow is in [`example_workflows/Stubelius_Ultimate_H3.json`](example_workflows/Stubelius_Ultimate_H3.json).
Once the pack is installed it also appears in ComfyUI under **Workflow → Browse Templates → Stubelius-Ultimate-H3**.

## What's in it

| Node | Job |
|---|---|
| **Stubelius H3 Setup** | Mode preset: Speed (≈480p, 8 steps), Hybrid (≈540p, 10 steps), Quality (≈768p, 20 steps, no speedup LoRA), PDMD (≈768p in 4 steps); 1–4 seeds |
| **Stubelius H3 Models** | ref2va + fl2va checkpoints (safetensors or GGUF), text encoder, VAEs, speedup LoRA, PDMD LoRA, two global LoRAs, attention and low-VRAM options, live preview |
| **Stubelius H3 Output** | Final resolution per mode (Speed up to 2K, the other modes up to 4K; exact short side, portrait too), 24/48/60 fps through RIFE, RTX VSR or DLSS5 + Color Lock, Quality polish (1.5x or 2x), a continued clip in front of the video or not, **de-stutter** |
| **Stubelius H3 Director V2** | Timeline, Reference (Omni) or First/Last Frame mode with up to two **middle frames**, **sounds and clips** pinned on the timeline (or a **clip to continue** in place of the first frame), references, aspect, duration (Extend past one chunk), seed, **LoRAs per chunk** |
| **Stubelius H3 Finish** | WINNER 1–4 (0 = hold after the seeds). Changing it re-runs only the finish, from cache |
| **Stubelius Live Preview** | Watch the Director (and the Quality polish) while it samples |
| **Stubelius RIFE to FPS**, **Stubelius Color Lock** | Frame rate conversion that keeps hard cuts clean; restores the original colours after DLSS5 |
| **Stubelius Theme** | Colour theme for this workflow only |

## Videos past one chunk

A video longer than one chunk is rendered chunk by chunk (Extend). Three things hold across the chunks.

**Lip Sync from a recording.** Set a reference audio to **Lip Sync** and the recording is the
video's sound. Every chunk is rendered against its own part of the recording, so the lips follow
it for the whole video, and the finished video plays the recording itself.

- The final sound is the recording and nothing else: no ambience or music is generated under it.
- Where the recording is over, the video is silent and the character stops talking. A later chunk
  that has a quoted line of its own in its CUTs is spoken by the model instead.
- **Transcribe** → **Insert as Timed CUTs** gives each chunk its words with their real timings.
  A chunk without typed lines still follows the recording.
- A video comes out a little longer than the duration asked for, because every chunk snaps to the
  model's frame grid (a 30 s video in 10 s chunks is 31.4 s). A recording as long as the video
  therefore ends just before it does.
- Needs a current ComfyUI (developed on 0.37). On a ComfyUI whose MiniMax H3 model cannot hold the
  audio still, the log says so and the recording is used as a reference, as before.

**A chunk with nothing to say stays quiet.** Without a recording, a chunk that continues a talking
shot and has no quoted line in its CUTs is told that nobody speaks. Quote a line, or describe a
voice in the CUT (she sings, the crowd cheers), and it is left alone.

**Quality polish.** Quality at 1080p and up renders the take again, bigger, and the upscaler
takes it the rest of the way to 2K or 4K. **quality polish scale** on the Output node sets how
much bigger: 1.5x (the default) or 2x. Every chunk is polished with the checkpoint that made it
and joined as the Director joined the originals. The polished video has the same length and the
same sound as the take it came from.

- **1.5x** renders about 1152p from the Quality preset, enough for 1080p. It uses zhangccccc's
  H3 latent upscaler, which builds the 1.5x latent directly
  ([nodes](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler),
  [model](https://huggingface.co/zhangccccc/Minimax_h3_latent_Upscaler)). Without it the polish
  runs at 2x and the log says so. On an RTX 5090 at the Quality preset a 1.5x step takes 38 s for
  a 6.6 s chunk (106 s at 2x), 77 s for a 10 s chunk and 110 s for a 10 s chunk that continues a
  video.
- **2x** renders about 1536p. Use it for a take rendered smaller than the Quality preset, or to
  polish 2K itself. It is heavy: on a 32 GB card at the Quality preset it fits chunks up to 8 s,
  or 10 s for a video's first chunk (one that continues a video also re-renders the frames it
  carries over). A longer chunk spills out of the card and takes hours. A 2x step takes 2 to 4
  minutes.

The Output node runs 12 polish steps by default. A large polish turns on KJNodes' low-VRAM patches
by itself (ComfyUI-KJNodes 1.5.1 or newer); they give the same picture. The polished video ends up
in memory uncompressed: about 11 GB for every 10 s at 2x from the Quality preset, about 6 GB at
1.5x. Long takes need a lot of RAM.

## Middle frames

In **First/Last Frame** mode the video can pass through up to two **middle frames** on its way from
the first frame to the last.

- Drop a picture on the **Middle 1** or **Middle 2** box, or straight onto the strip above a chunk's
  timeline, where it lands at that second. Drag its thumbnail along the strip to change when the
  video reaches it, or type the second in its box.
- Middle frames stay half a second apart, and half a second from the first and the last frame. A
  CUT edge dragged close to one snaps onto it, so a CUT can run from one frame to the next.
- Each middle frame is pinned on its own frame with ComfyUI's **Add Guide for MiniMax H3**, as in
  ComfyUI's own multiframe template. The text encoder sees the first and the last frame, as before,
  so describe what happens on the way in the prompt.
- In a video longer than one chunk, a middle frame belongs to the chunk that renders that second.
  The Quality polish follows the take through the middle frames.

## Continue a clip

In **First/Last Frame** mode the First Frame box also takes a video. Drop a clip there and the new
video starts where the clip ends: the clip's last 1.6 s of picture and sound are carried in, the
same way each chunk of a long video continues the one before it, so the motion and the sound go on
without a cut.

- The video is rendered at the clip's shape; the aspect ratio setting doesn't apply.
- The timeline and the total duration are the new part. Middle frames and a Last Frame work as
  usual, so a clip can be continued to a picture of your choice.
- **clip in output** on the Output node puts the clip in front of the new part, as one video (its
  own frames, only resized), or leaves it out, to place the new part after the clip in an editor.
  Changing it re-runs only the finish.
- A clip at another frame rate is read on H3's 24 fps clock, a clip without sound is continued in
  silence, and a phone clip is turned upright.
- The Quality polish starts from the clip's frames too, so the motion runs on smoothly at the
  polished size. The clip itself is only resized (with the Output's upscaler), so from the join on
  the polished part shows more fine detail. For an even look, continue a clip at its own size, in
  the mode it was made in.

## Sounds and clips on the timeline

In **First/Last Frame** mode a strip for sounds and clips runs under the frames above each chunk's
timeline. Drop a sound or a short video clip on it and it is pinned at that second, with ComfyUI's
**Add Guide for MiniMax H3**: the video is made around it.

- **A sound** (a spoken line, a sound effect, music) plays from that second as it is. For a line,
  type the same words in the CUT, in quotes, at that moment: the recording gives the words and the
  CUT tells H3 that someone is talking. Without the words in the CUT the lips may not follow. In our
  tests every word landed within about 40 ms of its pin and the lips followed. A sound doesn't move the
  picture on its own, though: H3 still times the action from the CUT's words. For a reaction right on
  the sound, pin a middle frame of it just after (a door slam at 3.0 s, a frame of her looking back at
  3.3 s).
- **A clip** plays its own frames from that second, and its own sound unless the speaker on it is
  off. It is pinned for as many frames as H3's clip lengths allow (5, 22, 39, 56 ... frames), starts
  on H3's 17-frame grid (every 0.71 s, the strip snaps it there: between two grid points its frames
  come out grey) and stays inside its chunk.
- Drag a block to move it, × removes it; up to 8. A sound may run on into the next chunk.
- The Quality polish doesn't pin them again: the take already plays them.

## Voices: a recorded line, a voice sample, Lip Sync

| You have | Where it goes | What the character says |
|---|---|---|
| A recording of the exact line | First/Last Frame mode: the sound strip, at its second (type the words in the CUT too). Or Reference (Omni) mode: a reference audio set to **Lip Sync**, for the whole video's sound | The recording, word for word |
| A voice sample and new words | Reference (Omni) mode: the sample in **Ref Audio N** next to the character's picture in **Ref N**, set to **Voice Reference — new dialogue, same voice**; type the new line in the CUT | The CUT's words, in a voice like the sample's |
| A voice sample, and the voice has to match closely | Make the line first with a voice-clone TTS (for example the LongCat AudioDiT, Fish Audio S2 or VoxCPM2 nodes), then use it as a recording (first row) | The cloned line |

- **Voice Reference reaches the first chunk only.** Past one chunk, a Reference (Omni) video continues on
  the First/Last Frame checkpoint (hybrid continuation, switched on by itself), which takes no audio; the
  later chunks carry the voice on from the last 1.6 s of the chunk before, not from the sample. For longer
  dialogue, clone the lines and use Lip Sync, which reaches every chunk.
- **Lip Sync or a line on the strip.** Lip Sync makes the recording the video's whole sound: every chunk
  follows it and the finished video plays the file itself, with nothing generated under it.
  **Transcribe → Insert as Timed CUTs** types its words into the CUTs. A line on the strip is one sound
  at its second, in a video whose other sound H3 makes.

## De-stutter

Some takes judder: the picture holds still for a frame in a steady rhythm while the rest moves, "move, move,
hold" (every third frame almost a copy of the one before, like 16 fps footage stretched to 24) or "move,
hold". It shows most in Speed mode: a 15 s Speed take measured 95 held frames, one every 3 frames, where PDMD
on the same seed had none. RIFE to 48/60 fps doesn't fix it; it only splits each jump in two.

**de-stutter** on the Output node finds the held frames and RIFE draws them again on the way to the next pose,
so the motion runs evenly. A held picture is one pose shown twice: it is placed halfway between its two frames
and both are drawn again. Every other frame stays as it was rendered, the length and the sound stay as they
were, and nothing is drawn across a hard cut.

- **auto** (the default) acts only on takes that judder (held frames on at least 8% of the moving steps);
  **on** takes every held frame it finds; **off** never.
- The **Seed Previews** node puts it on the seed previews too, so the seed you pick looks the way it will in the
  finished video. Changing the switch re-runs only the previews and the Finish, never the seeds.
- On the Speed take above: roughness (how unevenly the picture moves from frame to frame) 0.83 before, 0.23
  after, against 0.27 for PDMD.

## Jagged or smeared motion

- **Judder** (a held frame every second or third frame): Speed mode's takes do it most. **de-stutter**
  (above, auto by default) fixes the rhythm, and PDMD renders much smoother in the first place. 48/60 fps
  alone doesn't fix it.
- **Fast, small motion smears** (fingers, hands): render in PDMD instead of Speed. At Speed's ≈480p a
  finger is a few pixels wide; PDMD renders ≈768p in 4 steps and fixes most of it.
- **Jerky after pinning a line**, things to check: the CUT has the line's exact words and keeps the action
  light while the character speaks; the line stays inside one chunk; the recording has no hard cuts, long
  pauses or clipping (short fades, peaks around -3 dBFS). And try two or three seeds: any pin changes the
  whole take, so the same seed with a pin is a different take.

## PDMD mode

**PDMD** renders at the Quality size (≈768p) in 4 steps, with the 4-step LoRA from
[PDMD](https://pdmd2026.github.io/) (Projected Distribution Matching Distillation, Apache-2.0), and the
Output upscaler takes it to 1080p, 2K or 4K. There is no polish in this mode.

Put PDMD's LoRA in `models/loras` as it is published: `lora_model_0.safetensors` from
[pdmd2026/pdmd_4NFE_lora](https://huggingface.co/pdmd2026/pdmd_4NFE_lora) (1.4 GB), under any name,
for example `pdmd_4nfe_lora.safetensors`. Pick it as **pdmd lora** on the Models node; in PDMD mode it
takes the place of the speedup LoRA. The file uses Diffusers' names for H3's layers, which ComfyUI's
LoRA loader doesn't know, so the pack converts it when it loads it (any H3 LoRA saved that way works in
the LoRA slots now).

Measured on an RTX 5090, 6.6 s clips at 1344x768 finished to 2K with DLSS5 + Color Lock: PDMD 100 s
(67 s of it the 4-step render), Hybrid 85-99 s (at half the pixels), Quality with its 1.5x polish
715-800 s.

## Install

**ComfyUI Manager:** Install via Git URL → `https://github.com/stuubszzz/Stubelius-Ultimate-H3`, then restart.

**git:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/stuubszzz/Stubelius-Ultimate-H3
```

Windows portable, from the `ComfyUI_windows_portable` folder:

```bash
python_embeded\python.exe -m pip install -r ComfyUI\custom_nodes\Stubelius-Ultimate-H3\requirements.txt
```

## Update

Manager → **Update All**, or `git pull` in `custom_nodes/Stubelius-Ultimate-H3`, then restart ComfyUI.
Each update brings the newest nodes and the newest example workflow.

## Other node packs

Load the workflow and use Manager → **Install Missing Custom Nodes**, or install them yourself:

| Pack | Needed for |
|---|---|
| [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | video outputs |
| [Nvidia RTX nodes](https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI) | RTX VSR upscaling (NVIDIA RTX GPU) |
| [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | live preview, low-VRAM options, a large Quality polish |
| [ComfyUI-Frame-Interpolation](https://github.com/Fannovel16/ComfyUI-Frame-Interpolation) | 48 / 60 fps |
| [ComfyUI-H3-Motion-Context-MultiRef](https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef) | recommended: smoother continuity past one chunk |
| [ComfyUI-MiniMaxH3_LatentUpscaler](https://github.com/Tr1dae/ComfyUI-MiniMaxH3_LatentUpscaler) + [ComfyUI-H3-Latent-Upscaler-Mamad8](https://github.com/mamad8c/ComfyUI-H3-Latent-Upscaler-Mamad8) | Quality polish at 2x ("learned model (2x)") |
| [Comfyui_Minimax_h3_latent_Upscaler](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler) | Quality polish at 1.5x (zhangccccc's H3 latent upscaler, model below) |
| [ComfyUI-DLSS5-Enhancer](https://github.com/Blueforcer/ComfyUI-DLSS5-Enhancer) | DLSS5 upscaler |
| [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) | GGUF models |
| [ComfyUI-Spectrum-MiniMax-H3](https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3) | Spectrum option |
| [Comfyui-PlagueKind-Nodes](https://github.com/PlagueKind/Comfyui-PlagueKind-Nodes) | H3 cache option |

## Models

Official files from [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3):

| Folder | File |
|---|---|
| `models/diffusion_models` | `minimax_h3_ref2va_pruned_int8_convrot.safetensors`, `minimax_h3_fl2va_pruned_int8_convrot.safetensors` |
| `models/text_encoders` | `qwen3vl_32b_minimax_h3_int8_convrot.safetensors` (RTX 50-series: `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`) |
| `models/vae` | `minimax_h3_video_vae_fp16.safetensors`, `minimax_h3_audio_vae_fp32.safetensors` |
| `models/loras` | `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` |
| `models/loras` | for PDMD mode: [`lora_model_0.safetensors`](https://huggingface.co/pdmd2026/pdmd_4NFE_lora/resolve/main/lora_model_0.safetensors) from pdmd2026/pdmd_4NFE_lora, any name |
| `models/vae_approx` | optional live preview: [`taeh3.safetensors`](https://huggingface.co/Kijai/MiniMax-H3-TAE/resolve/main/vae_approx/taeh3.safetensors) (Kijai) |
| `models/latent_upscale_models` | for the 1.5x Quality polish: [`minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors`](https://huggingface.co/zhangccccc/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors) (zhangccccc) |

RIFE downloads its checkpoint the first time you pick 48 or 60 fps. Direct links for every
file are in [INSTALL.txt](INSTALL.txt).

Developed on an RTX 5090 (32 GB). With less VRAM, turn on the Models node's low-VRAM options or
use GGUF models.

On ComfyUI 0.37 and newer the Stubelius nodes turn ComfyUI's model compiler off while they render,
and back on after. With it, H3 at the Quality size ran out of VRAM on a 32 GB card from its second
sampler step on and crawled. Other nodes keep the compiler.

## Credits and license

Built on [Muse Minimax Director V1.2](https://github.com/muse-collective-26/MiniMaxH3-Director-V1.2)
by Muse Collective. MIT licensed, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
PDMD mode uses the 4-step LoRA by Zimo Wang et al. ([paper](https://arxiv.org/abs/2609.35768),
[code](https://github.com/ZeamoxWang/pdmd), Apache-2.0), which is not included here.
**Powered by MiniMax H3**: the model is MiniMax's and is used under the
[MiniMax H3 Community License](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE).
