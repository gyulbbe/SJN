import type { Point } from '../types';
export type DesignView = { zoom: number; center: Point };
export const fittedDesignView = (): DesignView => ({ zoom: 1, center: { x: 0.5, y: 0.5 } });
export function clampDesignView(view: DesignView): DesignView {
  const zoom = Math.max(1, Math.min(5, Number.isFinite(view.zoom) ? view.zoom : 1));
  const inset = 0.5 / zoom;
  const axis = (value: number) => Math.max(inset, Math.min(1 - inset, Number.isFinite(value) ? value : 0.5));
  return { zoom, center: { x: axis(view.center.x), y: axis(view.center.y) } };
}
export function panDesignView(
  view: DesignView,
  dx: number,
  dy: number,
  fitWidth: number,
  fitHeight: number,
): DesignView {
  if (fitWidth <= 0 || fitHeight <= 0) return view;
  return clampDesignView({
    ...view,
    center: {
      x: view.center.x - dx / (fitWidth * view.zoom),
      y: view.center.y - dy / (fitHeight * view.zoom),
    },
  });
}
/** Anchor is normalized to the fitted image; it can lie outside 0..1 in the letterbox. */
export function zoomDesignView(
  view: DesignView,
  zoom: number,
  anchor: Point = { x: 0.5, y: 0.5 },
): DesignView {
  const next = Math.max(1, Math.min(5, zoom));
  return clampDesignView({
    zoom: next,
    center: {
      x: view.center.x + (anchor.x - 0.5) * (1 / view.zoom - 1 / next),
      y: view.center.y + (anchor.y - 0.5) * (1 / view.zoom - 1 / next),
    },
  });
}
export function fitDesignBox(width: number, height: number, aspect: number) {
  if (width <= 0 || height <= 0 || !Number.isFinite(aspect) || aspect <= 0) return { width: 1, height: 1 };
  return width / height > aspect ? { width: height * aspect, height } : { width, height: width / aspect };
}
export function comparisonPreviewEdge(fitWidth: number, fitHeight: number, zoom: number, dpr = 1) {
  const needed = Math.max(fitWidth, fitHeight) * zoom * Math.max(1, Math.min(2, dpr));
  return [512, 1024, 1536, 2048].find((edge) => edge >= needed) ?? 2048;
}
