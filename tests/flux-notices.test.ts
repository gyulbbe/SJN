import { describe, it, expect } from 'vitest';
import { fluxResultNotices, readFluxCheck, type FluxProductLabel } from '../src/lib/ai-export/notices';
import type { FluxCheckResult } from '../src/lib/ai-export/check-contract';
import type { FaceChange } from '../src/lib/ai-export/color';

/** The 2026-09-27 user example: basin and shower on the left wall, toilet on the floor. */
const placed = [
  { kind: 'basin', face: 'left' },
  { kind: 'shower', face: 'left' },
  { kind: 'toilet', face: 'floor' },
] as const;
const products: FluxProductLabel[] = [
  { id: 'b', label: '세면대', where: '왼쪽', face: 'left' },
  { id: 's', label: '샤워', where: '왼쪽', face: 'left' },
  { id: 't', label: '양변기', where: '오른쪽 아래', face: 'floor' },
];
const answer = (patch: Partial<FluxCheckResult> = {}): FluxCheckResult => ({
  fixtures: [
    { index: 1, kind: 'basin', present: 'yes', seenAs: 'basin' },
    { index: 2, kind: 'shower', present: 'yes', seenAs: 'shower' },
    { index: 3, kind: 'toilet', present: 'yes', seenAs: 'toilet' },
  ],
  extras: [],
  ...patch,
});
const warm: FaceChange = {
  region: 1,
  kind: 'wall',
  reference: [88, 0, 2.5],
  result: [75, 1, 4.5],
  deltaE: 12,
  colorDeltaE: 2.4,
  shift: 'warmer',
};

describe('reading the FLUX check against the placed fixtures', () => {
  it('reads the user example: shower gone from the left wall and a shower on the right is a move', () => {
    const reading = readFluxCheck(
      answer({
        fixtures: [
          { index: 1, kind: 'basin', present: 'yes', seenAs: 'basin' },
          { index: 2, kind: 'shower', present: 'no', seenAs: 'none' },
          { index: 3, kind: 'toilet', present: 'yes', seenAs: 'toilet' },
        ],
        extras: [
          { kind: 'shelf', place: 'right' },
          { kind: 'showerHead', place: 'right' },
          { kind: 'glassPartition', place: 'middle' },
        ],
      }),
      placed,
    );
    expect(reading.moved).toEqual([{ index: 1, to: 'right' }]);
    expect(reading.missing).toEqual([]);
    // Large, room-changing objects are reported; a small shelf is kept with the answer only.
    expect(reading.extras).toEqual([{ kind: 'glassPartition', place: 'middle' }]);
    expect(reading.minor).toEqual([{ kind: 'shelf', place: 'right' }]);
  });

  it('takes an extra of a placed kind on its own or a neighbouring wall as that fixture, far away as a second one', () => {
    const reading = readFluxCheck(
      answer({
        extras: [
          { kind: 'showerHead', place: 'left' },
          // A left-wall shower in a corner view named on the back wall (2026-09-27 right corner 424242).
          { kind: 'showerHead', place: 'back' },
          { kind: 'showerHead', place: 'right' },
          { kind: 'toilet', place: 'back' },
          { kind: 'basin', place: 'left' },
        ],
      }),
      placed,
    );
    expect(reading.moved).toEqual([]);
    // The left/back shower head is the placed shower; a floor toilet "on the back wall" is the toilet.
    expect(reading.extras).toEqual([{ kind: 'showerHead', place: 'right' }]);
    expect(reading.minor).toEqual([]);
  });

  it('moves a missing floor fixture seen on a wall; one seen on its own face only drifted', () => {
    const missingToilet = answer({
      fixtures: [
        { index: 1, kind: 'basin', present: 'yes', seenAs: 'basin' },
        { index: 2, kind: 'shower', present: 'yes', seenAs: 'shower' },
        { index: 3, kind: 'toilet', present: 'no', seenAs: 'none' },
      ],
    });
    expect(
      readFluxCheck({ ...missingToilet, extras: [{ kind: 'toilet', place: 'left' }] }, placed),
    ).toMatchObject({
      moved: [{ index: 2, to: 'left' }],
      missing: [],
      extras: [],
    });
    expect(
      readFluxCheck({ ...missingToilet, extras: [{ kind: 'toilet', place: 'floor' }] }, placed),
    ).toMatchObject({
      moved: [],
      missing: [2],
      extras: [],
    });
  });

  it('does not call a fixture cut off by the left or right edge missing', () => {
    const cut = [
      { kind: 'basin', face: 'left', box: [0, 0.54, 0.09, 0.99] },
      { kind: 'shower', face: 'left', box: [0.15, 0.16, 0.21, 0.63] },
      { kind: 'toilet', face: 'floor', box: [0.63, 0.67, 0.85, 0.99] },
    ] as const;
    const none = answer({
      fixtures: [
        { index: 1, kind: 'basin', present: 'no', seenAs: 'none' },
        { index: 2, kind: 'shower', present: 'no', seenAs: 'none' },
        // Cut at the bottom only: still judged.
        { index: 3, kind: 'toilet', present: 'no', seenAs: 'other' },
      ],
    });
    expect(readFluxCheck(none, cut).missing).toEqual([1, 2]);
  });

  it('keeps an unknown face as the fixture itself (no warning on a guess)', () => {
    const reading = readFluxCheck(answer({ extras: [{ kind: 'basin', place: 'right' }] }), [
      { kind: 'basin' },
      { kind: 'shower' },
      { kind: 'toilet' },
    ]);
    expect(reading.extras).toEqual([]);
  });

  it('reports tile-layout answers and whether extras were checked at all', () => {
    const reading = readFluxCheck(
      answer({
        walls: [
          { face: 'left', uniformTiles: 'yes' },
          { face: 'back', uniformTiles: 'no' },
          { face: 'right', uniformTiles: 'unsure' },
        ],
      }),
      placed,
    );
    expect(reading.tiles).toEqual(['back']);
    expect(reading.extrasChecked).toBe(true);
    expect(readFluxCheck({ fixtures: answer().fixtures }, placed).extrasChecked).toBe(false);
  });
});

