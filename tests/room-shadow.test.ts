import { describe, expect, it } from 'vitest';
import { Mesh, MeshStandardMaterial, BoxGeometry, ShaderChunk, SpotLight, Vector3 } from 'three';
import {
  applyRoomShadow,
  bindRoomShadows,
  LIVE_SHADOW_RADIUS,
  roomShadowFov,
  smoothShadowChunk,
} from '../src/lib/room-viewer/shadow';
import { createRoomLightRig } from '../src/lib/render/realistic-lighting';
import { ROOM_VIEWER_RENDERER_REVISION } from '../src/lib/room-viewer/render-version';
import { designPreviewRoomContextKey } from '../src/lib/render/design-preview-context';

const rooms = [
  { widthMm: 1000, depthMm: 1200, heightMm: 2300 },
  { widthMm: 2400, depthMm: 2400, heightMm: 2400 },
  { widthMm: 2400, depthMm: 3000, heightMm: 2400 },
  { widthMm: 3200, depthMm: 4000, heightMm: 2600 },
];
const ceilingLight = (room: (typeof rooms)[number]) =>
  createRoomLightRig(room, { environment: true }).find((o): o is SpotLight => o instanceof SpotLight)!;

/** Where a world point lands in the light's shadow map (inside when both are within ±1). */
function shadowPoint(light: SpotLight, point: Vector3) {
  light.updateMatrixWorld(true);
  light.target.updateMatrixWorld(true);
  light.shadow.updateMatrices(light);
  return point.clone().project(light.shadow.camera);
}

describe('ceiling light shadow', () => {
  it('casts from a fitted frustum instead of the degenerate 180° one', () => {
    for (const room of rooms) {
      const light = ceilingLight(room);
      light.shadow.updateMatrices(light);
      expect(light.castShadow).toBe(true);
      expect(light.shadow.camera.fov).toBeGreaterThanOrEqual(60);
      expect(light.shadow.camera.fov).toBeLessThanOrEqual(150);
      expect(light.shadow.camera.fov).toBeCloseTo(roomShadowFov(room, light.position), 6);
      expect(light.shadow.radius).toBe(LIVE_SHADOW_RADIUS);
    }
    // A 20 m hall stops at 150°: past that the map has no resolution left at its edges.
    expect(roomShadowFov({ widthMm: 20000, depthMm: 20000, heightMm: 2400 }, { y: 2364, z: 10400 })).toBe(
      150,
    );
  });

  it('covers the floor and the walls up to fixture height, also where an export moves the light', () => {
    for (const room of rooms) {
      const light = ceilingLight(room);
      const home = light.position.clone(),
        aim = light.target.position.clone();
      for (const [dx, dz] of [
        [0, 0],
        [-300, -300],
        [300, 300],
        [300, -300],
      ]) {
        light.position.set(home.x + dx, home.y, home.z + dz);
        light.target.position.set(aim.x + dx, aim.y, aim.z + dz);
        const x = room.widthMm / 2,
          z = room.depthMm;
        for (const point of [
          new Vector3(-x, 0, 0),
          new Vector3(x, 0, 0),
          new Vector3(-x, 0, z),
          new Vector3(x, 0, z),
          new Vector3(0, 1200, 0),
          new Vector3(-x, 1200, z / 2),
          new Vector3(x, 1200, z / 2),
        ]) {
          const p = shadowPoint(light, point);
          expect(Math.abs(p.x), `${JSON.stringify(room)} ${point.toArray()}`).toBeLessThanOrEqual(1);
          expect(Math.abs(p.y), `${JSON.stringify(room)} ${point.toArray()}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('samples a fixed disk instead of the screen-space rotated one', () => {
    const chunk = ShaderChunk.shadowmap_pars_fragment;
    const smooth = smoothShadowChunk(chunk);
    expect(smooth).not.toBe(chunk);
    expect(smooth).toContain('vogelDiskSample( i, 32, 0.0 )');
    // The spot/directional getShadow no longer reads gl_FragCoord (the point-light one keeps it).
    const spot = smooth.slice(
      smooth.indexOf('float getShadow('),
      smooth.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )'),
    );
    expect(spot).not.toContain('gl_FragCoord');
    expect(() => smoothShadowChunk('void main(){}')).toThrow();
  });

  it('patches each viewer material once and keys its program', () => {
    const material = new MeshStandardMaterial();
    const mesh = new Mesh(new BoxGeometry(), material);
    bindRoomShadows(mesh);
    bindRoomShadows(mesh);
    expect(material.customProgramCacheKey()).toMatch(/\|sjn-disk-shadow-v1$/);
    expect(material.customProgramCacheKey().split('sjn-disk-shadow-v1')).toHaveLength(2);
    const shader = {
      fragmentShader: 'x\n#include <shadowmap_pars_fragment>\ny',
      vertexShader: '',
      uniforms: {},
    } as unknown as Parameters<MeshStandardMaterial['onBeforeCompile']>[0];
    material.onBeforeCompile(shader, undefined as never);
    expect(shader.fragmentShader).not.toContain('#include <shadowmap_pars_fragment>');
    expect(shader.fragmentShader).toContain('vogelDiskSample( i, 32, 0.0 )');
  });

  it('gives saved previews a new cache key', async () => {
    expect(ROOM_VIEWER_RENDERER_REVISION).toBe('room-view-v6-fixture-shadows');
    const context = { beforeScene: {} as never, view: {} as never, fitScenes: [] };
    const key = await designPreviewRoomContextKey(context as never);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('applies the same rule to any spot light', () => {
    const light = new SpotLight('#fff', 1, 0, Math.PI / 2, 1, 2);
    light.position.set(0, 2364, 1248);
    applyRoomShadow(light, rooms[1]);
    expect(light.shadow.mapSize.toArray()).toEqual([1024, 1024]);
    expect(light.shadow.focus * 180).toBeCloseTo(roomShadowFov(rooms[1], light.position), 6);
  });
});
