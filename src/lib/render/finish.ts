/** How light plays on a material surface, derived from its free-text finish (마감). */
export type FinishAppearance = {
  /** PBR roughness for the 3D viewer. */
  roughness: number;
  /** PBR metalness for the 3D viewer. */
  metalness: number;
  /** 0–1 strength of the front-view sheen, which also scales with the photo-shading strength. */
  gloss: number;
};

/** Empty or unrecognised finishes keep the long-standing matte look of existing projects. */
export const MATTE_FINISH: FinishAppearance = Object.freeze({ roughness: 0.83, metalness: 0, gloss: 0 });

// Checked in order, so a combined label such as "유광 폴리싱" resolves to the most specific finish.
const RULES: readonly (readonly [RegExp, FinishAppearance])[] = [
  [/크롬|chrome|미러|mirror/, { roughness: 0.18, metalness: 0.85, gloss: 0.9 }],
  [/브러시|brushed|헤어라인|hairline/, { roughness: 0.42, metalness: 0.7, gloss: 0.35 }],
  [/폴리싱|폴리시드|polish|하이\s*글로시|high\s*gloss/, { roughness: 0.12, metalness: 0, gloss: 1 }],
  // Before the plain gloss rule, so "semi-gloss" stays semi.
  [/반광|세미|semi|새틴|satin|라파토|lappato/, { roughness: 0.45, metalness: 0, gloss: 0.4 }],
  [/유광|글로시|glossy|gloss/, { roughness: 0.24, metalness: 0, gloss: 0.8 }],
  [/무광|매트|matt?e?\b|엠보|emboss|논슬립|non-?slip/, MATTE_FINISH],
];

export function finishAppearance(finish: string | undefined): FinishAppearance {
  const text = (finish ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return MATTE_FINISH;
  for (const [pattern, appearance] of RULES) if (pattern.test(text)) return appearance;
  return MATTE_FINISH;
}
