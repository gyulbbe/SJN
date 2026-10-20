"""Local FLUX.2 klein 4B for the direction-photo trials, in place of the Cloudflare test Worker.

The same request and answer as the test Worker (test-results/.../flux-test-worker.js), so the
harness (tests/direction-photo-real/variants.ts and run.mjs with FLUX_ENGINE=local) only changes its
address: POST / with JSON {model: 'flux-2-klein-4b', image, refs (1-3), prompt, width, height, seed},
the images base64 PNGs; the answer is {ms, image, meta}. The model input is the route's
(src/lib/direction-photo/server.ts): image 0 the guide, images 1-3 the photos, the size asked (twice
the guide's), the seed. One request at a time, no retry, 127.0.0.1 only. The app never calls it.

Weights: black-forest-labs/FLUX.2-klein-4B (Apache 2.0), its diffusers folders only, fetched into the
Hugging Face cache (HF_HOME) on the first start. Settings (env): LOCAL_FLUX_PORT (8798),
LOCAL_FLUX_OFFLOAD (model | sequential | none, default model: the 12 GB card), LOCAL_FLUX_STEPS (4,
the distilled model's), LOCAL_FLUX_GUIDANCE (1.0). Run: python server.py (docs:
.agents/skills/sjn-workflow/references/development-environment.md, "로컬 FLUX 시험 환경").
"""

import base64
import io
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import diffusers
import torch
from diffusers import Flux2KleinPipeline
from huggingface_hub import snapshot_download
from PIL import Image

REPO = 'black-forest-labs/FLUX.2-klein-4B'
MODEL = 'flux-2-klein-4b'
PORT = int(os.environ.get('LOCAL_FLUX_PORT', '8798'))
OFFLOAD = os.environ.get('LOCAL_FLUX_OFFLOAD', 'model')
STEPS = int(os.environ.get('LOCAL_FLUX_STEPS', '4'))
GUIDANCE = float(os.environ.get('LOCAL_FLUX_GUIDANCE', '1.0'))
MAX_REFS = 3
MAX_BODY = 16 * 1024 * 1024
if OFFLOAD not in ('model', 'sequential', 'none'):
    sys.exit('LOCAL_FLUX_OFFLOAD는 model, sequential, none 중 하나예요.')

# The diffusers folders only: the repository's single-file checkpoint (7.75 GB) is not needed.
FOLDER = snapshot_download(
    REPO,
    allow_patterns=['model_index.json', 'scheduler/*', 'text_encoder/*', 'tokenizer/*', 'transformer/*', 'vae/*'],
)
REVISION = os.path.basename(FOLDER)
pipe = Flux2KleinPipeline.from_pretrained(FOLDER, torch_dtype=torch.bfloat16)
if OFFLOAD == 'model':
    pipe.enable_model_cpu_offload()
elif OFFLOAD == 'sequential':
    pipe.enable_sequential_cpu_offload()
else:
    pipe.to('cuda')

META = {
    'engine': 'local',
    'model': REPO,
    'revision': REVISION,
    'steps': STEPS,
    'guidance': GUIDANCE,
    'dtype': 'bfloat16',
    'offload': OFFLOAD,
    'torch': torch.__version__,
    'diffusers': diffusers.__version__,
    'gpu': torch.cuda.get_device_name(0),
}


class Refused(Exception):
    pass


def png(text, what):
    """A base64 PNG as an RGB picture; anything else is refused."""
    try:
        data = base64.b64decode(text, validate=True)
    except Exception:
        raise Refused(f'{what}: base64가 아니에요.')
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        raise Refused(f'{what}: PNG가 아니에요.')
    return Image.open(io.BytesIO(data)).convert('RGB')


def size(value, what):
    if not isinstance(value, int) or isinstance(value, bool) or not 128 <= value <= 1024 or value % 16:
        raise Refused(f'{what}: 128~1024, 16의 배수여야 해요.')
    return value


def read(body):
    """The Worker's request, checked: one model, a guide, one to three photos, the size, the seed."""
    if not isinstance(body, dict):
        raise Refused('JSON 객체가 아니에요.')
    if body.get('model') != MODEL:
        raise Refused(f'model은 {MODEL}만 받아요.')
    refs = body.get('refs')
    if not isinstance(refs, list) or not 1 <= len(refs) <= MAX_REFS:
        raise Refused(f'refs는 1~{MAX_REFS}장이에요.')
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8000:
        raise Refused('prompt가 비었거나 너무 길어요.')
    seed = body.get('seed')
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**32:
        raise Refused('seed는 0 이상 2^32 미만의 정수예요.')
    images = [png(body.get('image'), 'image')] + [png(ref, f'refs[{i}]') for i, ref in enumerate(refs)]
    return images, prompt, size(body.get('width'), 'width'), size(body.get('height'), 'height'), seed


class Handler(BaseHTTPRequestHandler):
    def answer(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            return self.answer(200, {'ready': True, 'meta': META})
        self.answer(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/':
            return self.answer(404, {'error': 'not found'})
        length = int(self.headers.get('Content-Length') or 0)
        if not 0 < length <= MAX_BODY:
            return self.answer(400, {'error': '요청 본문 크기를 확인해 주세요.'})
        try:
            images, prompt, width, height, seed = read(json.loads(self.rfile.read(length)))
        except (Refused, json.JSONDecodeError) as error:
            return self.answer(400, {'error': str(error)})
        started = time.time()
        torch.cuda.reset_peak_memory_stats()
        try:
            image = pipe(
                image=images,
                prompt=prompt,
                width=width,
                height=height,
                num_inference_steps=STEPS,
                guidance_scale=GUIDANCE,
                generator=torch.Generator(device='cuda').manual_seed(seed),
            ).images[0]
        except Exception as error:  # Out of memory and the like: reported, never retried.
            torch.cuda.empty_cache()
            return self.answer(500, {'error': f'{type(error).__name__}: {str(error)[:300]}'})
        ms = round((time.time() - started) * 1000)
        out = io.BytesIO()
        image.save(out, format='PNG')
        peak = round(torch.cuda.max_memory_allocated() / 2**20)
        print(f'{time.strftime("%H:%M:%S")} {width}x{height} refs={len(images) - 1} seed={seed} {ms}ms peak={peak}MiB', flush=True)
        self.answer(200, {'ms': ms, 'image': base64.b64encode(out.getvalue()).decode(), 'meta': {**META, 'peakVramMb': peak}})

    def log_message(self, format, *args):
        pass


if __name__ == '__main__':
    print(f'local FLUX on http://127.0.0.1:{PORT} {json.dumps(META)}', flush=True)
    HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