describe('FLUX result notices', () => {
  const done = (result: FluxCheckResult) =>
    ({ status: 'done', reading: readFluxCheck(result, placed) }) as const;

  it('orders products, added objects, tile layout, then colour in one box, with one retry line', () => {
    const notices = fluxResultNotices({
      products,
      check: done(
        answer({
          fixtures: [
            { index: 1, kind: 'basin', present: 'no', seenAs: 'other' },
            { index: 2, kind: 'shower', present: 'no', seenAs: 'none' },
            { index: 3, kind: 'toilet', present: 'yes', seenAs: 'toilet' },
          ],
          extras: [
            { kind: 'showerHead', place: 'right' },
            { kind: 'window', place: 'right' },
            { kind: 'glassPartition', place: 'middle' },
          ],
          walls: [{ face: 'back', uniformTiles: 'no' }],
        }),
      ),
      colors: { status: 'corrected', warnings: [warm] },
      corrected: false,
      showTiles: true,
    });
    expect(notices.warnings.map((w) => w.key)).toEqual(['products', 'extras', 'tiles', 'color']);
    expect(notices.warnings[0]).toEqual({
      key: 'products',
      title: '배치한 제품이 바뀌었을 수 있어요',
      lines: [
        '샤워가 왼쪽 벽에서 오른쪽 벽으로 옮겨졌을 수 있어요.',
        '세면대가 왼쪽에서 보이지 않거나 다른 물건으로 바뀌었을 수 있어요.',
      ],
    });
    expect(notices.warnings[1].lines).toEqual([
      '배치하지 않은 물건이 생겼을 수 있어요: 창문(오른쪽 벽), 유리 칸막이(가운데)',
    ]);
    expect(notices.warnings[2].lines).toEqual(['뒷벽 타일 배열이 원본과 달라 보여요.']);
    expect(notices.warnings[3].lines).toEqual(['벽 타일 색이 원본보다 따뜻하게(노랗게) 바뀌었을 수 있어요.']);
    expect(notices.suggestRetry).toBe(true);
    expect(notices.infos).toEqual([]);
  });

  it('says so plainly when everything checks out, and keeps tile answers out when hidden', () => {
    const notices = fluxResultNotices({
      products,
      check: done(answer({ walls: [{ face: 'back', uniformTiles: 'no' }] })),
      colors: { status: 'corrected', warnings: [] },
      corrected: true,
      showTiles: false,
    });
    expect(notices.warnings).toEqual([]);
    expect(notices.suggestRetry).toBe(false);
    expect(notices.infos.map((i) => i.text)).toEqual([
      '벽·바닥 색을 원래 자재 색에 맞췄어요. 명암·질감과 제품·유리는 AI 결과 그대로예요.',
      'AI 제품 확인: 배치한 제품 3개가 모두 보여요. 배치하지 않은 큰 물건도 보이지 않아요.',
    ]);
  });

  it('does not ask for a retry for a colour change alone (it is corrected) and keeps failures quiet', () => {
    const colorOnly = fluxResultNotices({
      products,
      colors: { status: 'corrected', warnings: [warm] },
      corrected: false,
      showTiles: true,
    });
    expect(colorOnly.warnings.map((w) => w.key)).toEqual(['color']);
    expect(colorOnly.suggestRetry).toBe(false);
    const failed = fluxResultNotices({
      products,
      check: { status: 'failed', message: 'Cloudflare AI 사용 한도를 모두 사용했어요.' },
      colors: { status: 'reframed' },
      corrected: true,
      showTiles: true,
    });
    expect(failed.warnings).toEqual([]);
    expect(failed.infos.map((i) => i.key)).toEqual(['color', 'check']);
    // An outside view the model reframed: its white margin was not put back either.
    const margin = fluxResultNotices({
      products,
      colors: { status: 'reframed' },
      corrected: true,
      showTiles: true,
      backdrop: 'reframed',
    });
    expect(margin.infos[0].text).toBe(
      'AI가 구도를 바꿔 벽·바닥 색을 원본과 비교하지 못했어요. 자재 색은 원본과 직접 비교해 주세요. 방 둘레 흰 여백도 되돌리지 못했으니, 여백에 생긴 벽·물건은 무시해 주세요.',
    );
    expect(failed.infos[1].text).toBe(
      'AI 제품 확인을 하지 못했어요. Cloudflare AI 사용 한도를 모두 사용했어요.',
    );
    // An older server's answer (no extras): no claim about added objects.
    const old = fluxResultNotices({
      products,
      check: done({ fixtures: answer().fixtures }),
      corrected: true,
      showTiles: true,
    });
    expect(old.infos.map((i) => i.text)).toEqual(['AI 제품 확인: 배치한 제품 3개가 모두 보여요.']);
  });

  it('uses 로 after a vowel and 으로 after a final consonant', () => {
    const notices = fluxResultNotices({
      products,
      check: done(
        answer({
          fixtures: [
            { index: 1, kind: 'basin', present: 'no', seenAs: 'none' },
            { index: 2, kind: 'shower', present: 'yes', seenAs: 'shower' },
            { index: 3, kind: 'toilet', present: 'yes', seenAs: 'toilet' },
          ],
          extras: [{ kind: 'basin', place: 'middle' }],
        }),
      ),
      corrected: true,
      showTiles: true,
    });
    expect(notices.warnings[0].lines).toEqual(['세면대가 왼쪽 벽에서 가운데로 옮겨졌을 수 있어요.']);
  });
});

