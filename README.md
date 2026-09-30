# Stubelius Ultimate H3

One MiniMax H3 workflow for ComfyUI. You decide up front **how** the video is made
(Speed, Hybrid or Quality) and **what comes out** (resolution, frame rate, upscaler). The
Director holds **what the video is**. Render 1–4 full seeds with sound, pick the winner, and
only the winner gets finished.

The workflow is in [`example_workflows/Stubelius_Ultimate_H3.json`](example_workflows/Stubelius_Ultimate_H3.json).
Once the pack is installed it also appears in ComfyUI under **Workflow → Browse Templates → Stubelius-Ultimate-H3**.

## What's in it

| Node | Job |
|---|---|
| **Stubelius H3 Setup** | Mode preset: Speed (≈480p, 8 steps), Hybrid (≈540p, 10 steps), Quality (≈768p, 20 steps, no speedup LoRA); 1–4 seeds |
| **Stubelius H3 Models** | ref2va + fl2va checkpoints (safetensors or GGUF), text encoder, VAEs, speedup LoRA, two global LoRAs, attention and low-VRAM options, live preview |
| **Stubelius H3 Output** | Final resolution per mode (Speed up to 2K, Hybrid and Quality up to 4K; exact short side, portrait too), 24/48/60 fps through RIFE, RTX VSR or DLSS5 + Color Lock, Quality polish |
| **Stubelius H3 Director V2** | Timeline, Reference (Omni) or First/Last Frame mode, references, aspect, duration (Extend past one chunk), seed, **LoRAs per chunk** |
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

**Quality polish.** Quality at 1080p and up polishes every chunk, each with the checkpoint that
made it, and joins them as the Director joined the originals. The polished video has the same
length and the same sound as the take it came from. The polished frames are held in memory at
twice the render size, about 11 GB for every 10 s at the Quality preset, so long takes need a
lot of RAM.

A large polish turns on KJNodes' low-VRAM patches by itself (ComfyUI-KJNodes 1.5.1 or newer).
They give the same picture. Without them a 10 s chunk polished for 2K does not fit a 32 GB card.

On a 32 GB card at the Quality preset, a chunk fits the polish up to 8 s, or 10 s for a video's
first chunk: one that continues a video also re-renders the frames it carries over. A longer
chunk spills out of the card and takes hours. For Quality at 1080p and up, keep chunks at 8 s or
less. At that size a polish step takes 2 to 4 minutes, and the Output node runs 12 of them by
default.

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
| [ComfyUI-MiniMaxH3_LatentUpscaler](https://github.com/Tr1dae/ComfyUI-MiniMaxH3_LatentUpscaler) + [ComfyUI-H3-Latent-Upscaler-Mamad8](https://github.com/mamad8c/ComfyUI-H3-Latent-Upscaler-Mamad8) | Quality polish "learned model (2x)" |
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
| `models/vae_approx` | optional live preview: [`taeh3.safetensors`](https://huggingface.co/Kijai/MiniMax-H3-TAE/resolve/main/vae_approx/taeh3.safetensors) (Kijai) |

RIFE downloads its checkpoint the first time you pick 48 or 60 fps. Direct links for every
file are in [INSTALL.txt](INSTALL.txt).

Developed on an RTX 5090 (32 GB). With less VRAM, turn on the Models node's low-VRAM options or
use GGUF models.

## Credits and license

Built on [Muse Minimax Director V1.2](https://github.com/muse-collective-26/MiniMaxH3-Director-V1.2)
by Muse Collective. MIT licensed, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
**Powered by MiniMax H3**: the model is MiniMax's and is used under the
[MiniMax H3 Community License](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE).
