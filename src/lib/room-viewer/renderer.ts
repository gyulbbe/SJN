import {
  Box3,
  Color,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  NoBlending,
  NoToneMapping,
  OrthographicCamera,
  PCFShadowMap,
  Plane,
  Raycaster,
  PlaneGeometry,
  Scene as ThreeScene,
  ShaderMaterial,
  SRGBColorSpace,
  type SpotLight,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import {
  DEFAULT_COLOR,
  type AssetRecord,
  type ColorAdjust,
  type MaterialVersion,
  type RenderSnapshot,
  type Scene,
} from '../types';
import { validateRoomDimensions } from '../room-geometry';
import type { RoomFace } from '../room-types';
import { fitOutput } from '../render/math';
import {
  createInteriorEnvironment,
  createRoomLightRig,
  type InteriorEnvironment,
} from '../render/realistic-lighting';
import { buildViewerFixtures, ProductAssetCache } from './fixtures';
import { buildViewerCeiling, type ViewerCeiling } from './ceiling';
import { EXPORT_LIGHT_PANEL_MM, ExportAccumulator, exportJitter, jitterProjection } from './accumulate';
import { PhotoBloom, photoEffectUniforms, photoPostFragment, type PhotoEffects } from './photo-effects';
import { ViewerLightingLut } from './lighting';
import { ROOM_VIEWER_RENDERER_REVISION } from './render-version';
import { fitSourceDepthClip, visibleMeshBounds, type SourceDepthClip } from './depth-clip';
import { buildViewerSurfaces, ViewerTileCache, type SurfaceNotice } from './surfaces';
import { createRoomViewCamera, normalizeRoomView, roomViewViewport, type RoomViewState } from './view-state';

export type RoomViewerMode = 'before' | 'after' | 'split' | 'compare';
export type RoomViewerNotice = SurfaceNotice & { side: 'before' | 'after' };
type Reader = (id: string) => Promise<AssetRecord | undefined>;
type Prepared = {
  world: ThreeScene;
  source: Scene;
  fixtures: Awaited<ReturnType<typeof buildViewerFixtures>>;
  surfaces: Awaited<ReturnType<typeof buildViewerSurfaces>>;
  ceiling: ViewerCeiling;
  /** The ceiling downlight (moved inside its panel by multi-sample exports). */
  light?: SpotLight;
  bounds: Box3;
  structureBounds: Box3;
  notices: SurfaceNotice[];
  dispose(): void;
};
const POLICY = 'room-quarter-turn-world-v1';
/** Export-only shadow camera for the 90° ceiling cone: fov = 2·angle·focus = 144° instead of 180°. */
const EXPORT_SHADOW_FOCUS = 0.8;
const EXPORT_SHADOW_MAP = 2048;
/**
 * Multi-sample export settings; absent means the single-frame export used by previews. With
 * `budgetMs`, a slow device times its first (unjittered) sample and lowers the count so the export
 * ends near the budget; below 16 samples the light moves only within 100 mm (one shadow, no copies).
 */
export type RoomExportQuality = { samples: number; budgetMs?: number };
/**
 * Photo downloads: 32 samples look like 64 (soft shadow without banding) at half the cost — about
 * 2.7 s for 3600×2400 on Iris Xe (D3D11). The budget keeps slower devices near the 10 s target.
 */
export const ROOM_PHOTO_EXPORT_QUALITY: RoomExportQuality = { samples: 32, budgetMs: 10_000 };
/** Fewer light positions than this across the whole panel leave visible copies of each shadow. */
const SOFT_SHADOW_SAMPLES = 16;
/**
 * Light travel below that count: too short to split a shadow into copies, long enough that the
 * screen-space PCF dither (which the camera shift cannot average) differs between samples.
 */
const NARROW_LIGHT_MM = 100;
/**
 * Resolves after the next paint: a zero timeout alone lets back-to-back samples starve rendering.
 * Hidden tabs do not paint, so a short timer wins the race there.
 */
function nextPaint() {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, 100);
    if (typeof requestAnimationFrame === 'function')
      requestAnimationFrame(() => {
        clearTimeout(timer);
        setTimeout(finish, 0);
      });
  });
}
const postVertex = `varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;
const postFragment = `
varying vec2 vUv;
uniform sampler2D sjnBefore; uniform sampler2D sjnAfter;
uniform vec4 sjnBeforeColor;uniform vec4 sjnAfterColor;uniform float sjnMode;uniform float sjnSplit;uniform vec4 sjnPhotoRect;
vec3 adjustColor(vec3 c,vec4 a){
 c*=exp2(a.x);c=(c-.18)*a.y+.18;c=mix(vec3(dot(c,vec3(.2126,.7152,.0722))),c,a.z);
 return max(vec3(0.),c*vec3(1.+a.w*.18,1.,1.-a.w*.18));
}
vec3 encodeSRGB(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0.)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
void main(){
 bool isBefore=sjnMode<.5||(sjnMode>1.5&&sjnMode<2.5&&vUv.x<sjnSplit)||(sjnMode>2.5&&vUv.x<.5);
 vec2 uv=vUv;if(sjnMode>2.5)uv.x=isBefore?uv.x*2.:(uv.x-.5)*2.;
 if(uv.x<sjnPhotoRect.x||uv.y<sjnPhotoRect.y||uv.x>sjnPhotoRect.x+sjnPhotoRect.z||uv.y>sjnPhotoRect.y+sjnPhotoRect.w){gl_FragColor=vec4(.909804,.909804,.894118,1.);return;}
 vec3 c=isBefore?adjustColor(texture2D(sjnBefore,uv).rgb,sjnBeforeColor):adjustColor(texture2D(sjnAfter,uv).rgb,sjnAfterColor);
 gl_FragColor=vec4(encodeSRGB(c),1.);
}
`;
const colorVector = (input: ColorAdjust) => {
  const c = [input.exposure, input.contrast, input.saturation, input.warmth].every(Number.isFinite)
    ? input
    : DEFAULT_COLOR;
  return new Vector4(c.exposure, c.contrast, c.saturation, c.warmth);
};
/** Cost, name and application revision fields do not enter geometry/texture preparation. */
export function roomViewerSceneKey(scene: Scene, materials: Record<string, MaterialVersion>): string {
  const ids = [
    ...new Set(
      [
        ...scene.surfaces.map((s) => s.materialVersionId),
        ...scene.fixtures.map((f) => f.materialVersionId),
      ].filter((id): id is string => !!id),
    ),
  ].sort();
  const visualMaterials = ids.map((id) => {
    const m = materials[id];
    return m
      ? [
          id,
          m.category,
          m.widthMm,
          m.heightMm,
          m.depthMm,
          m.installation,
          m.color,
          m.textureAssetIds,
          m.views,
          m.coverAssetId,
          m.imageAssetIds,
          m.reconstruction,
        ]
      : [id];
  });
  return JSON.stringify([POLICY, scene, visualMaterials]);
}

export class RoomViewerRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly maxOutputEdge: number;
  private readonly renderer: WebGLRenderer;
  private readonly beforeTarget: WebGLRenderTarget;
  private readonly afterTarget: WebGLRenderTarget;
  private readonly post = new ThreeScene();
  private readonly postCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly postMaterial: ShaderMaterial;
  private readonly postGeometry = new PlaneGeometry(2, 2);
  private readonly postMesh: Mesh;
  /** Post program with the photo look, compiled on the first download that asks for it. */
  private photoMaterial?: ShaderMaterial;
  private readonly tiles: ViewerTileCache;
  private readonly products: ProductAssetCache;
  private readonly lighting = new ViewerLightingLut();
  private readonly environment?: InteriorEnvironment;
  private readonly scenes = new Map<string, Promise<Prepared>>();
  private reader: Reader = async () => undefined;
  private snapshot?: RenderSnapshot;
  private prepared?: { before: Prepared; after: Prepared; bounds: Box3; structureBounds: Box3 };
  private _notices: RoomViewerNotice[] = [];
  private request = 0;
  private disposed = false;
  private lost = false;
  private renders = 0;
  private sourceDepthClip?: SourceDepthClip;
  private preparations = 0;
  private accumulating = false;
  private deferredFrame?: {
    width: number;
    height: number;
    view: RoomViewState;
    mode: RoomViewerMode;
    split: number;
  };
  private lastExport?: {
    samples: number;
    ms: number;
    width: number;
    height: number;
    /** Photo look (bloom, vignette, grain, tone curve) applied. */
    effects: boolean;
    /** False when the budget left too few samples to move the light across the whole panel. */
    softShadows?: boolean;
    fallbackReason?: string;
  };
  private lastFrame?: {
    width: number;
    height: number;
    view: RoomViewState;
    mode: RoomViewerMode;
    split: number;
  };
  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
  };

  constructor() {
    try {
      this.renderer = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    } catch {
      throw new Error(
        '이 브라우저에서 WebGL 공간 둘러보기를 시작할 수 없습니다. 기존 정면 편집은 계속 사용할 수 있어요.',
      );
    }
    this.canvas = this.renderer.domElement;
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    const gl = this.renderer.getContext(),
      viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    this.maxOutputEdge = Math.min(
      4096,
      this.renderer.capabilities.maxTextureSize,
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      viewport[0],
      viewport[1],
    );
    const targetOptions = {
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      samples: Math.min(4, this.renderer.capabilities.maxSamples),
      type: this.renderer.extensions.has('EXT_color_buffer_float') ? HalfFloatType : UnsignedByteType,
    };
    this.beforeTarget = new WebGLRenderTarget(1, 1, targetOptions);
    this.afterTarget = new WebGLRenderTarget(1, 1, targetOptions);
    this.beforeTarget.texture.colorSpace = this.afterTarget.texture.colorSpace = LinearSRGBColorSpace;
    this.postMaterial = new ShaderMaterial({
      vertexShader: postVertex,
      fragmentShader: postFragment,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      toneMapped: false,
      uniforms: {
        sjnBefore: { value: this.beforeTarget.texture },
        sjnAfter: { value: this.afterTarget.texture },
        sjnBeforeColor: { value: colorVector(DEFAULT_COLOR) },
        sjnAfterColor: { value: colorVector(DEFAULT_COLOR) },
        sjnMode: { value: 1 },
        sjnSplit: { value: 0.5 },
        sjnPhotoRect: { value: new Vector4(0, 0, 1, 1) },
      },
    });
    this.postMesh = new Mesh(this.postGeometry, this.postMaterial);
    this.post.add(this.postMesh);
    // Shared by every prepared scene of this context; Before and After see identical light.
    this.environment = createInteriorEnvironment(this.renderer);
    this.tiles = new ViewerTileCache((id) => this.reader(id), this.maxOutputEdge);
    this.products = new ProductAssetCache((id) => this.reader(id));
  }
  get notices(): readonly RoomViewerNotice[] {
    return this._notices;
  }
  private assertOpen() {
    if (this.disposed) throw new Error('공간 둘러보기가 닫혔습니다.');
    if (this.lost || this.renderer.getContext().isContextLost())
      throw new Error('그래픽 연결이 끊겼습니다. 창을 닫고 공간 둘러보기를 다시 열어 주세요.');
  }
  private async prepare(scene: Scene, materials: Record<string, MaterialVersion>): Promise<Prepared> {
    const [surfacesResult, fixturesResult] = await Promise.allSettled([
      buildViewerSurfaces(scene, materials, this.tiles),
      buildViewerFixtures(scene, materials, this.reader, this.products),
    ]);
    if (surfacesResult.status === 'rejected' || fixturesResult.status === 'rejected') {
      if (surfacesResult.status === 'fulfilled') surfacesResult.value.dispose();
      if (fixturesResult.status === 'fulfilled') fixturesResult.value.dispose();
      throw surfacesResult.status === 'rejected'
        ? surfacesResult.reason
        : (fixturesResult as PromiseRejectedResult).reason;
    }
    const surfaces = surfacesResult.value,
      fixtures = fixturesResult.value,
      room = scene.room!;
    const world = new ThreeScene();
    world.background = new Color('#e8e8e4');
    world.environment = this.environment?.texture ?? null;
    world.environmentIntensity = this.environment?.intensity ?? 1;
    const lights = createRoomLightRig(room, { environment: !!this.environment });
    // Closes the room for in-room eye views only; hidden for orbit and photo cameras.
    const ceiling = buildViewerCeiling(room);
    world.add(surfaces.group, fixtures.group, ceiling.group, ...lights);
    // Objects standing on the floor get a soft contact shade (Before and After alike).
    const contacts: Box3[] = [];
    for (const object of fixtures.group.children) {
      const box = new Box3().setFromObject(object);
      if (
        !box.isEmpty() &&
        [...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite) &&
        box.min.y < 40
      )
        contacts.push(box);
    }
    surfaces.setContacts(contacts);
    this.lighting.bindTree(world);
    world.updateMatrixWorld(true);
    const roomBounds = new Box3(
      new Vector3(-room.widthMm / 2, 0, 0),
      new Vector3(room.widthMm / 2, room.heightMm, room.depthMm),
    );
    const bounds = roomBounds.clone(),
      fixtureBounds = new Box3().setFromObject(fixtures.group);
    const notices = [...surfaces.notices, ...fixtures.notices];
    if (!fixtureBounds.isEmpty()) {
      const maxBounds = roomBounds
        .clone()
        .expandByScalar(Math.max(room.widthMm, room.heightMm, room.depthMm) * 0.25);
      if (
        fixtureBounds.min.toArray().concat(fixtureBounds.max.toArray()).every(Number.isFinite) &&
        maxBounds.containsBox(fixtureBounds)
      )
        bounds.union(fixtureBounds);
      else
        notices.push({
          id: 'fit-bounds',
          name: '화면 맞춤',
          message:
            '방에서 지나치게 벗어난 설비는 화면 맞춤 범위에 포함하지 않아요. 위치·크기를 확인해 주세요.',
          severity: 'limitation',
        });
    }
    if (scene.backgroundAssetId)
      notices.push({
        id: 'restored-background',
        name: '편집 배경',
        message:
          '사진에 복원한 배경은 공간 깊이가 없어 이 보기에서 재현하지 않아요. 기존 정면 편집에서 확인할 수 있어요.',
        severity: 'limitation',
      });
    if (
      scene.protection.polygon.length ||
      scene.protection.polygons?.length ||
      scene.protection.holes?.length ||
      scene.protection.strokes.length
    )
      notices.push({
        id: 'protection',
        name: '사진 보호 영역',
        message: '사진 좌표의 보호 영역 대신 실제 공간 모형의 깊이로 가림을 처리해요.',
        severity: 'limitation',
      });
    this.preparations++;
    return {
      world,
      source: scene,
      surfaces,
      fixtures,
      ceiling,
      light: lights.find((light): light is SpotLight => (light as SpotLight).isSpotLight),
      bounds,
      structureBounds: surfaces.structureBounds,
      notices,
      dispose() {
        surfaces.dispose();
        fixtures.dispose();
        ceiling.dispose();
        for (const light of lights) (light as { shadow?: { dispose(): void } }).shadow?.dispose();
        world.clear();
      },
    };
  }
  async setSnapshot(
    input: RenderSnapshot,
    reader: Reader,
    options?: { fitScenes?: readonly Scene[] },
  ): Promise<void> {
    this.assertOpen();
    const id = ++this.request,
      snapshot = structuredClone(input);
    if (!snapshot.scene.room || !validateRoomDimensions(snapshot.scene.room))
      throw new Error(
        '공간 치수가 있는 기본·재구성 공간에서 둘러보기를 사용할 수 있어요. 사진 좌표만 있는 작업은 기존 정면 보기에서 확인해 주세요.',
      );
    if (!snapshot.beforeScene?.room || !validateRoomDimensions(snapshot.beforeScene.room))
      throw new Error(
        'Before의 공통 공간 정보가 없어 같은 시점으로 비교할 수 없습니다. 기존 정면 비교를 사용해 주세요.',
      );
    const room = snapshot.scene.room,
      beforeRoom = snapshot.beforeScene.room;
    if (
      room.widthMm !== beforeRoom.widthMm ||
      room.heightMm !== beforeRoom.heightMm ||
      room.depthMm !== beforeRoom.depthMm
    )
      throw new Error('Before와 After의 공간 크기가 달라 같은 시점으로 비교할 수 없습니다.');
    this.reader = reader;
    const beforeKey = roomViewerSceneKey(snapshot.beforeScene, snapshot.materials),
      afterKey = roomViewerSceneKey(snapshot.scene, snapshot.materials);
    const get = (key: string, scene: Scene) => {
      let promise = this.scenes.get(key);
      if (!promise) {
        promise = this.prepare(scene, snapshot.materials);
        this.scenes.set(key, promise);
        const pending = promise;
        void pending.catch(() => {
          if (this.scenes.get(key) === pending) this.scenes.delete(key);
        });
      }
      return promise;
    };
    let before: Prepared, after: Prepared;
    try {
      [before, after] = await Promise.all([
        get(beforeKey, snapshot.beforeScene),
        get(afterKey, snapshot.scene),
      ]);
    } catch (error) {
      for (const key of [beforeKey, afterKey]) {
        const pending = this.scenes.get(key);
        if (pending)
          void pending.then(
            () => {},
            () => {
              if (this.scenes.get(key) === pending) this.scenes.delete(key);
            },
          );
      }
      throw error;
    }
    if (this.disposed || id !== this.request) return;
    this.assertOpen();
    const bounds = before.bounds.clone().union(after.bounds);
    const structureBounds = before.structureBounds.clone().union(after.structureBounds);
    // Every design card uses one project-wide fit. Reuse the bounded scene/asset caches,
    // and discard extra geometry normally after its bounds have been accumulated.
    for (const inputScene of options?.fitScenes ?? []) {
      const scene = structuredClone(inputScene);
      if (
        !scene.room ||
        scene.room.widthMm !== room.widthMm ||
        scene.room.heightMm !== room.heightMm ||
        scene.room.depthMm !== room.depthMm
      )
        throw new Error('비교할 공간들의 크기가 달라 공통 시점을 만들 수 없습니다.');
      const fitted = await get(roomViewerSceneKey(scene, snapshot.materials), scene);
      bounds.union(fitted.bounds);
      structureBounds.union(fitted.structureBounds);
      if (this.disposed || id !== this.request) return;
    }
    this.assertOpen();
    this.snapshot = snapshot;
    this.prepared = { before, after, bounds, structureBounds };
    this._notices = [
      ...before.notices.map((n) => ({ ...n, side: 'before' as const })),
      ...after.notices.map((n) => ({ ...n, side: 'after' as const })),
    ];
    // Retain the common Before and a small recent design cache, not an unbounded project history.
    for (const [key, pending] of this.scenes) {
      if (this.scenes.size <= 6) break;
      if (key === beforeKey || key === afterKey) continue;
      this.scenes.delete(key);
      void pending.then(
        (p) => p.dispose(),
        () => {},
      );
    }
  }
  /** Camera, sizes and photo rectangle for one frame; resizes the targets and the canvas. */
  private frame(width: number, height: number, view: RoomViewState, mode: RoomViewerMode) {
    const size = fitOutput(width, height, this.maxOutputEdge);
    const state = normalizeRoomView(view);
    const panelWidth = mode === 'compare' ? size.width / 2 : size.width;
    const camera = createRoomViewCamera(
      this.snapshot!.scene.room!,
      panelWidth / size.height,
      state,
      this.prepared!.bounds,
      this.prepared!.structureBounds,
    );
    this.sourceDepthClip = undefined;
    if (state.sourceCamera && state.projection === 'source-photo') {
      // Decide visible cutaway walls/directional meshes before deriving one shared depth interval.
      for (const side of [this.prepared!.before, this.prepared!.after]) {
        side.surfaces.updateView(camera);
        side.fixtures.updateView(camera);
      }
      this.sourceDepthClip = fitSourceDepthClip(
        camera,
        visibleMeshBounds([this.prepared!.before.world, this.prepared!.after.world]),
      );
    }
    const targetWidth = mode === 'compare' ? Math.max(1, Math.ceil(size.width / 2)) : size.width;
    this.beforeTarget.setSize(targetWidth, size.height);
    this.afterTarget.setSize(targetWidth, size.height);
    this.renderer.setSize(size.width, size.height, false);
    const rect = roomViewViewport(targetWidth, size.height, state);
    return { size, state, camera, targetWidth, rect };
  }
  private paint(
    prepared: Prepared,
    target: WebGLRenderTarget,
    frame: ReturnType<RoomViewerRenderer['frame']>,
  ) {
    const { camera, rect, targetWidth, size, state } = frame;
    prepared.surfaces.updateView(camera);
    prepared.fixtures.updateView(camera);
    prepared.ceiling.setVisible(state.projection === 'room-eye');
    this.renderer.setRenderTarget(target);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, targetWidth, size.height);
    this.renderer.clear();
    // Shadow rendering restores the render target's viewport/scissor, not the renderer-only state.
    // Persist the photo rectangle on the target too, or portrait optics stretch to the full canvas.
    target.viewport.set(rect.x, rect.y, rect.width, rect.height).round();
    target.scissor.set(rect.x, rect.y, rect.width, rect.height).round();
    target.scissorTest = true;
    this.renderer.setViewport(rect.x, rect.y, rect.width, rect.height);
    this.renderer.setScissor(rect.x, rect.y, rect.width, rect.height);
    this.renderer.setScissorTest(true);
    this.renderer.render(prepared.world, camera);
    this.renderer.setScissorTest(false);
  }
  /** Colour adjustment, split/compare layout and sRGB output of the two side textures. */
  private composite(
    frame: ReturnType<RoomViewerRenderer['frame']>,
    mode: RoomViewerMode,
    split: number,
    before: Texture,
    after: Texture,
    effects?: PhotoEffects,
  ) {
    const { rect, targetWidth, size } = frame;
    const uniforms = this.postMaterial.uniforms;
    uniforms.sjnBefore.value = before;
    uniforms.sjnAfter.value = after;
    uniforms.sjnPhotoRect.value.set(
      rect.x / targetWidth,
      rect.y / size.height,
      rect.width / targetWidth,
      rect.height / size.height,
    );
    uniforms.sjnBeforeColor.value = colorVector(this.prepared!.before.source.color);
    uniforms.sjnAfterColor.value = colorVector(this.prepared!.after.source.color);
    uniforms.sjnMode.value = mode === 'before' ? 0 : mode === 'after' ? 1 : mode === 'split' ? 2 : 3;
    uniforms.sjnSplit.value = Number.isFinite(split) ? Math.max(0, Math.min(1, split)) : 0.5;
    let bloom: PhotoBloom | undefined;
    if (effects) {
      // Same uniform objects as the plain post, plus the glow and effect strengths.
      this.photoMaterial ??= new ShaderMaterial({
        vertexShader: postVertex,
        fragmentShader: photoPostFragment(postFragment),
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
        toneMapped: false,
        uniforms: {
          ...uniforms,
          sjnBloomBefore: { value: null },
          sjnBloomAfter: { value: null },
          sjnEffects: { value: new Vector4() },
          sjnGrainSeed: { value: 0 },
        },
      });
      const photo = this.photoMaterial.uniforms,
        values = photoEffectUniforms(effects);
      bloom = new PhotoBloom(targetWidth, size.height);
      photo.sjnBloomBefore.value = mode === 'after' ? null : bloom.run(this.renderer, 0, before);
      photo.sjnBloomAfter.value = mode === 'before' ? null : bloom.run(this.renderer, 1, after);
      photo.sjnEffects.value.set(...values.effects);
      photo.sjnGrainSeed.value = values.grainSeed;
      this.postMesh.material = this.photoMaterial;
    }
    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, size.width, size.height);
    this.renderer.setScissorTest(false);
    this.renderer.render(this.post, this.postCamera);
    if (bloom) {
      this.postMesh.material = this.postMaterial;
      this.photoMaterial!.uniforms.sjnBloomBefore.value = null;
      this.photoMaterial!.uniforms.sjnBloomAfter.value = null;
      bloom.dispose();
    }
    // The live targets are the default inputs again.
    uniforms.sjnBefore.value = this.beforeTarget.texture;
    uniforms.sjnAfter.value = this.afterTarget.texture;
  }
  render(
    width: number,
    height: number,
    view: RoomViewState,
    mode: RoomViewerMode = 'after',
    split = 0.5,
  ): HTMLCanvasElement {
    this.assertOpen();
    if (!this.prepared || !this.snapshot) throw new Error('공간을 준비하는 중입니다.');
    if (this.accumulating) {
      // An export owns the targets between its samples; draw the latest request when it ends.
      this.deferredFrame = { width, height, view: structuredClone(view), mode, split };
      return this.canvas;
    }
    return this.drawFrame(width, height, view, mode, split);
  }
  private drawFrame(
    width: number,
    height: number,
    view: RoomViewState,
    mode: RoomViewerMode,
    split: number,
    effects?: PhotoEffects,
  ): HTMLCanvasElement {
    const prepared = this.prepared!;
    const frame = this.frame(width, height, view, mode);
    if (mode !== 'after') this.paint(prepared.before, this.beforeTarget, frame);
    if (mode !== 'before') this.paint(prepared.after, this.afterTarget, frame);
    this.composite(frame, mode, split, this.beforeTarget.texture, this.afterTarget.texture, effects);
    this.assertOpen();
    this.lastFrame = {
      width: frame.size.width,
      height: frame.size.height,
      view: structuredClone(frame.state),
      mode,
      split,
    };
    this.renders++;
    return this.canvas;
  }
  /**
   * Export-only multi-sample frame: each sample shifts the camera by a sub-pixel and moves the
   * ceiling light inside its 600×600 panel (shadow maps re-render every sample), then all samples
   * are averaged. Only during this call the spot light's shadow camera is narrowed to a usable
   * field of view and a larger map; both are restored afterwards so live frames stay identical.
   * `capture` runs while the averaged frame is on the canvas.
   */
  private async renderAccumulated(
    width: number,
    height: number,
    view: RoomViewState,
    mode: RoomViewerMode,
    quality: RoomExportQuality,
    effects: PhotoEffects | undefined,
    capture: (canvas: HTMLCanvasElement) => void,
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal,
  ) {
    const prepared = this.prepared!;
    const sides: [number, Prepared, WebGLRenderTarget][] = [];
    if (mode !== 'after') sides.push([0, prepared.before, this.beforeTarget]);
    if (mode !== 'before') sides.push([1, prepared.after, this.afterTarget]);
    const lights = [
      ...new Set(sides.map(([, side]) => side.light).filter((light): light is SpotLight => !!light)),
    ];
    const saved = lights.map((light) => ({
      light,
      position: light.position.clone(),
      target: light.target.position.clone(),
      focus: light.shadow.focus,
      mapSize: light.shadow.mapSize.clone(),
    }));
    const resetShadowMap = (light: SpotLight) => {
      light.shadow.map?.dispose();
      light.shadow.map = null;
    };
    this.accumulating = true;
    let accumulator: ExportAccumulator | undefined;
    try {
      const frame = this.frame(width, height, view, mode);
      const projection = frame.camera.projectionMatrix.clone();
      accumulator = new ExportAccumulator(frame.targetWidth, frame.size.height);
      for (const { light } of saved) {
        // A 90° cone gives a 180° shadow frustum (no usable shadow); 0.8 → 144°.
        light.shadow.focus = EXPORT_SHADOW_FOCUS;
        light.shadow.mapSize.set(EXPORT_SHADOW_MAP, EXPORT_SHADOW_MAP);
        resetShadowMap(light);
      }
      let samples = quality.samples,
        lightSpread = samples >= SOFT_SHADOW_SAMPLES ? EXPORT_LIGHT_PANEL_MM : NARROW_LIGHT_MM;
      // 0% paints before the first sample, the slowest one on software rendering (shaders, maps).
      onProgress?.(0, samples);
      await nextPaint();
      if (this.disposed) throw new DOMException('공간 둘러보기가 닫혔습니다.', 'AbortError');
      const started = performance.now();
      for (let k = 0; k < samples; k++) {
        if (signal?.aborted) throw new DOMException('이미지 만들기를 취소했어요.', 'AbortError');
        this.assertOpen();
        const jitter = exportJitter(k);
        frame.camera.projectionMatrix.copy(projection);
        jitterProjection(
          frame.camera,
          jitter.camera[0],
          jitter.camera[1],
          frame.rect.width,
          frame.rect.height,
        );
        for (const entry of saved) {
          const dx = jitter.light[0] * lightSpread,
            dz = jitter.light[1] * lightSpread;
          entry.light.position.set(entry.position.x + dx, entry.position.y, entry.position.z + dz);
          entry.light.target.position.set(entry.target.x + dx, entry.target.y, entry.target.z + dz);
          entry.light.updateMatrixWorld(true);
          entry.light.target.updateMatrixWorld(true);
        }
        for (const [index, side, target] of sides) {
          this.paint(side, target, frame);
          accumulator.add(this.renderer, index, target.texture, k);
        }
        accumulator.finish(this.renderer, sides.at(-1)![0]);
        if (k === 0 && quality.budgetMs) {
          // Sample 0 is unjittered, so it stands alone when the device cannot afford more.
          const affordable = Math.floor(quality.budgetMs / Math.max(1, performance.now() - started));
          if (affordable < samples) {
            samples = Math.max(1, affordable);
            if (samples < SOFT_SHADOW_SAMPLES) lightSpread = NARROW_LIGHT_MM;
          }
        }
        onProgress?.(k + 1, samples);
        // Let the page paint progress and take a cancel click between samples.
        if (k + 1 < samples) await nextPaint();
        if (this.disposed) throw new DOMException('공간 둘러보기가 닫혔습니다.', 'AbortError');
      }
      // A cancel clicked during the last sample lands here, before the file is made.
      await nextPaint();
      if (signal?.aborted) throw new DOMException('이미지 만들기를 취소했어요.', 'AbortError');
      if (this.disposed) throw new DOMException('공간 둘러보기가 닫혔습니다.', 'AbortError');
      this.assertOpen();
      this.composite(
        frame,
        mode,
        0.5,
        accumulator.texture(0) ?? this.beforeTarget.texture,
        accumulator.texture(1) ?? this.afterTarget.texture,
        effects,
      );
      capture(this.canvas);
      return { samples, softShadows: lightSpread === EXPORT_LIGHT_PANEL_MM };
    } finally {
      for (const entry of saved) {
        entry.light.position.copy(entry.position);
        entry.light.target.position.copy(entry.target);
        entry.light.updateMatrixWorld(true);
        entry.light.target.updateMatrixWorld(true);
        entry.light.shadow.focus = entry.focus;
        entry.light.shadow.mapSize.copy(entry.mapSize);
        resetShadowMap(entry.light);
      }
      accumulator?.dispose();
      this.accumulating = false;
    }
  }
  /**
   * Visible fixture boxes of an After frame of this size and view, normalised to that frame (y down).
   * Uses the same camera and photo viewport as render(), so they line up with an exported image.
   */
  fixtureBounds(
    width: number,
    height: number,
    view: RoomViewState,
  ): Record<string, [number, number, number, number]> {
    this.assertOpen();
    if (!this.prepared || !this.snapshot) throw new Error('공간을 준비하는 중입니다.');
    const size = fitOutput(width, height, this.maxOutputEdge);
    const state = normalizeRoomView(view);
    const camera = createRoomViewCamera(
      this.snapshot.scene.room!,
      size.width / size.height,
      state,
      this.prepared.bounds,
      this.prepared.structureBounds,
    );
    const rect = roomViewViewport(size.width, size.height, state);
    const after = this.prepared.after;
    // Directional photo planes switch with the view; measure what this view actually shows.
    after.fixtures.updateView(camera);
    after.world.updateMatrixWorld(true);
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    const result: Record<string, [number, number, number, number]> = {};
    for (const object of after.fixtures.group.children) {
      const id = object.userData.fixtureId;
      if (typeof id !== 'string') continue;
      const xs: number[] = [],
        ys: number[] = [];
      object.traverseVisible((node) => {
        const mesh = node as Mesh;
        if (!mesh.isMesh) return;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
        for (const x of [box.min.x, box.max.x])
          for (const y of [box.min.y, box.max.y])
            for (const z of [box.min.z, box.max.z]) {
              const p = new Vector3(x, y, z).project(camera);
              if (!Number.isFinite(p.x) || p.z < -1 || p.z > 1) continue;
              xs.push((rect.x + ((p.x + 1) / 2) * rect.width) / size.width);
              ys.push(1 - (rect.y + ((p.y + 1) / 2) * rect.height) / size.height);
            }
      });
      if (!xs.length) continue;
      const box: [number, number, number, number] = [
        clamp(Math.min(...xs)),
        clamp(Math.min(...ys)),
        clamp(Math.max(...xs)),
        clamp(Math.max(...ys)),
      ];
      if (box[2] > box[0] && box[3] > box[1]) result[id] = box;
    }
    return result;
  }
  /** Normalized canvas coordinates, y down. Only the editable After panel is pickable. */
  private pointerRay(x: number, y: number): Raycaster | undefined {
    this.assertOpen();
    const frame = this.lastFrame;
    if (
      !frame ||
      frame.mode !== 'after' ||
      !this.snapshot?.scene.room ||
      !this.prepared ||
      ![x, y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    )
      return;
    const rect = roomViewViewport(frame.width, frame.height, frame.view);
    const px = x * frame.width,
      py = (1 - y) * frame.height;
    if (px < rect.x || px > rect.x + rect.width || py < rect.y || py > rect.y + rect.height) return;
    const camera = createRoomViewCamera(
      this.snapshot.scene.room,
      frame.width / frame.height,
      frame.view,
      this.prepared.bounds,
      this.prepared.structureBounds,
    );
    const ray = new Raycaster();
    ray.setFromCamera(
      new Vector2(((px - rect.x) / rect.width) * 2 - 1, ((py - rect.y) / rect.height) * 2 - 1),
      camera,
    );
    return ray;
  }
  pick(x: number, y: number): { id: string; kind: 'fixture' | 'surface' } | null {
    const ray = this.pointerRay(x, y);
    if (!ray || !this.prepared) return null;
    for (const hit of ray.intersectObject(this.prepared.after.world, true)) {
      let object: typeof hit.object | null = hit.object;
      let hidden = false;
      let selected: { id: string; kind: 'fixture' | 'surface' } | null = null;
      while (object) {
        if (!object.visible) hidden = true;
        if (typeof object.userData.fixtureId === 'string')
          selected = { id: object.userData.fixtureId, kind: 'fixture' };
        else if (!selected && typeof object.userData.surfaceId === 'string')
          selected = { id: object.userData.surfaceId, kind: 'surface' };
        object = object.parent;
      }
      if (!hidden && selected) return selected;
    }
    return null;
  }
  /** A drag stays on the fixture's original installation plane in millimetres. */
  facePosition(x: number, y: number, face: RoomFace): { u: number; v: number } | null {
    const ray = this.pointerRay(x, y),
      room = this.snapshot?.scene.room;
    if (!ray || !room) return null;
    const plane =
      face === 'floor'
        ? new Plane(new Vector3(0, 1, 0), 0)
        : face === 'back'
          ? new Plane(new Vector3(0, 0, 1), 0)
          : new Plane(new Vector3(1, 0, 0), face === 'left' ? room.widthMm / 2 : -room.widthMm / 2);
    const point = ray.ray.intersectPlane(plane, new Vector3());
    if (!point) return null;
    return {
      u:
        face === 'left'
          ? 1 - point.z / room.depthMm
          : face === 'right'
            ? point.z / room.depthMm
            : point.x / room.widthMm + 0.5,
      v: face === 'floor' ? point.z / room.depthMm : 1 - point.y / room.heightMm,
    };
  }
  async export(
    view: RoomViewState,
    options: {
      format: 'png' | 'jpeg';
      mode: RoomViewerMode;
      longEdge: number;
      /** Multi-sample photo export; omitted for previews, which stay one synchronous frame. */
      quality?: RoomExportQuality;
      /** Photo look for downloads; never for AI input or previews. */
      effects?: PhotoEffects;
      onProgress?: (done: number, total: number) => void;
      signal?: AbortSignal;
    },
  ): Promise<Blob> {
    this.assertOpen();
    if (!this.snapshot || !this.prepared) throw new Error('공간을 먼저 준비해 주세요.');
    const snapshot = this.snapshot,
      previous = this.lastFrame,
      state = structuredClone(view);
    const edge = Math.max(
      1,
      Math.min(
        this.maxOutputEdge,
        Math.max(snapshot.scene.imageWidth, snapshot.scene.imageHeight),
        Number.isFinite(options.longEdge) ? options.longEdge : this.maxOutputEdge,
      ),
    );
    const aspect =
      (snapshot.scene.imageWidth / snapshot.scene.imageHeight) * (options.mode === 'compare' ? 2 : 1);
    const output = fitOutput(aspect >= 1 ? edge : edge * aspect, aspect >= 1 ? edge / aspect : edge, edge);
    const copy = document.createElement('canvas');
    copy.width = output.width;
    copy.height = output.height;
    const context = copy.getContext('2d');
    if (!context) throw new Error('다운로드 이미지를 만들 수 없습니다.');
    const samples = Math.max(1, Math.min(256, Math.floor(options.quality?.samples ?? 1)));
    // Averaging needs a float target; an 8-bit one would band and clip, so export one frame instead.
    const floatTargets = this.afterTarget.texture.type === HalfFloatType;
    const started = performance.now();
    this.lastExport = {
      samples: samples > 1 && floatTargets ? samples : 1,
      ms: 0,
      width: output.width,
      height: output.height,
      effects: !!options.effects,
      ...(samples > 1 && !floatTargets
        ? { fallbackReason: '이 브라우저는 float 렌더 타깃이 없어 한 장으로 내보냈어요.' }
        : {}),
    };
    if (samples > 1 && floatTargets) {
      try {
        Object.assign(
          this.lastExport,
          await this.renderAccumulated(
            output.width,
            output.height,
            state,
            options.mode,
            { samples, budgetMs: options.quality?.budgetMs },
            options.effects,
            (canvas) => context.drawImage(canvas, 0, 0),
            options.onProgress,
            options.signal,
          ),
        );
      } catch (error) {
        const cancelled = error instanceof DOMException && error.name === 'AbortError';
        if (cancelled || this.disposed || this.lost || this.renderer.getContext().isContextLost()) {
          // The preview frame is restored in finally; nothing half-averaged is encoded.
          copy.width = copy.height = 1;
          throw error;
        }
        // Allocation or GPU trouble while averaging: keep the user's export as one frame.
        this.lastExport = {
          ...this.lastExport,
          samples: 1,
          fallbackReason:
            '여러 장 겹쳐 찍기를 하지 못해 한 장으로 내보냈어요. ' +
            (error instanceof Error ? error.message : String(error)),
        };
        context.drawImage(this.exportFrame(output.width, output.height, state, options), 0, 0);
      } finally {
        const next = this.deferredFrame ?? previous;
        this.deferredFrame = undefined;
        if (next && !this.disposed && !this.lost && !this.renderer.getContext().isContextLost())
          this.render(next.width, next.height, next.view, next.mode, next.split);
      }
    } else {
      // Paint + detached pixel copy are synchronous. Later scene changes cannot alter this file.
      try {
        context.drawImage(this.exportFrame(output.width, output.height, state, options), 0, 0);
      } finally {
        if (previous && !this.disposed)
          this.render(previous.width, previous.height, previous.view, previous.mode, previous.split);
      }
    }
    this.lastExport.ms = performance.now() - started;
    return new Promise<Blob>((resolve, reject) =>
      copy.toBlob(
        (blob) => {
          copy.width = copy.height = 1;
          if (blob) resolve(blob);
          else reject(new Error('이미지 파일을 인코딩하지 못했습니다. 다시 시도해 주세요.'));
        },
        options.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        0.94,
      ),
    );
  }
  /** One export frame: the plain render, or with the photo look when asked for. */
  private exportFrame(
    width: number,
    height: number,
    view: RoomViewState,
    options: { mode: RoomViewerMode; effects?: PhotoEffects },
  ) {
    if (!options.effects) return this.render(width, height, view, options.mode);
    this.assertOpen();
    return this.drawFrame(width, height, view, options.mode, 0.5, options.effects);
  }
  diagnostics() {
    const gl = this.renderer.getContext(),
      extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      policy: POLICY,
      roomViewerRendererRevision: ROOM_VIEWER_RENDERER_REVISION,
      projection: this.lastFrame?.view.projection ?? 'room-fit',
      photoViewport: this.lastFrame
        ? roomViewViewport(this.afterTarget.width, this.afterTarget.height, this.lastFrame.view)
        : null,
      disposed: this.disposed,
      contextLost: this.lost || gl.isContextLost(),
      contexts: this.disposed ? 0 : 1,
      renders: this.renders,
      sourceDepthClip: this.sourceDepthClip,
      preparations: this.preparations,
      preparedScenes: this.scenes.size,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      programs: this.renderer.info.programs?.length ?? 0,
      drawCalls: this.renderer.info.render.calls,
      targetWidth: this.afterTarget.width,
      targetHeight: this.afterTarget.height,
      maxOutputEdge: this.maxOutputEdge,
      gpu: extension
        ? (gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) as string)
        : (gl.getParameter(gl.RENDERER) as string),
      tileCache: this.tiles.diagnostics(),
      productCache: this.products.diagnostics,
      lightingCache: this.lighting.diagnostics,
      countersMayBeStaleAfterContextLoss: this.disposed || gl.isContextLost(),
      canvasSize: new Vector2(this.canvas.width, this.canvas.height).toArray(),
      lastExport: this.lastExport ? { ...this.lastExport } : null,
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.request++;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    for (const p of this.scenes.values())
      void p.then(
        (scene) => scene.dispose(),
        () => {},
      );
    this.scenes.clear();
    this.prepared = undefined;
    this.snapshot = undefined;
    this.lastFrame = undefined;
    this._notices = [];
    this.tiles.dispose();
    this.products.dispose();
    this.lighting.dispose();
    this.environment?.dispose();
    this.beforeTarget.dispose();
    this.afterTarget.dispose();
    this.postMaterial.dispose();
    this.photoMaterial?.dispose();
    this.postGeometry.dispose();
    this.post.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
