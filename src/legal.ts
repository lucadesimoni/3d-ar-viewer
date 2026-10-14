/**
 * The privacy notice and the licence, served with the app (`public/privacy.html`,
 * and `LICENSE.txt` written into the build by `scripts/third-party-notices.mjs`).
 * The Mendix widget swaps this module for `legal.widget.ts`: inside a Mendix
 * app, that app's own notice applies and these files are not served.
 */
export const LEGAL_LINKS: { privacy: string; licence: string } | undefined = {
  privacy: `${import.meta.env.BASE_URL}privacy.html`,
  licence: `${import.meta.env.BASE_URL}LICENSE.txt`,
};
