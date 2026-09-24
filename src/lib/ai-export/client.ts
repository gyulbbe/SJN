import { fluxDimensions } from './contract';
export async function prepareFluxImage(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    const size = fluxDimensions(bitmap.width, bitmap.height);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('AI 변환용 이미지를 만들지 못했어요.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
    const scale = Math.min(size.width / bitmap.width, size.height / bitmap.height);
    const w = bitmap.width * scale,
      h = bitmap.height * scale;
    context.drawImage(bitmap, (size.width - w) / 2, (size.height - h) / 2, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('PNG 변환에 실패했어요.'))),
        'image/png',
      ),
    );
  } finally {
    bitmap.close();
  }
}
export async function requestFluxImage(
  image: Blob,
  seed: number,
  signal: AbortSignal,
  userId?: string | null,
) {
  const form = new FormData();
  form.set('image', image, 'after.png');
  form.set('seed', String(seed));
  const response = await fetch('/api/export/photoreal', {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
    signal,
    headers: userId ? { 'X-SJN-User-Id': userId } : {},
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new Error(failure?.error || 'AI 이미지 변환에 실패했어요. 자동 재시도하지 않았어요.');
  }
  const result = await response.blob();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.type) || !result.size)
    throw new Error('AI 이미지 응답이 올바르지 않아요.');
  // Decode before displaying and export a real PNG even when the provider returns JPEG.
  const bitmap = await createImageBitmap(result);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('결과 이미지를 읽지 못했어요.');
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('결과 PNG 저장에 실패했어요.'))),
        'image/png',
      ),
    );
  } finally {
    bitmap.close();
  }
}
