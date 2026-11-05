import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  SRGBColorSpace,
} from 'three';

/**
 * Tile atlases of the 2D compositor and the 3D room renderer: one square cell per pattern variant,
 * read with mipmaps so fine ribs and brick edges average out instead of breaking into bands when a
 * tile is drawn small (docs/tile-mipmap-results-20261105.md).
 */

/**
 * How far the mipmap level is moved. 0 averages what one screen pixel covers, which with trilinear
 * filtering is a little softer than a render at 3× scaled down (brick-sheet edges); −0.5 is sharper
 * but lets stripes near the pixel limit break up again; −1 brings back faint bands. The user chose
 * "as in reality, fine" (Q1 in the results document); −0.25 was the one value that passed every
 * synthetic check on SwiftShader and D3D11 and came closest to the 3× reference over six real tiles.
 */
export const TILE_LOD_BIAS = -0.25;
/** Anisotropic filtering keeps ribs on walls and floors seen at an angle from blurring sideways. */
const MAX_TILE_ANISOTROPY = 8;
/**
 * The atlas is stored as sRGB (SRGB8_ALPHA8), so the GPU decodes before it filters and builds the
 * mipmaps in linear light: thin dark and light lines then average to their real brightness.
 * The shaders read linear colour and do not decode it again.
 */
export const TILE_ATLAS_SRGB = true;

export type TileAtlasLayout = {
  columns: number;
  /** Pixels of one variant's square image. */
  cell: number;
  /**
   * Edge pixels repeated around each cell when there are several cells, so blurred levels and
   * filtering stay inside one variant. 0 for a single cell, which the texture's edge clamps.
   */
  gutter: number;
  /** The atlas edge in pixels. */
  size: number;
  /** The most blurred mipmap level that still reads one cell only. */
  maxLod: number;
};

/**
 * The cell layout of `count` variants: cells up to `maxCell` pixels in an atlas up to `maxEdge`.
 * One variant keeps the previous layout exactly (one cell, no gutter). Several get a power-of-two
 * gutter (a sixteenth of the cell, at least 4) and cells that are a multiple of it, so every
 * mipmap level up to log2(gutter) splits on cell boundaries.
 */
export function tileAtlasLayout(count: number, maxCell: number, maxEdge: number): TileAtlasLayout {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  if (columns === 1) {
    const cell = Math.floor(Math.min(maxCell, maxEdge));
    return { columns, cell, gutter: 0, size: cell, maxLod: 16 };
  }
  const fit = Math.floor(maxEdge / columns);
  const gutter = Math.max(4, 2 ** Math.floor(Math.log2(Math.max(1, Math.min(maxCell, fit) / 16))));
  const cell = Math.floor(Math.min(maxCell, fit - 2 * gutter) / gutter) * gutter;
  return { columns, cell, gutter, size: columns * (cell + 2 * gutter), maxLod: Math.log2(gutter) };
}

/** Draws variant `index` into its cell (smoothly scaled) and repeats its edge pixels into its gutter. */
export function drawTileCell(
  ctx: CanvasRenderingContext2D,
  layout: TileAtlasLayout,
  index: number,
  source: CanvasImageSource,
): void {
  const { columns, cell, gutter } = layout;
  const stride = cell + 2 * gutter;
  const x = (index % columns) * stride + gutter,
    y = Math.floor(index / columns) * stride + gutter;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x, y, cell, cell);
  if (!gutter) return;
  // Nearest-neighbour stretches of the one-pixel edges: exact copies, nothing from the next cell.
  const canvas = ctx.canvas;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, x, y, cell, 1, x, y - gutter, cell, gutter);
  ctx.drawImage(canvas, x, y + cell - 1, cell, 1, x, y + cell, cell, gutter);
  ctx.drawImage(
    canvas,
    x,
    y - gutter,
    1,
    cell + 2 * gutter,
    x - gutter,
    y - gutter,
    gutter,
    cell + 2 * gutter,
  );
  ctx.drawImage(
    canvas,
    x + cell - 1,
    y - gutter,
    1,
    cell + 2 * gutter,
    x + cell,
    y - gutter,
    gutter,
    cell + 2 * gutter,
  );
  ctx.imageSmoothingEnabled = true;
}

/** The atlas as a mipmapped texture; `maxAnisotropy` is the renderer's capability (1 without it). */
export function tileAtlasTexture(canvas: HTMLCanvasElement, maxAnisotropy: number): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = TILE_ATLAS_SRGB ? SRGBColorSpace : NoColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.anisotropy = Math.max(1, Math.min(MAX_TILE_ANISOTROPY, Math.floor(maxAnisotropy) || 1));
  return texture;
}

/** The shader's `shape` (columns, cell, gutter, size) and `lod` (bias, most blurred level). */
export function tileAtlasUniforms(layout: TileAtlasLayout): {
  layout: [number, number, number, number];
  lod: [number, number];
} {
  return {
    layout: [layout.columns, layout.cell, layout.gutter, layout.size],
    lod: [TILE_LOD_BIAS, layout.maxLod],
  };
}

/**
 * GLSL shared by both renderers. `uv` is 0–1 inside the tile and `cell` the variant's column and
 * row. `dx`/`dy` are the screen derivatives of the continuous tile coordinate (millimetres over the
 * tile size, before the brick shift and the repeat): taken from the repeating coordinate, a tile
 * edge would jump by a whole tile and pick the most blurred level, drawing a line along every edge.
 * The level is moved by `lod.x` and kept at or below `lod.y` so it never reaches another variant.
 * Returns the texel as stored: linear when TILE_ATLAS_SRGB, else sRGB values to decode.
 */
export const TILE_SAMPLE_GLSL = `
vec4 sjnTileTexel(sampler2D atlas,vec2 uv,vec2 cell,vec2 dx,vec2 dy,vec4 shape,vec2 lod){
 float stride=shape.y+2.*shape.z;
 vec2 texel=cell*stride+shape.z+clamp(uv,0.,1.)*shape.y;
 vec2 at=vec2(texel.x,shape.w-texel.y)/shape.w;
 vec2 scale=vec2(1.,-1.)*(shape.y/shape.w)*exp2(lod.x);
 dx*=scale;dy*=scale;
 float level=log2(max(max(length(dx),length(dy))*shape.w,1e-8));
 float excess=exp2(-max(0.,level-lod.y));
 return textureGrad(atlas,at,dx*excess,dy*excess);
}
`;
