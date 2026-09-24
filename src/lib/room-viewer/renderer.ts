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
  bounds: Box3;
  structureBounds: Box3;
  notices: SurfaceNotice[];
  dispose(): void;
};
const POLICY = 'room-quarter-turn-world-v1';
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
    this.post.add(new Mesh(this.postGeometry, this.postMaterial));
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
    world.add(surfaces.group, fixtures.group, ...lights);
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
      bounds,
      structureBounds: surfaces.structureBounds,
      notices,
      dispose() {
        surfaces.dispose();
        fixtures.dispose();
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
  render(
    width: number,
    height: number,
    view: RoomViewState,
    mode: RoomViewerMode = 'after',
    split = 0.5,
  ): HTMLCanvasElement {
    this.assertOpen();
    if (!this.prepared || !this.snapshot) throw new Error('공간을 준비하는 중입니다.');
    const size = fitOutput(width, height, this.maxOutputEdge);
    const state = normalizeRoomView(view);
    const panelWidth = mode === 'compare' ? size.width / 2 : size.width;
    const camera = createRoomViewCamera(
      this.snapshot.scene.room!,
      panelWidth / size.height,
      state,
      this.prepared.bounds,
      this.prepared.structureBounds,
    );
    this.sourceDepthClip = undefined;
    if (state.sourceCamera && state.projection === 'source-photo') {
      // Decide visible cutaway walls/directional meshes before deriving one shared depth interval.
      for (const side of [this.prepared.before, this.prepared.after]) {
        side.surfaces.updateView(camera);
        side.fixtures.updateView(camera);
      }
      this.sourceDepthClip = fitSourceDepthClip(
        camera,
        visibleMeshBounds([this.prepared.before.world, this.prepared.after.world]),
      );
    }
    const targetWidth = mode === 'compare' ? Math.max(1, Math.ceil(size.width / 2)) : size.width;
    this.beforeTarget.setSize(targetWidth, size.height);
    this.afterTarget.setSize(targetWidth, size.height);
    this.renderer.setSize(size.width, size.height, false);
    const rect = roomViewViewport(targetWidth, size.height, state);
    const paint = (prepared: Prepared, target: WebGLRenderTarget) => {
      prepared.surfaces.updateView(camera);
      prepared.fixtures.updateView(camera);
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
    };
    if (mode !== 'after') paint(this.prepared.before, this.beforeTarget);
    if (mode !== 'before') paint(this.prepared.after, this.afterTarget);
    const uniforms = this.postMaterial.uniforms;
    uniforms.sjnPhotoRect.value.set(
      rect.x / targetWidth,
      rect.y / size.height,
      rect.width / targetWidth,
      rect.height / size.height,
    );
    uniforms.sjnBeforeColor.value = colorVector(this.prepared.before.source.color);
    uniforms.sjnAfterColor.value = colorVector(this.prepared.after.source.color);
    uniforms.sjnMode.value = mode === 'before' ? 0 : mode === 'after' ? 1 : mode === 'split' ? 2 : 3;
    uniforms.sjnSplit.value = Number.isFinite(split) ? Math.max(0, Math.min(1, split)) : 0.5;
    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, size.width, size.height);
    this.renderer.setScissorTest(false);
    this.renderer.render(this.post, this.postCamera);
    this.assertOpen();
    this.lastFrame = { width: size.width, height: size.height, view: structuredClone(state), mode, split };
    this.renders++;
    return this.canvas;
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
    options: { format: 'png' | 'jpeg'; mode: RoomViewerMode; longEdge: number },
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
    // Paint + detached pixel copy are synchronous. Later scene changes cannot alter this file.
    try {
      context.drawImage(this.render(output.width, output.height, state, options.mode), 0, 0);
    } finally {
      if (previous && !this.disposed)
        this.render(previous.width, previous.height, previous.view, previous.mode, previous.split);
    }
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
    this.postGeometry.dispose();
    this.post.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
