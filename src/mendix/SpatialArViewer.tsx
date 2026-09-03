import { useEffect } from 'react';
import { App } from '../App';
import { useStore } from '../state/store';
import type { AssemblyDef } from '../engine/types';

/**
 * Mendix pluggable-widget entry point.
 *
 * Mendix pluggable widgets are plain React components that receive their
 * configured properties as props. This wrapper adapts the standalone app into
 * that contract: a Mendix page can drop the "Spatial AR Viewer" widget onto a
 * screen, bind it to an assembly definition coming from the domain model (as a
 * JSON string attribute or a datasource), and the whole guided-AR experience
 * renders inside the Mendix client.
 *
 * The prop shape mirrors what Mendix generates from `SpatialArViewer.xml`:
 * `EditableValue`/`DynamicValue`-like objects expose their content on `.value`.
 * We keep the typing structural so this file compiles without the Mendix SDK
 * present, and degrades to the bundled sample assembly when nothing is bound.
 */

interface MendixValue<T> {
  status?: 'available' | 'loading' | 'unavailable';
  value?: T;
}

export interface SpatialArViewerProps {
  /** JSON string of an AssemblyDef, bound from a Mendix attribute. */
  assemblyJson?: MendixValue<string>;
  /** Optional model URLs for the recognition pipeline. */
  detectorModelUrl?: MendixValue<string>;
  classifierModelUrl?: MendixValue<string>;
  /** Fired (as a Mendix action) when the operator signs off the final step. */
  onComplete?: { execute?: () => void; canExecute?: boolean };
  class?: string;
  style?: React.CSSProperties;
}

function parseAssembly(json: string | undefined): AssemblyDef | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as AssemblyDef;
    if (!parsed.parts || !parsed.steps) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function SpatialArViewer(props: SpatialArViewerProps): JSX.Element {
  const loadAssembly = useStore((s) => s.loadAssembly);
  const assemblyJson = props.assemblyJson?.value;

  useEffect(() => {
    const assembly = parseAssembly(assemblyJson);
    if (assembly) loadAssembly(assembly);
  }, [assemblyJson, loadAssembly]);

  // Bridge the "build complete" moment back to the Mendix microflow.
  useEffect(() => {
    const action = props.onComplete;
    if (!action?.execute) return;
    return useStore.subscribe((state) => {
      const allDone = state.assembly.steps.every((s) => state.completedStepIds.has(s.id));
      if (allDone && action.canExecute !== false) action.execute?.();
    });
  }, [props.onComplete]);

  return (
    <div className={props.class} style={{ height: '100%', minHeight: 480, ...props.style }}>
      <App />
    </div>
  );
}

export default SpatialArViewer;
