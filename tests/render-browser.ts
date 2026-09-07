/** Standalone real-WebGL integration checks: node --experimental-strip-types tests/render-browser.ts */
import {chromium} from '@playwright/test';
import {build} from 'esbuild';
import assert from 'node:assert/strict';

const bundle=await build({stdin:{contents:`export { PhotoCompositor } from './src/lib/render/compositor';export {rectifyImage} from './src/lib/render/crop';`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',globalName:'RenderTest',platform:'browser'});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
try {
  const page=await browser.newPage({viewport:{width:1920,height:1080}});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error') errors.push(message.text());});
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const result=await page.evaluate(async()=>{
    // esbuild exposes the real application renderer, without a test implementation of its shaders.
    const {PhotoCompositor,rectifyImage}=(window as unknown as {RenderTest:typeof import('../src/lib/render/compositor')&typeof import('../src/lib/render/crop')}).RenderTest;
    const makeAsset=async(id:string,color:string,product=false,width=400,height=300):Promise<import('../src/lib/types').AssetRecord>=>{
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d')!;
      if(product) {ctx.fillStyle=color;ctx.fillRect(100,60,200,240);}
      else {ctx.fillStyle=color;ctx.fillRect(0,0,width,height);}
      const blob=await new Promise<Blob>(resolve=>canvas.toBlob(blob=>resolve(blob!),'image/png'));
      return {id,ownerId:'test',name:id,mime:'image/png',size:blob.size,width,height,kind:product?'product':'original',createdAt:new Date().toISOString(),blob};
    };
    const records=await Promise.all([makeAsset('photo','#808080'),makeAsset('tile','#2277ee'),makeAsset('fixture','#ff2222',true)]);
    const assets=Object.fromEntries(records.map(a=>[a.id,a]));
    const color={exposure:0,contrast:1,saturation:1,warmth:0};
    const empty=()=>({polygon:[],strokes:[]});
    const quad:[{x:number;y:number},{x:number;y:number},{x:number;y:number},{x:number;y:number}]=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
    const material:import('../src/lib/types').MaterialVersion={id:'tile-v1',materialId:'tile',version:1,name:'테스트 타일',brand:'',code:'',category:'tile',scope:'personal',description:'',color:'#2277ee',finish:'',widthMm:600,heightMm:300,depthMm:8,usage:'both',installation:'floor',coverAssetId:'tile',imageAssetIds:['tile'],textureAssetIds:['tile'],views:[],defaultGroutWidth:0,defaultGroutColor:'#ffffff',defaultPattern:'grid',createdAt:new Date().toISOString()};
    const fixtureMaterial={...material,id:'fixture-v1',materialId:'fixture',category:'basin' as const,coverAssetId:'fixture',imageAssetIds:['fixture'],textureAssetIds:[],views:[{assetId:'fixture',direction:'정면',anchor:{x:.5,y:1}}]};
    let snapshot:import('../src/lib/types').RenderSnapshot={materials:{'tile-v1':material,'fixture-v1':fixtureMaterial},scene:{originalAssetId:'photo',previewAssetId:'photo',imageWidth:400,imageHeight:300,surfaces:[{id:'floor',name:'바닥',kind:'floor',mask:{polygon:quad,strokes:[]},quad,widthMm:2400,heightMm:1800,calibrated:true,materialVersionId:'tile-v1',tile:{rotation:0,offsetX:0,offsetY:0,groutWidth:0,groutColor:'#ffffff',pattern:'grid',seed:12,shading:0},color}],protection:{polygon:[{x:0,y:0},{x:.15,y:0},{x:.15,y:.15},{x:0,y:.15}],strokes:[]},fixtures:[],color}};
    const engine=new PhotoCompositor();document.body.append(engine.canvas);
    const reader=async(id:string)=>assets[id];
    const pixel=(canvas:HTMLCanvasElement,x:number,y:number)=>{
      const copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;
      const ctx=copy.getContext('2d')!;ctx.drawImage(canvas,0,0);
      return [...ctx.getImageData(Math.floor(x*canvas.width),Math.floor(y*canvas.height),1,1).data];
    };
    const close=(a:number[],b:number[],label:string,tolerance=3)=>{
      if(a.slice(0,3).some((value,i)=>Math.abs(value-b[i])>tolerance)) throw new Error(`${label}: ${a} expected ${b}`);
    };
    await engine.setSnapshot(snapshot,reader);
    close(pixel(engine.render(400,300,'before'),.5,.5),[128,128,128],'원본');
    close(pixel(engine.render(400,300,'after'),.5,.5),[34,119,238],'불투명 타일 합성');
    close(pixel(engine.canvas,.08,.08),[128,128,128],'보호 영역');
    close(pixel(engine.render(400,300,'split',.5),.25,.5),[128,128,128],'분할 전');
    close(pixel(engine.canvas,.75,.5),[34,119,238],'분할 후');
    snapshot={...snapshot,scene:{...snapshot.scene,fixtures:[{id:'sink',name:'세면대',materialVersionId:'fixture-v1',viewIndex:0,position:{x:.5,y:.75},width:.5,height:.5,rotation:0,anchor:{x:.5,y:1},locked:false,shadow:{x:0,y:.02,opacity:.3,blur:.02,scale:.8},occlusion:empty(),color}]}};
    await engine.setSnapshot(snapshot,reader);
    close(pixel(engine.render(400,300),.5,.5),[255,34,34],'제품 본체');
    close(pixel(engine.canvas,.29,.3),[34,119,238],'제품 알파');
    const beforeMove=pixel(engine.canvas,.5,.5);
    snapshot={...snapshot,scene:{...snapshot.scene,fixtures:snapshot.scene.fixtures.map(f=>({...f,position:{x:.8,y:.75}}))}};
    await engine.setSnapshot(snapshot,reader);
    close(pixel(engine.render(400,300),.5,.5),[34,119,238],'제품 이동 잔상 없음');
    snapshot={...snapshot,scene:{...snapshot.scene,fixtures:snapshot.scene.fixtures.map(f=>({...f,occlusion:{polygon:[{x:.6,y:0},{x:1,y:0},{x:1,y:1},{x:.6,y:1}],strokes:[]}}))}};
    await engine.setSnapshot(snapshot,reader);
    close(pixel(engine.render(400,300),.8,.5),[34,119,238],'제품별 가림');
    const exported=await engine.exportImage(snapshot,4000,3000,'image/png',true);
    const bitmap=await createImageBitmap(exported);
    if(bitmap.width!==400||bitmap.height!==150) throw new Error(`비교 출력 총 크기: ${bitmap.width}x${bitmap.height}`);
    bitmap.close();
    const cropped=await rectifyImage(assets.tile.blob,quad,100,100);
    const rectified=await createImageBitmap(cropped);
    if(rectified.width!==100||rectified.height!==100) throw new Error('타일 정면 보정 크기');rectified.close();
    // A synchronous pixel readback forces completion; gl.finish alone may return early through ANGLE.
    const gl=engine.canvas.getContext('webgl2')!;
    const info=gl.getExtension('WEBGL_debug_renderer_info');
    const gpu=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
    snapshot={...snapshot,scene:{...snapshot.scene,imageWidth:1920,imageHeight:1080,surfaces:[snapshot.scene.surfaces[0],{...snapshot.scene.surfaces[0],id:'wall2'},{...snapshot.scene.surfaces[0],id:'wall3'}]}};
    await engine.setSnapshot(snapshot,reader);
    const sample=new Uint8Array(4);
    for(let i=0;i<5;i++){engine.render(1920,1080);gl.readPixels(960,540,1,1,gl.RGBA,gl.UNSIGNED_BYTE,sample);}
    const times:number[]=[];
    for(let i=0;i<30;i++){
      const start=performance.now();engine.render(1920,1080);gl.readPixels(960,540,1,1,gl.RGBA,gl.UNSIGNED_BYTE,sample);times.push(performance.now()-start);
    }
    const averageMs=times.reduce((a,b)=>a+b,0)/times.length;
    const animationStart=performance.now();
    for(let i=0;i<60;i++) {
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      const moving={...snapshot,scene:{...snapshot.scene,fixtures:snapshot.scene.fixtures.map(f=>({...f,position:{x:.6+i*.002,y:.75}}))}};
      await engine.setSnapshot(moving,reader);engine.render(1920,1080);
      gl.readPixels(960,540,1,1,gl.RGBA,gl.UNSIGNED_BYTE,sample);
    }
    const animationFps=60000/(performance.now()-animationStart);
    const data={checks:11,beforeMove,gpu,userAgent:navigator.userAgent,benchmark:{resolution:'1920x1080',surfaces:3,fixtures:1,frames:30,averageMs,p95Ms:times.sort((a,b)=>a-b)[Math.floor(times.length*.95)],draftAnimationFrames:60,draftAnimationFps:animationFps}};
    engine.dispose();
    // Identical gray photographs at different pixel sizes prove quality selection without relying
    // on artificially different source colors. Inspect actual prepared GPU source dimensions.
    const qualityAssets=await Promise.all([makeAsset('quality-original','#808080',false,4096,3072),makeAsset('quality-preview','#808080',false,512,384)]);
    qualityAssets.forEach(asset=>assets[asset.id]=asset);
    const reads:string[]=[];
    const qualityReader=async(id:string)=>{reads.push(id);if(!assets[id])throw new Error(`Missing test asset: ${id}`);return assets[id];};
    const highScene={...snapshot.scene,originalAssetId:'quality-original',previewAssetId:'quality-preview',imageWidth:4096,imageHeight:3072,surfaces:[snapshot.scene.surfaces[0]],fixtures:[]};
    const qualitySnapshot={...snapshot,scene:highScene};
    const qualityEngine=new PhotoCompositor();
    const inspect=qualityEngine as unknown as {quality:{quality:string};snapshot:typeof qualitySnapshot;tilePasses:{mask:{image:HTMLCanvasElement};atlas:{image:HTMLCanvasElement}}[]};
    await qualityEngine.setSnapshot(qualitySnapshot,qualityReader);
    qualityEngine.render(512,384,'split',.37);
    if(reads.includes('quality-original'))throw new Error('Preview eagerly read the original photo');
    if(inspect.tilePasses[0].mask.image.width!==2048||inspect.tilePasses[0].atlas.image.width!==512)throw new Error('Preview resource budget was not used');
    const normalRender=qualityEngine.render.bind(qualityEngine);let exportMaskWidth=0,exportAtlasWidth=0;
    qualityEngine.render=(w,h,mode='after',split=.5)=>{
      if(inspect.quality.quality==='export'){exportMaskWidth=inspect.tilePasses[0].mask.image.width;exportAtlasWidth=inspect.tilePasses[0].atlas.image.width;}
      return normalRender(w,h,mode,split);
    };
    const highExport=await qualityEngine.exportImage(qualitySnapshot,4096,3072,'image/png',false);
    if(!reads.includes('quality-original')||exportMaskWidth!==4096||exportAtlasWidth!==2048)throw new Error(`Export quality resources: mask=${exportMaskWidth}, atlas=${exportAtlasWidth}, reads=${reads}`);
    if(inspect.quality.quality!=='preview'||inspect.snapshot!==qualitySnapshot||qualityEngine.canvas.width!==512||inspect.tilePasses[0].mask.image.width!==2048)throw new Error('Export did not restore the preview snapshot and resource budget');
    close(pixel(qualityEngine.canvas,.3,.5),[128,128,128],'내보내기 뒤 split 복원');
    const highBitmap=await createImageBitmap(highExport);if(highBitmap.width!==4096||highBitmap.height!==3072)throw new Error('Full-resolution output size');highBitmap.close();
    let failed=false;
    try{await qualityEngine.exportImage({...qualitySnapshot,scene:{...highScene,originalAssetId:'missing-original'}},4096,3072,'image/png',false);}catch{failed=true;}
    if(!failed||inspect.snapshot!==qualitySnapshot||inspect.quality.quality!=='preview'||qualityEngine.canvas.width!==512)throw new Error('Export failure did not restore the prior preview');
    close(pixel(qualityEngine.canvas,.3,.5),[128,128,128],'실패 뒤 split 복원');
    qualityEngine.dispose();
    return {...data,quality:{previewPhoto:'512x384',originalPhoto:'4096x3072',exportMaskWidth,exportAtlasWidth,restoredPreview:true,failureRestored:true}};
  });
  assert.deepEqual(errors,[],`브라우저 오류: ${errors.join('\n')}`);
  console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
