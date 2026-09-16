"""Compare the SAME saved browser ONNX forward outputs with official Python infer postprocessing.
No model inference, downloads, or image decoding; input hashes and output arrays remain immutable.
"""
import argparse, hashlib, json, os, sys, time
from pathlib import Path
for key in ("OMP_NUM_THREADS","MKL_NUM_THREADS","OPENBLAS_NUM_THREADS"): os.environ[key]="1"
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/"scripts"))
from reconstruction_geometry.model import forbid_network, import_existing_cv2
forbid_network([]);import_existing_cv2(Path.home()/"AppData/Local/Programs/Python/Python310/Lib/site-packages")
sys.path.insert(0,str(ROOT/"tmp/moge2/MoGe-925b8ed835a7a9cdb7578ba15c658a0afc969030"));sys.path.insert(0,str(ROOT/"tmp/moge2/utils3d-3fab839f0be9931dac7c8488eb0e1600c236e183"))
import numpy as np
import torch
import utils3d
from moge.utils.geometry_torch import recover_focal_shift
torch.set_num_threads(1)
parser=argparse.ArgumentParser();parser.add_argument("--input",required=True);parser.add_argument("--out",required=True);args=parser.parse_args()
folder=Path(args.input);out=Path(args.out);out.mkdir(parents=True,exist_ok=False)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
rows=[]
for backend in ["webgpu","wasm"]:
 meta=json.loads((folder/(backend+"-result.json")).read_text());w,h=meta["raw"]["width"],meta["raw"]["height"]
 inputs=[folder/(backend+"-result.json")]+[folder/(backend+"-"+stage+"-"+key+".bin") for stage,keys in [("raw",["points","normal","mask"]),("dense",["points","normal","mask","depth"])] for key in keys]
 before={str(p):sha(p) for p in inputs}
 raw=lambda key,channels:np.fromfile(folder/(backend+"-raw-"+key+".bin"),np.float32).reshape(h,w,channels) if channels>1 else np.fromfile(folder/(backend+"-raw-"+key+".bin"),np.float32).reshape(h,w)
 p=torch.from_numpy(raw("points",3)).unsqueeze(0);normal=torch.from_numpy(raw("normal",3)).unsqueeze(0);mask=torch.from_numpy(raw("mask",1)>.5).unsqueeze(0)
 begin=time.perf_counter();focal,shift=recover_focal_shift(p,mask);aspect=w/h
 fx=focal/2*(1+aspect**2)**.5/aspect;fy=focal/2*(1+aspect**2)**.5
 k=utils3d.pt.intrinsics_from_focal_center(fx,fy,torch.tensor(.5),torch.tensor(.5))
 p[...,2]+=shift[:,None,None];mask &= p[...,2]>0;depth=p[...,2].clone()
 p=utils3d.pt.depth_map_to_point_map(depth,intrinsics=k);p*=meta["raw"]["metricScale"];depth*=meta["raw"]["metricScale"]
 p=torch.where(mask[...,None],p,torch.inf);depth=torch.where(mask,depth,torch.inf);normal=torch.where(mask[...,None],normal,torch.zeros_like(normal))
 duration=(time.perf_counter()-begin)*1000
 comparisons={}
 for key,tensor in [("points",p[0]),("depth",depth[0]),("normal",normal[0]),("mask",mask[0])]:
  expected=tensor.numpy();actual=np.fromfile(folder/(backend+"-dense-"+key+".bin"),np.uint8 if key=="mask" else np.float32).reshape(expected.shape)
  if key=="mask":comparisons[key]=dict(equal=bool(np.array_equal(expected,actual)),pixels=int(expected.sum()))
  else:
   finite=np.isfinite(expected)&np.isfinite(actual);diff=np.abs(expected[finite]-actual[finite]).astype(np.float64)
   comparisons[key]=dict(validityEqual=bool(np.array_equal(np.isfinite(expected),np.isfinite(actual))),maximum=float(diff.max()) if len(diff) else 0,mean=float(diff.mean()) if len(diff) else 0,p95=float(np.percentile(diff,95)) if len(diff) else 0)
 row=dict(backend=backend,width=w,height=h,officialFocal=float(focal[0]),officialShift=float(shift[0]),browserFocal=meta["diagnostics"]["focal"],browserShift=meta["diagnostics"]["shift"],focalAbsoluteDifference=abs(float(focal[0])-meta["diagnostics"]["focal"]),shiftAbsoluteDifference=abs(float(shift[0])-meta["diagnostics"]["shift"]),officialIntrinsics=k[0].numpy().tolist(),browserIntrinsics=meta["intrinsics"],comparisons=comparisons,pythonPostprocessMs=duration,sourceInputHashes=before,unchanged=all(sha(p)==digest for p,digest in before.items()))
 rows.append(row)
report=dict(scope="Same actual browser raw tensors -> official torch recovery/projection/mask; no new inference",newInference=0,network=0,rows=rows,limitations="Bounded scalar LM and scipy LM have different convergence implementations; raw tensors and masks are identical inputs.",sourceSHA={p:sha(ROOT/p) for p in ["tests/reconstruction-moge-browser-actual-postprocess.py","src/lib/reconstruction/moge-browser/postprocess.ts"]})
(out/"report.json").write_text(json.dumps(report,indent=2),encoding="utf8");print(json.dumps(report,indent=2))

