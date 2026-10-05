import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import {
  clampFluxOrbit,
  FLUX_FRONT,
  fluxOrbitLabel,
  snapFluxOrbit,
  turnFluxOrbit,
} from '../src/lib/ai-export/view';
import {
  cameraQuarterAzimuth,
  createRoomViewCamera,
  defaultRoomView,
  FOUR_DIRECTION_VIEWS,
  normalizeRoomView,
  roomEyeView,
  roomViewLabel,
  rotateRoomView,
  snapQuarter,
  snapRoomView,
  sourceRoomView,
  type RoomOrbit,
  type RoomViewState,
} from '../src/lib/room-viewer/view-state';
import type { SourceCamera } from '../src/lib/reconstruction/source-camera';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';

const turns = (view: RoomViewState, ...path: ('left' | 'right' | 'up' | 'down')[]) =>
  path.reduce((current, direction) => snapRoomView(rotateRoomView(current, direction)), view);
const turn = (degrees: number) =>
  new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (degrees * Math.PI) / 180);
const tilt = (degrees: number) =>
  new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (degrees * Math.PI) / 180);
const viewOf = (q: Quaternion, extra: Partial<RoomViewState> = {}): RoomViewState => ({
  ...defaultRoomView(),
  quaternion: q.toArray() as RoomViewState['quaternion'],
  ...extra,
});

describe('the four-direction limit is on', () => {
  it('is the rule the screens follow', () => {
    expect(FOUR_DIRECTION_VIEWS).toBe(true);
  });
});

describe('the nearest of the four sides', () => {
  it('snaps an azimuth to 0, 90, 180 or −90, halfway going clockwise', () => {
    expect([0, 10, 44, -44, 46, 89, 91, 135, 180, 181, -181, 270, -270, 359].map(snapQuarter)).toEqual([
      0, 0, 0, 0, 90, 90, 90, 180, 180, 180, 180, -90, 90, 0,
    ]);
    expect(snapQuarter(45)).toBe(90);
    expect(snapQuarter(-45)).toBe(0);
    expect(snapQuarter(Number.NaN)).toBe(0);
    expect(snapQuarter(Infinity)).toBe(0);
  });

  it('reads the side a camera looks from, also when it looks steeply down or up', () => {
    for (const degrees of [0, 90, -90, 30, -150])
      expect(cameraQuarterAzimuth(turn(degrees))).toBeCloseTo(degrees, 6);
    expect(Math.abs(cameraQuarterAzimuth(turn(180)))).toBeCloseTo(180, 6);
    // Straight down: the picture's bottom points to the front (the same convention as the AI orbit).
    expect(snapQuarter(cameraQuarterAzimuth(tilt(-90)))).toBe(0);
    expect(snapQuarter(cameraQuarterAzimuth(turn(90).multiply(tilt(-90))))).toBe(90);
    expect(snapQuarter(cameraQuarterAzimuth(turn(180).multiply(tilt(-90))))).toBe(180);
    // Straight up from below: the other way round.
    expect(snapQuarter(cameraQuarterAzimuth(tilt(90)))).toBe(0);
    expect(snapQuarter(cameraQuarterAzimuth(turn(-90).multiply(tilt(90))))).toBe(-90);
  });
});

describe('the space viewer opens on one of the four sides', () => {
  const side = (view: RoomViewState) =>
    snapQuarter(cameraQuarterAzimuth(new Quaternion(...snapRoomView(view).quaternion)));

  it('keeps a view that is already one of the four, as it is', () => {
    for (const degrees of [0, 90, 180, -90]) {
      const view = viewOf(turn(degrees), { zoom: 2, pan: { x: 0.1, y: -0.2 } });
      const snapped = snapRoomView(view);
      expect(snapped.zoom).toBe(2);
      expect(snapped.pan).toEqual({ x: 0.1, y: -0.2 });
      expect(side(view)).toBe(degrees);
      expect(snapRoomView(snapped)).toEqual(snapped);
    }
    expect(snapRoomView(defaultRoomView())).toEqual(normalizeRoomView(defaultRoomView()));
  });

  it('turns any other saved view to the nearest side, level', () => {
    // Between two sides.
    expect(side(viewOf(turn(30)))).toBe(0);
    expect(side(viewOf(turn(60)))).toBe(90);
    expect(side(viewOf(turn(-100)))).toBe(-90);
    // From above or below at any side, or tilted a little: the side it names, level.
    expect(side(viewOf(tilt(-90)))).toBe(0);
    expect(side(viewOf(turn(90).multiply(tilt(-90))))).toBe(90);
    expect(side(viewOf(turn(180).multiply(tilt(-40))))).toBe(180);
    // Upside down (rolled): its heading still names the side.
    expect(
      side(viewOf(turn(-90).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI)))),
    ).toBe(-90);
    // The result is a plain turn about the vertical: the camera is level.
    const camera = createRoomViewCamera(
      DEFAULT_ROOM,
      1.5,
      snapRoomView(viewOf(turn(90).multiply(tilt(-60)))),
    );
    const look = camera.getWorldDirection(new Vector3());
    expect(look.y).toBeCloseTo(0, 6);
    expect(look.x).toBeCloseTo(-1, 6);
  });

  it('opens a view saved from inside the room on the front', () => {
    const eye = roomEyeView(DEFAULT_ROOM, 'right-corner');
    expect(eye.projection).toBe('room-eye');
    const snapped = snapRoomView(eye);
    expect(snapped.projection).toBeUndefined();
    expect(snapped.eye).toBeUndefined();
    expect(side(eye)).toBe(0);
    expect(roomViewLabel(snapped)).toBe('정면');
  });

  it('does not touch the photo camera of a photo reconstruction project', () => {
    const source: SourceCamera = {
      version: 1,
      positionMm: [250, 1550, 3050],
      quaternion: [0, 0, 0, 1],
      verticalFovDegrees: 64,
      image: { width: 960, height: 1280 },
    };
    const photo = sourceRoomView(source, DEFAULT_ROOM);
    expect(snapRoomView(photo)).toEqual(normalizeRoomView(photo));
    // The explicit whole-room view of a project with a photo is an ordinary one: it snaps.
    const fit = { ...photo, projection: 'room-fit' as const, quaternion: turn(30).toArray() as never };
    expect(side(fit)).toBe(0);
    expect(snapRoomView(fit).sourceCamera).toBeTruthy();
    expect(snapRoomView(fit).projection).toBe('room-fit');
  });

  it('left and right turns go front → right → back → left (and back) and stay level', () => {
    let view = snapRoomView(defaultRoomView());
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      view = turns(view, 'right');
      seen.push(roomViewLabel(view));
    }
    expect(seen).toEqual(['오른쪽', '뒤쪽', '왼쪽', '정면']);
    seen.length = 0;
    for (let i = 0; i < 4; i++) {
      view = turns(view, 'left');
      seen.push(roomViewLabel(view));
    }
    expect(seen).toEqual(['왼쪽', '뒤쪽', '오른쪽', '정면']);
    // Zoom and pan are the person's, kept through a turn.
    const moved = turns({ ...view, zoom: 2.5, pan: { x: 0.3, y: 0.1 } }, 'right');
    expect([moved.zoom, moved.pan]).toEqual([2.5, { x: 0.3, y: 0.1 }]);
  });
});

