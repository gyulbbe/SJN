/**
 * The "고칠 점" trial's prompts (tests/direction-photo-feedback/cases.ts): way A is the earlier answer's
 * own prompt and the feedback paragraph about image 2 (the app's, or as sent on 11-07 for the two quick
 * fixes the app dropped); way B changes image 0 with the guide as image 2. No AI call.
 */
import { describe, expect, it } from 'vitest';
import { feedbackSentence } from '../src/lib/direction-photo/prompt';
import { CASES, feedbackOf, promptOf, trialParagraph } from './direction-photo-feedback/cases';

describe('the 고칠 점 trial', () => {
  it('has five cases, one quick fix each, and Korean words for each', () => {
    expect(CASES).toHaveLength(5);
    expect(new Set(CASES.map((c) => c.fix)).size).toBe(5);
    for (const c of CASES) expect(c.ko).toMatch(/[가-힣]/);
  });

  it('adds the paragraph about image 2 in way A, the dropped fixes as sent on 11-07', () => {
    const [b1, b6] = CASES;
    expect(promptOf('BASE.', b1, 'A', 'fix')).toBe(
      'BASE. Image 2 is an earlier attempt at this photo that the person wants changed. Image 2 is turned toward the camera or seen at a slant; make the view exactly that of image 0, straight on, with no perspective and no turn. Make the new photo from image 0 and the product photos as said above, keep what image 2 already got right and change only what is asked.',
    );
    // The app's own fixes and the words are the app's paragraph.
    expect(promptOf('BASE.', b6, 'A', 'fix')).toBe(
      `BASE. ${feedbackSentence({ fixes: ['colour'], text: '' }, 2)}`,
    );
    expect(promptOf('BASE.', b1, 'A', 'ko')).toBe(
      `BASE. ${feedbackSentence({ fixes: [], text: feedbackOf(b1, 'ko').text }, 2)}`,
    );
    expect(promptOf('BASE.', b1, 'A', 'ko')).toContain(
      `The person's request about image 2, in their own words: "${b1.ko}".`,
    );
    expect(() => trialParagraph({ fixes: ['straight', 'colour'], text: '' }, 2)).toThrow();
  });

  it('changes image 0 with the guide as image 2 in way B', () => {
    const text = promptOf('BASE.', CASES[0], 'B', 'fix');
    expect(text).not.toContain('BASE.');
    expect(text).toMatch(/^Image 0 is an earlier attempt/);
    expect(text).toContain('Image 2 is a plain grey 3D render');
    expect(text).toContain('make the view exactly that of image 2');
  });
});
