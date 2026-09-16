export const FLUX_MODELS = {
  '4b': '@cf/black-forest-labs/flux-2-klein-4b',
  '9b': '@cf/black-forest-labs/flux-2-klein-9b',
} as const;
export type FluxVariant = keyof typeof FLUX_MODELS;
export const FLUX_GATEWAY = 'sjn-gateway';
// Cloudflare's klein editing guide requires reference images smaller than 512px.
export const FLUX_INPUT_EDGE = 496;
export const FLUX_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const FLUX_PROMPT = `Edit image 0 into a photorealistic photograph of the same completed interior, photographed on site by an architectural photographer. Preserve exactly the camera viewpoint, framing, room geometry, walls, floor, ceiling, doors, windows, and every fixture's count, position, orientation, shape and installation method. Preserve the selected materials, tile colors, tile dimensions, grout pattern and spacing. Only improve photographic realism: physically plausible lighting, contact shadows, subtle material texture, ceramic glaze, metal reflections and transparent glass. Natural exposure and neutral white balance. Do not redesign, add or remove objects, change the layout, recolor materials, add people, text, labels or watermarks. This is a faithful photographic visualization of image 0, not a new design.`;
export function fluxDimensions(width: number, height: number) {
  const scale = Math.min(1, FLUX_INPUT_EDGE / Math.max(width, height));
  // Pad, rather than stretch or crop, to the provider's 16px grid.
  return {
    width: Math.max(128, Math.min(FLUX_INPUT_EDGE, Math.ceil((width * scale) / 16) * 16)),
    height: Math.max(128, Math.min(FLUX_INPUT_EDGE, Math.ceil((height * scale) / 16) * 16)),
  };
}
