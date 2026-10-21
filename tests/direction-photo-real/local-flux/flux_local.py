"""FLUX.2 klein 4B loaded the one way the local trials use it: server.py and diag.py share it.

Weights: black-forest-labs/FLUX.2-klein-4B (Apache 2.0), its diffusers folders only, fetched into the
Hugging Face cache (HF_HOME) on the first start. The repository's model_index.json marks it distilled
(is_distilled: true): the pipeline then never runs classifier-free guidance, so guidance_scale changes
nothing here; Cloudflare takes a guidance field, but what it does with it is not documented.
"""

import os

import diffusers
import torch
import transformers
from diffusers import Flux2KleinPipeline
from huggingface_hub import snapshot_download

REPO = 'black-forest-labs/FLUX.2-klein-4B'
MODEL = 'flux-2-klein-4b'
OFFLOADS = ('model', 'sequential', 'none')


def load_pipeline(offload='model'):
    """The pipeline in bfloat16 on the card (model CPU offload by default: the 12 GB card) and its meta."""
    if offload not in OFFLOADS:
        raise ValueError('offload는 model, sequential, none 중 하나예요.')
    # The diffusers folders only: the repository's single-file checkpoint (7.75 GB) is not needed.
    folder = snapshot_download(
        REPO,
        allow_patterns=['model_index.json', 'scheduler/*', 'text_encoder/*', 'tokenizer/*', 'transformer/*', 'vae/*'],
    )
    pipe = Flux2KleinPipeline.from_pretrained(folder, torch_dtype=torch.bfloat16)
    if offload == 'model':
        pipe.enable_model_cpu_offload()
    elif offload == 'sequential':
        pipe.enable_sequential_cpu_offload()
    else:
        pipe.to('cuda')
    meta = {
        'engine': 'local',
        'model': REPO,
        'revision': os.path.basename(folder),
        'dtype': 'bfloat16',
        'offload': offload,
        'distilled': bool(pipe.config.is_distilled),
        'torch': torch.__version__,
        'diffusers': diffusers.__version__,
        'transformers': transformers.__version__,
        'gpu': torch.cuda.get_device_name(0),
    }
    return pipe, meta
