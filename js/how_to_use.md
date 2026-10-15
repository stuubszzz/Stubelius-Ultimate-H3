# Ultimate H3 — how to use

Four windows, left to right: **1 Setup → 2 Director → 3 Seeds → 4 Output**. The step bar at the top of every window jumps to the others. The small nodes the windows edit sit behind them: move a window to reach one. A workflow laid out before is tidied once when it opens (**Tidy the canvas** under Look in Setup does it again).

**Updates:** [github.com/stuubszzz/Stubelius-Ultimate-H3](https://github.com/stuubszzz/Stubelius-Ultimate-H3) · ComfyUI Manager → Update All, or `git pull` in custom_nodes/Stubelius-Ultimate-H3. **Live preview:** put `taeh3.safetensors` in models/vae_approx and pick it under Models in Setup.

## 1 · SETUP — how it's rendered
- **Mode** — PDMD, Speed, Hybrid or Quality: *how* the video is made. A card fills steps, size and turbo strength; fine-tune them under the cards. The size that comes out is picked in Output.

| | MP | steps | sampler | turbo | to your Output size |
|---|---|---|---|---|---|
| Speed | 0.4 | 8 | res_multistep / simple | 1.0 | renders ≈480p, upscales up to 2K |
| Hybrid | 0.5 | 10 | euler / beta | 0.75 | renders ≈540p, upscales up to 4K |
| Quality | 0.98 | 20 | euler / beta | off | native ≈768p; from 1080p a polish (1.5×) re-renders it bigger, up to 4K |
| PDMD | 0.98 | 4 | euler / simple | PDMD LoRA | native ≈768p in 4 steps, upscales up to 4K |

- **Seeds to compare** — how many full videos, with sound, to render: 1–4. With every chunk picked (after **Pick by chunk** or a hunt) the first seed is your picks and the others try new seeds for the last chunk.
- **Models** — the First/Last Frame and Reference checkpoints (safetensors or GGUF), text encoder, video and audio VAE, live preview. Each card shows the precision, the size and whether the file is on disk.
- **Speed-ups and LoRAs** — the turbo LoRA for Speed and Hybrid: the known kinds first, **Choose another speed-up LoRA…** for any file, its **Strength** right under them. The **PDMD 4-step LoRA**. Two **global LoRAs** for every chunk (slider LoRAs up to ±9). LoRAs for one chunk go in the Director.
- **Video memory**, **Performance** (attention, low-VRAM switches, Spectrum and step cache) and **Look** (six themes, **Tidy the canvas**).
- Changing anything here **re-renders**.

## 2 · DIRECTOR — what the video is
- **Top:** First/Last Frame or Reference (Omni) mode, shape, length (longer than one chunk = Extend), chunk size, seed, the mode, **Render**.
- **Keyframes** — the first frame (a video there is a clip the video continues), up to eight **middle frames** and the last frame. Drop pictures at a second or click **+** to add one at the playhead; drag them along; click one for its card: its second (type it, nudge it, slide it), another picture, remove.
- **Shots** — drag the edge between two. **Sound** — sounds and short clips pinned at their seconds. **Chunks** — the badge between two sets how they join.
- **Characters** — characters made from many pictures, for the whole video: **+** adds a saved one or makes one from 8–16 pictures; click one for its strength or to type its description into a shot.
- **Inspector** (the chunk you picked): how it joins the chunk before it, its shots (a spoken line goes in quotes), style, soundscape, music, **LoRAs for this chunk** and its **takes**.
- **Takes** — every chunk is kept. **Retake** renders the chunk again with a new seed; click an older take to pick it back. **Hunt** renders 2, 3 or 4 seeds of that one chunk (the arrow beside it picks how many): pick one in Seeds. **Render to chunk N** works on the start of a long video first. **Stop** keeps the chunks it finished.
- **Reference mode:** the cast (nine characters and a location), reference videos and sounds, **Lip Sync** with **Transcribe → Insert as timed shots**.
- Text in the **PROMPT OVERRIDE** node (behind the Director) replaces the timeline.

## 3 · SEEDS — pick the winner
All the seeds side by side, in sync, with the Output's de-stutter, as the finished video will move. **Solo** a seed's sound, **A/B split**, **Loop** a chunk, **Full size**. The hints (held frames redrawn, a nearly silent take) are hints: your eye picks. **Pick** the winner, then **Finish the winner**. In a long video, **Pick by chunk**: keep a chunk's seed, hunt the next chunk on top of it, then **Render the rest**.

## 4 · OUTPUT — what comes out
- The winner against the finished video: drag the divider, **Loupe** for the detail; the finish step by step.
- **Final size** — Speed up to 2K, the other modes up to 4K. The short side lands exactly on the number, portrait too. 4K holds ≈100 MB of RAM per frame: keep 4K clips short.
- **Frame rate** — a slider from 24 (untouched) up to 120; above 24 RIFE draws the frames in between, length and sync kept.
- **Upscaler** — RTX VSR, or DLSS5 + Color Lock. **De-stutter** — auto, on or off. **Quality polish** — Quality mode at 1080p and up.
- **Export** — the file (in output/UltimateH3: type another name to change it), its size and loudness, **Open folder**.
- **Last frame** — the frame the finished video ends on: click it to see it big, **Save** it to start the next video from it.
- Changing anything here **never re-renders** the seeds: only the finish runs again. **Render** in the Director always stops after the seeds: pick in Seeds, then **Finish the winner**.

## 5 · GOOD TO KNOW
- **A recorded line on the Sound lane:** type the same words in that shot, in quotes. The recording gives the words; the shot tells H3 someone is talking. A sound doesn't move the picture: for a reaction right on it, pin a middle frame of the reaction just after.
- **A voice sample, new words:** Reference (Omni) mode → the sample in **Ref Audio** for the character in **Ref** → **Voice reference: new lines, same voice** → type the new line in the shot. A similar voice, not a clone, and only the first chunk hears it.
- **The voice has to match closely:** make the line first with a voice-clone TTS (LongCat AudioDiT, Fish S2, VoxCPM2), then pin it on the Sound lane or set it as **Lip Sync**, which plays the file itself in every chunk.
- **The face changes from chunk to chunk:** make the character from 8–16 pictures on the **Characters** lane and keep it on; describe the character in the shots too, since H3 reads the words, not the pictures.
- **A later chunk sounds dull:** set its join to **Picture, fresh sound**.
- **Judder** (every second or third frame held, most of all in Speed): **de-stutter** fixes it, and PDMD renders much smoother. A higher frame rate alone doesn't.
- **Fast, small motion smears** (fingers): use PDMD instead of Speed.
- **Jerky after pinning a line:** check the shot has its exact words, the line stays inside one chunk and the recording has no hard cuts, then try another seed.
- **Middle frames:** up to eight, half a second apart; eight add about a tenth to the render time. Don't pin fast action in the first half second of a chunk that continues the video: pin the moments around it.
- **Turbo modes can mumble dialogue** (measured −31…−39 dB against −14 dB): for talking shots use Quality.
