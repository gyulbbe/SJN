// The material ids of the side-tile AI trial's scenes (specs.ts), as tests/fixture-haze/specs.ts (`gloss`)
// names them. Its basins (Z08L, Z23L, Z01L, LL-821) were registered on a local dev server only; the public
// catalogue has no basin at all (checked 2026-11-21: 2023 tiles, 10 toilets, 1 shower, 1 bath), so the
// scenes keep only their toilets.
export const TILES = {
  olive: '9d4e3ac5-bbca-4a25-96c8-cd2ba51701b6', // SI ROMAN OLVIE-G, olive glossy brick
  black: '1997a51c', // HE 비셀라도 니그로 브릴로, black glossy
  beige: '8e8c1545', // 타일의 기준 6134P, beige polished porcelain
  white: '21ddf554', // HSC DW 9467, white glossy ceramic
  greyFloor: 'c6aa6574-e315-4583-b375-5c1addf6a4bc', // 66517, grey 600 × 600 glossy
  stoneFloor: '591b59df-0c9c-473b-bd86-4a78a8d67050', // FOR-GRIGIO, grey stone 600 × 600
};
export const TOILETS = {
  lc3200: '1a226a9e-', // LAUCHE 포레 원피스 LC-3200
  lc2200: '6e8f9d83-', // LAUCHE 포레 투피스 LC-2200
  lc3100j: 'a857131f-', // LAUCHE 아크 원피스 LC-3100J
  hsc606: 'd41fd984-', // HSC 606J/608J 투피스
};
export const NEEDED = [...Object.values(TILES), ...Object.values(TOILETS)];
