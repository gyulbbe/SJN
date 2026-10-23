/**
 * Floor products meet the floor, and against their wall meet the wall, from all four sides
 * (docs/size-order-and-contact-results-20261024.md). Measured on what shows of the photo, in room mm.
 */
import { describe, expect, it } from 'vitest';
import {
  asStandardModel,
  CONTACT_CASES,
  contactFixture,
  contactMaterial,
  contactScene,
  measureContact,
} from './helpers/fixture-contact';

const LIMIT_MM = 2;

describe('floor products touch the floor and their wall', () => {
  it.each(CONTACT_CASES.map((c) => [c.name, c] as const))(
    '%s: the product itself stands on the floor from the four sides',
    async (_, c) => {
      const material = contactMaterial(c);
      for (const model of [false, true]) {
        const scene = contactScene([contactFixture(c)]);
        if (model) asStandardModel(scene, material);
        const { sides } = await measureContact(scene, material, c.photos);
        expect(sides).toHaveLength(4);
        for (const side of sides)
          expect(Math.abs(side.solidFloorMm), `${side.quarter}`).toBeLessThanOrEqual(LIMIT_MM);
      }
    },
  );

  it.each(CONTACT_CASES.map((c) => [c.name, c] as const))(
    '%s: against the wall, its back meets the wall from the four sides',
    async (_, c) => {
      const material = contactMaterial(c);
      for (const model of [false, true]) {
        const fixture = contactFixture(c);
        fixture.roomPlacement!.againstWall = true;
        const scene = contactScene([fixture]);
        if (model) asStandardModel(scene, material);
        const { sides } = await measureContact(scene, material, c.photos);
        for (const side of sides) {
          expect(Math.abs(side.backMm), `${side.quarter}`).toBeLessThanOrEqual(LIMIT_MM);
          // Never inside the wall.
          expect(side.backMm, `${side.quarter}`).toBeGreaterThanOrEqual(-0.5);
          expect(Math.abs(side.solidFloorMm), `${side.quarter}`).toBeLessThanOrEqual(LIMIT_MM);
        }
      }
    },
  );

  it('leaves a photo whose anchor was set well above its bottom as the anchor says (a photo from above)', async () => {
    const c = {
      ...CONTACT_CASES[0],
      photos: [{ ...CONTACT_CASES[0].photos[0], anchor: { x: 0.5, y: 0.6 } }],
    };
    const { sides } = await measureContact(contactScene([contactFixture(c)]), contactMaterial(c), c.photos);
    // The footprint's middle is on the floor; the lower part of the picture is below it, as before.
    for (const side of sides) expect(side.solidFloorMm).toBeLessThan(-100);
  });

  it('puts a soft shadow under a floor photo, the size of its footprint, and none under a wall product', async () => {
    const c = CONTACT_CASES[0];
    const { root } = await measureContact(contactScene([contactFixture(c)]), contactMaterial(c), c.photos);
    const shadows = root!.children.filter((node) => node.userData.groundShadow);
    expect(shadows).toHaveLength(1);
    const wall = contactFixture(c);
    wall.roomPlacement!.face = 'back';
    const onWall = await measureContact(contactScene([wall]), contactMaterial(c), c.photos);
    expect(onWall.root!.children.filter((node) => node.userData.groundShadow)).toHaveLength(0);
  });
});
