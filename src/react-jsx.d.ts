import type { JSX as ReactJSX } from 'react';
declare global {
  // Allow the classic `JSX.Element` return annotation with the React 19 types.
  namespace JSX {
    type Element = ReactJSX.Element;
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
  }
}
