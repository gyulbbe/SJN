import {describe,expect,it} from 'vitest';
import {homography,inverseHomography,transformPoint,validateQuad,tileAtPoint,variantForCell,fitOutput} from '../src/lib/render/math';
import {maskContains,surfaceContains} from '../src/lib/render/mask';
import {DEFAULT_TILE,type Mask,type Quad} from '../src/lib/types';

const unit:Quad=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
describe('photo plane homography',()=>{
  it('maps all trapezoid corners exactly to physical plane coordinates',()=>{
    const q:Quad=[{x:.2,y:.1},{x:.78,y:.17},{x:.96,y:.92},{x:.06,y:.8}];
    const h=homography(q);
    q.forEach((point,i)=>{
      const result=transformPoint(h,point);
      expect(result.x).toBeCloseTo(unit[i].x,8);
      expect(result.y).toBeCloseTo(unit[i].y,8);
    });
    const photo=transformPoint(inverseHomography(h),{x:.36,y:.67});
    const plane=transformPoint(h,photo);
    expect(plane.x).toBeCloseTo(.36,8);expect(plane.y).toBeCloseTo(.67,8);
  });
  it('rejects crossing, concave, duplicate, collinear, and nonfinite quadrilaterals',()=>{
    const bad:Quad[]=[
      [unit[0],unit[2],unit[1],unit[3]],
      [unit[0],unit[1],{x:.2,y:.2},unit[3]],
      [unit[0],unit[0],unit[2],unit[3]],
      [unit[0],{x:.5,y:0},unit[1],unit[3]],
      [unit[0],unit[1],{x:NaN,y:1},unit[3]],
    ];
    bad.forEach(q=>{expect(validateQuad(q)).toBe(false);expect(()=>homography(q)).toThrow();});
  });
  it('works across clockwise and counterclockwise orientations',()=>{
    const q:Quad=[unit[0],unit[3],unit[2],unit[1]];
    expect(validateQuad(q)).toBe(true);
    expect(transformPoint(homography(q),{x:.25,y:.7})).toEqual({x:.7,y:.25});
  });
});

describe('physical tile repeats',()=>{
  const plane={width:2400,height:1800},tile={width:600,height:300};
  it('includes grout in the physical repeat and locates seam pixels',()=>{
    const settings={...DEFAULT_TILE,groutWidth:2};
    expect(tileAtPoint({x:601/2400,y:.05},plane,tile,settings).grout).toBe(true);
    const second=tileAtPoint({x:603/2400,y:.05},plane,tile,settings);
    expect(second.column).toBe(1);expect(second.grout).toBe(false);
    expect(second.u).toBeCloseTo(1/600);
  });
  it('offsets alternate brick rows by half a full repeat',()=>{
    const settings={...DEFAULT_TILE,pattern:'brick' as const,groutWidth:0};
    const first=tileAtPoint({x:100/2400,y:100/1800},plane,tile,settings);
    const second=tileAtPoint({x:100/2400,y:400/1800},plane,tile,settings);
    expect(first.column).toBe(0);expect(second.column).toBe(-1);
    expect(second.u).toBeCloseTo(2/3);
  });
  it('applies millimeter origin and rotation independently of output resolution',()=>{
    const a=tileAtPoint({x:.3,y:.4},plane,tile,{...DEFAULT_TILE,offsetX:720,offsetY:720,rotation:90});
    expect(a.u).toBeCloseTo(0);expect(a.v).toBeCloseTo(0);
    const b=tileAtPoint({x:720/2400,y:1020/1800},plane,tile,{...DEFAULT_TILE,offsetX:720,offsetY:720,rotation:90,groutWidth:0});
    expect(b.u).toBeCloseTo(.5);expect(b.grout).toBe(false);
  });
  it('keeps variant selection stable for negative cells and saved seeds',()=>{
    const cells=Array.from({length:100},(_,i)=>variantForCell(i-50,i*2-75,812,5));
    expect(cells).toEqual(Array.from({length:100},(_,i)=>variantForCell(i-50,i*2-75,812,5)));
    expect(new Set(cells).size).toBe(5);
    expect(cells.every(n=>n>=0&&n<5)).toBe(true);
    expect(variantForCell(-1,-1,812,1)).toBe(0);
  });
});

describe('masks and object protection',()=>{
  const full:Mask={polygon:unit,strokes:[]};
  it('applies erase and restore strokes in saved order',()=>{
    const mask:Mask={polygon:unit,strokes:[{points:[{x:.2,y:.5},{x:.8,y:.5}],radius:.1,erase:true}]};
    expect(maskContains(mask,{x:.5,y:.5})).toBe(false);
    expect(maskContains(mask,{x:.5,y:.75})).toBe(true);
    mask.strokes.push({points:[{x:.5,y:.5}],radius:.03,erase:false});
    expect(maskContains(mask,{x:.5,y:.5})).toBe(true);
    expect(maskContains(mask,{x:.6,y:.5})).toBe(false);
  });
  it('always subtracts protection from a painted surface',()=>{
    const protection:Mask={polygon:[{x:.3,y:.2},{x:.6,y:.2},{x:.6,y:.9},{x:.3,y:.9}],strokes:[]};
    expect(surfaceContains(full,protection,{x:.45,y:.5})).toBe(false);
    expect(surfaceContains(full,protection,{x:.8,y:.5})).toBe(true);
  });
  it('unions multiple protection polygons instead of replacing earlier areas',()=>{
    const protection:Mask={polygon:[],polygons:[[{x:.1,y:.1},{x:.3,y:.1},{x:.3,y:.3},{x:.1,y:.3}],[{x:.7,y:.7},{x:.9,y:.7},{x:.9,y:.9},{x:.7,y:.9}]],strokes:[]};
    expect(surfaceContains(full,protection,{x:.2,y:.2})).toBe(false);
    expect(surfaceContains(full,protection,{x:.8,y:.8})).toBe(false);
    expect(surfaceContains(full,protection,{x:.5,y:.5})).toBe(true);
  });
  it('uses image-width units for physically round brush strokes',()=>{
    const mask:Mask={polygon:[],strokes:[{points:[{x:.5,y:.5}],radius:.1,erase:false}]};
    expect(maskContains(mask,{x:.5,y:.68},2)).toBe(true);
    expect(maskContains(mask,{x:.5,y:.72},2)).toBe(false);
    expect(maskContains(mask,{x:.62,y:.5},2)).toBe(false);
  });
});

describe('output resolution',()=>{
  it('limits long edges without upscaling the source',()=>{
    expect(fitOutput(6000,4000)).toEqual({width:4096,height:2731});
    expect(fitOutput(900,1200)).toEqual({width:900,height:1200});
    expect(fitOutput(6000,4000,2048)).toEqual({width:2048,height:1365});
    expect(()=>fitOutput(0,100)).toThrow();
  });
});
