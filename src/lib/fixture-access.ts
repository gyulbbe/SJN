export const FIXTURES_OPEN_TEST_KEY = 'sjn:test:fixtures-open';

/**
 * 위생도기 in a project is administrators' only for now: the editor hides its tab from members and
 * guests (a screen limit; products already placed stay, and the APIs are as they were). To open it to
 * everyone, make the editor's `canPlaceFixtures` true and delete this file and the tests' use of its key.
 *
 * Guests can never be administrators, so the browser tests of what guests do with products turn the
 * tab on with this session key. It is read only outside production builds.
 */
export function fixturesOpenForTests() {
  if (process.env.NODE_ENV === 'production' || typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(FIXTURES_OPEN_TEST_KEY) === '1';
  } catch {
    return false;
  }
}
