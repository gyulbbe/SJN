import {
  Box3,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  Vector2,
  Vector3,
  Vector4,
  type Camera,
  type Texture,
} from 'three';
import { roomFacePoint } from '../room-geometry';
import { finishAppearance, MATTE_FINISH } from '../render/finish';
import { CORNER_OCCLUSION_GLSL, TONE_MAPPING_GLSL } from '../render/realistic-lighting';
import { buildWallFeaturePieces, type WallFeaturePiece } from './wall-feature-geometry';
import type { RoomDefinition, RoomFace } from '../room-types';
import {
  DEFAULT_COLOR,
  isImageAsset,
  type AssetRecord,
  type ColorAdjust,
  type MaterialVersion,
  type Scene,
  type Surface,
} from '../types';

export type SurfaceNotice = { id: string; name: string; message: string; severity: 'limitation' | 'error' };
export type ViewerSurfacePatch = { face: RoomFace; from: number; to: number; surface?: Surface };
export const VIEWER_FACE_COLORS: Record<RoomFace, string> = {
  floor: '#d5d1c9',
  left: '#e9e6df',
  back: '#f0ede7',
  right: '#dcd8d0',
};
const faces: RoomFace[] = ['floor', 'left', 'back', 'right'];
const hasAdditionalMask = (s: Surface) =>
  !!(s.mask.strokes.length || s.mask.holes?.length || s.mask.polygons?.length);

/** Partition physical intervals instead of stacking coplanar materials. No photo quad is projected. */
export function viewerSurfacePatches(scene: Scene): {
  patches: ViewerSurfacePatch[];
  notices: SurfaceNotice[];
} {
  const patches: ViewerSurfacePatch[] = [],
    notices: SurfaceNotice[] = [];
  const warn = (s: Surface, message: string) =>
    notices.push({ id: s.id, name: s.name, message, severity: 'limitation' });
  for (const s of scene.surfaces) {
    if (!s.roomFace || s.geometryMode !== 'room')
      warn(s, '사진 좌표로 편집한 면은 입체 위치를 확정할 수 없어 이 보기에서 자재를 표시하지 않아요.');
    else if (hasAdditionalMask(s))
      warn(s, '사진 좌표의 브러시·보호 구멍은 이 보기에서 재현하지 않으며, 알려진 공간 면 범위를 사용해요.');
  }
  for (const face of faces) {
    const candidates = scene.surfaces.filter((s) => s.roomFace === face && s.geometryMode === 'room');
    const valid = candidates.filter((s) => {
      const b = s.reconstructionBand;
      if (
        b &&
        (face === 'floor' ||
          !Number.isFinite(b.from) ||
          !Number.isFinite(b.to) ||
          b.from < 0 ||
          b.to > 1 ||
          b.from >= b.to)
      ) {
        warn(s, '벽 높이 구간이 잘못되어 자재를 표시하지 않아요.');
        return false;
      }
      return true;
    });
    const full = valid.filter(
      (s) => !s.reconstructionBand || (s.reconstructionBand.from === 0 && s.reconstructionBand.to === 1),
    );
    const bands = valid.filter((s) => !full.includes(s));
    const conflicting = new Set<Surface>();
    for (const a of bands)
      for (const b of bands)
        if (
          a !== b &&
          Math.min(a.reconstructionBand!.to, b.reconstructionBand!.to) -
            Math.max(a.reconstructionBand!.from, b.reconstructionBand!.from) >
            1e-9
        ) {
          conflicting.add(a);
          conflicting.add(b);
        }
    for (const s of conflicting)
      warn(s, '겹치는 벽 구간의 앞뒤를 임의로 정하지 않아요. 해당 자재 구간을 확인해 주세요.');
    if (full.length > 1)
      full.forEach((s) => warn(s, '같은 공간 면에 전체 자재가 여러 개여서 자동 선택하지 않아요.'));
    const boundaries = [
      ...new Set([0, 1, ...bands.flatMap((s) => [s.reconstructionBand!.from, s.reconstructionBand!.to])]),
    ].sort((a, b) => a - b);
    for (let i = 0; i < boundaries.length - 1; i++) {
      const from = boundaries[i],
        to = boundaries[i + 1],
        mid = (from + to) / 2;
      const covering = bands.filter(
        (s) => s.reconstructionBand!.from <= mid && s.reconstructionBand!.to >= mid,
      );
      const surface =
        covering.length === 1 && !conflicting.has(covering[0])
          ? covering[0]
          : covering.length
            ? undefined
            : full.length === 1
              ? full[0]
              : undefined;
      patches.push({ face, from, to, surface });
    }
  }
  return { patches, notices };
}