describe('the AI input picks one of the four sides', () => {
  const orbit = (azimuth: number, elevation = 0): RoomOrbit => ({ azimuth, elevation });

  it('snaps any direction to the nearest side, level', () => {
    expect(snapFluxOrbit(orbit(30, 20))).toEqual(orbit(0));
    expect(snapFluxOrbit(orbit(75, 90))).toEqual(orbit(90));
    expect(snapFluxOrbit(orbit(-100, 45))).toEqual(orbit(-90));
    expect(snapFluxOrbit(orbit(170, 0))).toEqual(orbit(180));
    expect(snapFluxOrbit(orbit(-180, 12))).toEqual(orbit(180));
    expect(snapFluxOrbit(orbit(Number.NaN, Number.NaN))).toEqual(orbit(0));
    // A stored value from the earlier free views: the nearest side, whatever it was.
    for (const azimuth of [-359, -200, -91, -46, 0, 44, 89, 133, 200, 359]) {
      const snapped = snapFluxOrbit(orbit(azimuth, 33));
      expect([0, 90, 180, -90]).toContain(snapped.azimuth);
      expect(snapped.elevation).toBe(0);
    }
  });

  it('turns right through the four sides in order, and left the other way, level every time', () => {
    let at = FLUX_FRONT;
    const right: string[] = [];
    for (let i = 0; i < 4; i++) {
      at = turnFluxOrbit(at, 'right');
      right.push(fluxOrbitLabel(at));
      expect(at.elevation).toBe(0);
    }
    expect(right).toEqual(['오른쪽', '뒤', '왼쪽', '정면']);
    const left: string[] = [];
    for (let i = 0; i < 4; i++) {
      at = turnFluxOrbit(at, 'left');
      left.push(fluxOrbitLabel(at));
    }
    expect(left).toEqual(['왼쪽', '뒤', '오른쪽', '정면']);
    expect(turnFluxOrbit(orbit(90), 'front')).toEqual(FLUX_FRONT);
  });

  it('has nothing to do for the removed above and side turns, and takes an in-between angle to a side', () => {
    expect(turnFluxOrbit(orbit(90), 'top')).toEqual(orbit(90));
    expect(turnFluxOrbit(orbit(-90), 'side')).toEqual(orbit(-90));
    // From between two sides, a turn lands on a side (the next one that way).
    expect(turnFluxOrbit(orbit(40), 'right')).toEqual(orbit(90));
    expect(turnFluxOrbit(orbit(40), 'left')).toEqual(orbit(0));
    expect(turnFluxOrbit(orbit(20, 50), 'right')).toEqual(orbit(90));
    expect(clampFluxOrbit(turnFluxOrbit(orbit(135), 'right'))).toEqual(orbit(180));
  });

  it('draws the same camera for the same side, whatever came before', () => {
    const camera = (o: RoomOrbit) =>
      new PerspectiveCamera().position.toArray().length &&
      createRoomViewCamera(DEFAULT_ROOM, 1.5, {
        ...defaultRoomView(),
        projection: 'room-orbit',
        orbit: snapFluxOrbit(o),
      }).position.toArray();
    expect(camera(orbit(5, 80))).toEqual(camera(orbit(0)));
    expect(camera(orbit(88, 10))).toEqual(camera(orbit(90)));
  });
});
