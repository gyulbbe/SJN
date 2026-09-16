"""Generate NumPy 2.2.6 plane RNG fixtures; no models/images/network."""
import hashlib,json
from pathlib import Path
import numpy as np
rng=np.random.default_rng(20260913)
steps=[]
for n,k in [(20,20),(20,7),(10001,6000),(69000,6000),(6000,96),(300,300),(1048576,6000),(5000,0)]:
 a=rng.choice(n,k,replace=False).astype('<i8'); steps.append(dict(kind='sample',n=n,k=k,sha256=hashlib.sha256(a.tobytes()).hexdigest(),head=a[:10].tolist()))
 a=rng.integers(0,6000,size=1152).astype('<i8');steps.append(dict(kind='integer',n=6000,k=1152,sha256=hashlib.sha256(a.tobytes()).hexdigest(),head=a[:10].tolist()))
result=dict(numpyVersion=np.__version__,seed=20260913,initialState=np.random.PCG64(20260913).state,steps=steps)
out=Path(__file__).parent/'fixtures/moge-plane-rng-reference.json';out.write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
print(out)
