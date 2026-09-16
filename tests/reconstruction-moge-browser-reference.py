"""Offline numeric reference only. Uses existing installed Python; no model/inference/download.
Pinned official torch recover_focal_shift and current semantic plane pipeline.
The fixtures are authored numeric scenes, not photo accuracy evidence.
"""
import argparse, base64, hashlib, importlib.util, json, os, sys
from pathlib import Path
for key in ("OMP_NUM_THREADS","MKL_NUM_THREADS","OPENBLAS_NUM_THREADS"): os.environ[key]="1"
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
from reconstruction_geometry.model import forbid_network, import_existing_cv2
forbid_network([])
import_existing_cv2(Path.home()/"AppData/Local/Programs/Python/Python310/Lib/site-packages")
sys.path.insert(0,str(ROOT/"tmp/moge2/MoGe-925b8ed835a7a9cdb7578ba15c658a0afc969030"))
sys.path.insert(0,str(ROOT/"tmp/moge2/utils3d-3fab839f0be9931dac7c8488eb0e1600c236e183"))
import numpy as np
import torch
import utils3d
from moge.utils.geometry_torch import recover_focal_shift
torch.set_num_threads(1)
def digest(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def make_raw(w,h,kind):
 a=w/h;sx=a/(1+a*a)**.5;sy=1/(1+a*a)**.5
 y,x=np.mgrid[:h,:w]
 u=sx*(2*(x+.5)/w-1);v=sy*(2*(y+.5)/h-1)
 z=1.3+.009*x+.014*y+.045*np.sin(x*.7+y*.2)
 shift=.27; focal=.93
 pts=np.stack((u*(z+shift)/focal,v*(z+shift)/focal,z),axis=-1).astype(np.float32)
 normal=np.zeros_like(pts);normal[...,2]=-1
 mask=np.ones((h,w),np.float32)
 if kind=="holes": mask[(x+2*y)%7==0]=.5;mask[(x+y)%19==0]=.1
 if kind=="empty": mask[:]=.4
 if kind=="noise": pts[...,0]+=(.003*np.sin(x*3+y)).astype(np.float32)
 return pts,normal,mask
def post(w,h,kind,known=False):
 pts,normal,mask=make_raw(w,h,kind)
 p=torch.from_numpy(pts).unsqueeze(0).clone();n=torch.from_numpy(normal).unsqueeze(0)
 m=torch.from_numpy(mask>.5).unsqueeze(0)
 focal,shift=recover_focal_shift(p,m,focal=torch.tensor([.93]) if known else None)
 aspect=w/h
 fx=focal/2*(1+aspect**2)**.5/aspect;fy=focal/2*(1+aspect**2)**.5
 k=utils3d.pt.intrinsics_from_focal_center(fx,fy,torch.tensor(.5),torch.tensor(.5))
 p[...,2]+=shift[:,None,None];m &= p[...,2]>0;depth=p[...,2].clone()
 p=utils3d.pt.depth_map_to_point_map(depth,intrinsics=k);p*=1.7;depth*=1.7
 p=torch.where(m[...,None],p,torch.inf);depth=torch.where(m,depth,torch.inf);n=torch.where(m[...,None],n,torch.zeros_like(n))
 return dict(width=w,height=h,kind=kind,known=known,focal=float(focal[0]),shift=float(shift[0]),intrinsics=k[0].numpy().tolist(),points=np.where(np.isfinite(p[0]),p[0],0).reshape(-1).tolist(),depth=np.where(np.isfinite(depth[0]),depth[0],0).reshape(-1).tolist(),normal=n[0].reshape(-1).tolist(),mask=m[0].reshape(-1).int().tolist())
spec=importlib.util.spec_from_file_location("geometry_worker",ROOT/"tests/helpers/moge-plane-reference.py")
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
def plane_fixture(kind):
 w,h=80,64;y,x=np.mgrid[:h,:w];floor=y>=32; wall=~floor
 points=np.zeros((h,w,3),np.float32);normal=np.zeros_like(points)
 points[...,0]=(x-40)*.025;points[...,1]=(y-32)*.035;points[...,2]=2
 points[floor,1]=1.3;points[floor,2]=.7+(y[floor]-32)*.04
 normal[...,2]=-1;normal[floor]=[0,-1,0]
 if kind in ("corner","exclusions","outliers"):
  right=(x>=45)&wall
  points[right,0]=.85;points[right,2]=.6+(x[right]-40)*.04;normal[right]=[-1,0,0]
 if kind=="outliers":
  bad=(x*7+y*11)%47==0;points[bad,2]+=.17
 valid=np.ones((h,w),bool)
 if kind=="empty":valid[:]=False
 regions=[] if kind!="exclusions" else [dict(id="fixture",kind="mirror",source="inventory",bounds=dict(left=.4,top=.1,right=.6,bottom=.3))]
 metadata=dict(mask=dict(width=w,height=h),image=dict(width=w,height=h),floor=base64.b64encode((floor*255).astype(np.uint8)).decode(),wall=base64.b64encode((wall*255).astype(np.uint8)).decode(),regions=regions)
 arrays=dict(points=points,normal=normal,mask=valid,depth=points[...,2],intrinsics=np.array([[1,0,.5],[0,1,.5],[0,0,1]],np.float32))
 obs,evidence,labels=worker.create_observation(arrays,metadata,"0"*64)
 return dict(kind=kind,observation=obs,filtering=evidence["candidateFiltering"],threshold=evidence["planes"][0]["residual"]["thresholdModelUnits"] if evidence["planes"] else None,floorLabels=labels["floorLabels"].reshape(-1).tolist(),wallLabels=labels["wallLabels"].reshape(-1).tolist())
out=dict(reference="official torch recover_focal_shift + unchanged SJN create_observation",python=sys.version,numpy=np.__version__,torch=torch.__version__,newAI=0,sourceHashes={str(p.relative_to(ROOT)):digest(p) for p in [Path(__file__),ROOT/"tests/helpers/moge-plane-reference.py",ROOT/"scripts/reconstruction_geometry/planes.py",ROOT/"scripts/reconstruction_geometry/consensus.py",ROOT/"tmp/moge2/MoGe-925b8ed835a7a9cdb7578ba15c658a0afc969030/moge/utils/geometry_torch.py",ROOT/"tmp/moge2/MoGe-925b8ed835a7a9cdb7578ba15c658a0afc969030/moge/utils/geometry_numpy.py"]},postprocess=[post(w,h,k,known) for w,h,k,known in [(16,12,"clean",False),(15,23,"holes",False),(28,17,"noise",False),(16,12,"clean",True),(16,12,"empty",False)]],planes=[plane_fixture(k) for k in ("single","corner","exclusions","outliers","empty")])
parser=argparse.ArgumentParser();parser.add_argument("--out",required=True);args=parser.parse_args()
p=Path(args.out);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(out,allow_nan=False,separators=(",",":")),encoding="utf8")
print(json.dumps(dict(path=str(p),bytes=p.stat().st_size,sha256=digest(p),postprocess=len(out["postprocess"]),planes=len(out["planes"]),newAI=0)))

