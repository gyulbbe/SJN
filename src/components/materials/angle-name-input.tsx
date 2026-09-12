'use client';

import { useId, type KeyboardEventHandler } from 'react';
import { MAX_PRODUCT_VIEW_NAME } from '@/lib/product3d/apply';
import styles from './angle-name-input.module.css';

export const ANGLE_NAME_PRESETS = [
  '정면',
  '왼쪽 사선',
  '오른쪽 사선',
  '왼쪽 측면',
  '오른쪽 측면',
  '위에서',
  '뒤에서',
] as const;

export interface AngleNameInputProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}

/** A naming shortcut only: this component never changes a product's pose. */
export function AngleNameInput({ value, onChange, label, disabled = false, onKeyDown }: AngleNameInputProps) {
  const id = useId();
  const preset = ANGLE_NAME_PRESETS.find((name) => name === value) ?? '';
  return (
    <div className={styles.root}>
      <div className={styles.fields}>
        <label className={styles.custom} htmlFor={`${id}-name`}>
          <span>{label}</span>
          <input
            id={`${id}-name`}
            aria-label={label}
            aria-describedby={`${id}-hint`}
            value={value}
            maxLength={MAX_PRODUCT_VIEW_NAME}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
        <label className={styles.quick} htmlFor={`${id}-preset`}>
          <span>빠른 이름 선택</span>
          <select
            id={`${id}-preset`}
            aria-label={`${label} 빠른 선택`}
            aria-describedby={`${id}-hint`}
            value={preset}
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value) onChange(event.target.value);
            }}
          >
            <option value="" disabled>
              이름 선택
            </option>
            {ANGLE_NAME_PRESETS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p id={`${id}-hint`} className={styles.hint}>
        빠른 선택은 이름만 바꾸며 제품을 회전하지 않아요.
      </p>
    </div>
  );
}
