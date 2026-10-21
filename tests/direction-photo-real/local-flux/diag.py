"""Why local FLUX.2 klein 4B draws the side views otherwise than Cloudflare: diagnostic runs.

The pipeline is called directly (loaded as the server loads it, flux_local.py) on the inputs a
Cloudflare run sent (its sent-guide-<view>.png, sent-ref-1.png and prompt-<view>.txt), with one thing
changed per case: the photo alone, a red photo, the images' order or their T coordinates (H1), the
images numbered from 1 in the prompt (H2), plain sentences (H3), the app prompt's parts one at a
time (H3p), the inputs' size (H4), the steps or classifier-free guidance forced on (H5). Each case's
answers go to <out>/<case>/<seed>.png with case.json, and each group gets a sheet <out>/<group>.png:
a row per case (the Cloudflare answers for the same input on top), a column per seed.

Run (the venv of requirements.txt, HF_HOME as for server.py, from the repository root):
  python tests/direction-photo-real/local-flux/diag.py [--out DIR] [--seeds 1003,1004] GROUP...
GROUP: H0 H1 H2 H3 H3p H4 H5, H6 (H0 again, run with other package versions first on PYTHONPATH),
or vae (the photo through the VAE and back, its colour difference).
"""

import argparse
import glob
import json
import os
import re
import sys
import time

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageOps

from flux_local import load_pipeline

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SIDE = os.path.join(ROOT, 'test-results', 'toilet-side')
# The Cloudflare runs whose inputs are replayed, and where their Cloudflare answers are.
INPUTS = {
    'bear': (os.path.join(SIDE, 'bear-cf-base'), 'right', [os.path.join(SIDE, 'bear-cf-base', 'answers'), os.path.join(SIDE, 'bear-cf-base-more', 'answers')]),
    'bear-m': (os.path.join(SIDE, 'bear-m-cf-base'), 'right', [os.path.join(SIDE, 'bear-m-cf-base', 'answers')]),
    'smart': (os.path.join(SIDE, 'smart-stage1'), 'right', [os.path.join(ROOT, 'test-results', 'direction-photo-gemma', 'smart-base', 'answers')]),
}
CELL = 240


def load_input(name):
    folder, view, _ = INPUTS[name]
    guide = Image.open(os.path.join(folder, f'sent-guide-{view}.png')).convert('RGB')
    photo = Image.open(os.path.join(folder, 'sent-ref-1.png')).convert('RGB')
    with open(os.path.join(folder, f'prompt-{view}.txt'), encoding='utf-8') as f:
        prompt = f.read()
    # The route asks for twice the guide's size.
    return {'guide': guide, 'photo': photo, 'prompt': prompt, 'size': (guide.width * 2, guide.height * 2)}


def cloudflare_answers(name):
    _, view, folders = INPUTS[name]
    return sorted(f for folder in folders for f in glob.glob(os.path.join(folder, f'*-{view}-*.png')))


def renumber(prompt):
    """The images counted from 1: the guide image 1, the photo image 2."""
    return prompt.replace('Image 1', 'Image 2').replace('image 1', 'image 2').replace('Image 0', 'Image 1').replace('image 0', 'image 1')


def swap_numbers(prompt):
    """Image 0 and image 1 trade names (for the photo sent first)."""
    marker = '\0'
    for a, b in (('Image 0', 'Image 1'), ('image 0', 'image 1')):
        prompt = prompt.replace(a, marker).replace(b, a).replace(marker, b)
    return prompt


def red(photo):
    """The photo's product painted red, the white around it kept."""
    return ImageOps.colorize(ImageOps.grayscale(photo), black=(70, 0, 0), mid=(210, 30, 30), white=(255, 255, 255))


def scaled(image, factor):
    """Resized by factor, kept a multiple of 16."""
    width, height = (max(16, round(image.width * factor / 16) * 16), max(16, round(image.height * factor / 16) * 16))
    return image.resize((width, height), Image.LANCZOS)


def sentences(prompt):
    """The prompt's sentences (each ends with a full stop before a capital)."""
    return re.split(r'(?<=\.) (?=[A-Z])', prompt)


def kept(prompt, drop=(), first=None):
    """The prompt without the sentences starting with `drop`, the one starting with `first` moved first."""
    parts = [s for s in sentences(prompt) if not s.startswith(tuple(drop))]
    if first:
        parts.sort(key=lambda s: not s.startswith(first))
    return ' '.join(parts)


# The app prompt's sentences, by how they start (prompt.ts).
FRONT_VIEW_HIDDEN = ('Its front is', 'The view shows', 'In this view')
PHOTO_ANGLE = ('Image 1 was taken', 'Turn the product to the view')
LOOK = 'Turn image 0 into'

