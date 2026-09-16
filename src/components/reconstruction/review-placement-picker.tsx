'use client';

import type { RoomDefinition } from '@/lib/room-types';
import type { PlacementReview } from '@/lib/reconstruction/strict-placement';
import { reviewPlacementPoint, reviewPlacementPresets } from '@/lib/reconstruction/review-placement';
import { PlacementPicker } from './placement-picker';

export function ReviewPlacementPicker({
  room,
  request,
  prefix,
  disabled,
  onChange,
  onChooseWall,
}: {
  room: RoomDefinition;
  request: PlacementReview['requested'];
  prefix: string;
  disabled: boolean;
  onChange: (edits: Partial<PlacementReview['requested']>) => void;
  onChooseWall: (edits: Partial<PlacementReview['requested']>) => void;
}) {
  const presets = reviewPlacementPresets(room, request);
  const yaw =
    request.yawDegrees ?? (request.orientation === 'left' ? 90 : request.orientation === 'right' ? -90 : 0);
  return (
    <div>
      {presets.length > 0 && (
        <details>
          <summary>벽 쪽 기본 위치에서 시작</summary>
          <p>
            벽 중앙에서 제품 뒷면을 50mm 띄운 제안이에요. 사진에서 측정한 위치가 아니며, 선택한 후 그림에서
            옮길 수 있어요. 규격은 유지해요.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 4 }}>
            {presets.map((preset) => (
              <button
                type="button"
                className="btn small"
                key={preset.wall}
                disabled={disabled || !preset.valid}
                title={preset.valid ? '선택한 위치를 사용자 설정으로 사용' : preset.reasons.join(' ')}
                aria-label={prefix + ' ' + preset.label + ' 기본 위치 선택'}
                onClick={() =>
                  onChooseWall({
                    u: preset.proposal.u,
                    v: preset.proposal.v,
                    orientation: preset.wall,
                    yawDegrees: preset.proposal.yawDegrees,
                  })
                }
                style={{ display: 'grid', whiteSpace: 'normal', padding: 5, minWidth: 0 }}
              >
                <svg viewBox="0 0 100 100" aria-hidden="true" style={{ width: '100%', maxHeight: 62 }}>
                  <rect x="1" y="1" width="98" height="98" fill="#f6f8f5" stroke="#7a8a82" />
                  <path
                    d={preset.wall === 'back' ? 'M1 1H99' : preset.wall === 'left' ? 'M1 1V99' : 'M99 1V99'}
                    stroke="#277663"
                    strokeWidth="6"
                  />
                  <circle cx={preset.proposal.u * 100} cy={preset.proposal.v * 100} r="6" fill="#277663" />
                </svg>
                <span>{preset.label}</span>
                {!preset.valid && <small>규격 확인 필요</small>}
              </button>
            ))}
          </div>
        </details>
      )}
      <PlacementPicker
        room={room}
        face={request.face}
        u={request.u}
        v={request.v}
        widthMm={request.widthMm * (request.scale ?? 1)}
        heightMm={request.heightMm * (request.scale ?? 1)}
        depthMm={request.depthMm * (request.scale ?? 1)}
        yawDegrees={yaw}
        prefix={prefix}
        disabled={disabled || !!request.support}
        readOnlyMessage={request.support ? '연결된 지지면은 설비 속성에서 수정해 주세요.' : undefined}
        onChange={(point) => onChange(reviewPlacementPoint(room, request, point))}
      />
      {request.face === 'floor' && !request.support && (
        <div className="row" aria-label={prefix + ' 방향 선택'}>
          {[
            [0, '앞쪽 보기'],
            [90, '오른쪽 보기'],
            [-90, '왼쪽 보기'],
            [180, '뒤쪽 보기'],
          ].map(([angle, label]) => (
            <button
              type="button"
              className="btn small"
              key={angle}
              disabled={disabled}
              aria-pressed={yaw === angle}
              onClick={() => onChange({ yawDegrees: Number(angle) })}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
