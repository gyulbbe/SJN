'use client';

import type { MaterialVersion } from '@/lib/types';

const INSTALLATION: Record<MaterialVersion['installation'], string> = {
  floor: '바닥형',
  wall: '벽걸이형',
  embedded: '매립형',
  suspended: '천장형',
};

/**
 * A product on a wall has no switch: it always touches its wall (docs/wall-contact-results-20261024.md).
 * `moveTo`: the product stands on the other kind of face than its installation says (a 벽걸이형 one on
 * the floor, a 바닥형 one on a wall); nothing moves it by itself, the button does (the inspector's face
 * change, one undo step).
 */
export function WallInstallNote({
  onWall,
  installation,
  moveTo,
  disabled,
  onMove,
}: {
  onWall: boolean;
  installation?: MaterialVersion['installation'];
  moveTo?: 'floor' | 'back';
  disabled: boolean;
  onMove: (face: 'floor' | 'back') => void;
}) {
  return (
    <div data-testid="wall-install-note" style={{ margin: '4px 0 14px' }}>
      {onWall && (
        <p className="muted" style={{ fontSize: 12 }}>
          벽에 설치한 제품은 항상 벽에 붙어요.
        </p>
      )}
      {moveTo && installation && (
        <div
          data-testid="installation-mismatch"
          className="row"
          style={{ gap: 8, alignItems: 'center', marginTop: 4 }}
        >
          <p style={{ fontSize: 12, flex: 1 }}>
            설치 방식과 놓인 곳이 달라요. 이 제품은 {INSTALLATION[installation]}이에요.
          </p>
          <button
            type="button"
            className="btn small max-[620px]:min-h-11 [@media(pointer:coarse)]:min-h-11"
            disabled={disabled}
            onClick={() => onMove(moveTo)}
          >
            {moveTo === 'floor' ? '바닥으로 옮기기' : '벽으로 옮기기'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * "벽에 붙이기": keeps a floor product with its back on the wall behind it (src/lib/room-wall-contact.ts).
 * The inspector changes the scene (one undo step each way); this only draws the switch.
 */
export default function WallContactSwitch({
  on,
  wallName,
  disabled,
  onToggle,
}: {
  on: boolean;
  /** The wall behind the product in words; none when its back is to the open front. */
  wallName?: string;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  const unavailable = !wallName;
  return (
    <div data-testid="wall-contact-block" style={{ margin: '4px 0 14px' }}>
      <label
        // The whole row is the switch's target: 44 px tall on a phone or a touch screen.
        className="row max-[620px]:min-h-11 [@media(pointer:coarse)]:min-h-11"
        style={{ gap: 8, alignItems: 'center', cursor: disabled || unavailable ? 'default' : 'pointer' }}
      >
        <input
          type="checkbox"
          role="switch"
          aria-label="벽에 붙이기"
          aria-describedby="wall-contact-hint"
          checked={on && !unavailable}
          disabled={disabled || unavailable}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span style={{ fontSize: 13, fontWeight: 600 }}>벽에 붙이기</span>
      </label>
      <p id="wall-contact-hint" className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        {unavailable
          ? '‘뒤’ 각도라 제품의 뒤가 열린 앞쪽을 봐요. 붙일 벽이 없어요.'
          : on
            ? `제품의 뒤가 ${wallName}에 닿아 있어요. 방 크기나 각도가 바뀌어도 붙어 있어요.`
            : `켜면 제품의 뒤를 ${wallName}에 붙여요. 벽 가까이 끌어도 붙어요.`}
      </p>
    </div>
  );
}