describe('the composite export (fixtures composited on the model empty room)', () => {
  it('reports large objects and sanitary ware the model drew, the rest with the answer only', () => {
    const reading = readFluxCheck(
      {
        fixtures: [],
        extras: [
          { kind: 'showerHead', place: 'right' },
          { kind: 'mirror', place: 'back' },
          { kind: 'glassPartition', place: 'middle' },
          { kind: 'toilet', place: 'floor' },
        ],
      },
      placed,
      { emptyRoom: true },
    );
    expect(reading.extras).toEqual([
      { kind: 'glassPartition', place: 'middle' },
      { kind: 'showerHead', place: 'right' },
      { kind: 'toilet', place: 'floor' },
    ]);
    expect(reading.minor).toEqual([{ kind: 'mirror', place: 'back' }]);
    expect(reading.missing).toEqual([]);
    expect(reading.moved).toEqual([]);
  });

  it('warns first when the model moved the room, and words the check for an empty room', () => {
    const shifted = fluxResultNotices({
      products,
      check: {
        status: 'done',
        reading: readFluxCheck({ fixtures: [], extras: [] }, placed, { emptyRoom: true }),
      },
      colors: { status: 'reframed' },
      corrected: true,
      showTiles: false,
      composite: { shifted: true },
    });
    expect(shifted.warnings).toEqual([
      { key: 'framing', lines: ['AI가 방 구도를 바꿔 도기가 떠 보일 수 있어요.'] },
    ]);
    expect(shifted.suggestRetry).toBe(true);
    expect(shifted.infos.map((i) => i.text)).toEqual([
      'AI가 구도를 바꿔 벽·바닥 색을 원본과 비교하지 못했어요. 자재 색은 원본과 직접 비교해 주세요.',
      'AI 확인: 배치하지 않은 큰 물건이 보이지 않아요.',
    ]);
    const kept = fluxResultNotices({
      products,
      check: { status: 'failed', message: '한도' },
      colors: { status: 'corrected', warnings: [] },
      corrected: true,
      showTiles: false,
      composite: { shifted: false },
    });
    expect(kept.warnings).toEqual([]);
    expect(kept.infos.map((i) => i.text)).toEqual([
      '벽·바닥 색을 원래 자재 색에 맞췄어요. 제품은 3D 렌더를 제자리에 그대로 올렸어요.',
      'AI 확인을 하지 못했어요. 한도',
    ]);
  });
});
