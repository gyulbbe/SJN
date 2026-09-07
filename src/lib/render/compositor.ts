import {
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Matrix3,
  Mesh,
  NoBlending,
  NoColorSpace,
  NoToneMapping,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget,
  type Texture,
} from 'three';
import type {
  AssetRecord,
  ColorAdjust,
  FixtureInstance,
  Mask,
  MaterialVersion,
  RenderSnapshot,
  Scene as EditorScene,
  Surface,
} from '../types';
import { fitOutput, homography, validateQuad } from './math';
import { maskCanvas } from './mask';

export type AssetReader = (id: string) => Promise<AssetRecord>;
export type CompareMode = 'before' | 'after' | 'split';
type SnapshotQuality = {
  quality: 'preview' | 'export';
  maskWidth?: number;
  maskHeight?: number;
  previewEdge?: number;
};
type TilePass = {
  surface: Surface;
  material: MaterialVersion;
  atlas: Texture;
  columns: number;
  count: number;
  mask: Texture;
  inverse: Matrix3;
  shading: Texture;
  referenceLuminance: number;
};
type ShadingField = { texture: Texture; mean: number; histogram: Uint32Array; samples: number };
type LuminanceImage = { width: number; height: number; values: Float32Array };
type FixturePass = { fixture: FixtureInstance; texture: Texture; occlusion: Texture; inverse?: Matrix3 };
type PreparedScene = {
  scene: EditorScene;
  original: Texture;
  background: Texture;
  tiles: TilePass[];
  fixtures: FixturePass[];
  maskIds: string[];
  shadingIds: string[];
};

