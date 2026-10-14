# Native shells

The web app is the product: an installable PWA on Android and iOS. These two
small apps are an optional upgrade. Each one shows the same web app over the
platform's own world tracking:

| | Android | iOS |
|---|---|---|
| Tracking | ARCore | ARKit |
| Folder | `native/android` (Kotlin, Gradle) | `native/ios` (Swift, XcodeGen) |
| Why | Chrome already offers ARCore through WebXR; the app adds the camera frames and a launcher icon | iPhone Safari has no WebXR: in the browser the overlay can only turn with the phone. In the app it stays where it was put as you walk. |

## How they connect

The web app talks to a shell through `src/native/bridge.ts`, protocol version 1:

- **Shell to page.** `hello`, then a `pose` every frame. A pose carries the
  camera's pose, its field of view, the tracking state and the floor height.
  The shell also sends `camera-image` when asked, cut to exactly what the
  screen shows, and `session` state changes.
- **Page to shell.** `start`, `stop`, `request-image`.

The same contract is mirrored in each shell, with unit tests:

- `native/android/protocol` (Kotlin), run with `./gradlew -PprotocolOnly :protocol:test`;
- `native/ios/SpatialProtocol` (Swift), run with `swift test`.

The shells give the bridge only to the app's own site, and only to its top
frame. Any other link opens in the browser.

**Inside a shell,** Enter AR uses the shell's tracking. The page turns
transparent over the camera. A tap places the assembly on the floor the shell
measured. Recognition and the camera step check read the shell's frames. If
the shell cannot start AR, the page falls back to its own camera path.

**Outside a shell,** on Android the web app shows "Open in the Spatial AR app"
only when Chrome reports the app installed. On iOS a page cannot find that
out, so the link is in the AR settings.

`scripts/native-check.mjs` runs the web app against a simulated Android shell
and a simulated iOS shell, and checks all of the above in a browser.

## Building and installing

Both build in GitHub Actions (`.github/workflows/native.yml`) on every push
that touches them.

### Android

The release attaches the APK as `spatial-ar-android-X.Y.Z.apk`, and every
build of the workflow keeps it as an artifact. To install it:

1. open the APK on the phone;
2. allow installing from that source when Android asks;
3. on first AR use, the app offers to install Google Play Services for AR if
   it is missing.

The APK is signed with a **test key that is in this repository on purpose**
(`native/android/app/test-signing.jks`, password `spatialar-test`). The key
being stable is what lets a newer APK install over an older one. Because
anyone can sign with it, it is for testing and sideloading only. A Play Store
release must be signed with a private key, which the build takes from
`SPATIAL_KEYSTORE`, `SPATIAL_KEYSTORE_PASSWORD`, `SPATIAL_KEY_ALIAS` and
`SPATIAL_KEY_PASSWORD`.

To build locally you need the Android SDK (Android Studio, or the command-line
tools):

```bash
cd native/android && ./gradlew :app:assembleRelease
```

The APK ends up in `app/build/outputs/apk/release/`.

### iOS

iOS installs only apps signed by an Apple account. CI builds two things:

- the app for the simulator, which proves it compiles. The simulator cannot
  run ARKit;
- `spatial-ar-ios-X.Y.Z-unsigned.ipa` for devices.

**Without paying anything**, best first:

1. **No native app at all:** in Safari, the web app's "Open with real AR
   tracking" opens it in Needle's App Clip. That gives ARKit tracking with
   nothing to install. It is a third-party service, and not yet verified on a
   device.
2. **SideStore** (free). A computer is needed once to set it up; after that
   it re-signs the unsigned `.ipa` on the phone every 7 days, with no
   computer.
3. **Sideloadly** (Windows or Mac) or **Xcode** (Mac) with a free Apple ID.
   The app runs for 7 days, then is re-signed from the computer. A free Apple
   ID can have 3 such apps.

The only automatic route, TestFlight, needs the paid Apple Developer Program.

In detail, to put it on an iPhone or iPad, one of:

- **Xcode on a Mac.** Run `brew install xcodegen`, then
  `cd native/ios && xcodegen generate && open SpatialAR.xcodeproj`. Choose your
  team under Signing & Capabilities and run it on the connected device. A free
  Apple ID works; the app then expires after 7 days.
- **A re-signing tool** (AltStore, Sideloadly) with the unsigned `.ipa` and
  your Apple ID. Same 7-day limit with a free account.
- **TestFlight or the App Store.** This needs the Apple Developer Program
  (99 USD a year) and your team ID in `project.yml`.

## What has been tested, and what has not

| | Tested |
|---|---|
| The bridge protocol, both shells | Unit tests in CI (Kotlin, Swift) |
| The web app inside a shell | Browser check against simulated Android and iOS shells |
| Android app compiles, passes lint, packages | CI |
| iOS app compiles for simulator and device | CI |
| ARCore and ARKit on a real phone | **Not yet.** No phone is available to CI. |
| The camera-image crop's orientation on a device | **Not yet.** Check that recognition locks in the app. |

The first device session should cover these steps:

1. Enter AR; the camera should show behind the page.
2. Tap the floor.
3. Walk around: the assembly should stay put.
4. Send the diagnostics log. It records `native host`, `native session
   running` and `native tracking`.
