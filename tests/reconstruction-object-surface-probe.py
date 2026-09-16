"""Offline semantic product surfaces, never bbox-only geometry or measured product dimensions."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

for key in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS'):
    os.environ[key] = '1'
sys.dont_write_bytecode = True
import numpy as np
from scipy import ndimage
from scipy.spatial.transform import Rotation
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
LABEL_SOURCE = 'https://github.com/tensorflow/tfjs-models/blob/master/deeplab/src/config.ts'
LABELS = {0: 'background', 1: 'wall', 4: 'floor', 9: 'windowpane', 11: 'cabinet', 15: 'door',
          25: 'shelf', 28: 'mirror', 38: 'bathtub', 43: 'column', 46: 'counter', 48: 'sink',
          66: 'toilet', 71: 'countertop', 147: 'radiator', 148: 'glass'}
KIND_LABELS = {'vanity': [11, 48], 'basin': [48], 'toilet': [66], 'bath': [38],
               'wallShelf': [25], 'door': [15]}
REFLECTIVE = {'mirror', 'mirrorCabinet', 'window', 'glassPartition'}
CONFIG = {'erosionGridPixels': 1, 'minimumConnectedPixels': 16,
          'maximumLocalDepthMedianDeviationRatio': .03, 'robustQuantiles': [2, 98],
          'directionBinMaximumAngleDegrees': 30, 'minimumDirectionBinPixels': 40}
COLORS = {11: [248, 177, 58], 48: [39, 223, 216], 66: [230, 106, 182],
          38: [157, 135, 251], 25: [147, 220, 65], 15: [87, 155, 237]}


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')


def relative(path):
    return path.relative_to(ROOT).as_posix()


def offline():
    def audit(event, _):
        if event in {'socket.connect', 'socket.getaddrinfo', 'socket.sendto', 'urllib.Request'}:
            raise RuntimeError(f'Offline surface analysis forbids {event}')
    sys.addaudithook(audit)


def bbox_mask(bounds, width, height):
    x = (np.arange(width) + .5) / width
    y = (np.arange(height) + .5) / height
    return ((x >= bounds['left']) & (x <= bounds['right']))[None, :] & ((y >= bounds['top']) & (y <= bounds['bottom']))[:, None]


def stats(points):
    if not len(points):
        return None
    lo, hi = np.percentile(points, CONFIG['robustQuantiles'], axis=0)
    return {'count': len(points), 'min': points.min(axis=0).tolist(), 'max': points.max(axis=0).tolist(),
            'medianPoint': np.median(points, axis=0).tolist(), 'robustMin': lo.tolist(),
            'robustMax': hi.tolist(), 'robustSpan': (hi-lo).tolist(),
            'visibleBoundsMidpoint': ((lo+hi)/2).tolist(),
            'meaning': 'Visible selected surface sample extent; not complete object size or installation center.'}


def directions(points, normals, space):
    # Diagnostic normal bins, without snapping the normals or adopting a product pose.
    axis = np.abs(normals).argmax(axis=1)
    signed = normals[np.arange(len(normals)), axis]
    nearest = axis * 2 + (signed < 0)
    agreement = np.abs(signed)
    confident = agreement >= np.cos(np.deg2rad(CONFIG['directionBinMaximumAngleDegrees']))
    bins = []
    for i, name in enumerate(['+X', '-X', '+Y', '-Y', '+Z', '-Z']):
        select = confident & (nearest == i)
        if select.sum() < CONFIG['minimumDirectionBinPixels']:
            continue
        n = np.median(normals[select], axis=0)
        n /= np.linalg.norm(n)
        p = points[select]
        center = np.median(p, axis=0)
        residual = np.abs((p-center) @ n)
        bins.append({'nearestAxis': name, 'count': int(select.sum()), 'fraction': float(select.mean()),
                     'medianNormal': n.tolist(), 'normalAngleToAxisMedianDegrees': float(np.median(np.rad2deg(np.arccos(np.clip(agreement[select], 0, 1))))),
                     'sampleBounds': stats(p), 'medianPointPlaneResidualP50P95': np.percentile(residual, [50, 95]).tolist(),
                     'meaning': 'Normal-direction evidence only; curved or disconnected surfaces need not form one plane.'})
    return {'space': space, 'bins': sorted(bins, key=lambda b: -b['count']),
            'unbinnedFraction': float((~confident).mean()) if len(normals) else 1}


def safe_point(point, width, height):
    return min(width-1, max(0, int(point['x']*width))), min(height-1, max(0, int(point['y']*height)))


def process(case, args):
    started = time.perf_counter()
    cid = case['id']
    sd = args.labels / cid
    md = args.moge / cid
    pd = args.placement / cid
    out = args.output / cid
    out.mkdir(parents=True, exist_ok=True)
    sem, mog, place = read(sd/'report.json'), read(md/'report.json'), read(pd/'report.json')
    inp = ROOT / case['input']['path']
    assert sha(inp) == case['input']['sha256'] == sem['inputSha256'] == mog['input']['sha256'] == place['observation']['inputFingerprint'], 'Input hash mismatch'
    assert not sem['errors'] and not sem['external'], 'Capture error/external traffic'
    assert sem['capturePass'] == 'primary-full-photo-only'
    assert sha(sd/'semantic-labels.u8') == sem['labelSha256'], 'Labels hash mismatch'
    assert sha(md/'geometry.npz') == mog['artifacts']['geometrySha256'], 'Pointmap archive hash mismatch'
    current_hashes = {name: sha(ROOT/name) for name in sem['sourceHashes']}
    assert current_hashes == sem['sourceHashes'], 'Capture source changed; recapture or evaluate an explicitly frozen checkout'
    width, height = sem['width'], sem['height']
    labels = np.fromfile(sd/'semantic-labels.u8', dtype=np.uint8).reshape(height, width)
    floor = np.fromfile(sd/'floor.u8', dtype=np.uint8).reshape(height, width)
    assert np.array_equal(labels == 4, floor != 0), 'Primary labels do not match captured floor mask'
    arrays = np.load(md/'geometry.npz', allow_pickle=False)
    oh, ow = arrays['depth'].shape
    assert (ow, oh) == (mog['input']['width'], mog['input']['height']) == Image.open(inp).size
    # Semantic grid pixels represent area centers; map to original full-photo pixels, no crops/flips.
    xx = np.floor((np.arange(width)+.5)*ow/width).astype(int)
    yy = np.floor((np.arange(height)+.5)*oh/height).astype(int)
    points = arrays['points'][np.ix_(yy, xx)].astype(np.float64)
    normals = arrays['normal'][np.ix_(yy, xx)].astype(np.float64)
    mask = arrays['mask'][np.ix_(yy, xx)]
    normlen = np.linalg.norm(normals, axis=2)
    finite = mask & np.isfinite(points).all(axis=2) & np.isfinite(normals).all(axis=2) & (normlen > .5) & (points[:, :, 2] > 0)
    normals /= np.maximum(normlen[:, :, None], 1e-12)
    depth = points[:, :, 2]
    local = ndimage.median_filter(depth, size=3)
    stable = np.abs(depth-local) <= CONFIG['maximumLocalDepthMedianDeviationRatio'] * np.maximum(local, 1e-9)
    intr = arrays['intrinsics']
    uv = points[:, :, :2] / points[:, :, 2:3] * np.diag(intr)[:2] + intr[:2, 2]
    expected = np.stack(np.broadcast_arrays((xx[None, :]+.5)/ow, (yy[:, None]+.5)/oh), axis=2)
    reproj = np.abs(uv-expected) * [ow, oh]
    assert float(reproj[finite].max()) < .01, 'Point/grid convention mismatch'
    fit = place['camera']['fit']
    camera = fit.get('camera') if fit['status'] == 'estimated' else None
    rotation = Rotation.from_quat(camera['quaternion']) if camera else None
    world = rotation.apply((points * [1000, -1000, -1000]).reshape(-1, 3)).reshape(points.shape) + camera['positionMm'] if camera else None
    worldnormals = rotation.apply((normals * [1, -1, -1]).reshape(-1, 3)).reshape(normals.shape) if camera else None
    if camera:
        restored = rotation.inv().apply((world-camera['positionMm']).reshape(-1, 3)).reshape(points.shape) * [.001, -.001, -.001]
        assert np.max(np.abs(restored-points)) < 1e-10
    experiment = place['comparison']['experiment']
    candidates = experiment['review']['candidates']
    placements = {p['candidateId']: p for p in experiment['pipeline']['placements']}
    reflective = np.zeros(labels.shape, dtype=bool)
    for c in candidates:
        if c['kind'] in REFLECTIVE:
            reflective |= bbox_mask(c['bounds'], width, height)
    reflected = {'candidateBoxes': [c['id'] for c in candidates if c['kind'] in REFLECTIVE],
                 'method': 'Conservative exclusion only: these bounding boxes never supply product geometry.',
                 'limitation': 'Unrecognized reflection/glass cannot be ruled out; foreground objects overlapping glass boxes are also excluded.'}
    rows, saved = [], {}
    show = np.asarray(Image.open(inp).convert('RGB').resize((width, height))).copy()
    normalshow = (show * .25).astype(np.uint8)
    for c in candidates:
        bmask = bbox_mask(c['bounds'], width, height)
        allow = KIND_LABELS.get(c['kind'], [])
        row = {'candidateId': c['id'], 'kind': c['kind'], 'qwenBounds': c['bounds'], 'source': c.get('source'),
               'allowedSemanticLabels': {str(k): LABELS[k] for k in allow},
               'bboxLabelHistogram': {str(int(k)): int(v) for k, v in zip(*np.unique(labels[bmask], return_counts=True))}}
        if not allow:
            row.update(status='skipped', reason='Reflective/transparent object depth cannot establish its physical surface.' if c['kind'] in REFLECTIVE else 'No exact same-kind label mapping.')
            rows.append(row)
            continue
        raw = bmask & np.isin(labels, allow)
        unreflected = raw & ~reflective
        eroded = np.zeros(labels.shape, dtype=bool)
        component_summary = {}
        for label in allow:
            region = ndimage.binary_erosion(unreflected & (labels == label), iterations=CONFIG['erosionGridPixels'])
            ids, count = ndimage.label(region)
            size = np.bincount(ids.ravel())
            keep = np.flatnonzero(size >= CONFIG['minimumConnectedPixels'])
            keep = keep[keep != 0]
            eroded |= np.isin(ids, keep)
            component_summary[str(label)] = {'beforeTinyComponentRemoval': count, 'retainedComponents': len(keep),
                                              'retainedSizes': sorted(size[keep].tolist(), reverse=True)}
        clean = eroded & finite & stable
        row.update(status='observed-surfaces' if clean.any() else 'held-no-same-kind-surface',
                   filtering={'bboxPixels': int(bmask.sum()), 'sameKindPixels': int(raw.sum()),
                              'reflectiveBoxExcluded': int((raw & reflective).sum()),
                              'boundaryOrTinyComponentExcluded': int((unreflected & ~eroded).sum()),
                              'invalidGeometryExcluded': int((eroded & ~finite).sum()),
                              'depthDiscontinuityExcluded': int((eroded & finite & ~stable).sum()),
                              'retainedPixels': int(clean.sum()), 'components': component_summary})
        pt = {'x': (c['bounds']['left']+c['bounds']['right'])/2, 'y': c['bounds']['bottom']}
        px, py = safe_point(pt, width, height)
        placement = placements.get(c['id'], {})
        row['bboxBottomMidpoint'] = {'normalized': pt, 'gridPixel': [px, py], 'semanticLabel': int(labels[py, px]),
                                    'semanticName': LABELS.get(int(labels[py, px]), 'other'),
                                    'sameKind': bool(raw[py, px]), 'retainedSurfacePixel': bool(clean[py, px]),
                                    'sampledPointCamera': points[py, px].tolist() if finite[py, px] else None,
                                    'sampledPointWorldMm': world[py, px].tolist() if camera and finite[py, px] else None,
                                    'savedPlacementStatus': placement.get('status'), 'savedRayPlaneAnchor': placement.get('anchor'),
                                    'savedPlacementReasons': placement.get('reasons'),
                                    'meaning': 'Diagnostic sample and previous ray-plane intersection are different; neither is verified object center.'}
        if clean.any():
            p, ns = points[clean], normals[clean]
            row['cameraSpaceModelMetres'] = {'surfaces': stats(p), 'directions': directions(p, ns, 'opencv-camera')}
            row['parts'] = {}
            for label in allow:
                part = clean & (labels == label)
                if part.any():
                    row['parts'][LABELS[label]] = {'count': int(part.sum()), 'cameraSpaceModelMetres': stats(points[part]),
                                                  'worldSpaceModelMm': stats(world[part]) if camera else None}
            if camera:
                wp, wn = world[clean], worldnormals[clean]
                row['worldSpaceModelMm'] = {'surfaces': stats(wp), 'directions': directions(wp, wn, 'model-common-room')}
                if placement.get('anchor', {}).get('worldMm'):
                    anchor = np.array(placement['anchor']['worldMm'])
                    row['bboxBottomMidpoint']['anchorMinusVisibleBoundsMidpointMm'] = (anchor-np.array(stats(wp)['visibleBoundsMidpoint'])).tolist()
            else:
                row['worldSpaceModelMm'] = None
            saved[c['id']+'_gridFlatIndices'] = np.flatnonzero(clean).astype(np.int32)
            saved[c['id']+'_labels'] = labels[clean]
            saved[c['id']+'_pointsCamera'] = p.astype(np.float32)
            saved[c['id']+'_normalsCamera'] = ns.astype(np.float32)
            if camera:
                saved[c['id']+'_pointsWorldMm'] = wp.astype(np.float32)
                saved[c['id']+'_normalsWorld'] = wn.astype(np.float32)
            for label in allow:
                select = clean & (labels == label)
                show[select] = .3 * show[select] + .7 * np.array(COLORS[label])
            nsdisplay = worldnormals if camera else normals
            normalshow[clean] = ((nsdisplay[clean]+1)*127.5).clip(0, 255).astype(np.uint8)
        rows.append(row)
    np.savez_compressed(out/'surface-points.npz', **saved)
    images = [Image.fromarray(show), Image.fromarray(normalshow)]
    for im in images:
        draw = ImageDraw.Draw(im)
        for c in candidates:
            b = c['bounds']
            xy = (int(b['left']*width), int(b['top']*height), min(width-1, int(b['right']*width)), min(height-1, int(b['bottom']*height)))
            draw.rectangle(xy, outline=(230, 230, 230), width=1)
            draw.text((xy[0]+2, xy[1]+2), c['id']+' '+c['kind'], fill=(255, 255, 255), stroke_width=1, stroke_fill=(0, 0, 0))
            if c['kind'] in KIND_LABELS:
                x, y = safe_point({'x': (b['left']+b['right'])/2, 'y': b['bottom']}, width, height)
                draw.line((x-5, y, x+5, y), fill=(255, 35, 35), width=2)
                draw.line((x, y-5, x, y+5), fill=(255, 35, 35), width=2)
    board = Image.new('RGB', (width*2, height+52), (24, 27, 32))
    for k, im in enumerate(images):
        board.paste(im, (width*k, 52))
    draw = ImageDraw.Draw(board)
    draw.text((8, 6), cid+' | Same-kind semantic pixels only; red cross = bbox bottom midpoint', fill='white')
    draw.text((8, 24), 'Left: cabinet gold / sink cyan / toilet pink / bath purple. Right: '+('WORLD' if camera else 'CAMERA')+' normal RGB', fill='white')
    board.save(out/'overlay.png')
    board.save(out/'overlay.jpg', quality=90)
    olddir = args.old_semantic/cid
    parity = {name: sha(sd/name) == sha(olddir/name) for name in ['floor.u8', 'wall.u8']} if olddir.exists() else None
    result = {'id': cid, 'status': 'complete', 'config': CONFIG,
              'provenance': {'inputSha256': sem['inputSha256'], 'labelsSha256': sem['labelSha256'],
                             'geometrySha256': sha(md/'geometry.npz'), 'placementReportSha256': sha(pd/'report.json'),
                             'labelsReportSha256': sha(sd/'report.json'), 'scriptSha256': sha(Path(__file__)),
                             'captureSourceHashes': sem['sourceHashes'], 'currentSourceHashesMatch': True,
                             'qwenCandidateSource': relative(pd/'report.json')+'#comparison.experiment.review.candidates',
                             'semanticLabelSource': LABEL_SOURCE},
              'grid': {'semantic': [width, height], 'mogeOriginal': [ow, oh],
                       'mapping': 'floor((semantic index + 0.5) * original extent / semantic extent), full-photo only',
                       'maxInternalReprojectionPixelError': float(reproj[finite].max()),
                       'meaning': 'Coordinate/grid consistency only; MoGe force_projection enforces it, not measured geometry accuracy.',
                       'labelsFloorEqualsCapturedFloor': True, 'originalSemanticCaptureParity': parity},
              'camera': {'status': fit['status'], 'camera': camera,
                         'transformation': 'positionMm + R(quaternion) * cameraPointMetres * [1000,-1000,-1000]' if camera else None,
                         'scale': 'model-estimated, not measured',
                         'limitation': 'Camera and room alignment are an offline model estimate; no app adoption or recovered hidden dimensions.'},
              'reflectionExclusion': reflected, 'candidates': rows,
              'artifacts': {'surfacePoints': relative(out/'surface-points.npz'), 'overlay': relative(out/'overlay.png')},
              'elapsedSeconds': time.perf_counter()-started,
              'limitations': ['Semantic labels are model classes, not instance segmentation or ground truth.',
                             'Qwen boxes only restrict candidate association; no bbox-only pixels become object geometry.',
                             'Same-kind reflections outside recognized mirror/glass boxes remain possible.',
                             'Visible bounds omit hidden surfaces; cannot establish product width/depth/center by themselves.',
                             'Direction bins are diagnostics, not snapped normals, calibrated product pose, or planar guarantees.',
                             'All four photos are development cases, not an unseen quality benchmark.']}
    write(out/'report.json', result)
    brief = {'id': cid, 'status': 'complete', 'camera': fit['status'], 'grid': result['grid'],
             'candidates': [{'id': row['candidateId'], 'kind': row['kind'], 'status': row['status'],
                             'points': row.get('filtering', {}).get('retainedPixels', 0),
                             'bboxBottomLabel': row.get('bboxBottomMidpoint', {}).get('semanticName')} for row in rows]}
    print(json.dumps(brief), flush=True)
    return brief


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, default=ROOT/'test-results/reconstruction-object-surfaces-20260913/manifest.json')
    parser.add_argument('--labels', type=Path, default=ROOT/'test-results/reconstruction-object-surfaces-20260913/labels')
    parser.add_argument('--moge', type=Path, default=ROOT/'test-results/reconstruction-moge2-20260913')
    parser.add_argument('--placement', type=Path, default=ROOT/'test-results/reconstruction-floor-geometry-20260913/placement')
    parser.add_argument('--old-semantic', type=Path, default=ROOT/'test-results/reconstruction-floor-geometry-20260913/semantic')
    parser.add_argument('--output', type=Path, default=ROOT/'test-results/reconstruction-object-surfaces-20260913/surfaces')
    args = parser.parse_args()
    offline()
    results = [process(case, args) for case in read(args.manifest)['cases']]
    write(args.output/'summary.json', {'schemaVersion': 1, 'scriptSha256': sha(Path(__file__)), 'cases': results,
                                     'scope': 'Offline saved pointmap + fresh primary labels + frozen Qwen boxes. No new depth/Qwen model call, no app pose or dimension adoption.'})


if __name__ == '__main__':
    main()