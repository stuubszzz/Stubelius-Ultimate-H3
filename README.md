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
| [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | live preview, low-VRAM options |
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
| `models/vae_approx` | optional live preview: [`taeh3.safetensors`](https://github.com/madebyollin/taehv/raw/main/safetensors/taeh3.safetensors) |

RIFE downloads its checkpoint the first time you pick 48 or 60 fps. Direct links for every
file are in [INSTALL.txt](INSTALL.txt).

Developed on an RTX 5090 (32 GB). With less VRAM, turn on the Models node's low-VRAM options or
use GGUF models.

## Credits and license

Built on [Muse Minimax Director V1.2](https://github.com/muse-collective-26/MiniMaxH3-Director-V1.2)
by Muse Collective. MIT licensed, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
**Powered by MiniMax H3**: the model is MiniMax's and is used under the
[MiniMax H3 Community License](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE).
