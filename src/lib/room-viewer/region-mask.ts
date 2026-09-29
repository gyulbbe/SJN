import { Matrix3, ShaderMaterial, type Material, type Texture } from 'three';

/**
 * Flat stand-in materials for a region pass (FLUX result colour check): each wall or floor draws
 * its region number in the red channel, fixtures (glass included) draw 255, and everything else
 * (ceiling, background) 0. Cut-out product photos keep their alpha test, so a fixture covers its
 * silhouette, not its rectangle.
 */
const vertexShader = `
uniform mat3 mapTransform;
varying vec2 vUv;
void main() {
  vUv = (mapTransform * vec3(uv, 1.)).xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`;
const fragmentShader = `
uniform sampler2D map;
uniform float useMap;
uniform float cutoff;
uniform float index;
varying vec2 vUv;
void main() {
  if (useMap > .5 && texture2D(map, vUv).a < cutoff) discard;
  gl_FragColor = vec4(index / 255., 0., 0., 1.);
}`;

type Maybe = Material & { map?: Texture | null; alphaTest?: number; transparent?: boolean };

export function regionMaskMaterial(original: Material, index: number): ShaderMaterial {
  const source = original as Maybe;
  const map = source.map ?? null;
  const cutout = !!map && ((source.alphaTest ?? 0) > 0 || source.transparent === true);
  if (map?.matrixAutoUpdate) map.updateMatrix();
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      map: { value: cutout ? map : null },
      mapTransform: { value: cutout ? map!.matrix.clone() : new Matrix3() },
      useMap: { value: cutout ? 1 : 0 },
      cutoff: { value: Math.max(0.5, source.alphaTest ?? 0) },
      index: { value: index },
    },
    side: original.side,
    depthWrite: true,
    depthTest: true,
  });
}

const coverageFragment = `
uniform sampler2D map;
uniform float useMap;
uniform float cutoff;
uniform float value;
uniform float opacity;
varying vec2 vUv;
void main() {
  if (useMap > .5 && texture2D(map, vUv).a < cutoff) discard;
  gl_FragColor = vec4(vec3(value), opacity);
}`;
/**
 * How much of each pixel a fixture covers, for the composite FLUX export's fixture layer: fixtures
 * draw white at their own opacity (glass lets the room through), every other mesh black and
 * opaque so walls still hide what is behind them. Drawn into a multisampled target, so edges get
 * the same partial coverage as the render's antialiasing; cut-out photos keep their alpha test.
 */
export function coverageMaterial(original: Material, fixture: boolean): ShaderMaterial {
  const source = original as Maybe & { opacity?: number };
  const map = source.map ?? null;
  const cutout = !!map && ((source.alphaTest ?? 0) > 0 || source.transparent === true);
  if (map?.matrixAutoUpdate) map.updateMatrix();
  const opacity = fixture && source.transparent ? Math.max(0, Math.min(1, source.opacity ?? 1)) : 1;
  return new ShaderMaterial({
    vertexShader,
    fragmentShader: coverageFragment,
    uniforms: {
      map: { value: cutout ? map : null },
      mapTransform: { value: cutout ? map!.matrix.clone() : new Matrix3() },
      useMap: { value: cutout ? 1 : 0 },
      // The render's own alpha test, so the covered silhouette is exactly the drawn one.
      cutoff: { value: (source.alphaTest ?? 0) > 0 ? source.alphaTest! : 0.5 },
      value: { value: fixture ? 1 : 0 },
      opacity: { value: opacity },
    },
    side: original.side,
    transparent: opacity < 1,
    depthWrite: opacity >= 1,
    depthTest: true,
  });
}

/** GL rows run bottom-up; labels come back top-down, one byte per pixel. */
/**
 * 1 where no mesh drew (the background around the room and through its open side), from the alpha
 * a region pass leaves: every mesh writes 1, the clear is 0. Top-down like labelsFromPixels.
 */
export function backgroundFromPixels(pixels: Uint8Array, width: number, height: number) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data[y * width + x] = pixels[((height - 1 - y) * width + x) * 4 + 3] < 128 ? 1 : 0;
  return data;
}
export function labelsFromPixels(pixels: Uint8Array, width: number, height: number) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data[y * width + x] = pixels[((height - 1 - y) * width + x) * 4];
  return data;
}
