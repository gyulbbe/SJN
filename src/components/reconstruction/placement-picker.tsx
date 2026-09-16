'use client';

import { useRef } from 'react';
import type { RoomDefinition, RoomFace } from '@/lib/room-types';
import styles from './reconstruction-lab.module.css';

type Position = { u: number; v: number };
const clamp = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000;

/** A user-set installation point, not a photo mask or an inferred room boundary. */
export function PlacementPicker({
  room,
  face,
  u,
  v,
  widthMm,
  heightMm,
  depthMm,
  yawDegrees,
  disabled,
  prefix,
  readOnlyMessage,
  onChange,
}: Position & {
  room: RoomDefinition;
  face: RoomFace;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  yawDegrees: number;
  disabled: boolean;
  prefix: string;
  readOnlyMessage?: string;
  onChange: (position: Position) => void;
}) {
  const drag = useRef<{ pointerId: number; start: Position } | null>(null);
  const horizontal = face === 'left' || face === 'right' ? room.depthMm : room.widthMm;
  const vertical = face === 'floor' ? room.depthMm : room.heightMm;
  const position = { u: Number.isFinite(u) ? u : 0.5, v: Number.isFinite(v) ? v : 0.5 };
  const angle = Number.isFinite(yawDegrees) ? (yawDegrees * Math.PI) / 180 : 0;
  const width = Number.isFinite(widthMm) && widthMm > 0 ? widthMm : 0;
  const height = Number.isFinite(heightMm) && heightMm > 0 ? heightMm : 0;
  const depth = Number.isFinite(depthMm) && depthMm > 0 ? depthMm : 0;
  const corners =
    face === 'floor'
      ? [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([x, z]) => ({
          u:
            position.u +
            (((x * width) / 2) * Math.cos(angle) + ((z * depth) / 2) * Math.sin(angle)) / horizontal,
          v:
            position.v +
            (((-x * width) / 2) * Math.sin(angle) + ((z * depth) / 2) * Math.cos(angle)) / vertical,
        }))
      : [
          { u: position.u - width / 2 / horizontal, v: position.v - height / vertical },
          { u: position.u + width / 2 / horizontal, v: position.v - height / vertical },
          { u: position.u + width / 2 / horizontal, v: position.v },
          { u: position.u - width / 2 / horizontal, v: position.v },
        ];
  const outside = corners.some((point) => point.u < 0 || point.u > 1 || point.v < 0 || point.v > 1);
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0)
      onChange({
        u: clamp((event.clientX - rect.left) / rect.width),
        v: clamp((event.clientY - rect.top) / rect.height),
      });
  };
  return (
    <div className={styles.placementPicker}>
      <strong>{face === 'floor' ? '위에서 본 바닥' : '설치 벽을 펼쳐서 보기'}</strong>
      <small>
        {face === 'floor'
          ? '위: 뒤쪽 벽 · 아래: 앞쪽'
          : face === 'back'
            ? '위: 천장 · 아래: 바닥'
            : face === 'left'
              ? '왼쪽: 앞쪽 · 오른쪽: 뒤쪽 벽 · 아래: 바닥'
              : '왼쪽: 뒤쪽 벽 · 오른쪽: 앞쪽 · 아래: 바닥'}
      </small>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ aspectRatio: String(horizontal / vertical) }}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={prefix + ' 설치 위치 그림'}
        aria-disabled={disabled}
        data-testid="placement-picker"
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus();
          drag.current = { pointerId: event.pointerId, start: position };
          event.currentTarget.setPointerCapture(event.pointerId);
          move(event);
        }}
        onPointerMove={(event) => {
          if (!disabled && drag.current?.pointerId === event.pointerId) move(event);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          if (!disabled) move(event);
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointerId === event.pointerId) {
            onChange(drag.current.start);
            drag.current = null;
          }
        }}
        onKeyDown={(event) => {
          if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const step = event.shiftKey ? 0.1 : 0.01;
          onChange({
            u: clamp(
              position.u + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
            ),
            v: clamp(position.v + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0)),
          });
        }}
      >
        <title>원하는 곳을 누르거나 점을 끌어 위치를 정하세요. 방향키로 조금씩 움직일 수 있어요.</title>
        <rect width="100" height="100" fill="#f6f8f5" />
        {[25, 50, 75].map((at) => (
          <path
            key={at}
            d={`M ${at} 0 V 100 M 0 ${at} H 100`}
            stroke="#dce3dc"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polygon
          points={corners.map((p) => `${p.u * 100},${p.v * 100}`).join(' ')}
          fill={outside ? '#d8644a33' : '#3d897733'}
          stroke={outside ? '#b54530' : '#3d8977'}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {face === 'floor' && (
          <path
            d={`M ${position.u * 100} ${position.v * 100} l ${Math.sin(angle) * 12} ${Math.cos(angle) * 12}`}
            stroke="#255e50"
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <circle
          cx={position.u * 100}
          cy={position.v * 100}
          r="2"
          fill="#255e50"
          stroke="white"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <small>
        {face === 'floor'
          ? '점은 제품 바닥 면의 중심, 선은 앞을 향하는 방향이에요.'
          : '점은 제품 하단 중앙이에요. 제품은 점 위쪽에 놓여요.'}{' '}
        {readOnlyMessage ?? '그림을 누르거나 끌어서 지정해요. 방향키로 1%, Shift와 함께 10%씩 이동해요.'}
      </small>
      {outside && <p role="status">제품 일부가 이 면 밖에 있어요. 위치·방향·규격을 확인해 주세요.</p>}
    </div>
  );
}