const vertexShader = `
varying vec2 vUv;
void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}
`;
// Source and atlas bytes remain sRGB. We explicitly decode them into linear working targets;
// masks carry alpha-only data. Only the output pass encodes sRGB, without a second output chunk.
const colorFunctions = `
vec3 decodeSRGB(vec3 c){return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),step(vec3(0.04045),c));}
vec3 encodeSRGB(vec3 c){c=max(vec3(0.),c);return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-0.055,step(vec3(0.0031308),c));}
vec3 adjustColor(vec3 c,vec4 adjustment){
  c*=exp2(adjustment.x);
  c=(c-0.18)*adjustment.y+0.18;
  float lum=dot(c,vec3(.2126,.7152,.0722));
  c=mix(vec3(lum),c,adjustment.z);
  c*=vec3(1.+adjustment.w*.18,1.,1.-adjustment.w*.18);
  return max(c,vec3(0.));
}
`;
const backgroundShader = `
varying vec2 vUv;uniform sampler2D image;
${colorFunctions}
void main(){gl_FragColor=vec4(decodeSRGB(texture2D(image,vUv).rgb),1.);}
`;
const tileShader = `
varying vec2 vUv;
uniform sampler2D previousImage;uniform sampler2D atlas;uniform sampler2D areaMask;uniform sampler2D shadingImage;
uniform mat3 inversePlane;uniform vec2 planeSize;uniform vec2 tileSize;uniform vec2 offset;
uniform float angle;uniform float groutWidth;uniform vec3 groutColor;uniform float brick;
uniform float seed;uniform float variantCount;uniform float atlasColumns;uniform float atlasPixels;
uniform float shading;uniform float meanLuminance;uniform vec4 adjustment;
${colorFunctions}
void main(){
  vec4 background=texture2D(previousImage,vUv);
  float amount=texture2D(areaMask,vUv).a;
  if(amount<.001){gl_FragColor=background;return;}
  vec2 photo=vec2(vUv.x,1.-vUv.y);
  vec3 projected=inversePlane*vec3(photo,1.);
  if(abs(projected.z)<.0000001){gl_FragColor=background;return;}
  vec2 mm=projected.xy/projected.z*planeSize-offset;
  float c=cos(angle),s=sin(angle);
  mm=vec2(c*mm.x+s*mm.y,-s*mm.x+c*mm.y);
  vec2 aa=max(fwidth(mm),vec2(.001));
  vec2 period=max(vec2(.001),tileSize+groutWidth);
  float row=floor(mm.y/period.y);
  mm.x-=brick*mod(row,2.)*period.x*.5;
  vec2 cell=floor(mm/period);
  vec2 inside=mod(mm,period);
  vec2 tileUv=inside/max(tileSize,vec2(.001));
  float h=mod(mod(cell.x,251.)*17.+mod(cell.y,251.)*131.+mod(seed,251.)*23.,251.);
  float variant=floor(mod(h*73.+19.,251.)/251.*variantCount);
  vec2 atlasCell=vec2(mod(variant,atlasColumns),floor(variant/atlasColumns));
  // Half-texel insets prevent interpolation from leaking neighboring variants into seams.
  float inset=.5/(atlasPixels/atlasColumns);
  vec2 atlasUv=(atlasCell+clamp(tileUv,vec2(inset),vec2(1.-inset)))/atlasColumns;
  atlasUv.y=1.-atlasUv.y;
  vec3 tileColor=decodeSRGB(texture2D(atlas,atlasUv).rgb);
  // Integrate the physical seam over the pixel footprint on BOTH sides of the repeat.
  // This preserves subpixel grout coverage without periodically losing the leading edge.
  vec2 seamDistance=abs(mod(inside-(tileSize+groutWidth*.5)+period*.5,period)-period*.5);
  vec2 seamCoverage=clamp((groutWidth*.5-seamDistance+aa*.5)/aa,0.,1.)-clamp((-groutWidth*.5-seamDistance+aa*.5)/aa,0.,1.);
  seamCoverage=mix(seamCoverage,vec2(groutWidth)/period,step(period,aa));
  float grout=groutWidth<=0.?0.:1.-(1.-seamCoverage.x)*(1.-seamCoverage.y);
  vec3 result=mix(tileColor,groutColor,grout);
  float luminance=texture2D(shadingImage,vUv).r;
  float light=clamp(luminance/max(meanLuminance,.015),.18,1.6);
  // Exposure-like interpolation preserves the relative darkness of contact shadows. At zero
  // strength it is exactly neutral; input color is never blended over the replacement tile.
  result*=pow(light,shading);
  result=adjustColor(result,adjustment);
  gl_FragColor=vec4(mix(background.rgb,result,amount),1.);
}
`;
const fixtureShader = `
varying vec2 vUv;uniform sampler2D previousImage;uniform sampler2D product;uniform sampler2D occlusion;
uniform vec2 photoSize;uniform vec2 productPosition;uniform vec2 productSize;uniform vec2 anchor;
uniform float angle;uniform float projective;uniform mat3 inverseProduct;uniform vec4 adjustment;uniform vec2 shadowOffset;uniform float shadowOpacity;
uniform float shadowBlur;uniform float shadowScale;
${colorFunctions}
void main(){
  vec3 background=texture2D(previousImage,vUv).rgb;
  vec2 photo=vec2(vUv.x,1.-vUv.y);
  float visibility=1.-texture2D(occlusion,vUv).a;
  vec2 shadowCenter=productPosition+shadowOffset;
  vec2 sd=(photo-shadowCenter)*photoSize;
  float halfWidth=max(.0001,productSize.x*photoSize.x*shadowScale*.5);
  float halfHeight=max(.0001,productSize.y*photoSize.y*.065*shadowScale);
  float blur=max(.0001,shadowBlur*photoSize.x);
  float shadow=exp(-2.*dot(sd/vec2(halfWidth+blur,halfHeight+blur),sd/vec2(halfWidth+blur,halfHeight+blur)));
  background*=1.-shadow*shadowOpacity*visibility;
  vec2 d=(photo-productPosition)*photoSize;
  float c=cos(angle),s=sin(angle);
  vec2 local=vec2(c*d.x+s*d.y,-s*d.x+c*d.y)/(productSize*photoSize)+anchor;
  if(projective>.5){
    vec3 projected=inverseProduct*vec3(photo,1.);
    local=abs(projected.z)<.0000001?vec2(-1.):projected.xy/projected.z;
  }
  vec4 productColor=texture2D(product,vec2(local.x,1.-local.y));
  float inside=step(0.,local.x)*step(0.,local.y)*step(local.x,1.)*step(local.y,1.);
  float alpha=productColor.a*inside*visibility;
  vec3 result=adjustColor(decodeSRGB(productColor.rgb),adjustment);
  gl_FragColor=vec4(mix(background,result,alpha),1.);
}
`;
const outputShader = `
varying vec2 vUv;uniform sampler2D edited;uniform sampler2D original;uniform sampler2D beforeEdited;
uniform vec4 adjustment;uniform vec4 beforeAdjustment;uniform float hasBeforeScene;
uniform float mode;uniform float splitPosition;
${colorFunctions}
void main(){
  vec3 before=texture2D(original,vUv).rgb;
  if(hasBeforeScene>.5) before=encodeSRGB(adjustColor(texture2D(beforeEdited,vUv).rgb,beforeAdjustment));
  vec3 after=encodeSRGB(adjustColor(texture2D(edited,vUv).rgb,adjustment));
  gl_FragColor=vec4(mode<.5?before:(mode>1.5&&vUv.x<splitPosition?before:after),1.);
}
`;

const copyShader = `
varying vec2 vUv;uniform sampler2D image;
void main(){gl_FragColor=texture2D(image,vUv);}
`;

function shader(fragmentShader: string): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    toneMapped: false,
  });
}
function uniform(material: ShaderMaterial, name: string, value: unknown) {
  if (material.uniforms[name]) material.uniforms[name].value = value;
  else material.uniforms[name] = { value };
}
function colorVector(color: ColorAdjust) {
  return new Vector4(color.exposure, color.contrast, color.saturation, color.warmth);
}
function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = NoColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  return texture;
}
function context2d(canvas: HTMLCanvasElement, read = false): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: read });
  if (!ctx) throw new Error('이미지 캔버스를 준비하지 못했습니다.');
  return ctx;
}