TEXT_RED = 'A photorealistic studio product photograph of a bright red glossy ceramic toilet on a pure white seamless background.'
GUIDE_RED = 'Turn image 0 into a photorealistic studio product photograph of a bright red glossy ceramic toilet on a pure white seamless background (#FFFFFF). Keep the shape and the camera angle of image 0.'
PHOTO_ONLY = 'Turn image 0 into a photorealistic studio product photograph of the same toilet on a pure white seamless background (#FFFFFF). Keep everything about the toilet as in image 0.'


def cases(group, inputs):
    """The cases of a group: (case name, input name, images, prompt, size, options)."""
    bear = inputs('bear')
    if group == 'H0':
        return [(f'H0-{name}', name, [x['guide'], x['photo']], x['prompt'], x['size'], {}) for name in INPUTS for x in [inputs(name)]]
    if group == 'H6':
        # H0 again, run with other package versions first on PYTHONPATH.
        return [(f'H6-{name}', name, [x['guide'], x['photo']], x['prompt'], x['size'], {}) for name in ('bear', 'smart') for x in [inputs(name)]]
    if group == 'H3p':
        # Which part of the app prompt draws the turn and the grey here: one part changed at a time.
        out = []
        for name in ('bear', 'smart'):
            x = inputs(name)
            images, prompt = [x['guide'], x['photo']], x['prompt']
            out += [
                (f'H3p-no-grey-{name}', name, images, prompt.replace('a plain grey 3D render of', 'a 3D render of'), x['size'], {}),
                (f'H3p-no-angle-{name}', name, images, kept(prompt, PHOTO_ANGLE), x['size'], {}),
                (f'H3p-no-view-{name}', name, images, kept(prompt, FRONT_VIEW_HIDDEN), x['size'], {}),
                (f'H3p-look-first-{name}', name, images, kept(prompt, first=LOOK), x['size'], {}),
                (f'H3p-short-{name}', name, images, kept(prompt, FRONT_VIEW_HIDDEN + PHOTO_ANGLE + ('The real toilet',)), x['size'], {}),
                (f'H3p-no-photo-{name}', name, [x['guide']], kept(prompt, PHOTO_ANGLE + ('Image 1 is',)), x['size'], {}),
            ]
        return out
    if group == 'H1':
        b = bear
        return [
            ('H1a-photo-only-app-prompt', 'bear', [b['photo']], b['prompt'], b['size'], {}),
            ('H1a2-photo-only-plain', 'bear', [b['photo']], PHOTO_ONLY, b['size'], {}),
            ('H1b-red-photo', 'bear', [b['guide'], red(b['photo'])], b['prompt'], b['size'], {}),
            ('H1c-photo-first', 'bear', [b['photo'], b['guide']], swap_numbers(b['prompt']), b['size'], {}),
            ('H1d-t-swapped', 'bear', [b['guide'], b['photo']], b['prompt'], b['size'], {'t': [20, 10]}),
        ]
    if group == 'H2':
        return [(f'H2-from-1-{name}', name, [x['guide'], x['photo']], renumber(x['prompt']), x['size'], {}) for name in INPUTS for x in [inputs(name)]]
    if group == 'H3':
        b = bear
        return [
            ('H3a-text-only-red', 'bear', [], TEXT_RED, b['size'], {}),
            ('H3b-guide-red', 'bear', [b['guide']], GUIDE_RED, b['size'], {}),
            ('H3c-app-prompt-red', 'bear', [b['guide'], b['photo']], b['prompt'] + ' The body is red.', b['size'], {}),
        ]
    if group == 'H4':
        b = bear
        return [
            ('H4a-inputs-x2', 'bear', [scaled(b['guide'], 2), scaled(b['photo'], 2)], b['prompt'], b['size'], {}),
            ('H4b-inputs-half', 'bear', [scaled(b['guide'], 0.5), scaled(b['photo'], 0.5)], b['prompt'], b['size'], {}),
            ('H4c-output-1x', 'bear', [b['guide'], b['photo']], b['prompt'], b['guide'].size, {}),
        ]
    if group == 'H5':
        b = bear
        return [
            ('H5a-steps-8', 'bear', [b['guide'], b['photo']], b['prompt'], b['size'], {'steps': 8}),
            ('H5b-steps-16', 'bear', [b['guide'], b['photo']], b['prompt'], b['size'], {'steps': 16}),
            ('H5c-cfg-2.5', 'bear', [b['guide'], b['photo']], b['prompt'], b['size'], {'cfg': 2.5}),
            ('H5d-cfg-4', 'bear', [b['guide'], b['photo']], b['prompt'], b['size'], {'cfg': 4.0}),
        ]
    raise SystemExit(f'모르는 묶음: {group}')


