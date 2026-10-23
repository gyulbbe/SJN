'use client';

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
