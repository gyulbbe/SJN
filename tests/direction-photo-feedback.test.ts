/**
 * The "고칠 점" trial's prompts (tests/direction-photo-feedback/cases.ts): way A is the earlier answer's
 * own prompt and the app's feedback paragraph about image 2; way B changes image 0 with the guide as
 * image 2. No AI call.
 */
import { describe, expect, it } from 'vitest';
import { feedbackSentence } from '../src/lib/direction-photo/prompt';
import { CASES, feedbackOf, promptOf } from './direction-photo-feedback/cases';

describe('the 고칠 점 trial', () => {
  it('has five cases, one quick fix each, and Korean words for each', () => {
    expect(CASES).toHaveLength(5);
    expect(new Set(CASES.map((c) => c.fix)).size).toBe(5);
    for (const c of CASES) expect(c.ko).toMatch(/[가-힣]/);
  });

  it('adds the app paragraph about image 2 in way A', () => {
    const [b1] = CASES;
    expect(promptOf('BASE.', b1, 'A', 'fix')).toBe(`BASE. ${feedbackSentence(feedbackOf(b1, 'fix'), 2)}`);
    expect(promptOf('BASE.', b1, 'A', 'fix')).toContain('Image 2 is turned toward the camera');
    expect(promptOf('BASE.', b1, 'A', 'ko')).toContain(
      `The person's request about image 2, in their own words: "${b1.ko}".`,
    );
  });

  it('changes image 0 with the guide as image 2 in way B', () => {
    const text = promptOf('BASE.', CASES[0], 'B', 'fix');
    expect(text).not.toContain('BASE.');
    expect(text).toMatch(/^Image 0 is an earlier attempt/);
    expect(text).toContain('Image 2 is a plain grey 3D render');
    expect(text).toContain('make the view exactly that of image 2');
  });
});