def generate(pipe, images, prompt, size, seed, options):
    """One answer, with the case's T coordinates, steps or forced guidance; the pipeline put back after."""
    original_ids = pipe._prepare_image_ids
    if 't' in options:
        order = options['t']

        def image_ids(latents, scale=10):
            ids = original_ids(latents, scale)
            start = 0
            for latent, t in zip(latents, order):
                count = latent.shape[-2] * latent.shape[-1]
                ids[0, start:start + count, 0] = t
                start += count
            return ids

        pipe._prepare_image_ids = image_ids
    cfg = options.get('cfg')
    if cfg:
        pipe.register_to_config(is_distilled=False)
    try:
        return pipe(
            image=images or None,
            prompt=prompt,
            width=size[0],
            height=size[1],
            num_inference_steps=options.get('steps', 4),
            guidance_scale=cfg or 1.0,
            generator=torch.Generator(device='cuda').manual_seed(seed),
        ).images[0]
    finally:
        pipe._prepare_image_ids = original_ids
        pipe.register_to_config(is_distilled=True)


def cell(path_or_image):
    image = Image.open(path_or_image) if isinstance(path_or_image, str) else path_or_image
    image = image.convert('RGB')
    image.thumbnail((CELL, CELL))
    out = Image.new('RGB', (CELL, CELL), 'white')
    out.paste(image, ((CELL - image.width) // 2, (CELL - image.height) // 2))
    return out


def sheet(path, rows):
    """Rows of (label, images): a label column, then the images."""
    label_width = 220
    columns = max(len(images) for _, images in rows)
    out = Image.new('RGB', (label_width + columns * (CELL + 4), len(rows) * (CELL + 4)), (235, 235, 235))
    draw = ImageDraw.Draw(out)
    for r, (label, images) in enumerate(rows):
        y = r * (CELL + 4)
        draw.text((6, y + 6), label, fill='black')
        for c, image in enumerate(images):
            out.paste(cell(image), (label_width + c * (CELL + 4), y))
    out.save(path)


def vae_check(pipe, out):
    """The photo through the VAE and back at its own size: how much its colours move."""
    photo = load_input('bear')['photo']
    processor = pipe.image_processor
    tensor = processor.preprocess(photo, height=photo.height // 16 * 16, width=photo.width // 16 * 16, resize_mode='crop')
    pipe.vae.to('cuda')
    with torch.no_grad():
        latent = pipe.vae.encode(tensor.to('cuda', pipe.vae.dtype)).latent_dist.mode()
        back = pipe.vae.decode(latent).sample
    pipe.vae.to('cpu')
    image = processor.postprocess(back.float().cpu(), output_type='pil')[0]
    os.makedirs(out, exist_ok=True)
    image.save(os.path.join(out, 'vae-photo.png'))
    a = np.asarray(photo.crop((0, 0, image.width, image.height)), dtype=np.float32)
    b = np.asarray(image, dtype=np.float32)
    result = {'meanAbs': float(np.abs(a - b).mean()), 'meanBefore': a.reshape(-1, 3).mean(0).tolist(), 'meanAfter': b.reshape(-1, 3).mean(0).tolist()}
    print('vae', json.dumps(result), flush=True)
    with open(os.path.join(out, 'vae.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('groups', nargs='+')
    parser.add_argument('--out', default=os.path.join(ROOT, 'test-results', 'direction-photo-explore', 'diag'))
    parser.add_argument('--seeds', default='1003,1004,1005,1006')
    args = parser.parse_args()
    seeds = [int(s) for s in args.seeds.split(',')]
    loaded = {}

    def inputs(name):
        if name not in loaded:
            loaded[name] = load_input(name)
        return loaded[name]

    plans = {group: cases(group, inputs) for group in args.groups if group != 'vae'}
    pipe, meta = load_pipeline()
    print(json.dumps(meta), flush=True)
    if 'vae' in args.groups:
        vae_check(pipe, os.path.join(args.out, 'vae'))
    for group, group_cases in plans.items():
        rows = []
        shown = set()
        for name, input_name, images, prompt, size, options in group_cases:
            if input_name not in shown:
                shown.add(input_name)
                rows.append((f'Cloudflare {input_name}', cloudflare_answers(input_name)))
            folder = os.path.join(args.out, name)
            os.makedirs(folder, exist_ok=True)
            answers = []
            for seed in seeds:
                started = time.time()
                image = generate(pipe, images, prompt, size, seed, options)
                image.save(os.path.join(folder, f'{seed}.png'))
                answers.append(image)
                print(f'{name} {seed} {time.time() - started:.1f}s', flush=True)
            with open(os.path.join(folder, 'case.json'), 'w', encoding='utf-8') as f:
                json.dump({'case': name, 'input': input_name, 'images': [list(i.size) for i in images], 'size': list(size), 'options': options, 'seeds': seeds, 'prompt': prompt, 'meta': meta}, f, ensure_ascii=False, indent=2)
            rows.append((name, answers))
        sheet(os.path.join(args.out, f'{group}.png'), rows)
        print(f'sheet {group}', flush=True)


if __name__ == '__main__':
    sys.exit(main())
