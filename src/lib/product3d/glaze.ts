import { PMREMGenerator, type Texture, type WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * The glaze of white ceramic. A 360° product drawn with the lit colours has a rough matte surface
 * with no reflection, which reads as clay. Glazed ceramic is smooth and shows a soft highlight and a
 * faint reflection of its surroundings, so ceramic products can be drawn with a glaze: lower
 * roughness, a thin clear coat, and a soft reflection of a studio-like environment made in code
 * (no file). Wood, metal and glass are left as they are.
 */
export type ProductGloss = 'none' | 'light' | 'normal';
export const PRODUCT_GLOSSES: readonly ProductGloss[] = ['none', 'light', 'normal'];
export const GLOSS_LABELS: Record<ProductGloss, string> = {
  none: '광택 없음',
  light: '약하게',
  normal: '보통',
};

/**
 * The categories drawn glazed: the ceramic ones. A vanity (세면대장) may be wood or a cabinet, a faucet
 * is metal, a mirror is glass: all of those, and any category not named here, keep the matte material.
 */
export const GLAZED_CATEGORIES: ReadonlySet<string> = new Set(['toilet', 'basin', 'bath']);
export const canGlaze = (category: string | undefined) => !!category && GLAZED_CATEGORIES.has(category);
/** The gloss a product is drawn with: what was chosen for a glazed category, else none. */
export const glossFor = (category: string | undefined, gloss: ProductGloss | undefined): ProductGloss =>
  canGlaze(category) && gloss && PRODUCT_GLOSSES.includes(gloss) ? gloss : 'none';

export interface Glaze {
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  /**
   * The editor's lights (key light, sky light) and the environment's reflection, as multiples of the
   * matte material's values. The glaze lights itself too (the environment adds diffuse light and its
   * surface reflects), and a white product has little room before it blows out, so the environment is
   * kept faint, the specular reflection is cut (`specular`), and the lights are set so a white glaze
   * facing the viewer is as bright as the matte one (within 3%). Measured by
   * tests/product3d-gloss-browser.ts.
   */
  editor: { key: number; sky: number; environment: number; specular: number };
  /** The room has its own environment (see room-viewer/renderer.ts); only the surface changes there. */
  room: { roughness: number; clearcoat: number; clearcoatRoughness: number };
}

export const GLAZE: Record<Exclude<ProductGloss, 'none'>, Glaze> = {
  light: {
    roughness: 0.35,
    clearcoat: 0.25,
    clearcoatRoughness: 0.2,
    editor: { key: 1.2, sky: 0.65, environment: 0.06, specular: 0.5 },
    room: { roughness: 0.35, clearcoat: 0.25, clearcoatRoughness: 0.2 },
  },
  normal: {
    roughness: 0.25,
    clearcoat: 0.8,
    clearcoatRoughness: 0.06,
    editor: { key: 1.25, sky: 0.5, environment: 0.12, specular: 0.5 },
    room: { roughness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.06 },
  },
};

const environments = new WeakMap<WebGLRenderer, { texture: Texture; dispose: () => void }>();

/**
 * A soft studio-like environment (three's room of boxes lit from above and the sides), made once per
 * renderer by the PMREM generator and shared by every glazed material of that renderer. Nothing is
 * downloaded. Undefined when the renderer cannot make it (the glaze then has no reflection, only
 * the lower roughness).
 */
export function glazeEnvironment(renderer: WebGLRenderer): Texture | undefined {
  const known = environments.get(renderer);
  if (known) return known.texture;
  const generator = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  try {
    const target = generator.fromScene(room, 0.04);
    environments.set(renderer, { texture: target.texture, dispose: () => target.dispose() });
    return target.texture;
  } catch {
    return undefined;
  } finally {
    generator.dispose();
    room.dispose();
  }
}

/** Frees the environment made for `renderer` (called as the renderer goes). */
export function disposeGlazeEnvironment(renderer: WebGLRenderer) {
  environments.get(renderer)?.dispose();
  environments.delete(renderer);
}