export function viewerFaceIsVisible(room: RoomDefinition, face: RoomFace, cameraPosition: Vector3): boolean {
  // The near outer shell is hidden from outside. Installed objects are not children of it.
  const epsilon = Math.max(room.widthMm, room.heightMm, room.depthMm) * 1e-7;
  if (face === 'floor') return cameraPosition.y >= -epsilon;
  if (face === 'back') return cameraPosition.z >= -epsilon;
  if (face === 'left') return cameraPosition.x >= -room.widthMm / 2 - epsilon;
  return cameraPosition.x <= room.widthMm / 2 + epsilon;
}

export function viewerSurfaceGeometry(room: RoomDefinition, patch: ViewerSurfacePatch): BufferGeometry {
  const uv = [
    [0, patch.from],
    [1, patch.from],
    [1, patch.to],
    [0, patch.to],
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      uv.flatMap(([u, v]) => roomFacePoint(room, patch.face, u, v).toArray()),
      3,
    ),
  );
  geometry.setAttribute('uv', new Float32BufferAttribute(uv.flat(), 2));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

type Atlas = { texture: Texture; columns: number; count: number; pixels: number };
export class ViewerTileCache {
  private readonly atlases = new Map<string, Promise<Atlas>>();
  private disposed = false;
  constructor(
    private readonly reader: (id: string) => Promise<AssetRecord | undefined>,
    private readonly maxSize: number,
  ) {}
  async get(material: MaterialVersion): Promise<Atlas> {
    const ids = material.textureAssetIds.length
      ? material.textureAssetIds
      : [material.coverAssetId || material.imageAssetIds?.[0]].filter((id): id is string => !!id);
    if (!ids.length) throw new Error('시공할 타일 텍스처가 없습니다.');
    const key = JSON.stringify(ids);
    let result = this.atlases.get(key);
    if (!result) {
      result = (async () => {
        const columns = Math.ceil(Math.sqrt(ids.length));
        const cell = Math.floor(Math.min(1024, this.maxSize / columns));
        if (cell < 4) throw new Error('타일 무늬가 너무 많아 그래픽 한도를 넘습니다.');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = cell * columns;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('타일 이미지를 준비할 수 없습니다.');
        for (let i = 0; i < ids.length; i++) {
          if (this.disposed) throw new Error('공간 둘러보기가 닫혔습니다.');
          const asset = await this.reader(ids[i]);
          if (!asset || !isImageAsset(asset))
            throw new Error(`타일 이미지 자산을 찾을 수 없습니다: ${ids[i]}`);
          const bitmap = await createImageBitmap(asset.blob);
          try {
            ctx.drawImage(bitmap, (i % columns) * cell, Math.floor(i / columns) * cell, cell, cell);
          } finally {
            bitmap.close();
          }
        }
        if (this.disposed) throw new Error('공간 둘러보기가 닫혔습니다.');
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = NoColorSpace;
        texture.minFilter = texture.magFilter = LinearFilter;
        texture.generateMipmaps = false;
        return { texture, columns, count: ids.length, pixels: canvas.width };
      })();
      this.atlases.set(key, result);
    }
    try {
      return await result;
    } catch (e) {
      if (this.atlases.get(key) === result) this.atlases.delete(key);
      throw e;
    }
  }
  diagnostics() {
    return { tileAtlases: this.atlases.size, disposed: this.disposed };
  }
  dispose() {
    this.disposed = true;
    for (const p of this.atlases.values())
      void p.then(
        (a) => {
          a.texture.dispose();
          const c = a.texture.image as HTMLCanvasElement;
          c.width = c.height = 1;
        },
        () => {},
      );
    this.atlases.clear();
  }
}

