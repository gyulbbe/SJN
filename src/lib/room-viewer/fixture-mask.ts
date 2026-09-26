import { Matrix3, ShaderMaterial, type Material, type Texture } from 'three';

/**
 * Flat stand-in materials for a fixture id pass (AI result protection): each fixture draws its
 * index in the red channel, everything else draws 0 and so hides what is behind it. Cut-out photo
 * planes keep their alpha test, so the silhouette is the product's, not its rectangle. Transparent
 * materials (glass) draw nothing: they hide nothing.
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

type Maybe = Material & {
  map?: Texture | null;
  alphaTest?: number;
  transparent?: boolean;
  opacity?: number;
};

export function fixtureMaskMaterial(original: Material, index: number): ShaderMaterial {
  const source = original as Maybe;
  const glass = source.transparent === true && (source.opacity ?? 1) < 1;
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
    colorWrite: !glass,
    depthWrite: !glass,
    depthTest: true,
  });
}

/** GL rows run bottom-up; ids come back top-down, one byte per pixel. */
export function maskFromPixels(pixels: Uint8Array, width: number, height: number) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data[y * width + x] = pixels[((height - 1 - y) * width + x) * 4];
  return data;
}
