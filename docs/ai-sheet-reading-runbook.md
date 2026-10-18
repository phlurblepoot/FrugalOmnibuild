# AI Sheet Reading — Ops Runbook

## What it is
A local vision model (default **Qwen2.5-VL-7B**) reads plan-sheet numbers/titles
and matches revisions when adding a plan set. Fully local; no external calls at
inference time, no API key. Inference runs through a bundled **llama.cpp
`llama-server`** subprocess on the GPU; the app calls it over localhost. If the
server/GPU isn't available, the app silently falls back to the existing text/OCR
extraction + manual naming.

## Architecture
- The **CUDA image** (`Dockerfile.cuda`) bundles the `llama-server` binary.
- On first use, the Node app spawns `llama-server` pointing at the model, which
  **auto-downloads the model + its vision projector (mmproj) from Hugging Face**
  (`-hf`) into the mounted `/models` volume, then serves an OpenAI-compatible
  `/v1/chat/completions` endpoint the app calls.
- The **default CPU image** (`Dockerfile`) does **not** include `llama-server`,
  so the feature stays disabled there.

## Requirements
- NVIDIA GPU (target: RTX 5070) with the NVIDIA Container Toolkit on the host.
- Image built from `Dockerfile.cuda`.
- A host directory mounted at `/models` (persists the downloaded weights).
- Outbound internet on first run (to download the model). After that it's offline.

## Unraid setup
1. **Install the "Nvidia Driver" plugin** (ich777) from Community Applications;
   reboot. The RTX 5070 (Blackwell) needs a recent driver branch (570+) — pick
   the latest/production driver in the plugin if the card isn't detected.
   Confirm with `nvidia-smi` on the host; note the UUID from `nvidia-smi -L`.
2. **Build/pull the CUDA image** (`docker build -f Dockerfile.cuda -t frugalomnibuild:cuda .`).
3. In the container template (Advanced view):
   - **Extra Parameters:** `--runtime=nvidia`
   - **Variable** `NVIDIA_VISIBLE_DEVICES` = `GPU-<uuid>` (or `all`)
   - **Variable** `NVIDIA_DRIVER_CAPABILITIES` = `all`
   - **Path** `/models` → e.g. `/mnt/user/appdata/frugalomnibuild/models` (read/write)

## Config (environment variables)
- `AI_ENABLED` — default on; set `false`/`0` to disable entirely.
- `AI_MODEL_HF` — Hugging Face model to auto-download, `repo:quant`
  (default `ggml-org/Qwen2.5-VL-7B-Instruct-GGUF:Q4_K_M`; the 3B is lighter but
  can't synthesize a sheet-level description for sheets that only carry
  per-drawing labels — the 7B can). llama-server pulls the
  matching mmproj automatically for multimodal repos.
- `AI_MODEL_PATH` + `AI_MMPROJ_PATH` — use explicit local GGUF files instead of
  `-hf` (skips auto-download). Both must be set together.
- `AI_MODELS_DIR` / `LLAMA_CACHE` — download/cache dir (default `/models`).
- `AI_LLAMA_SERVER_BIN` — path to the binary (the CUDA image sets it to
  `/app/llama-server`, from the bundled llama.cpp server-cuda base).
- `AI_HOST` / `AI_PORT` — llama-server bind address (default `127.0.0.1:8080`).
- `AI_GPU_LAYERS` — `-ngl`, default `999` (offload all).
- `AI_TIMEOUT_MS` — per-inference timeout (default 30000).
- `AI_STARTUP_TIMEOUT_MS` — max wait for the server to become healthy on first
  run, which includes the model download (default 900000 = 15 min).

To use a different model, e.g. the tiny fallback SmolVLM-500M:
`AI_MODEL_HF=ggml-org/SmolVLM-500M-Instruct-GGUF:Q8_0`, or the larger
`ggml-org/Qwen2.5-VL-7B-Instruct-GGUF:Q4_K_M`.

## Manual model download (optional)
If you prefer to pre-seed the weights instead of first-run auto-download:
```bash
pip install -U "huggingface_hub[cli]"
cd /mnt/user/appdata/frugalomnibuild/models
huggingface-cli download ggml-org/Qwen2.5-VL-3B-Instruct-GGUF \
  Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf \
  mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf --local-dir .
```
Then point at them explicitly:
`AI_MODEL_PATH=/models/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf`
`AI_MMPROJ_PATH=/models/mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf`

## Verify
Authenticated `GET /api/ai/status`:
```
{"available": true, "model": "...:Q4_K_M", "device": "cuda"}
```
On the very first run after a fresh deploy, `available` stays `false` while the
model downloads/loads (several minutes) — imports during that window use OCR.
Once the download finishes, `available` flips to `true` and reads work. Then:
```
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"imageId":"<a real page imageId>"}' http://localhost:3331/api/ai/read-sheet
# → {"sheetNumber":"A-201","sheetTitle":"...","confidence":0.x}
```

## Troubleshooting
- `available:false`, model `"llama-server not found"` → you're running the CPU
  image; build/run `Dockerfile.cuda`.
- `available:false` for a long time on first run → still downloading the model;
  check container logs and outbound network. Increase `AI_STARTUP_TIMEOUT_MS` for
  slow links.
- `available:false` after download → the container can't see the GPU. Confirm
  `docker exec -it <container> nvidia-smi` lists the card and `--runtime=nvidia`
  + `NVIDIA_*` vars are set.

## Fallback behaviour
When unavailable, imports and the add-set review step use the existing OCR +
manual-region naming and the manual "Revision of / New sheet" dropdown. Nothing
blocks; the AI badges simply don't appear.
