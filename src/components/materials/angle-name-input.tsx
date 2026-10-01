'use client';

import { useId } from 'react';
import { PRODUCT_DIRECTIONS, type ProductDirection } from '@/lib/product-direction';
import styles from './angle-name-input.module.css';

export interface AngleNameSelectProps {
  value: string;
  onChange: (value: ProductDirection) => void;
  label: string;
  disabled?: boolean;
  /** Names another photo of this material already has (one photo per direction). */
  taken?: readonly string[];
  /** The stored name that could not be read; asks for a new pick until one is made. */
  unreadName?: string;
}

/**
 * The angle name is picked from the closed list, never typed. The name is the direction the
 * product faces in that photo, seen from the front of the room; the rooms and the AI conversion
 * follow it. Picking a name here never rotates a product (the 360° editor turns it on its own).
 */
export function AngleNameSelect({
  value,
  onChange,
  label,
  disabled = false,
  taken = [],
  unreadName,
}: AngleNameSelectProps) {
  const id = useId();
  const listed = (PRODUCT_DIRECTIONS as readonly string[]).includes(value) ? value : '';
  return (
    <div className={styles.root}>
      <label className={styles.field} htmlFor={`${id}-name`}>
        <span>{label}</span>
        <select
          id={`${id}-name`}
          aria-label={label}
          aria-describedby={`${id}-hint`}
          value={listed}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as ProductDirection)}
        >
          {!listed && (
            <option value="" disabled>
              방향 선택
            </option>
          )}
          {PRODUCT_DIRECTIONS.map((name) => (
            <option key={name} value={name} disabled={name !== listed && taken.includes(name)}>
              {name}
              {name !== listed && taken.includes(name) ? ' (사용 중)' : ''}
            </option>
          ))}
        </select>
      </label>
      <p id={`${id}-hint`} className={styles.hint}>
        이 사진에서 제품이 바라보는 방향이에요(방을 정면에서 볼 때). 방향마다 한 장만 저장해요.
      </p>
      {unreadName !== undefined && (
        <p role="status" className={styles.stale}>
          이전에 저장한 이름 ‘{unreadName || '(이름 없음)'}’을 읽을 수 없어 ‘{value}’로 보여 줘요. 방향을 다시
          골라 주세요.
        </p>
      )}
    </div>
  );
}
