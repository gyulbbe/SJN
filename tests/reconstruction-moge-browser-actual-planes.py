"""Same browser dense + actual DeepLab masks -> unchanged Python semantic planes.
No image/model inference; estimates are not measured room dimensions.
"""
import argparse,base64,hashlib,importlib.util,json,os,sys,time,itertools,math
from pathlib import Path
for key in ("OMP_NUM_THREADS","MKL_NUM_THREADS","OPENBLAS_NUM_THREADS"):os.environ[key]="1"
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/"scripts"))
from reconstruction_geometry.model import forbid_network
forbid_network([])
import numpy as np
spec=importlib.util.spec_from_file_location("geometry_worker",ROOT/"tests/helpers/moge-plane-reference.py")
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
p=argparse.ArgumentParser();p.add_argument("--input",required=True);p.add_argument("--out",required=True);p.add_argument("--backend",default="webgpu");p.add_argument("--rng",choices=["numpy","browser"],default="numpy");p.add_argument("--browser-result");a=p.parse_args()
folder=Path(a.input);out=Path(a.out);out.mkdir(parents=True,exist_ok=False)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
metadata=json.loads((folder/"metadata.json").read_text(encoding="utf8"))
result=json.loads((folder/(a.backend+"-result.json")).read_text(encoding="utf8"))
w=result["raw"]["width"];h=result["raw"]["height"]
paths=[folder/"metadata.json",folder/(a.backend+"-result.json"),folder/"semantic-floor.bin",folder/"semantic-wall.bin"]+[folder/(a.backend+"-dense-"+key+".bin") for key in ["points","normal","mask","depth"]]
if a.browser_result:paths.append(Path(a.browser_result))
before={str(p):sha(p) for p in paths}
arrays={key:np.fromfile(folder/(a.backend+"-dense-"+key+".bin"),np.uint8 if key=="mask" else np.float32).reshape((h,w,3) if key in ["points","normal"] else (h,w)) for key in ["points","normal","mask","depth"]}
arrays["mask"]=arrays["mask"]>0
k=result["intrinsics"];arrays["intrinsics"]=np.array([[k["fx"],0,k["cx"]],[0,k["fy"],k["cy"]],[0,0,1]],np.float32)
for key in ["floor","wall"]:metadata[key]=base64.b64encode((folder/("semantic-"+key+".bin")).read_bytes()).decode()
class BrowserRandom:
 def __init__(self,seed):self.state=seed
 def next(self):
  x=self.state;x^=(x<<13)&0xffffffff;x^=x>>17;x^=(x<<5)&0xffffffff;self.state=x&0xffffffff;return self.state/4294967296
 def choice(self,n,size,replace=False):
  assert replace is False
  values=list(range(n))
  for i in range(size):
   j=i+int(self.next()*(n-i));values[i],values[j]=values[j],values[i]
  return np.array(values[:size],dtype=np.int64)
 def integers(self,low,high,size):
  return np.array([low+int(self.next()*(high-low)) for _ in range(int(np.prod(size)))],dtype=np.int64).reshape(size)
if a.rng=="browser": np.random.default_rng=lambda seed:BrowserRandom(seed)
start=time.perf_counter();observation,evidence,labels=worker.create_observation(arrays,metadata,metadata["inputFingerprint"]);duration=(time.perf_counter()-start)*1000
browser_result=json.loads(Path(a.browser_result).read_text(encoding="utf8")) if a.browser_result else result
browser=browser_result.get("planes",browser_result)
if "observation" in browser:browser=browser["observation"]
threshold=float(np.median(arrays["depth"][arrays["mask"]]))*.008
def distance(p,q):
 dot=float(np.clip(np.dot(p["normalCamera"],q["normalCamera"]),-1,1))
 return math.degrees(math.acos(dot))+abs(p["offset"]-q["offset"])*100
def comparison(p,q):
 av=np.array(list(p["imageSupport"]["occupied"]))=="1";bv=np.array(list(q["imageSupport"]["occupied"]))=="1";union=(av|bv).sum()
 angle=math.degrees(math.acos(float(np.clip(np.dot(p["normalCamera"],q["normalCamera"]),-1,1))))
 d=abs(p["offset"]-q["offset"]);rms=abs(p["rmsResidual"]-q["rmsResidual"]);iou=float((av&bv).sum()/union) if union else 1
 return dict(pythonId=p["id"],browserId=q["id"],normalAngleDegrees=angle,offsetAbsoluteDifference=d,inlierCountPython=p["inlierCount"],inlierCountBrowser=q["inlierCount"],rmsAbsoluteDifference=rms,support64IoU=iou,medianPointDistance=float(np.linalg.norm(np.array(p["medianPointCamera"])-q["medianPointCamera"])),withinDeclaredNumericTolerance=angle<=.5 and d<=threshold*.25 and rms<=threshold*.1 and iou>=.98)
matches=[]
if observation["floor"] is not None and browser["floor"] is not None:matches.append(comparison(observation["floor"],browser["floor"]))
pa=observation["walls"];pb=browser["walls"]
if len(pa)==len(pb) and pa:
 perm=min(itertools.permutations(range(len(pb))),key=lambda order:sum(distance(pa[i],pb[j]) for i,j in enumerate(order)))
 matches.extend(comparison(pa[i],pb[j]) for i,j in enumerate(perm))
sameCounts=(observation["floor"] is None)==(browser["floor"] is None) and len(pa)==len(pb)
report=dict(referenceRng=a.rng,referenceMeaning="Unmodified original NumPy RNG baseline" if a.rng=="numpy" else "DIAGNOSTIC ONLY: Python unchanged plane algorithm with browser RNG substituted; not baseline parity",scope="same actual browser dense and DeepLab binary masks, Python plane extraction; zero new inference",newInference=0,backend=a.backend,pythonExtractionMs=duration,thresholdModelUnits=threshold,tolerance=dict(normalDegrees=.5,offsetThresholdMultiple=.25,rmsThresholdMultiple=.1,support64IoUMin=.98,basis="Far narrower than existing15deg normal and full distance acceptance; no missing/extra planes allowed. Model-plane numerical agreement, not physical accuracy."),samePlaneCounts=sameCounts,pythonPlaneCount=len(pa)+(observation["floor"] is not None),browserPlaneCount=len(pb)+(browser["floor"] is not None),matches=matches,withinDeclaredNumericTolerance=sameCounts and all(x["withinDeclaredNumericTolerance"] for x in matches),sourceInputSHA=before,inputsUnchanged=all(sha(p)==digest for p,digest in before.items()),sourceSHA={str(p.relative_to(ROOT)):sha(p) for p in [Path(__file__),ROOT/"tests/helpers/moge-plane-reference.py",ROOT/"scripts/reconstruction_geometry/planes.py",ROOT/"scripts/reconstruction_geometry/consensus.py"]})
for name,value in [("report.json",report),("python-observation.json",observation),("python-evidence.json",evidence)]: (out/name).write_text(json.dumps(value,indent=2,ensure_ascii=False,allow_nan=False),encoding="utf8")
for key,value in labels.items():value.tofile(out/("python-"+key+".bin"))
print(json.dumps(report,indent=2))

