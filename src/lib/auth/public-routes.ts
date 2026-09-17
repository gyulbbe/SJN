/** Public entry points never grant access to an account workspace. */
export function isPublicPage(pathname: string): boolean {
  return ['/', '/materials', '/try', '/login'].includes(pathname.replace(/\/$/, '') || '/');
}
export type SignInOptions = { resumeGuest?: boolean };
export function signInDestinations(options: SignInOptions = {}) {
  return options.resumeGuest
    ? { callbackURL: '/try?resume=1', errorCallbackURL: '/login?authError=google&resume=guest' }
    : { callbackURL: '/', errorCallbackURL: '/login?authError=google' };
}
