'use client';

import { kindBehavior } from '@/lib/material-kinds';
import { useEffect, useRef, useState } from 'react';
import { copyText } from '@/lib/clipboard';
import { PRODUCT_DIRECTIONS, type ProductDirection } from '@/lib/product-direction';
import {
  buildDirectionPhotoPrompt,
  DIRECTION_PROMPT_SUMMARY,
  directionPromptNotices,
  recommendedDirections,
  type DirectionPhotoPromptInput,
} from '@/lib/product-photo-prompt';
import type { MaterialInput } from '@/lib/types';
import styles from './materials.module.css';

/** What the form knows that goes into a prompt (the features are typed here and never stored). */
export type PromptSource = Pick<
  MaterialInput,
  'category' | 'widthMm' | 'heightMm' | 'depthMm' | 'installation'
> & {
  details: string;
};

/** The prompt input for one direction: the other directions refer to the 정면 result made first. */
const promptInput = (source: PromptSource, direction: ProductDirection): DirectionPhotoPromptInput => ({
  category: kindBehavior(source.category),
  direction,
  widthMm: source.widthMm,
  heightMm: source.heightMm,
  depthMm: source.depthMm,
  install: source.installation,
  details: source.details,
  withFrontResult: direction !== '정면',
});

/** "복사했어요" for a moment, or how to copy by hand when the browser refused. */
function useCopyState() {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (next: 'copied' | 'failed') => {
    clearTimeout(timer.current);
    setState(next);
    if (next === 'copied') timer.current = setTimeout(() => setState('idle'), 2000);
  };
  return [state, show] as const;
}

/** The button on a photo card: copies the prompt for that card's direction. */
export function DirectionPromptCopy({
  source,
  direction,
}: {
  source: PromptSource;
  direction: ProductDirection;
}) {
  const [state, show] = useCopyState();
  return (
    <div className={styles.promptCopy}>
      <button
        type="button"
        className="btn small"
        aria-label={`${direction} 방향 프롬프트 복사`}
        onClick={async () =>
          show(
            (await copyText(buildDirectionPhotoPrompt(promptInput(source, direction)))) ? 'copied' : 'failed',
          )
        }
      >
        이 방향 프롬프트 복사
      </button>
      {state !== 'idle' && (
        <span role="status" className={styles.note}>
          {state === 'copied'
            ? '복사했어요'
            : '복사하지 못했어요. 위 ‘외부 AI용 프롬프트 복사’에서 글상자를 선택해 직접 복사해 주세요.'}
        </span>
      )}
    </div>
  );
}

/**
 * "외부 AI용 프롬프트 복사" (named "AI로 방향별 사진 만들기" until the app made the photos itself): how to make the 정면·왼쪽·오른쪽·뒤 photos with an outside image
 * generator from one photo the person has, and the prompt for each direction to copy (the app calls
 * no AI). The prompts follow the app's direction rules (src/lib/product-photo-prompt.ts).
 */
export function DirectionPhotoPrompts({
  source,
  onDetailsChange,
}: {
  source: PromptSource;
  onDetailsChange: (details: string) => void;
}) {
  const [direction, setDirection] = useState<ProductDirection>('정면');
  const [state, show] = useCopyState();
  const text = useRef<HTMLTextAreaElement>(null);
  const input = promptInput(source, direction);
  const prompt = buildDirectionPhotoPrompt(input);
  const notices = directionPromptNotices(input);
  const copy = async () => {
    if (await copyText(prompt)) return show('copied');
    // Refused: select the whole prompt so Ctrl+C (or the menu) copies it.
    text.current?.focus();
    text.current?.select();
    show('failed');
  };
  return (
    <details className={styles.promptGuide} data-testid="direction-prompts">
      <summary>외부 AI용 프롬프트 복사</summary>
      <p className={styles.note}>
        갖고 있는 제품 사진 한 장(사선·위에서 찍은 사진·연출 사진도 돼요)과 아래 프롬프트를 이미지 생성 AI에
        함께 넣으면, 이 앱의 방향 규칙에 맞는 정면·왼쪽·오른쪽·뒤 사진을 만들 수 있어요. 앱은 AI를 부르지 않고
        프롬프트만 만들어요.
      </p>
      <ol className={styles.promptSteps}>
        <li>원본 제품 사진을 준비해요.</li>
        <li>정면 프롬프트를 복사해 원본 사진과 함께 AI에 넣어요.</li>
        <li>결과가 맞는지 아래 확인 목록으로 확인해요.</li>
        <li>나머지 방향은 원본과 정면 결과를 함께 넣고, 그 방향의 프롬프트를 복사해 넣어요.</li>
        <li>한 번에 한 방향씩 만들어요.</li>
        <li>결과를 저장해 같은 이름의 방향으로 등록해요.</li>
      </ol>
      <label className="field">
        지켜야 할 제품 특징(선택)
        <textarea
          className="input"
          aria-label="지켜야 할 제품 특징(선택)"
          rows={2}
          maxLength={300}
          placeholder="예: overflow at the right end, flush button on top, logo on the front"
          value={source.details}
          onChange={(event) => onDetailsChange(event.target.value)}
        />
        <span className={styles.note}>
          입력하면 프롬프트에 들어가요(영어로 쓰면 더 정확해요). 자재에는 저장되지 않아요.
        </span>
      </label>
      <div role="tablist" aria-label="프롬프트 방향" className={styles.toolbar}>
        {PRODUCT_DIRECTIONS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={name === direction}
            className={`btn small${name === direction ? ' active' : ''}`}
            onClick={() => setDirection(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={`${direction} 프롬프트 안내`} className={styles.promptPanel}>
        <p className={styles.note}>{DIRECTION_PROMPT_SUMMARY[direction]}</p>
        {notices.map((notice) => (
          <p key={notice} role="status" className={styles.promptNotice} data-testid="prompt-notice">
            {notice}
          </p>
        ))}
        <textarea
          ref={text}
          readOnly
          className={`input ${styles.promptText}`}
          aria-label={`${direction} 프롬프트`}
          rows={9}
          value={prompt}
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className={styles.toolbar}>
          <button
            type="button"
            className="btn small"
            aria-label={`${direction} 프롬프트 복사`}
            onClick={copy}
          >
            프롬프트 복사
          </button>
          {state !== 'idle' && (
            <span role="status" className={styles.note}>
              {state === 'copied'
                ? '복사했어요'
                : '복사하지 못했어요. 글상자의 프롬프트를 선택해 두었으니 Ctrl+C로 복사해 주세요.'}
            </span>
          )}
        </div>
      </div>
      <p className={styles.note}>
        이 제품에 권장하는 사진: {recommendedDirections(kindBehavior(source.category))}
      </p>
      <p className={styles.note}>만든 사진 확인 목록</p>
      <ul className={styles.promptSteps}>
        <li>같은 제품인가요(모양·세부·색)?</li>
        <li>제품의 앞이 사진의 맞는 쪽을 보나요(왼쪽 사진은 왼쪽, 오른쪽 사진은 오른쪽)?</li>
        <li>사진 속 제품의 가로 : 높이가 프롬프트의 비율과 비슷한가요?</li>
        <li>배경이 순백이고 소품·글자가 없나요?</li>
        <li>제품 가장자리가 잘리지 않았나요?</li>
      </ul>
      <p className={styles.promptNotice}>
        AI로 만든 사진은 실제 제품과 다를 수 있어요. 실제 제품과 비교해 확인하세요.
      </p>
    </details>
  );
}
