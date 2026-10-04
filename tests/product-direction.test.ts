import { describe, expect, it } from 'vitest';
import {
  PRODUCT_DIRECTIONS,
  MAX_PRODUCT_VIEWS,
  describeProductFacing,
  directionAngle,
  directionSuitsFace,
  facingOfDirection,
  isProductDirection,
  mismatchMessage,
  nearestHorizontalDirection,
  nextProductDirection,
  readMaterialViews,
  readProductDirection,
  suitingDirection,
} from '../src/lib/product-direction';
describe('the closed list of angle names', () => {
  it('has the six names, in the list order, one photo each', () => {
    expect([...PRODUCT_DIRECTIONS]).toEqual(['정면', '왼쪽', '오른쪽', '위', '아래', '뒤']);
    expect(MAX_PRODUCT_VIEWS).toBe(6);
    expect(PRODUCT_DIRECTIONS.every(isProductDirection)).toBe(true);
    for (const free of ['사선', '정면 ', '', 'front', '각도 1', 3, null, undefined])
      expect(isProductDirection(free)).toBe(false);
  });

  it('reads older names as their nearest direction, and what it cannot read as 정면 (unknown)', () => {
    const cases: [string, string][] = [
      ['오른쪽 측면', '오른쪽'],
      ['왼쪽 측면', '왼쪽'],
      ['뒤에서', '뒤'],
      ['후면', '뒤'],
      ['위에서', '위'],
      ['front', '정면'],
      ['left', '왼쪽'],
      ['right', '오른쪽'],
      ['back', '뒤'],
      ['오른쪽 사선', '오른쪽'],
      ['왼쪽 사선', '왼쪽'],
      [' 정면 ', '정면'],
      ['오른쪽', '오른쪽'],
    ];
    for (const [old, now] of cases) expect(readProductDirection(old)).toEqual({ name: now, known: true });
    for (const old of ['사선', '원본 사진 방향', '공간 공통 카메라', '각도 1', '', '옆면 비스듬히'])
      expect(readProductDirection(old)).toEqual({ name: '정면', known: false });
  });

  it('suggests the first direction not used yet, in the list order', () => {
    expect(nextProductDirection([])).toBe('정면');
    expect(nextProductDirection(['정면'])).toBe('왼쪽');
    expect(nextProductDirection(['정면', '왼쪽'])).toBe('오른쪽');
    expect(nextProductDirection(['정면', '오른쪽'])).toBe('왼쪽');
    expect(nextProductDirection(['정면', '왼쪽', '오른쪽'])).toBe('위');
    expect(nextProductDirection([...PRODUCT_DIRECTIONS])).toBeUndefined();
  });

  it('maps names to the angle the product faces; 위 and 아래 have none', () => {
    expect(PRODUCT_DIRECTIONS.map((name) => directionAngle(name))).toEqual([
      0,
      -90,
      90,
      undefined,
      undefined,
      180,
    ]);
    expect(nearestHorizontalDirection(80).name).toBe('오른쪽');
    expect(nearestHorizontalDirection(-200).name).toBe('뒤');
    expect(nearestHorizontalDirection(-44).name).toBe('정면');
    expect(nearestHorizontalDirection(-46).name).toBe('왼쪽');
    expect(PRODUCT_DIRECTIONS.map((name) => facingOfDirection(name))).toEqual([
      'front',
      'left',
      'right',
      undefined,
      undefined,
      'back',
    ]);
  });
});

describe('names against the wall a product stands on', () => {
  it('suits 오른쪽 on the left wall, 왼쪽 on the right wall, 정면 on the back wall, anything on the floor', () => {
    expect(suitingDirection('left')).toBe('오른쪽');
    expect(suitingDirection('right')).toBe('왼쪽');
    expect(suitingDirection('back')).toBe('정면');
    expect(suitingDirection('floor')).toBeUndefined();
    for (const name of PRODUCT_DIRECTIONS) expect(directionSuitsFace('floor', name)).toBe(true);
    expect(directionSuitsFace('left', '오른쪽')).toBe(true);
    expect(directionSuitsFace('left', '정면')).toBe(false);
    expect(directionSuitsFace('back', '정면')).toBe(true);
    expect(directionSuitsFace('back', '위')).toBe(false);
  });

  it('says where the product looks and warns, in words, only when it does not suit', () => {
    expect(describeProductFacing('left', '오른쪽')).toBe('방 안쪽을 봐요.');
    expect(describeProductFacing('right', '왼쪽')).toBe('방 안쪽을 봐요.');
    expect(describeProductFacing('back', '정면')).toBe('정면(방 안쪽)을 봐요.');
    expect(describeProductFacing('floor', '정면')).toBe('정면(열린 쪽)을 봐요.');
    expect(describeProductFacing('left', '정면')).toBe('정면(열린 쪽)을 봐요.');
    expect(describeProductFacing('floor', '뒤')).toBe('뒤 벽 쪽을 봐요.');
    expect(describeProductFacing('back', '위')).toMatch(/방향은 정하지 않아요/);
    expect(mismatchMessage('left', '오른쪽')).toBe('');
    expect(mismatchMessage('floor', '뒤')).toBe('');
    expect(mismatchMessage('left', '정면')).toBe(
      '왼쪽 벽에는 ‘오른쪽’ 각도가 어울려요. 지금은 ‘정면’ 각도라 정면(열린 쪽)을 봐요.',
    );
  });
});

describe('older stored material versions', () => {
  const view = (direction: string, extra = {}) => ({
    assetId: 'a',
    direction,
    anchor: { x: 0.5, y: 0.5 },
    ...extra,
  });
  it('reads every view through the list, in place, flagging only what it could not read', () => {
    const version = { id: 'v', views: [view('정면'), view('오른쪽 측면'), view('사선'), view('뒤에서')] };
    const read = readMaterialViews(version);
    expect(read.views.map((v) => v.direction)).toEqual(['정면', '오른쪽', '정면', '뒤']);
    expect(read.views.map((v) => (v as { directionWas?: string }).directionWas)).toEqual([
      undefined,
      undefined,
      '사선',
      undefined,
    ]);
    // Nothing else changes, and the stored object is not modified.
    expect(read.views[1]).toEqual(view('오른쪽'));
    expect(version.views[1].direction).toBe('오른쪽 측면');
  });

  it('returns the very same object when every name is already on the list', () => {
    const version = { views: [view('정면'), view('왼쪽')] };
    expect(readMaterialViews(version)).toBe(version);
    const none = { views: [] };
    expect(readMaterialViews(none)).toBe(none);
  });

  it('does not flag a reconstruction material (internal, disposable)', () => {
    const read = readMaterialViews({ reconstruction: { version: 2 }, views: [view('공간 공통 카메라')] });
    expect(read.views[0]).toEqual(view('정면'));
  });

  it('drops a stale flag once the name is on the list', () => {
    const read = readMaterialViews({ views: [view('정면', { directionWas: '사선' })] });
    expect('directionWas' in read.views[0]).toBe(false);
  });
});