/** A 0.75 raster-pixel Gaussian only reduces coverage: protected/outside pixels cannot gain tile. */
function featherMaskCoverage(canvas: HTMLCanvasElement): void {
  const { width, height } = canvas;
  const ctx = context2d(canvas, true);
  const image = ctx.getImageData(0, 0, width, height);
  const pixels = image.data;
  const horizontal = new Uint8Array(width * height);
  const neighbor = Math.exp(-0.5 / (0.75 * 0.75));
  const normalizer = 1 + 2 * neighbor;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const index = row + x;
      horizontal[index] = Math.round(
        (pixels[index * 4 + 3] +
          neighbor *
            (pixels[(row + Math.max(0, x - 1)) * 4 + 3] +
              pixels[(row + Math.min(width - 1, x + 1)) * 4 + 3])) /
          normalizer,
      );
    }
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const above = Math.max(0, y - 1) * width;
    const below = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) {
      const offset = (row + x) * 4 + 3;
      const blurred =
        (horizontal[row + x] + neighbor * (horizontal[above + x] + horizontal[below + x])) / normalizer;
      pixels[offset] = Math.min(pixels[offset], Math.round(blurred));
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** One renderer, two linear ping-pong buffers; masks and handles never enter the final overlay. */
export class PhotoCompositor {
  readonly canvas: HTMLCanvasElement;
  readonly maxOutputEdge: number;
  private readonly renderer: WebGLRenderer;
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly scene = new Scene();
  private readonly geometry = new PlaneGeometry(2, 2);
  private readonly backgroundMaterial = shader(backgroundShader);
  private readonly tileMaterial = shader(tileShader);
  private readonly fixtureMaterial = shader(fixtureShader);
  private readonly outputMaterial = shader(outputShader);
  private readonly copyMaterial = shader(copyShader);
  private readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly targets: [WebGLRenderTarget, WebGLRenderTarget];
  private readonly beforeTarget: WebGLRenderTarget;
  private beforePrepared?: PreparedScene;
  private beforePreparedKey = '';
  private beforeRenderedKey = '';
  private readonly images = new Map<string, Promise<HTMLCanvasElement>>();
  private readonly textures = new Map<string, Texture>();
  private readonly masks = new Map<string, { key: string; texture: Texture }>();
  private readonly retiredMasks: Texture[] = [];
  private readonly atlases = new Map<string, Promise<{ texture: Texture; columns: number; count: number }>>();
  private readonly shadingCache = new Map<string, { key: string; promise: Promise<ShadingField> }>();
  private readonly luminanceCache = new Map<string, Promise<LuminanceImage>>();
  private snapshot?: RenderSnapshot;
  private reader?: AssetReader;
  private original?: Texture;
  private background?: Texture;
  private tilePasses: TilePass[] = [];
  private fixturePasses: FixturePass[] = [];
  private generation = 0;
  private quality: SnapshotQuality = { quality: 'preview' };
  private exporting?: Promise<void>;
  private lastView: { mode: CompareMode; split: number } = { mode: 'after', split: 0.5 };
  private disposed = false;
  private lost = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    const context = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!context)
      throw new Error('WebGL 2를 사용할 수 없습니다. 브라우저의 하드웨어 가속을 켜고 다시 열어 주세요.');
    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      context,
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.maxOutputEdge = Math.min(
      4096,
      this.renderer.capabilities.maxTextureSize,
      context.getParameter(context.MAX_RENDERBUFFER_SIZE) as number,
    );
    this.renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
      console.error(
        '공간미리 WebGL shader',
        gl.getProgramInfoLog(program),
        gl.getShaderInfoLog(vertex),
        gl.getShaderInfoLog(fragment),
      );
      throw new Error(
        '그래픽 합성 프로그램을 시작하지 못했습니다. 최신 브라우저와 하드웨어 가속을 확인해 주세요.',
      );
    };
    const type = this.renderer.extensions.has('EXT_color_buffer_float') ? HalfFloatType : UnsignedByteType;
    this.targets = [0, 1].map(
      () =>
        new WebGLRenderTarget(1, 1, {
          type,
          depthBuffer: false,
          stencilBuffer: false,
          minFilter: LinearFilter,
          magFilter: LinearFilter,
        }),
    ) as [WebGLRenderTarget, WebGLRenderTarget];
    this.beforeTarget = this.targets[0].clone();
    this.mesh = new Mesh(this.geometry, this.backgroundMaterial);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
  };
  private onContextRestored = () => {
    this.lost = false;
    this.beforeRenderedKey = '';
  };

  private async loadImage(id: string, maxEdge = this.maxOutputEdge): Promise<HTMLCanvasElement> {
    const key = `${id}:${maxEdge}`;
    const cached = this.images.get(key);
    if (cached) return cached;
    const promise = (async () => {
      if (!this.reader) throw new Error('이미지 저장소가 연결되지 않았습니다.');
      const record = await this.reader(id);
      const bitmap = await createImageBitmap(record.blob, {
        imageOrientation: 'from-image',
        premultiplyAlpha: 'none',
      });
      try {
        const size = fitOutput(bitmap.width, bitmap.height, maxEdge);
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        context2d(canvas).drawImage(bitmap, 0, 0, size.width, size.height);
        return canvas;
      } finally {
        bitmap.close();
      }
    })();
    this.images.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      this.images.delete(key);
      throw error;
    }
  }

  private async getTexture(id: string, maxEdge = this.maxOutputEdge): Promise<Texture> {
    const key = `${id}:${maxEdge}`;
    const cached = this.textures.get(key);
    if (cached) return cached;
    const image = await this.loadImage(id, maxEdge);
    // Two concurrent snapshots may await the same image; retain only one GPU texture.
    const existing = this.textures.get(key);
    if (existing) return existing;
    if (this.disposed) throw new Error('렌더러가 닫혔습니다.');
    const texture = canvasTexture(image);
    this.textures.set(key, texture);
    return texture;
  }

  private async atlasFor(material: MaterialVersion, quality: SnapshotQuality['quality'], compact = false) {
    const ids = material.textureAssetIds.length ? material.textureAssetIds : [material.coverAssetId];
    const key = JSON.stringify([quality, ids, compact]);
    const existing = this.atlases.get(key);
    if (existing) return existing;
    const promise = (async () => {
      if (!ids.length || !ids[0]) throw new Error(`${material.name}: 렌더링용 타일 이미지가 없습니다.`);
      const columns = Math.ceil(Math.sqrt(ids.length));
      const cell = Math.max(
        16,
        Math.min(quality === 'export' ? 2048 : 512, Math.floor(this.maxOutputEdge / columns)),
      );
      // Comparison cards only need the atlas cell pixels, not retained full-size originals.
      const images = await Promise.all(ids.map((id) => this.loadImage(id, compact ? cell : undefined)));
      const canvas = document.createElement('canvas');
      canvas.width = columns * cell;
      canvas.height = columns * cell;
      const ctx = context2d(canvas);
      ctx.fillStyle = material.color || '#e5e0d7';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      images.forEach((source, i) =>
        ctx.drawImage(source, (i % columns) * cell, Math.floor(i / columns) * cell, cell, cell),
      );
      if (this.disposed) throw new Error('렌더러가 닫혔습니다.');
      return { texture: canvasTexture(canvas), columns, count: images.length };
    })();
    this.atlases.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      this.atlases.delete(key);
      throw error;
    }
  }

  private getMask(
    id: string,
    mask: Mask,
    width: number,
    height: number,
    protection?: Mask,
    feather = false,
  ): Texture {
    const key = JSON.stringify([width, height, mask, protection, feather]);
    const cached = this.masks.get(id);
    if (cached?.key === key) return cached.texture;
    const canvas = maskCanvas(mask, width, height, protection);
    if (feather) featherMaskCoverage(canvas);
    const texture = canvasTexture(canvas);
    if (cached) this.retiredMasks.push(cached.texture);
    this.masks.set(id, { key, texture });
    return texture;
  }

  private async getLuminance(id: string, compact = false): Promise<LuminanceImage> {
    const key = compact ? `${id}:compact` : id;
    const cached = this.luminanceCache.get(key);
    if (cached) return cached;
    const promise = (async () => {
      const source = await this.loadImage(id, compact ? 256 : undefined);
      const size = fitOutput(source.width, source.height, 256);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = context2d(canvas, true);
      ctx.drawImage(source, 0, 0, size.width, size.height);
      const pixels = ctx.getImageData(0, 0, size.width, size.height).data;
      const values = new Float32Array(size.width * size.height);
      const linear = (n: number) => (n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4));
      const lut = Float32Array.from({ length: 256 }, (_, value) => linear(value / 255));
      for (let i = 0; i < values.length; i++)
        values[i] =
          0.2126 * lut[pixels[i * 4]] + 0.7152 * lut[pixels[i * 4 + 1]] + 0.0722 * lut[pixels[i * 4 + 2]];
      return { ...size, values };
    })();
    this.luminanceCache.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      this.luminanceCache.delete(key);
      throw error;
    }
  }

  private async getShading(
    id: string,
    surface: Surface,
    protection: Mask,
    cacheId = surface.id,
    compact = false,
  ): Promise<ShadingField> {
    const key = JSON.stringify([id, surface.mask, protection, compact]);
    const cached = this.shadingCache.get(cacheId);
    if (cached?.key === key) return cached.promise;
    const promise = (async () => {
      const { width, height, values } = await this.getLuminance(id, compact);
      const area = maskCanvas(surface.mask, width, height, protection);
      const coverage = context2d(area, true).getImageData(0, 0, width, height).data;
      const valid = Uint8Array.from(values, (_, i) => (coverage[i * 4 + 3] >= 250 ? 1 : 0));
      const weights = new Float32Array(values.length);
      const numerator = new Float32Array(values.length);
      const histogram = new Uint32Array(256);
      let samples = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (!valid[i]) continue;
          // Keep white fixtures and other excluded surfaces out of the light estimate, including
          // mixed pixels immediately beside their mask edge. The render mask itself is unchanged.
          if (
            !valid[y * width + Math.max(0, x - 1)] ||
            !valid[y * width + Math.min(width - 1, x + 1)] ||
            !valid[Math.max(0, y - 1) * width + x] ||
            !valid[Math.min(height - 1, y + 1) * width + x]
          )
            continue;
          const neighborhood: number[] = [];
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const j =
                Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx));
              if (valid[j]) neighborhood.push(values[j]);
            }
          neighborhood.sort((a, b) => a - b);
          // Suppress narrow old grout and texture spikes before extracting low-frequency light.
          const luminance = neighborhood[Math.floor(neighborhood.length / 2)];
          weights[i] = 1;
          numerator[i] = luminance;
          histogram[Math.round(luminance * 255)]++;
          samples++;
        }
      let reference = 0.5,
        accumulated = 0;
      if (samples)
        for (let bin = 0; bin < histogram.length; bin++) {
          accumulated += histogram[bin];
          if (accumulated >= samples * 0.7) {
            reference = Math.max(0.015, bin / 255);
            break;
          }
        }
      // Normalized convolution in linear luminance: excluded pixels contribute neither color
      // nor weight. A 256px field with sigma 2.1 retains contact light that the old 96px/4 blur lost.
      const radius = 7,
        sigma = 2.1;
      const kernel = Float32Array.from({ length: radius * 2 + 1 }, (_, i) =>
        Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)),
      );
      const horizontalLight = new Float32Array(values.length),
        horizontalWeight = new Float32Array(values.length);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          for (let offset = -radius; offset <= radius; offset++) {
            const sample = y * width + Math.max(0, Math.min(width - 1, x + offset)),
              weight = kernel[offset + radius];
            horizontalLight[i] += numerator[sample] * weight;
            horizontalWeight[i] += weights[sample] * weight;
          }
        }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = context2d(canvas),
        data = ctx.createImageData(width, height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          let light = 0,
            weight = 0;
          for (let offset = -radius; offset <= radius; offset++) {
            const sample = Math.max(0, Math.min(height - 1, y + offset)) * width + x,
              coefficient = kernel[offset + radius];
            light += horizontalLight[sample] * coefficient;
            weight += horizontalWeight[sample] * coefficient;
          }
          const i = (y * width + x) * 4;
          data.data[i] =
            data.data[i + 1] =
            data.data[i + 2] =
              Math.round((weight > 0.00001 ? light / weight : reference) * 255);
          data.data[i + 3] = 255;
        }
      ctx.putImageData(data, 0, 0);
      if (this.disposed) throw new Error('렌더러가 닫혔습니다.');
      return { texture: canvasTexture(canvas), mean: reference, histogram, samples };
    })();
    if (cached)
      void cached.promise
        .then((field) => {
          if (this.disposed) field.texture.dispose();
          else this.retiredMasks.push(field.texture);
        })
        .catch(() => {});
    this.shadingCache.set(cacheId, { key, promise });
    try {
      return await promise;
    } catch (error) {
      if (this.shadingCache.get(surface.id)?.promise === promise) this.shadingCache.delete(cacheId);
      throw error;
    }
  }

  async setSnapshot(
    snapshot: RenderSnapshot,
    assetReader: AssetReader,
    options?: { maxPreviewEdge?: number },
  ): Promise<void> {
    // An export temporarily uses the same renderer at source resolution. User edits wait for
    // its finally block, then prepare the newest preview without racing the export's buffers.
    if (this.exporting) await this.exporting;
    const previewEdge =
      options?.maxPreviewEdge === undefined
        ? undefined
        : Math.max(1, Math.min(2048, Math.round(options.maxPreviewEdge)));
    return this.prepareSnapshot(snapshot, assetReader, {
      quality: 'preview',
      ...(previewEdge === undefined ? {} : { previewEdge }),
    });
  }

  /** Both scenes use the same preparation path; namespaces isolate even cloned layer ids. */
  private async prepareScene(
    scene: EditorScene,
    materials: RenderSnapshot['materials'],
    quality: SnapshotQuality,
    namespace: 'before' | 'after',
    generation: number,
  ): Promise<PreparedScene | undefined> {
    const current = () => generation === this.generation && !this.disposed;
    const sourceId = quality.quality === 'export' ? scene.originalAssetId : scene.previewAssetId;
    const backgroundId = scene.backgroundAssetId || sourceId;
    const sourceEdge =
      quality.quality === 'export'
        ? this.maxOutputEdge
        : Math.min(quality.previewEdge ?? 2048, this.maxOutputEdge);
    const [original, background] = await Promise.all([
      this.getTexture(sourceId, sourceEdge),
      this.getTexture(backgroundId, sourceEdge),
    ]);
    if (!current()) return;
    const maskSize =
      quality.quality === 'export' && quality.maskWidth && quality.maskHeight
        ? fitOutput(quality.maskWidth, quality.maskHeight, this.maxOutputEdge)
        : fitOutput(
            scene.imageWidth,
            scene.imageHeight,
            Math.min(quality.previewEdge ?? 2048, this.maxOutputEdge),
          );
    const tiles: TilePass[] = [],
      fixtures: FixturePass[] = [];
    const maskIds: string[] = [],
      shadingIds = new Set<string>();
    const shadingFor = (surface: Surface) => {
      const id = namespace + ':surface:' + surface.id;
      shadingIds.add(id);
      return this.getShading(backgroundId, surface, scene.protection, id, quality.previewEdge !== undefined);
    };
    // Wall planes share their own scene's light reference, never the other comparison side's.
    let wallReference: number | undefined;
    const walls = scene.surfaces.filter((surface) => surface.kind === 'wall');
    if (walls.length > 1 && walls.some((surface) => surface.materialVersionId)) {
      const fields = await Promise.all(walls.map(shadingFor));
      if (!current()) return;
      const histogram = new Uint32Array(256);
      const samples = fields.reduce((sum, field) => sum + field.samples, 0);
      for (const field of fields)
        for (let bin = 0; bin < histogram.length; bin++) histogram[bin] += field.histogram[bin];
      let accumulated = 0;
      for (let bin = 0; samples && bin < histogram.length; bin++) {
        accumulated += histogram[bin];
        if (accumulated >= samples * 0.7) {
          wallReference = Math.max(0.015, bin / 255);
          break;
        }
      }
    }
    for (const surface of scene.surfaces) {
      if (!surface.materialVersionId) continue;
      const material = materials[surface.materialVersionId];
      if (!material) throw new Error(surface.name + ': 저장된 자재 버전을 찾지 못했습니다.');
      if (!validateQuad(surface.quad)) continue;
      const [atlas, shading] = await Promise.all([
        this.atlasFor(material, quality.quality, quality.previewEdge !== undefined),
        shadingFor(surface),
      ]);
      if (!current()) return;
      const id = namespace + ':surface:' + surface.id;
      maskIds.push(id);
      tiles.push({
        surface,
        material,
        ...atlas,
        atlas: atlas.texture,
        mask: this.getMask(id, surface.mask, maskSize.width, maskSize.height, scene.protection, true),
        inverse: new Matrix3().set(...homography(surface.quad)),
        shading: shading.texture,
        referenceLuminance: surface.kind === 'wall' ? (wallReference ?? shading.mean) : shading.mean,
      });
    }
    for (const fixture of scene.fixtures) {
      const material = materials[fixture.materialVersionId];
      if (!material) throw new Error(fixture.name + ': 저장된 제품 버전을 찾지 못했습니다.');
      const assetId =
        material.views[fixture.viewIndex]?.assetId ||
        material.views[0]?.assetId ||
        material.imageAssetIds[fixture.viewIndex] ||
        material.coverAssetId;
      const texture = await this.getTexture(
        assetId,
        quality.previewEdge === undefined ? this.maxOutputEdge : sourceEdge,
      );
      if (!current()) return;
      // An invalid in-progress planar handle must not fall back to a misleading screen rectangle.
      if (fixture.projectedQuad && !validateQuad(fixture.projectedQuad)) continue;
      const id = namespace + ':fixture:' + fixture.id;
      maskIds.push(id);
      fixtures.push({
        fixture,
        texture,
        inverse: fixture.projectedQuad ? new Matrix3().set(...homography(fixture.projectedQuad)) : undefined,
        occlusion: this.getMask(id, fixture.occlusion, maskSize.width, maskSize.height),
      });
    }
    if (!current()) return;
    return { scene, original, background, tiles, fixtures, maskIds, shadingIds: [...shadingIds] };
  }

  private async prepareSnapshot(
    snapshot: RenderSnapshot,
    assetReader: AssetReader,
    quality: SnapshotQuality,
  ): Promise<void> {
    if (this.disposed) throw new Error('렌더러가 닫혔습니다.');
    if (
      snapshot.beforeScene &&
      Math.abs(
        snapshot.beforeScene.imageWidth / snapshot.beforeScene.imageHeight -
          snapshot.scene.imageWidth / snapshot.scene.imageHeight,
      ) > 0.00001
    )
      throw new Error('Before와 After의 화면 비율이 같아야 비교할 수 있어요.');
    const generation = ++this.generation;
    this.reader = assetReader;
    const before = snapshot.beforeScene;
    const versionIds = before
      ? [
          ...new Set(
            [
              ...before.surfaces.map((surface) => surface.materialVersionId),
              ...before.fixtures.map((fixture) => fixture.materialVersionId),
            ].filter((id): id is string => !!id),
          ),
        ].sort()
      : [];
    // The content key survives store clones, and excludes unrelated After materials and UI state.
    const beforeKey = before
      ? JSON.stringify([before, versionIds.map((id) => snapshot.materials[id]), quality])
      : '';
    const reused = beforeKey && beforeKey === this.beforePreparedKey ? this.beforePrepared : undefined;
    const [afterPrepared, beforePrepared] = await Promise.all([
      this.prepareScene(snapshot.scene, snapshot.materials, quality, 'after', generation),
      before
        ? (reused ?? this.prepareScene(before, snapshot.materials, quality, 'before', generation))
        : undefined,
    ]);
    if (generation !== this.generation || this.disposed || !afterPrepared || (before && !beforePrepared))
      return;
    this.snapshot = snapshot;
    this.original = afterPrepared.original;
    this.background = afterPrepared.background;
    this.tilePasses = afterPrepared.tiles;
    this.fixturePasses = afterPrepared.fixtures;
    this.quality = quality;
    if (beforeKey !== this.beforePreparedKey) this.beforeRenderedKey = '';
    this.beforePrepared = beforePrepared;
    this.beforePreparedKey = beforeKey;
    const liveTextures = new Set<Texture>();
    for (const prepared of [afterPrepared, beforePrepared]) {
      if (!prepared) continue;
      for (const tile of prepared.tiles) {
        liveTextures.add(tile.mask);
        liveTextures.add(tile.shading);
      }
      for (const fixture of prepared.fixtures) liveTextures.add(fixture.occlusion);
    }
    // A superseded async preparation may retire a texture still used by the winning cached Before.
    for (const texture of this.retiredMasks.splice(0)) {
      if (liveTextures.has(texture)) this.retiredMasks.push(texture);
      else texture.dispose();
    }
    const liveMaskIds = new Set([...afterPrepared.maskIds, ...(beforePrepared?.maskIds ?? [])]);
    for (const [id, entry] of this.masks)
      if (!liveMaskIds.has(id)) {
        entry.texture.dispose();
        this.masks.delete(id);
      }
    const liveShadingIds = new Set([...afterPrepared.shadingIds, ...(beforePrepared?.shadingIds ?? [])]);
    for (const [id, entry] of this.shadingCache) {
      if (liveShadingIds.has(id)) continue;
      this.shadingCache.delete(id);
      void entry.promise.then((field) => field.texture.dispose()).catch(() => {});
    }
  }

  private draw(material: ShaderMaterial, target: WebGLRenderTarget | null): void {
    this.mesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  private composeScene(
    scene: EditorScene,
    background: Texture,
    tiles: TilePass[],
    fixtures: FixturePass[],
  ): Texture {
    let index = 0;
    uniform(this.backgroundMaterial, 'image', background);
    this.draw(this.backgroundMaterial, this.targets[index]);
    for (const {
      surface,
      material,
      atlas,
      columns,
      count,
      mask,
      inverse,
      shading,
      referenceLuminance,
    } of tiles) {
      const shader = this.tileMaterial;
      const values: Record<string, unknown> = {
        previousImage: this.targets[index].texture,
        atlas,
        areaMask: mask,
        shadingImage: shading,
        inversePlane: inverse,
        planeSize: new Vector2(surface.widthMm, surface.heightMm),
        tileSize: new Vector2(material.widthMm, material.heightMm),
        offset: new Vector2(surface.tile.offsetX, surface.tile.offsetY),
        angle: (surface.tile.rotation * Math.PI) / 180,
        groutWidth: Math.max(0, surface.tile.groutWidth),
        groutColor: new Color(surface.tile.groutColor),
        brick: surface.tile.pattern === 'brick' ? 1 : 0,
        seed: surface.tile.seed,
        variantCount: count,
        atlasColumns: columns,
        atlasPixels: (atlas.image as HTMLCanvasElement).width,
        shading: Math.max(0, Math.min(1, surface.tile.shading)),
        meanLuminance: referenceLuminance,
        adjustment: colorVector(surface.color),
      };
      Object.entries(values).forEach(([key, value]) => uniform(shader, key, value));
      index = 1 - index;
      this.draw(shader, this.targets[index]);
    }
    for (const { fixture, texture, occlusion, inverse } of fixtures) {
      const shader = this.fixtureMaterial;
      const values: Record<string, unknown> = {
        previousImage: this.targets[index].texture,
        product: texture,
        occlusion,
        photoSize: new Vector2(scene.imageWidth / scene.imageHeight, 1),
        productPosition: new Vector2(fixture.position.x, fixture.position.y),
        productSize: new Vector2(Math.max(0.0001, fixture.width), Math.max(0.0001, fixture.height)),
        anchor: new Vector2(fixture.anchor.x, fixture.anchor.y),
        angle: (fixture.rotation * Math.PI) / 180,
        projective: inverse ? 1 : 0,
        inverseProduct: inverse ?? new Matrix3(),
        adjustment: colorVector(fixture.color),
        shadowOffset: new Vector2(fixture.shadow.x, fixture.shadow.y),
        shadowOpacity: fixture.shadow.opacity,
        shadowBlur: fixture.shadow.blur,
        shadowScale: fixture.shadow.scale,
      };
      Object.entries(values).forEach(([key, value]) => uniform(shader, key, value));
      index = 1 - index;
      this.draw(shader, this.targets[index]);
    }
    return this.targets[index].texture;
  }

  render(width: number, height: number, mode: CompareMode = 'after', split = 0.5): HTMLCanvasElement {
    if (this.disposed) throw new Error('렌더러가 닫혔습니다.');
    if (this.lost) throw new Error('그래픽 연결이 중단되었습니다. 잠시 기다린 뒤 다시 시도해 주세요.');
    if (!this.snapshot || !this.original || !this.background)
      throw new Error('렌더링할 사진을 먼저 불러와 주세요.');
    const size = fitOutput(width, height, this.maxOutputEdge);
    if (this.canvas.width !== size.width || this.canvas.height !== size.height) {
      this.renderer.setSize(size.width, size.height, false);
      this.targets.forEach((target) => target.setSize(size.width, size.height));
    }
    const before = this.beforePrepared;
    if (before && mode !== 'after') {
      const key = this.beforePreparedKey + ':' + size.width + ':' + size.height;
      if (this.beforeRenderedKey !== key) {
        this.beforeTarget.setSize(size.width, size.height);
        const texture = this.composeScene(before.scene, before.background, before.tiles, before.fixtures);
        uniform(this.copyMaterial, 'image', texture);
        this.draw(this.copyMaterial, this.beforeTarget);
        this.beforeRenderedKey = key;
      }
    }
    const edited =
      mode !== 'before'
        ? this.composeScene(this.snapshot.scene, this.background, this.tilePasses, this.fixturePasses)
        : this.targets[0].texture;
    const final = this.outputMaterial;
    uniform(final, 'edited', edited);
    uniform(final, 'original', this.original);
    uniform(final, 'beforeEdited', this.beforeTarget.texture);
    uniform(final, 'hasBeforeScene', before ? 1 : 0);
    uniform(final, 'beforeAdjustment', colorVector(before?.scene.color ?? this.snapshot.scene.color));
    uniform(final, 'adjustment', colorVector(this.snapshot.scene.color));
    uniform(final, 'mode', mode === 'before' ? 0 : mode === 'after' ? 1 : 2);
    uniform(final, 'splitPosition', Math.max(0, Math.min(1, split)));
    this.draw(final, null);
    this.lastView = { mode, split };
    return this.canvas;
  }

  /** Compare export places full before/after images side by side; total long edge stays <= 4096. */
  async exportImage(
    snapshot: RenderSnapshot,
    width: number,
    height: number,
    format: 'image/png' | 'image/jpeg',
    compare: boolean,
  ): Promise<Blob> {
    if (this.exporting) await this.exporting;
    if (!this.reader) throw new Error('편집할 사진을 먼저 열어 주세요.');
    const beforeSnapshot = this.snapshot;
    const beforeReader = this.reader;
    const beforeQuality = this.quality;
    const beforeSize = { width: this.canvas.width, height: this.canvas.height };
    const beforeView = this.lastView;
    let release = () => {};
    this.exporting = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const scene = snapshot.scene;
      const maxOriginal = Math.max(scene.imageWidth, scene.imageHeight);
      // Keep the source aspect ratio regardless of export input; dimensions specify the pixel budget.
      const requested = Math.max(1, Math.min(Math.max(width, height), maxOriginal, this.maxOutputEdge));
      const aspect = scene.imageWidth / scene.imageHeight;
      const combinedAspect = aspect * (compare ? 2 : 1);
      const output =
        combinedAspect >= 1
          ? { width: Math.round(requested), height: Math.max(1, Math.round(requested / combinedAspect)) }
          : { width: Math.max(1, Math.round(requested * combinedAspect)), height: Math.round(requested) };
      const panelWidth = compare ? Math.max(1, Math.floor(output.width / 2)) : output.width;
      await this.prepareSnapshot(snapshot, beforeReader, {
        quality: 'export',
        maskWidth: panelWidth,
        maskHeight: output.height,
      });
      const canvas = document.createElement('canvas');
      canvas.width = output.width;
      canvas.height = output.height;
      const ctx = context2d(canvas);
      if (compare) {
        ctx.drawImage(this.render(panelWidth, output.height, 'before'), 0, 0, panelWidth, output.height);
        ctx.drawImage(
          this.render(panelWidth, output.height, 'after'),
          panelWidth,
          0,
          output.width - panelWidth,
          output.height,
        );
      } else ctx.drawImage(this.render(output.width, output.height, 'after'), 0, 0);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('내보내기 이미지를 만들지 못했습니다.'))),
          format,
          0.94,
        ),
      );
    } finally {
      try {
        if (!this.disposed && beforeSnapshot) {
          await this.prepareSnapshot(beforeSnapshot, beforeReader, beforeQuality);
          if (beforeSize.width > 0 && beforeSize.height > 0)
            this.render(beforeSize.width, beforeSize.height, beforeView.mode, beforeView.split);
        }
      } finally {
        this.exporting = undefined;
        release();
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.geometry.dispose();
    [
      this.backgroundMaterial,
      this.tileMaterial,
      this.fixtureMaterial,
      this.outputMaterial,
      this.copyMaterial,
    ].forEach((m) => m.dispose());
    this.targets.forEach((t) => t.dispose());
    this.beforeTarget.dispose();
    this.textures.forEach((t) => t.dispose());
    this.masks.forEach((m) => m.texture.dispose());
    this.retiredMasks.splice(0).forEach((texture) => texture.dispose());
    this.atlases.forEach((p) => {
      void p.then((a) => a.texture.dispose()).catch(() => {});
    });
    this.shadingCache.forEach(({ promise }) => {
      void promise.then((s) => s.texture.dispose()).catch(() => {});
    });
    this.images.clear();
    this.textures.clear();
    this.masks.clear();
    this.atlases.clear();
    this.shadingCache.clear();
    this.luminanceCache.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
