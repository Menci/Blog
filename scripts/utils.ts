export const isRelativeUrl = (url: string) => {
  const TEST_ORIGIN = "https://test-relative-url.example.com/";
  const origin = new URL(TEST_ORIGIN);
  const testedUrl = new URL(url, origin);
  return testedUrl.origin === origin.origin;
};
