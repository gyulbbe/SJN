import { describe, expect, it, vi } from 'vitest';
import { DataTexture, MeshStandardMaterial, type Material, type Texture, type WebGLRenderer } from 'three';
import { ViewerLightingLut } from '../src/lib/room-viewer/lighting';
type Shader = Parameters<Material['onBeforeCompile']>[0];
const shader = (hasLut = true) =>
  ({
    uniforms: hasLut ? { dfgLUT: { value: null } } : {},
    vertexShader: '',
    fragmentShader: '',
  }) as unknown as Shader;
const compile = (owner: ViewerLightingLut, value = shader()) => {
  const material = new MeshStandardMaterial();
  owner.bind(material);
  material.onBeforeCompile(value, {} as WebGLRenderer);
  return { material, shader: value };
};

describe('viewer-owned PBR lookup lifetime', () => {
  it('preserves previous shader customizations and cache identity', () => {
    const owner = new ViewerLightingLut(),
      material = new MeshStandardMaterial(),
      previous = vi.fn((s: Shader) => {
        s.fragmentShader += 'custom-colour';
      });
    material.onBeforeCompile = previous;
    material.customProgramCacheKey = () => 'material-specific';
    owner.bind(material);
    const s = shader();
    material.onBeforeCompile(s, {} as WebGLRenderer);
    expect(previous).toHaveBeenCalledOnce();
    expect(s.fragmentShader).toBe('custom-colour');
    expect(material.customProgramCacheKey()).toBe('material-specific|sjn-owned-dfg-lut-v1');
    owner.dispose();
    material.dispose();
  });
  it('shares one immutable-pixel clone across material passes without changing source', () => {
    const owner = new ViewerLightingLut(),
      a = compile(owner),
      b = compile(owner),
      source = new DataTexture(new Uint16Array([1, 2]), 1, 1);
    for (let i = 0; i < 30; i++) {
      a.shader.uniforms.dfgLUT.value = source;
      b.shader.uniforms.dfgLUT.value = source;
    }
    const first = a.shader.uniforms.dfgLUT.value as Texture;
    expect(first).not.toBe(source);
    expect(first.source).toBe(source.source);
    expect(b.shader.uniforms.dfgLUT.value).toBe(first);
    expect(owner.diagnostics.textures).toBe(1);
    owner.dispose();
    a.material.dispose();
    b.material.dispose();
    source.dispose();
  });
  it('disposes only its local clone and makes repeated disposal harmless', () => {
    const owner = new ViewerLightingLut(),
      a = compile(owner),
      source = new DataTexture();
    const globalDispose = vi.fn(),
      ownDispose = vi.fn();
    source.addEventListener('dispose', globalDispose);
    a.shader.uniforms.dfgLUT.value = source;
    (a.shader.uniforms.dfgLUT.value as Texture).addEventListener('dispose', ownDispose);
    owner.dispose();
    owner.dispose();
    expect(globalDispose).not.toHaveBeenCalled();
    expect(ownDispose).toHaveBeenCalledOnce();
    expect(owner.diagnostics).toEqual({ textures: 0, disposed: true });
    a.material.dispose();
  });
  it('does not allocate from a shader refresh that arrives after close', () => {
    const owner = new ViewerLightingLut(),
      a = compile(owner),
      source = new DataTexture();
    owner.dispose();
    a.shader.uniforms.dfgLUT.value = source;
    expect(a.shader.uniforms.dfgLUT.value).toBeNull();
    expect(owner.diagnostics.textures).toBe(0);
    a.material.dispose();
  });
  it('keeps another viewer using the global source valid after one viewer closes', () => {
    const aOwner = new ViewerLightingLut(),
      bOwner = new ViewerLightingLut(),
      a = compile(aOwner),
      b = compile(bOwner),
      source = new DataTexture();
    a.shader.uniforms.dfgLUT.value = source;
    b.shader.uniforms.dfgLUT.value = source;
    const other = b.shader.uniforms.dfgLUT.value;
    expect(a.shader.uniforms.dfgLUT.value).not.toBe(other);
    aOwner.dispose();
    expect(b.shader.uniforms.dfgLUT.value).toBe(other);
    expect(bOwner.diagnostics.textures).toBe(1);
    bOwner.dispose();
    a.material.dispose();
    b.material.dispose();
  });
  it('leaves shaders without the installed-version uniform untouched', () => {
    const owner = new ViewerLightingLut(),
      a = compile(owner, shader(false));
    expect(a.shader.uniforms).toEqual({});
    expect(owner.diagnostics.textures).toBe(0);
    owner.dispose();
    a.material.dispose();
  });
});
