import type { Repositories } from './repositories/contracts';
import type { MaterialInput } from './types';
import { makeAsset } from './images';
let seeding: Promise<void> | undefined;
export function ensureExampleTiles(repo: Repositories) {
  if (repo.mode !== 'local') return Promise.resolve();
  return (seeding ??= (async () => {
    const entries = await repo.materials.list();
    if (entries.some((v) => v.version.code === 'EXAMPLE-STONE-01')) return;
    const palettes = [
      { name: '라이트 스톤', rgb: [201, 199, 188], size: [600, 600], finish: '무광' },
      { name: '웜 샌드', rgb: [185, 169, 146], size: [300, 600], finish: '무광' },
      { name: '차콜 스톤', rgb: [82, 89, 87], size: [600, 600], finish: '무광' },
      { name: '클라우드 화이트', rgb: [232, 233, 224], size: [300, 600], finish: '무광' },
    ];
    for (let k = 0; k < palettes.length; k++) {
      const p = palettes[k],
        canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = (256 * p.size[1]) / p.size[0];
      const ctx = canvas.getContext('2d')!;
      const data = ctx.createImageData(canvas.width, canvas.height);
      let seed = 1871 + k;
      for (let i = 0; i < data.data.length; i += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const n = (seed / 4294967296 - 0.5) * 11;
        const x = (i / 4) % canvas.width,
          y = Math.floor(i / 4 / canvas.width);
        const v = Math.sin(x * 0.055 + y * 0.029) * 1.8;
        data.data[i] = p.rgb[0] + n + v;
        data.data[i + 1] = p.rgb[1] + n + v;
        data.data[i + 2] = p.rgb[2] + n + v;
        data.data[i + 3] = 255;
      }
      ctx.putImageData(data, 0, 0);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
      const asset = await makeAsset(blob, `${p.name} 예시.png`, 'texture');
      await repo.assets.put(asset);
      const input: MaterialInput = {
        name: p.name,
        brand: '공간미리 예시',
        code: `EXAMPLE-STONE-0${k + 1}`,
        category: 'tile',
        scope: 'shared',
        description: '코드로 직접 제작한 테스트용 질감입니다. 실제 판매 상품이 아닙니다.',
        color: p.name,
        finish: p.finish,
        widthMm: p.size[0],
        heightMm: p.size[1],
        depthMm: 9,
        usage: 'both',
        installation: 'floor',
        coverAssetId: asset.id,
        imageAssetIds: [],
        textureAssetIds: [asset.id],
        views: [],
        defaultGroutWidth: 2,
        defaultGroutColor: '#d5d1c9',
        defaultPattern: 'grid',
      };
      await repo.materials.create(input);
    }
  })().catch((e) => {
    seeding = undefined;
    throw e;
  }));
}
