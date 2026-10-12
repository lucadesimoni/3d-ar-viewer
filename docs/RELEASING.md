# Releasing

Every component ships from one tag, built once, checked the way its user
will use it, and published only when all of it works.

| Component | Asset | Where |
| --- | --- | --- |
| Web app | `spatial-ar-web-X.Y.Z.zip` / `.tar.gz` | the GitHub release |
| Server (app + `spatial-ar-viewer` command) | `lucadesimoni-spatial-ar-viewer-X.Y.Z.tgz` | the release, and `@lucadesimoni/spatial-ar-viewer` on GitHub Packages |
| Container image | `ghcr.io/lucadesimoni/3d-ar-viewer:X.Y.Z` and `:latest` | GHCR, linux/amd64 and linux/arm64 |
| Mendix widget (preview) | `anthropic.SpatialArViewer-X.Y.Z.mpk` | the release |
| Checksums | `SHA256SUMS.txt` | the release |

## Cutting a release

1. Set the version in `package.json` (plain `X.Y.Z`: Mendix takes nothing
   else) and run `npm install` so the lockfile agrees.
2. Add a `## [X.Y.Z]` section to `CHANGELOG.md`. It becomes the release
   notes as written, with install instructions added; a version without one
   is refused.
3. Merge to `main` the usual way: the full battery green.
4. Optionally, a dry run: Actions → **Release** → *Run workflow*. It does
   everything below except publish, and keeps the packages as an artifact.
5. Tag the merge and push the tag:

   ```bash
   git tag vX.Y.Z origin/main
   git push origin vX.Y.Z
   ```

The **Release** workflow then:

1. runs the whole CI battery (`ci.yml`): types, unit tests, build, every
   browser suite, the package checks;
2. refuses a tag that does not match `package.json`;
3. packages every component (`npm run release:package`) and tries each one
   (`npm run release:check`): the archives unpacked, the npm package installed
   with no network and started, the widget loaded into a host page by an AMD
   loader and as an ES module, rendered, and kept from styling the host page;
4. builds the image for the runner and runs it (health check, serves the app,
   not root), then builds both architectures and pushes them;
5. publishes the npm package and creates the GitHub release with every asset.

Nothing is published before step 5, and step 5 only runs when everything
before it passed.

## Locally

```bash
npm run release:package          # everything into release/
npm run release:check            # try each package (needs Playwright's Chromium)
docker build -t spatial-ar .     # the image
```

Behind a TLS-inspecting proxy, give the image build its CA as a secret:
`docker build --secret id=ca,src=ca.pem -t spatial-ar .` It is used for
`npm ci` and is not stored in the image.

## The Mendix widget

`vite.widget.config.ts` builds it the way Mendix's pluggable-widget tooling
does: `anthropic/spatialarviewer/SpatialArViewer.js` (loaded through AMD) and
`.mjs` (ES module), with React, React DOM, `mendix` and `big.js` supplied by
the Mendix client. The app's stylesheet is scoped to the widget (`@scope`),
so it does not restyle the host page; a browser without `@scope` (before
Safari 17.4) shows the widget unstyled rather than the page restyled.

It is a preview: checked against a host page here, with this repository's
React 19, and not yet imported into Studio Pro, whose client ships React 18.
The widget uses only hooks that both have. ONNX Runtime's wasm is not in the
package; recognition models load it from the CDN, as the app does.
