/** Conservative RGB/semantic guards. These remove wall coverage; they do not invent object labels. */
export interface SemanticLogits {
  values: Float32Array;
  width: number;
  height: number;
  channels: number;
  cropWidth: number;
  cropHeight: number;
  paddedWidth: number;
  paddedHeight: number;
}

export interface WallRefinementInput {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  labels: Uint8Array;
  logits?: SemanticLogits;
}

// ADE20K classes that denote planes, landscape, roads or other structural surfaces are not object seeds.
const structure = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 10, 12, 14, 17, 22, 26, 27, 29, 30, 33, 35, 39, 41, 43, 47, 49, 52, 53, 54, 55, 57,
  60, 61, 62, 69, 77, 79, 81, 85, 86, 88, 89, 91, 92, 96, 97, 102, 106, 107, 114, 122, 124, 129, 131, 137,
]);
const objectClass = (label: number) => label > 0 && !structure.has(label);

function evidenceAt(input: WallRefinementInput) {
  const count = input.width * input.height;
  const margin = new Float32Array(count).fill(Infinity);
  const door = new Uint8Array(count);
  const logits = input.logits;
  if (!logits) return { margin, door };
  const { width: lw, height: lh, channels, values } = logits;
  if (channels < 16 || values.length !== lw * lh * channels)
    throw new Error('벽 분석 점수의 크기가 맞지 않아요.');
  for (let y = 0; y < input.height; y++) {
    const gy = Math.min(
      lh - 1,
      (((y * logits.cropHeight) / input.height) * (lh - 1)) / Math.max(1, logits.paddedHeight - 1),
    );
    const y0 = Math.floor(gy),
      y1 = Math.min(lh - 1, y0 + 1),
      fy = gy - y0;
    for (let x = 0; x < input.width; x++) {
      const position = y * input.width + x;
      if (input.labels[position] !== 1) continue;
      const gx = Math.min(
        lw - 1,
        (((x * logits.cropWidth) / input.width) * (lw - 1)) / Math.max(1, logits.paddedWidth - 1),
      );
      const x0 = Math.floor(gx),
        x1 = Math.min(lw - 1, x0 + 1),
        fx = gx - x0;
      const a = (y0 * lw + x0) * channels,
        b = (y0 * lw + x1) * channels;
      const c = (y1 * lw + x0) * channels,
        d = (y1 * lw + x1) * channels;
      let wallScore = -Infinity,
        doorScore = -Infinity,
        bestObject = -Infinity,
        otherScore = -Infinity;
      for (let label = 0; label < channels; label++) {
        const value =
          (1 - fy) * ((1 - fx) * values[a + label] + fx * values[b + label]) +
          fy * ((1 - fx) * values[c + label] + fx * values[d + label]);
        if (label === 1) wallScore = value;
        else if (label === 15) doorScore = value;
        else otherScore = Math.max(otherScore, value);
        if (objectClass(label)) bestObject = Math.max(bestObject, value);
      }
      margin[position] = wallScore - bestObject;
      // Runner-up evidence alone never removes a pixel: a long separating RGB boundary is required too.
      door[position] = doorScore > otherScore + 1.5 && wallScore - doorScore < 12 ? 1 : 0;
    }
  }
  return { margin, door };
}

