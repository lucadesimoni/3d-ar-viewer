/**
 * Test-environment shims.
 *
 * jsdom does not implement the canvas image types, so the handful of vision
 * helpers that legitimately produce an `ImageData` have nothing to construct in
 * Node. This provides a minimal, spec-shaped stand-in — enough for the pure
 * pixel maths under test, never loaded in the browser build.
 */
if (typeof globalThis.ImageData === 'undefined') {
  class ImageDataPolyfill {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    readonly colorSpace = 'srgb' as const;
    constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
      if (typeof dataOrWidth === 'number') {
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(dataOrWidth * widthOrHeight * 4);
      } else {
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height = height ?? dataOrWidth.length / (4 * widthOrHeight);
      }
    }
  }
  globalThis.ImageData = ImageDataPolyfill as unknown as typeof ImageData;
}
