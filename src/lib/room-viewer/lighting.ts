import type { Material, Object3D, Texture } from 'three';
import { Mesh } from 'three';

/**
 * Three 0.185.1 supplies a module-global DFG lookup texture to every PBR material.
 * Its per-renderer dispose listeners retain closed WebGLRenderer instances. Own a
 * clone per viewer so closing it can release its listeners without touching other
 * editors' global texture. onBeforeCompile/Texture.clone/dispose are public APIs;
 * the guarded dfgLUT uniform name is an installed-version integration contract.
 */
export class ViewerLightingLut {
  private source?: Texture;
  private owned?: Texture;
  private readonly bound = new WeakSet<Material>();
  private closed = false;

  get diagnostics() {
    return { textures: this.owned ? 1 : 0, disposed: this.closed };
  }

  bindTree(tree: Object3D) {
    tree.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material])
        this.bind(material);
    });
  }

  bind(material: Material) {
    if (this.closed || this.bound.has(material)) return;
    this.bound.add(material);
    const previous = material.onBeforeCompile,
      previousKey = material.customProgramCacheKey;
    const read = () => this.owned ?? null;
    const refresh = (value: Texture | null) => {
      if (!value || this.closed || value === this.source) return;
      this.owned?.dispose();
      this.source = value;
      this.owned = value.clone();
      this.owned.name = 'SJN viewer DFG LUT';
    };
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      if (!shader.uniforms.dfgLUT) return;
      // WebGLRenderer refreshes this value on every material pass. A getter/setter
      // keeps that refresh local while preserving the immutable lookup pixel data.
      shader.uniforms.dfgLUT = {
        get value() {
          return read();
        },
        set value(value: Texture | null) {
          refresh(value);
        },
      };
    };
    material.customProgramCacheKey = () => `${previousKey.call(material)}|sjn-owned-dfg-lut-v1`;
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.owned?.dispose();
    this.owned = undefined;
    this.source = undefined;
  }
}