export function refineWallMask(input: WallRefinementInput) {
  const { width, height, rgba, labels } = input;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 512 ||
    height > 512 ||
    labels.length !== width * height ||
    rgba.length !== width * height * 4
  )
    throw new Error('벽 경계 분석 이미지의 크기가 맞지 않아요.');
  const count = width * height;
  const wall = Uint8Array.from(labels, (label) => (label === 1 ? 255 : 0));
  const protectedPixels = new Uint8Array(count);
  const { margin, door } = evidenceAt(input);
  const difference = (a: number, b: number) =>
    Math.sqrt(
      ((rgba[a * 4] - rgba[b * 4]) ** 2 +
        (rgba[a * 4 + 1] - rgba[b * 4 + 1]) ** 2 +
        (rgba[a * 4 + 2] - rgba[b * 4 + 2]) ** 2) /
        3,
    );
  const localContrast = new Float32Array(count);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const position = y * width + x;
      if (!wall[position] || margin[position] > 4) continue;
      const channelSamples: number[][] = [[], [], []];
      for (const [dx, dy] of [
        [-5, 0],
        [5, 0],
        [0, -5],
        [0, 5],
        [-4, -4],
        [4, -4],
        [-4, 4],
        [4, 4],
      ]) {
        const sample =
          (Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx))) * 4;
        for (let channel = 0; channel < 3; channel++) channelSamples[channel].push(rgba[sample + channel]);
      }
      let squared = 0;
      for (let channel = 0; channel < 3; channel++) {
        channelSamples[channel].sort((a, b) => a - b);
        squared += (rgba[position * 4 + channel] - channelSamples[channel][4]) ** 2;
      }
      localContrast[position] = Math.sqrt(squared / 3);
      // Both a plausible non-wall class and visible local object contrast are necessary.
      if (margin[position] < 1.5 && localContrast[position] > 17) protectedPixels[position] = 1;
    }
  // RGB-guided narrow band around already detected objects. Broad shadows and plain grout have
  // neither matching object color nor the competing semantic evidence needed to expand this band.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!wall[p] || protectedPixels[p] || margin[p] > 4 || localContrast[p] < 10) continue;
      let objectDistance = Infinity,
        wallDistance = Infinity;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          if (x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height) continue;
          const q = (y + dy) * width + x + dx;
          if (objectClass(labels[q])) objectDistance = Math.min(objectDistance, difference(p, q));
        }
      for (const [dx, dy] of [
        [-6, 0],
        [6, 0],
        [0, -6],
        [0, 6],
        [-5, -5],
        [5, -5],
        [-5, 5],
        [5, 5],
      ]) {
        const q =
          Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx));
        if (labels[q] === 1 && margin[q] > 3) wallDistance = Math.min(wallDistance, difference(p, q));
      }
      if (objectDistance < 22 && objectDistance + 6 < wallDistance) protectedPixels[p] = 1;
    }
  let fixturePixels = 0;
  for (let p = 0; p < count; p++) if (protectedPixels[p]) fixturePixels++;

  // An open foreground door/frame may be confidently mislabeled wall. Only protect an outer
  // strip when door class evidence, a sustained vertical image edge, and absence of floor agree.
  const exterior: { side: 'left' | 'right'; x: number; strength: number }[] = [];
  for (const side of ['left', 'right'] as const) {
    let best: { x: number; strength: number } | undefined;
    const from = side === 'left' ? Math.ceil(width * 0.025) : Math.floor(width * 0.75);
    const to = side === 'left' ? Math.ceil(width * 0.25) : Math.floor(width * 0.975);
    for (let x = from; x < to; x++) {
      const contrasts: number[] = [];
      for (let y = 0; y < height; y++)
        contrasts.push(difference(y * width + Math.max(0, x - 1), y * width + Math.min(width - 1, x + 1)));
      contrasts.sort((a, b) => a - b);
      const strength = contrasts[Math.floor(height * 0.35)];
      if (strength < 8 || contrasts[Math.floor(height * 0.5)] < 10) continue;
      let samples = 0,
        evidence = 0,
        floor = 0;
      const start = side === 'left' ? 0 : x + 1,
        end = side === 'left' ? x : width;
      for (let sy = 0; sy < height; sy += 3)
        for (let sx = start; sx < end; sx += 3) {
          const p = sy * width + sx;
          samples++;
          if (door[p] || labels[p] === 15) evidence++;
          if (labels[p] === 4) floor++;
        }
      if (evidence / samples < 0.6 || floor / samples > 0.01) continue;
      best = { x, strength };
      // Choose the innermost qualifying edge rather than a stronger bevel inside the door frame.
      if (side === 'right') break;
    }
    if (best) {
      exterior.push({ side, ...best });
      const start = side === 'left' ? 0 : best.x + 1,
        end = side === 'left' ? best.x : width;
      for (let y = 0; y < height; y++)
        for (let x = start; x < end; x++) {
          const p = y * width + x;
          if (wall[p]) protectedPixels[p] = 1;
        }
    }
  }
  let excludedPixels = 0;
  for (let p = 0; p < count; p++)
    if (protectedPixels[p]) {
      wall[p] = 0;
      excludedPixels++;
    }
  return { wall, protectedPixels, stats: { excludedPixels, fixturePixels, exterior } };
}