const adjustSource = `
uniform vec4 sjnAdjustment;
vec3 sjnAdjust(vec3 c){
 c*=exp2(sjnAdjustment.x);c=(c-.18)*sjnAdjustment.y+.18;
 c=mix(vec3(dot(c,vec3(.2126,.7152,.0722))),c,sjnAdjustment.z);
 return max(vec3(0.),c*vec3(1.+sjnAdjustment.w*.18,1.,1.-sjnAdjustment.w*.18));
}
`;
const tileSource = `
varying vec2 sjnUv;
uniform sampler2D sjnAtlas;uniform vec2 sjnPlane;uniform vec2 sjnTile;uniform vec2 sjnOffset;
uniform float sjnAngle;uniform float sjnGrout;uniform vec3 sjnGroutColor;uniform float sjnBrick;
uniform float sjnSeed;uniform float sjnCount;uniform float sjnColumns;uniform float sjnPixels;
float sjnGroutAmount=0.;
// Surface slope along the face's u/v millimetre axes: a small rounded tile edge beside the grout.
vec2 sjnSlope=vec2(0.);
vec3 sjnDecode(vec3 c){return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),step(vec3(.04045),c));}
vec3 sjnTileColor(){
 vec2 mm=sjnUv*sjnPlane-sjnOffset;
 float c=cos(sjnAngle),s=sin(sjnAngle); mm=vec2(c*mm.x+s*mm.y,-s*mm.x+c*mm.y);
 vec2 aa=max(fwidth(mm),vec2(.001));vec2 period=max(vec2(.001),sjnTile+sjnGrout);
 float row=floor(mm.y/period.y);mm.x-=sjnBrick*mod(row,2.)*period.x*.5;
 vec2 cell=floor(mm/period),inside=mod(mm,period);
 float h=mod(mod(cell.x,251.)*17.+mod(cell.y,251.)*131.+mod(sjnSeed,251.)*23.,251.);
 float variant=floor(mod(h*73.+19.,251.)/251.*sjnCount);
 vec2 atlasCell=vec2(mod(variant,sjnColumns),floor(variant/sjnColumns));
 float inset=.5/(sjnPixels/sjnColumns);
 vec2 atlasUv=(atlasCell+clamp(inside/sjnTile,vec2(inset),vec2(1.-inset)))/sjnColumns;
 atlasUv.y=1.-atlasUv.y;
 vec3 color=sjnDecode(texture2D(sjnAtlas,atlasUv).rgb);
 vec2 seam=mod(inside-(sjnTile+sjnGrout*.5)+period*.5,period)-period*.5;
 vec2 d=abs(seam);
 vec2 coverage=clamp((sjnGrout*.5-d+aa*.5)/aa,0.,1.)-clamp((-sjnGrout*.5-d+aa*.5)/aa,0.,1.);
 coverage=mix(coverage,vec2(sjnGrout)/period,step(period,aa));
 float grout=sjnGrout<=0.?0.:1.-(1.-coverage.x)*(1.-coverage.y);
 sjnGroutAmount=grout;
 if(sjnGrout>0.){
  // Rise over a bevel of a few millimetres from the recessed joint (smoothstep derivative),
  // faded out once the bevel is smaller than a pixel so distant tiles do not shimmer.
  float bevel=clamp(min(sjnTile.x,sjnTile.y)*.012,.6,2.5);
  vec2 t=clamp((d-sjnGrout*.5)/bevel,0.,1.);
  vec2 fade=clamp(1.-(aa-bevel*.5)/(bevel*1.5),0.,1.);
  vec2 slope=2.1*t*(1.-t)*sign(seam)*fade;
  sjnSlope=vec2(c*slope.x-s*slope.y,s*slope.x+c*slope.y);
 }
 // The recessed joint receives less bounce light than the tile face.
 return mix(color,sjnGroutColor*.88,grout);
}
`;
// Height-gradient normal perturbation with a screen-derivative tangent frame (as three's
// perturbNormal2Arb), so it needs no tangent attribute and works on every generated face.
const reliefNormal = `
if(dot(sjnSlope,sjnSlope)>0.){
 vec3 q0=dFdx(-vViewPosition),q1=dFdy(-vViewPosition);
 vec2 st0=dFdx(sjnUv*sjnPlane),st1=dFdy(sjnUv*sjnPlane);
 vec3 q1perp=cross(q1,normal),q0perp=cross(normal,q0);
 vec3 T=q1perp*st0.x+q0perp*st1.x,B=q1perp*st0.y+q0perp*st1.y;
 float det=max(dot(T,T),dot(B,B));
 if(det>0.)normal=normalize(normal-(sjnSlope.x*T+sjnSlope.y*B)*inversesqrt(det));
}
`;
const adjustment = (value: ColorAdjust) => {
  const c = [value.exposure, value.contrast, value.saturation, value.warmth].every(Number.isFinite)
    ? value
    : DEFAULT_COLOR;
  return new Vector4(c.exposure, c.contrast, c.saturation, c.warmth);
};
const MAX_CONTACTS = 8;
type ContactUniforms = {
  sjnContacts: { value: Vector4[] };
  sjnContactHeights: { value: number[] };
  sjnContactCount: { value: number };
};
// Floor bounce light is reduced around installed objects' footprints (x/z millimetres), so a bath
// or toilet sits on the floor instead of floating. Direct light still comes from the shadow map.
const contactSource = `
uniform vec4 sjnContacts[${MAX_CONTACTS}];uniform float sjnContactHeights[${MAX_CONTACTS}];uniform int sjnContactCount;
float sjnContactOcclusion(){
 if(sjnFaceAxis.y<.5)return 1.;
 float o=1.;
 for(int i=0;i<${MAX_CONTACTS};i++){
  if(i>=sjnContactCount)break;
  vec4 b=sjnContacts[i];
  vec2 d=max(max(b.xy-sjnWorld.xz,sjnWorld.xz-b.zw),0.);
  o*=1.-.5*clamp(sjnContactHeights[i]/400.,.25,1.)*exp(-length(d)/150.);
 }
 return o;
}
`;
function surfaceMaterial(
  room: RoomDefinition,
  patch: ViewerSurfacePatch,
  contacts: ContactUniforms,
  product?: MaterialVersion,
  atlas?: Atlas,
): MeshStandardMaterial {
  const surface = patch.surface;
  const appearance = product && atlas ? finishAppearance(product.finish) : MATTE_FINISH;
  const material = new MeshStandardMaterial({
    color: product && atlas ? '#ffffff' : VIEWER_FACE_COLORS[patch.face],
    roughness: appearance.roughness,
    metalness: appearance.metalness,
    side: DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.sjnAdjustment = { value: adjustment(surface?.color ?? DEFAULT_COLOR) };
    shader.uniforms.sjnRoom = { value: new Vector3(room.widthMm, room.heightMm, room.depthMm) };
    shader.uniforms.sjnFaceAxis = {
      value: new Vector3(
        patch.face === 'left' || patch.face === 'right' ? 1 : 0,
        patch.face === 'floor' ? 1 : 0,
        patch.face === 'back' ? 1 : 0,
      ),
    };
    // Shared objects: setContacts() updates every floor material without recompiling.
    Object.assign(shader.uniforms, contacts);
    shader.vertexShader = 'varying vec3 sjnWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nsjnWorld=(modelMatrix*vec4(transformed,1.)).xyz;',
    );
    shader.fragmentShader =
      adjustSource + TONE_MAPPING_GLSL + CORNER_OCCLUSION_GLSL + contactSource + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <opaque_fragment>',
        'outgoingLight=sjnToneMap(sjnAdjust(outgoingLight));\n#include <opaque_fragment>',
      )
      // Corners and the wall/floor joint receive less bounce light; direct light keeps its shadow map.
      .replace(
        '#include <aomap_fragment>',
        '#include <aomap_fragment>\n{float sjnAo=sjnCornerOcclusion()*sjnContactOcclusion();reflectedLight.indirectDiffuse*=sjnAo;reflectedLight.indirectSpecular*=mix(1.,sjnAo,.5);}',
      )
      // Keep glazed tiles readable: reflections of the light and room are softened so a dark
      // glossy tile is not washed out into a grey mirror of its surroundings.
      .replace(
        '#include <lights_fragment_end>',
        '#include <lights_fragment_end>\nreflectedLight.directSpecular*=.6;reflectedLight.indirectSpecular*=.6;',
      );
    if (!product || !atlas || !surface) return;
    const tile = surface.tile;
    Object.assign(shader.uniforms, {
      sjnAtlas: { value: atlas.texture },
      sjnPlane: {
        value: new Vector2(
          patch.face === 'left' || patch.face === 'right' ? room.depthMm : room.widthMm,
          patch.face === 'floor' ? room.depthMm : room.heightMm,
        ),
      },
      sjnTile: { value: new Vector2(product.widthMm, product.heightMm) },
      sjnOffset: { value: new Vector2(tile.offsetX, tile.offsetY) },
      sjnAngle: { value: (tile.rotation * Math.PI) / 180 },
      sjnGrout: { value: Math.max(0, tile.groutWidth) },
      sjnGroutColor: { value: new Color(tile.groutColor) },
      sjnBrick: { value: tile.pattern === 'brick' ? 1 : 0 },
      sjnSeed: { value: tile.seed },
      sjnCount: { value: atlas.count },
      sjnColumns: { value: atlas.columns },
      sjnPixels: { value: atlas.pixels },
    });
    shader.vertexShader = 'varying vec2 sjnUv;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\nsjnUv=uv;',
    );
    shader.fragmentShader = tileSource + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', 'diffuseColor.rgb*=sjnTileColor();')
      // Cement grout stays rough and non-metallic whatever the tile's glaze.
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,.9,sjnGroutAmount);',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\nmetalnessFactor*=1.-sjnGroutAmount;',
      )
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + reliefNormal);
  };
  material.customProgramCacheKey = () => (atlas ? 'sjn-room-world-tile-v2' : 'sjn-room-world-neutral-v2');
  return material;
}

