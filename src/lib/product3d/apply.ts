import type { AssetRepository } from '../repositories/contracts';
import type { MaterialInput } from '../types';
import { makeAsset } from '../images';
import { makeProductMeshAsset } from './codec';
import type { Product3dApplication } from './types';
import type { ProductMesh } from './state-types';
import { MAX_PRODUCT_VIEWS, PRODUCT_DIRECTIONS, isProductDirection } from '../product-direction';
export { MAX_PRODUCT_VIEWS };
/** An angle name is one of the closed list, never typed. */
export function productViewName(name: string) {
  const value = name.trim();
  if (!isProductDirection(value))
    throw new Error(`각도 이름은 목록에서 골라 주세요(${PRODUCT_DIRECTIONS.join(' · ')}).`);
  return value;
}
/** One photo per direction: another photo already has this name. */
function assertFreeDirection(views: { direction: string }[], name: string, except?: number) {
  if (views.some((view, index) => index !== except && view.direction === name))
    throw new Error(`‘${name}’ 방향 사진이 이미 있어요. 다른 방향을 고르거나 그 사진을 수정해 주세요.`);
}
const staged = new WeakMap<ProductMesh, { input: Blob; inputId?: string; meshId?: string }>();
export async function prepareProductReplacement(
  result: Product3dApplication,
  assets: AssetRepository,
  installation: MaterialInput['installation'],
  assertCurrent: () => void = () => {},
) {
  const capture = result.capture;
  if (
    capture.blob.type !== 'image/png' ||
    !capture.blob.size ||
    capture.width !== 1024 ||
    capture.height !== 1024
  )
    throw new Error('현재 각도의 PNG 결과가 올바르지 않아요.');
  assertCurrent();
  let stage = staged.get(result.mesh);
  if (!stage || stage.input !== result.input.blob) {
    stage = { input: result.input.blob };
    staged.set(result.mesh, stage);
  }
  let inputId = result.input.existingAssetId ?? stage.inputId;
  if (!inputId) {
    const input = await makeAsset(
      result.input.blob,
      `${result.input.name} · 입체화 입력.png`,
      'product',
      result.input.sourceAssetId,
    );
    input.derivation = 'ai-alpha';
    assertCurrent();
    await assets.put(input);
    inputId = input.id;
    stage.inputId = inputId;
    assertCurrent();
  }
  let meshId = result.meshAssetId ?? stage.meshId;
  if (!meshId) {
    const mesh = await makeProductMeshAsset(result.mesh, `${result.input.name} · 입체 형상`, inputId);
    assertCurrent();
    await assets.put(mesh);
    meshId = mesh.id;
    stage.meshId = meshId;
    assertCurrent();
  }
  const image = await makeAsset(capture.blob, `${result.input.name} · 360도 제품.png`, 'product', inputId);
  image.derivation = 'ai-product3d';
  if (image.width !== 1024 || image.height !== 1024) throw new Error('생성 이미지 크기를 확인하지 못했어요.');
  assertCurrent();
  await assets.put(image);
  assertCurrent();
  return {
    assetId: image.id,
    anchor: installation === 'floor' ? { ...capture.anchor } : { x: 0.5, y: 0.5 },
    product3d: {
      version: 1 as const,
      meshAssetId: meshId,
      inputAssetId: inputId,
      pose: structuredClone(result.pose),
      modelId: result.modelId,
      modelRevision: result.modelRevision,
      // 'baked' is the absence of the field, so it is written exactly as before; only a lit mode is recorded.
      ...(result.shading === 'baked' ? {} : { shading: result.shading }),
      // Only a fit that was asked for is recorded; older saves carry none and the mesh stays as made.
      ...(result.fit ? { fit: structuredClone(result.fit) } : {}),
      // Likewise the photo's colours: recorded only when they are on, so older saves read as they were.
      ...(result.photoCamera ? { photoCamera: structuredClone(result.photoCamera) } : {}),
    },
  };
}
export function replaceProductPhoto(
  form: MaterialInput,
  index: number,
  expectedAssetId: string,
  replacement: Awaited<ReturnType<typeof prepareProductReplacement>>,
): MaterialInput {
  if (form.views[index]?.assetId !== expectedAssetId)
    throw new Error('선택한 제품 사진이 바뀌었어요. 다시 열어 주세요.');
  return {
    ...form,
    views: form.views.map((view, i) => (i === index ? { ...view, ...structuredClone(replacement) } : view)),
  };
}

/** One product/version owns all views; geometry/input IDs are immutable shared assets. */
export function addProductPhoto(
  form: MaterialInput,
  sourceIndex: number,
  expectedAssetId: string,
  replacement: Awaited<ReturnType<typeof prepareProductReplacement>>,
  name: string,
): MaterialInput {
  if (form.views[sourceIndex]?.assetId !== expectedAssetId)
    throw new Error('선택한 제품 사진이 바뀌었어요. 다시 열어 주세요.');
  if (form.views.length >= MAX_PRODUCT_VIEWS)
    throw new Error(
      `자재 하나에 각도 사진은 방향마다 한 장, 최대 ${MAX_PRODUCT_VIEWS}장까지 저장할 수 있어요.`,
    );
  const direction = productViewName(name);
  assertFreeDirection(form.views, direction);
  return {
    ...form,
    views: [...form.views, { ...structuredClone(replacement), direction }],
  };
}

export function renameProductPhoto(form: MaterialInput, index: number, name: string): MaterialInput {
  if (!form.views[index]) throw new Error('이름을 바꿀 각도 사진을 찾을 수 없어요.');
  const direction = productViewName(name);
  assertFreeDirection(form.views, direction, index);
  return {
    ...form,
    views: form.views.map((view, i) => {
      if (i !== index) return view;
      // The stored name that could not be read is settled once a name is picked.
      const next = { ...view, direction };
      delete next.directionWas;
      return next;
    }),
  };
}

export function removeProductPhoto(form: MaterialInput, index: number): MaterialInput {
  const removed = form.views[index];
  if (!removed) throw new Error('삭제할 각도 사진을 찾을 수 없어요.');
  const views = form.views.filter((_, i) => i !== index);
  return {
    ...form,
    views,
  };
}
