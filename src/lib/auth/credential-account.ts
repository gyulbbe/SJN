/**
 * ID/password members have no real email. Better Auth still needs a unique `user.email`,
 * so the server stores a reserved, never-deliverable address (RFC 2606 `.invalid`).
 */
export const CREDENTIAL_EMAIL_DOMAIN = 'users.sjn.invalid';
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{4,20}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const normalizeUsername = (username: string) => username.trim().toLowerCase();
export const credentialEmail = (username: string) =>
  normalizeUsername(username) + '@' + CREDENTIAL_EMAIL_DOMAIN;

/** Shows `아이디 xxx` instead of the placeholder address wherever a member is identified. */
export function accountLabel(email: string) {
  const suffix = '@' + CREDENTIAL_EMAIL_DOMAIN;
  return email.endsWith(suffix) ? '아이디 ' + email.slice(0, -suffix.length) : email;
}

const usernameCodes = new Set(['USERNAME_REQUIRED', 'USERNAME_TOO_SHORT', 'USERNAME_TOO_LONG', 'INVALID_USERNAME']);
/** Korean copy for Better Auth username/password errors; never shows the provider's English text. */
export function credentialErrorMessage(mode: 'sign-in' | 'sign-up', status: number, code?: string) {
  if (status === 429) return '시도가 너무 많아요. 잠시 후 다시 시도해 주세요.';
  if (code === 'ACCOUNT_SUSPENDED') return '이용이 정지된 계정이에요. 관리자에게 문의해 주세요.';
  if (code === 'USERNAME_IS_ALREADY_TAKEN') return '이미 사용 중인 아이디예요. 다른 아이디를 입력해 주세요.';
  if (mode === 'sign-in' && (code === 'INVALID_USERNAME_OR_PASSWORD' || (code && usernameCodes.has(code))))
    return '아이디 또는 비밀번호가 맞지 않아요.';
  if (code && usernameCodes.has(code)) return '아이디는 영문·숫자·밑줄 4~20자로 입력해 주세요.';
  if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG')
    return `비밀번호는 ${PASSWORD_MIN_LENGTH}~${PASSWORD_MAX_LENGTH}자로 입력해 주세요.`;
  return mode === 'sign-up'
    ? '회원가입을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.'
    : '로그인하지 못했어요. 잠시 후 다시 시도해 주세요.';
}
