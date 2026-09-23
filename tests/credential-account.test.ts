import { describe, expect, it } from 'vitest';
import {
  accountLabel,
  credentialEmail,
  credentialErrorMessage,
  USERNAME_PATTERN,
} from '../src/lib/auth/credential-account';

describe('credential accounts', () => {
  it('derives a non-deliverable email from the normalized ID and labels it back as an ID', () => {
    expect(credentialEmail(' Gildong_01 ')).toBe('gildong_01@users.sjn.invalid');
    expect(accountLabel('gildong_01@users.sjn.invalid')).toBe('아이디 gildong_01');
    expect(accountLabel('member@example.com')).toBe('member@example.com');
    expect(accountLabel('users.sjn.invalid@example.com')).toBe('users.sjn.invalid@example.com');
  });

  it('accepts 4-20 letters, digits and underscores only', () => {
    for (const valid of ['abcd', 'A_1b', 'x'.repeat(20)]) expect(USERNAME_PATTERN.test(valid)).toBe(true);
    for (const invalid of ['abc', 'x'.repeat(21), 'bad id', '한글아이디', 'dot.name'])
      expect(USERNAME_PATTERN.test(invalid)).toBe(false);
  });

  it('maps server codes to Korean without revealing which half of a login was wrong', () => {
    expect(credentialErrorMessage('sign-in', 401, 'INVALID_USERNAME_OR_PASSWORD')).toBe(
      '아이디 또는 비밀번호가 맞지 않아요.',
    );
    expect(credentialErrorMessage('sign-in', 422, 'USERNAME_TOO_SHORT')).toBe(
      '아이디 또는 비밀번호가 맞지 않아요.',
    );
    expect(credentialErrorMessage('sign-up', 400, 'USERNAME_TOO_SHORT')).toContain('4~20자');
    expect(credentialErrorMessage('sign-up', 400, 'USERNAME_IS_ALREADY_TAKEN')).toContain('이미 사용 중');
    expect(credentialErrorMessage('sign-up', 400, 'PASSWORD_TOO_SHORT')).toContain('8~128자');
    expect(credentialErrorMessage('sign-in', 403, 'ACCOUNT_SUSPENDED')).toContain('정지');
    expect(credentialErrorMessage('sign-in', 429)).toContain('시도가 너무 많아요');
    expect(credentialErrorMessage('sign-up', 500, 'Some English error')).toBe(
      '회원가입을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.',
    );
  });
});