export async function buildViewerSurfaces(
  scene: Scene,
  materials: Record<string, MaterialVersion>,
  cache: ViewerTileCache,
) {
  const room = scene.room!;
  const { patches, notices } = viewerSurfacePatches(scene),
    group = new Group();
  const features = scene.wallFeatures?.length
    ? buildWallFeaturePieces(room, patches, scene.wallFeatures)
    : undefined;
  const meshes: {
    face: RoomFace;
    mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
    piece?: WallFeaturePiece;
  }[] = [];
  const ownedGeometry = new Set<BufferGeometry>();
  const ownedMaterials = new Set<MeshStandardMaterial>();
  const contacts: ContactUniforms = {
    sjnContacts: { value: Array.from({ length: MAX_CONTACTS }, () => new Vector4()) },
    sjnContactHeights: { value: new Array<number>(MAX_CONTACTS).fill(0) },
    sjnContactCount: { value: 0 },
  };
  const voidBounds = new Map<string, Box3>();
  for (const piece of features?.pieces ?? []) {
    if (!piece.featureId) continue;
    const bounds = voidBounds.get(piece.featureId) ?? new Box3();
    bounds.union(piece.worldBounds);
    voidBounds.set(piece.featureId, bounds);
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const geometry of ownedGeometry) geometry.dispose();
    features?.dispose();
    for (const material of ownedMaterials) material.dispose();
    group.clear();
  };
  try {
    for (const patch of patches) {
      let product = patch.surface?.materialVersionId ? materials[patch.surface.materialVersionId] : undefined;
      let atlas: Atlas | undefined;
      if (patch.surface?.materialVersionId) {
        try {
          if (!product) throw new Error('적용한 자재 버전을 찾을 수 없습니다.');
          const tile = patch.surface.tile;
          if (
            ![product.widthMm, product.heightMm].every((n) => Number.isFinite(n) && n > 0) ||
            ![tile.offsetX, tile.offsetY, tile.rotation, tile.groutWidth, tile.seed].every(Number.isFinite)
          )
            throw new Error('타일 규격·배열 값이 올바르지 않습니다.');
          atlas = await cache.get(product);
        } catch (e) {
          notices.push({
            id: patch.surface.id,
            name: patch.surface.name,
            message: e instanceof Error ? e.message : '타일을 준비하지 못했습니다.',
            severity: 'error',
          });
          product = undefined;
        }
      }
      const material = surfaceMaterial(room, patch, contacts, product, atlas);
      ownedMaterials.add(material);
      const add = (geometry: BufferGeometry, piece?: WallFeaturePiece) => {
        const mesh = new Mesh(geometry, material);
        mesh.name = piece
          ? 'wall-feature:' + (piece.featureId ?? patch.face) + ':' + piece.role
          : 'room-face:' +
            patch.face +
            ':' +
            (patch.surface?.id ?? 'neutral') +
            ':' +
            patch.from +
            ':' +
            patch.to;
        if (patch.surface) mesh.userData.surfaceId = patch.surface.id;
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        group.add(mesh);
        meshes.push({ face: piece?.ownerFace ?? patch.face, mesh, piece });
      };
      if (!features?.affectedFaces.has(patch.face)) {
        const geometry = viewerSurfaceGeometry(room, patch);
        ownedGeometry.add(geometry);
        add(geometry);
      }
      for (const piece of features?.pieces ?? []) if (piece.parentPatch === patch) add(piece.geometry, piece);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  if (scene.surfaces.some((s) => s.materialVersionId && s.tile.shading > 0))
    notices.push({
      id: 'photo-shading',
      name: '공간 조명',
      message: '사진에서 추출한 명암 대신 방 좌표에 고정된 조명을 사용해요.',
      severity: 'limitation',
    });
  return {
    group,
    notices,
    structureBounds: features?.structureBounds.clone() ?? new Box3(),
    /** World-space boxes of objects standing on the floor; the largest footprints are kept. */
    setContacts(boxes: readonly Box3[]) {
      const kept = [...boxes]
        .sort((a, b) => (b.max.x - b.min.x) * (b.max.z - b.min.z) - (a.max.x - a.min.x) * (a.max.z - a.min.z))
        .slice(0, MAX_CONTACTS);
      kept.forEach((box, i) => {
        contacts.sjnContacts.value[i].set(box.min.x, box.min.z, box.max.x, box.max.z);
        contacts.sjnContactHeights.value[i] = box.max.y - box.min.y;
      });
      contacts.sjnContactCount.value = kept.length;
    },
    updateView(camera: Camera) {
      const position = camera.getWorldPosition(new Vector3());
      for (const entry of meshes) {
        const piece = entry.piece;
        if (!piece || piece.role === 'base-wall')
          entry.mesh.visible = viewerFaceIsVisible(room, entry.face, position);
        else if (piece.role === 'floor-extension')
          entry.mesh.visible = viewerFaceIsVisible(room, 'floor', position);
        else
          entry.mesh.visible =
            viewerFaceIsVisible(room, entry.face, position) ||
            !!(piece.featureId && voidBounds.get(piece.featureId)?.containsPoint(position));
      }
    },
    dispose,
  };
}
