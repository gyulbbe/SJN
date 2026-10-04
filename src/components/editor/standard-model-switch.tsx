'use client';
import type { FixtureInstance } from '@/lib/types';

type Model = NonNullable<FixtureInstance['reconstruction']>;

/**
 * "표준 모형으로 보기": the switch that shows a registered photo product as the generic toilet, basin
 * or bath the 3D room builds in code, and the few options the model has. The inspector does the work
 * (it reads the photo's colour and changes the scene); this only draws it.
 */
export default function StandardModelSwitch({
  model,
  disabled,
  busy,
  notice,
  error,
  onToggle,
  onModel,
  onModelCommit,
}: {
  /** The fixture's `reconstruction` while the switch is on; none while it is off. */
  model?: Model;
  disabled: boolean;
  /** The photo's colour is being read. */
  busy: boolean;
  notice: string;
  error: string;
  onToggle: (on: boolean) => void;
  /** Edits the model; `preview` shows it live and `onModelCommit` makes it one undo step. */
  onModel: (edit: (model: Model) => void, preview?: boolean) => void;
  onModelCommit: () => void;
}) {
  const on = !!model;
  return (
    <div data-testid="standard-model-block" style={{ margin: '4px 0 14px' }}>
      <label
        className="row"
        style={{ gap: 8, alignItems: 'center', cursor: disabled || busy ? 'default' : 'pointer' }}
      >
        <input
          type="checkbox"
          role="switch"
          aria-label="표준 모형으로 보기"
          checked={on}
          disabled={disabled || busy}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span style={{ fontSize: 13, fontWeight: 600 }}>표준 모형으로 보기</span>
      </label>
      <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        {on
          ? '일반 변기·세면대·욕조 모양으로 위·옆에서도 입체로 보여요. 제품 생김새는 사라져요. 끄면 사진으로 돌아와요. 다른 제품으로 바꾸면 사진으로 시작해요.'
          : '켜면 위·옆에서도 입체로 보이지만 제품 생김새는 사라지고 일반 모양이 돼요. 끄면 사진으로 돌아와요.'}
      </p>
      {busy && (
        <p role="status" className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          사진에서 색을 읽는 중이에요…
        </p>
      )}
      {notice && (
        <p
          role="status"
          data-testid="standard-model-notice"
          className="muted"
          style={{ fontSize: 12, marginTop: 6 }}
        >
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error" style={{ fontSize: 12, marginTop: 6 }}>
          {error}
        </p>
      )}
      {model && (
        <div data-testid="standard-model-options" style={{ marginTop: 10 }}>
          <label className="color-field">
            모형 색상
            <input
              aria-label="모형 색상"
              type="color"
              value={model.color}
              disabled={disabled}
              onChange={(e) => onModel((m) => (m.color = e.target.value), true)}
              onBlur={onModelCommit}
            />
          </label>
          {model.kind === 'toilet' && (
            <label className="field">
              뚜껑
              <select
                className="input"
                aria-label="변기 뚜껑"
                value={model.toiletLidState ?? 'seat'}
                disabled={disabled}
                onChange={(e) =>
                  onModel((m) => {
                    if (e.target.value === 'seat') delete m.toiletLidState;
                    else m.toiletLidState = e.target.value as 'open' | 'closed';
                  })
                }
              >
                <option value="closed">닫힘</option>
                <option value="open">열림</option>
                <option value="seat">시트만</option>
              </select>
            </label>
          )}
          {model.kind === 'basin' && (
            <>
              <label className="field">
                세면대 형태
                <select
                  className="input"
                  aria-label="세면대 형태"
                  value={model.basinVariant ?? 'pedestal'}
                  disabled={disabled}
                  onChange={(e) => onModel((m) => (m.basinVariant = e.target.value as 'wall' | 'pedestal'))}
                >
                  <option value="wall">벽걸이</option>
                  <option value="pedestal">받침대</option>
                </select>
              </label>
              <label className="field">
                그릇 모양
                <select
                  className="input"
                  aria-label="세면대 그릇 모양"
                  value={model.basinShape ?? 'round'}
                  disabled={disabled}
                  onChange={(e) => onModel((m) => (m.basinShape = e.target.value as 'round' | 'rectangular'))}
                >
                  <option value="round">둥근 모양</option>
                  <option value="rectangular">사각 모양</option>
                </select>
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}
