import { describe, expect, it } from 'vitest';
import {
  buildDirectionPhotoPrompt,
  directionPromptNotices,
  FLOOR_CAMERA_DOWN_DEGREES,
  productFrontSentence,
  recommendedDirections,
  type DirectionPhotoPromptInput,
} from '../src/lib/product-photo-prompt';
import { PRODUCT_DIRECTIONS } from '../src/lib/product-direction';
import type { MaterialCategory } from '../src/lib/types';

const bath = (
  direction: DirectionPhotoPromptInput['direction'],
  extra: Partial<DirectionPhotoPromptInput> = {},
) =>
  buildDirectionPhotoPrompt({
    category: 'bath',
    direction,
    widthMm: 1700,
    heightMm: 560,
    depthMm: 750,
    install: 'floor',
    ...extra,
  });

describe('the prompt for one direction', () => {
  it('says which edge of the picture the front points to, the right way round for each side', () => {
    const left = bath('왼쪽'),
      right = bath('오른쪽');
    expect(left).toContain(
      'front points toward the LEFT edge of the image and its back toward the RIGHT edge',
    );
    expect(left).toContain("the camera looks straight at the product's left side");
    expect(right).toContain(
      'front points toward the RIGHT edge of the image and its back toward the LEFT edge',
    );
    expect(right).toContain("the camera looks straight at the product's right side");
    expect(bath('정면')).toContain("View: the product's front faces the camera straight on.");
    expect(bath('뒤')).toContain(
      "View: the product's back faces the camera straight on; its front faces away.",
    );
    for (const name of ['정면', '뒤'] as const) expect(bath(name)).not.toMatch(/LEFT|RIGHT/);
  });

  it('asks for width : height from the front and the back, depth : height from the sides (as the room draws them)', () => {
    for (const name of ['정면', '뒤'] as const) {
      expect(bath(name)).toContain('visible width : height in the image is about 3.0 : 1 (1700 : 560 mm)');
      expect(bath(name)).toContain('16:9 landscape');
    }
    for (const name of ['왼쪽', '오른쪽'] as const) {
      expect(bath(name)).toContain('visible width : height in the image is about 1.3 : 1 (750 : 560 mm)');
      expect(bath(name)).toContain('16:9 landscape');
    }
    expect(bath('정면')).toContain('Product: bathtub, 1700 × 560 × 750 mm (width × height × depth).');
    // A tall narrow product gets a portrait frame, a squarish one a square frame.
    const toilet = (direction: DirectionPhotoPromptInput['direction']) =>
      buildDirectionPhotoPrompt({
        category: 'toilet',
        direction,
        widthMm: 370,
        heightMm: 660,
        depthMm: 640,
        install: 'floor',
      });
    expect(toilet('정면')).toContain('about 0.6 : 1 (370 : 660 mm)');
    expect(toilet('정면')).toContain('3:4 portrait');
    expect(toilet('왼쪽')).toContain('about 1.0 : 1 (640 : 660 mm)');
    expect(toilet('왼쪽')).toContain('1:1 square');
  });

  it('leaves the size and the ratio out when the sizes are missing, and the screen says to fill them in', () => {
    const empty = { category: 'bath' as const, direction: '정면' as const, install: 'floor' as const };
    const prompt = buildDirectionPhotoPrompt(empty);
    expect(prompt).toContain('Product: bathtub.');
    // (The lens line says 85mm; no size in mm, no ratio and no frame shape.)
    expect(prompt).not.toMatch(/ mm|width : height|16:9 landscape|3:4 portrait|1:1 square/);
    expect(directionPromptNotices(empty)).toContain(
      '가로·높이·깊이를 먼저 넣으면 비율이 프롬프트에 들어가요.',
    );
    // A side view needs the depth: without it, no ratio there, though the front has one.
    const noDepth = { ...empty, widthMm: 1700, heightMm: 560 };
    expect(buildDirectionPhotoPrompt(noDepth)).toContain('3.0 : 1');
    expect(buildDirectionPhotoPrompt({ ...noDepth, direction: '왼쪽' })).not.toContain(' : 1 (');
    expect(directionPromptNotices({ ...noDepth, direction: '왼쪽' })).toHaveLength(1);
    expect(directionPromptNotices({ ...noDepth, depthMm: 750 })).toEqual([]);
  });

  it('looks down on a floor product and straight at a wall product', () => {
    expect(FLOOR_CAMERA_DOWN_DEGREES).toBe(10);
    for (const install of ['floor', 'embedded'] as const)
      expect(bath('정면', { install })).toContain(
        'The camera is slightly above the product, looking down about 10 degrees.',
      );
    for (const install of ['wall', 'suspended'] as const) {
      const wall = bath('정면', { install });
      expect(wall).toContain("The camera is at the product's center height, looking straight at it.");
      expect(wall).not.toContain('looking down');
    }
  });

  it('puts the features to keep in, in one line, only when there are some', () => {
    expect(bath('정면', { details: '  overflow on the left end,\n chrome drain  ' })).toContain(
      'Details that must stay the same: overflow on the left end, chrome drain.',
    );
    expect(bath('정면', { details: '   ' })).not.toContain('Details that must stay the same');
    expect(bath('정면')).not.toContain('Details that must stay the same');
  });

  it('refers to the front result for the other directions only', () => {
    const reference = 'image 2 is the front view already made from it';
    for (const name of ['왼쪽', '오른쪽', '뒤'] as const) {
      expect(bath(name, { withFrontResult: true })).toContain(reference);
      expect(bath(name)).not.toContain(reference);
    }
    expect(bath('정면', { withFrontResult: true })).not.toContain(reference);
  });

  it('always asks for the same product on a pure white background, with nothing else in the picture', () => {
    for (const name of PRODUCT_DIRECTIONS) {
      const prompt = bath(name);
      expect(prompt).toContain('pure white seamless background (#FFFFFF)');
      expect(prompt).toContain('Do not redesign it and do not add or remove parts.');
      expect(prompt).toContain('No floor texture, no walls, no props, no text, no watermark, no people.');
      expect(prompt).toContain('about 85mm equivalent');
    }
  });

  it("names each kind of product's front, and a plain one for the rest", () => {
    expect(productFrontSentence('toilet')).toBe(
      "Its front is the bowl end, where a seated person's legs go; the tank or rear housing is its back.",
    );
    expect(productFrontSentence('bath')).toBe(
      'Its front is the long side facing the room; its back is the long side placed along the wall.',
    );
    expect(productFrontSentence('basin')).toBe(
      'Its front is the side a person stands at; its back mounts to the wall.',
    );
    expect(productFrontSentence('mirror')).toBe('Its front is the mirror face; its back mounts to the wall.');
    expect(productFrontSentence('unknown' as MaterialCategory)).toBe(
      'Its front is the side that faces a person using it.',
    );
    expect(bath('정면')).toContain(productFrontSentence('bath'));
  });

  it('gives the same words for the same input, every time', () => {
    const input: DirectionPhotoPromptInput = {
      category: 'toilet',
      direction: '오른쪽',
      widthMm: 370,
      heightMm: 660,
      depthMm: 640,
      install: 'floor',
      details: 'flush button on top',
      withFrontResult: true,
    };
    expect(buildDirectionPhotoPrompt(input)).toBe(buildDirectionPhotoPrompt(structuredClone(input)));
  });

  it('notes that a wall product hardly needs a back photo (still copyable)', () => {
    const wallBack = {
      category: 'basin' as const,
      direction: '뒤' as const,
      widthMm: 600,
      heightMm: 450,
      depthMm: 400,
    };
    expect(directionPromptNotices({ ...wallBack, install: 'wall' })).toEqual([
      '벽에 거는 제품은 뒤 사진이 거의 필요 없어요.',
    ]);
    expect(directionPromptNotices({ ...wallBack, install: 'floor' })).toEqual([]);
    expect(directionPromptNotices({ ...wallBack, direction: '정면', install: 'wall' })).toEqual([]);
    expect(buildDirectionPhotoPrompt({ ...wallBack, install: 'wall' })).toContain('back faces the camera');
  });

  it('recommends how many directions to make for a toilet, a bath, a basin and a mirror', () => {
    expect(recommendedDirections('toilet')).toBe('정면·왼쪽·오른쪽(필요하면 뒤)');
    expect(recommendedDirections('bath')).toContain('정면·왼쪽');
    expect(recommendedDirections('basin')).toBe('정면');
    expect(recommendedDirections('mirror')).toBe('정면');
  });
});
