/**
 * Entry point of the packaged Mendix widget (`npm run release:package` builds
 * it into the `.mpk`). The component itself is `SpatialArViewer.tsx`; this adds
 * what a page the app does not own needs: its stylesheet, scoped to the widget.
 */
import css from '../styles/app.css?inline';
import { ensureWidgetStyles } from './widgetStyles';

ensureWidgetStyles(css);

export { SpatialArViewer, SpatialArViewer as default } from './SpatialArViewer';
