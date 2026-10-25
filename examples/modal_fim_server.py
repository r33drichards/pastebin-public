# Fallback completion server for pbin's AI tab completion, on Modal.
#
# Serves Qwen2.5-Coder-0.5B with vLLM's OpenAI-compatible API, the shape
# complete.go expects from COMPLETION_FALLBACK_URL. Deploy, then point the
# pastebin at it:
#
#   modal deploy examples/modal_fim_server.py
#   export COMPLETION_FALLBACK_URL=https://<workspace>--pbin-fim-serve.modal.run
#   export COMPLETION_FALLBACK_TOKEN=<the API key you choose below>
#
# The primary provider stays the Hugging Face Inference Providers router
# (HF_TOKEN); this endpoint only sees traffic when that fails. Modal scales
# to zero when idle, so a quiet fallback costs nothing but cold starts.
#
# Based on Modal's vLLM example: https://modal.com/docs/examples/vllm_inference

import subprocess

import modal

MODEL = "Qwen/Qwen2.5-Coder-0.5B"
PORT = 8000

# Protects the public modal.run URL. Store it with:
#   modal secret create pbin-fim-api-key API_KEY=<something long and random>
api_key_secret = modal.Secret.from_name("pbin-fim-api-key")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("vllm", "huggingface_hub[hf_transfer]")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)

# Cache model weights between cold starts.
hf_cache = modal.Volume.from_name("pbin-fim-hf-cache", create_if_missing=True)

app = modal.App("pbin-fim")


@app.function(
    image=image,
    gpu="T4",  # a 0.5B model fits easily; T4 is the cheapest option
    secrets=[api_key_secret],
    volumes={"/root/.cache/huggingface": hf_cache},
    scaledown_window=300,  # shut down after 5 idle minutes
    timeout=600,
)
@modal.concurrent(max_inputs=32)
@modal.web_server(port=PORT, startup_timeout=600)
def serve():
    import os

    subprocess.Popen(
        [
            "vllm",
            "serve",
            MODEL,
            "--host", "0.0.0.0",
            "--port", str(PORT),
            "--api-key", os.environ["API_KEY"],
            # Tab completion wants latency, not throughput: keep the
            # context small and skip long prompts entirely.
            "--max-model-len", "4096",
        ]
    )
