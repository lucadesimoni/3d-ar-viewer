import { useEffect, useMemo, useState } from 'react';
import { App } from '../App';
import type { UiConfig, UiPreset } from '../ui/config';
import { useStore } from '../state/store';
import { AssemblyImportError, parseAssembly } from '../engine/assemblyImport';
import { recommendedPipelineConfig } from '../vision/defaultModels';
import type { PipelineConfig } from '../vision/pipeline';

/**
 * Mendix pluggable-widget entry point — COMPATIBILITY SHIM ONLY.
 *
 * This exists so the app is ready to be embedded as a Mendix pluggable widget;
 * it is deliberately NOT a finished widget build. It is structurally typed so it
 * compiles without the Mendix SDK, is not imported by the standalone app, and is
 * excluded from the production bundle. The full widget packaging (SDK types,
 * build tooling, editorConfig/preview, MPK output) is to be done later.
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
  /** JSON class-name arrays in each ONNX model's output order. */
  detectorLabelsJson?: MendixValue<string>;
  classifierLabelsJson?: MendixValue<string>;
  /** JSON model-class -> occurrence id (or array of ambiguous candidates). */
  labelMappingJson?: MendixValue<string>;
  /** Fired (as a Mendix action) when the operator signs off the final step. */
  onComplete?: { execute?: () => void; canExecute?: boolean };
  /** UI layout preset: full | compact | minimal | viewer. */
  uiPreset?: string | MendixValue<string>;
  /** Embed mode: fill the widget's container and trim fixed chrome. */
  embedded?: MendixValue<boolean>;
  /** Brand accent colour (CSS). */
  accent?: MendixValue<string>;
  class?: string;
  style?: React.CSSProperties;
}

function buildUiConfig(props: SpatialArViewerProps): Partial<UiConfig> {
  const preset = typeof props.uiPreset === 'string' ? props.uiPreset : props.uiPreset?.value;
  const cfg: Partial<UiConfig> = { embedded: props.embedded?.value ?? true };
  if (preset === 'full' || preset === 'compact' || preset === 'minimal' || preset === 'viewer') {
    cfg.preset = preset as UiPreset;
  }
  if (props.accent?.value) cfg.accent = props.accent.value;
  return cfg;
}

class HostRecognitionError extends Error {}

function hostJson(value: string | undefined, field: string): unknown {
  if (!value) throw new HostRecognitionError(`${field} is required for a host-provided model.`);
  try { return JSON.parse(value); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new HostRecognitionError(`${field} is not valid JSON.`);
  }
}

function hostLabels(value: string | undefined, field: string): string[] {
  const parsed = hostJson(value, field);
  if (!Array.isArray(parsed) || !parsed.length
    || !parsed.every((label): label is string => typeof label === 'string' && label.trim().length > 0)) {
    throw new HostRecognitionError(`${field} must be a non-empty array of class names in model output order.`);
  }
  if (new Set(parsed).size !== parsed.length) throw new HostRecognitionError(`${field} contains duplicate class names.`);
  return parsed;
}

function hostMapping(value: string): NonNullable<PipelineConfig['labelMapping']> {
  const parsed = hostJson(value, 'labelMappingJson');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HostRecognitionError('labelMappingJson must map model class names to occurrence ids.');
  }
  const entries: [string, string | string[]][] = [];
  for (const [label, target] of Object.entries(parsed)) {
    if (typeof target === 'string' && target.trim()) entries.push([label, target]);
    else if (Array.isArray(target) && target.length
      && target.every((id): id is string => typeof id === 'string' && id.trim().length > 0)) {
      entries.push([label, target]);
    } else throw new HostRecognitionError(`labelMappingJson.${label} must be an occurrence id or a non-empty array of ids.`);
  }
  return Object.fromEntries(entries);
}

export function SpatialArViewer(props: SpatialArViewerProps): JSX.Element {
  const loadAssembly = useStore((s) => s.loadAssembly);
  const assemblyJson = props.assemblyJson?.value;
  const [importError, setImportError] = useState<string>();
  const detectorUrl = props.detectorModelUrl?.value;
  const classifierUrl = props.classifierModelUrl?.value;
  const detectorLabels = props.detectorLabelsJson?.value;
  const classifierLabels = props.classifierLabelsJson?.value;
  const labelMapping = props.labelMappingJson?.value;
  const recognition = useMemo((): { config?: PipelineConfig; error?: string } => {
    if (!detectorUrl && !classifierUrl && !labelMapping) return {};
    try {
      const config = recommendedPipelineConfig({ detectorUrl, classifierUrl });
      if (config.detector) config.detector.labels = hostLabels(detectorLabels, 'detectorLabelsJson');
      if (config.classifier) config.classifier.labels = hostLabels(classifierLabels, 'classifierLabelsJson');
      if (labelMapping) config.labelMapping = hostMapping(labelMapping);
      return { config };
    } catch (error) {
      if (!(error instanceof HostRecognitionError)) throw error;
      // Invalid host configuration disables inference rather than silently
      // falling back to unrelated environment-provided model classes.
      return { config: {}, error: error.message };
    }
  }, [detectorUrl, classifierUrl, detectorLabels, classifierLabels, labelMapping]);

  useEffect(() => {
    if (!assemblyJson) { setImportError(undefined); return; }
    try {
      loadAssembly(parseAssembly(assemblyJson));
      setImportError(undefined);
    } catch (error) {
      if (!(error instanceof AssemblyImportError)) throw error;
      setImportError(error.message);
    }
  }, [assemblyJson, loadAssembly]);

  // Bridge the "build complete" moment back to the Mendix microflow.
  useEffect(() => {
    const action = props.onComplete;
    if (!action?.execute) return;
    let previousAssembly = useStore.getState().assembly;
    let wasComplete = previousAssembly.steps.length > 0
      && previousAssembly.steps.every((s) => useStore.getState().completedStepIds.has(s.id));
    return useStore.subscribe((state) => {
      if (state.assembly !== previousAssembly) wasComplete = false;
      previousAssembly = state.assembly;
      const allDone = state.assembly.steps.length > 0
        && state.assembly.steps.every((s) => state.completedStepIds.has(s.id));
      const becameComplete = allDone && !wasComplete;
      wasComplete = allDone;
      if (becameComplete && action.canExecute !== false) action.execute?.();
    });
  }, [props.onComplete]);

  return (
    <div className={props.class} style={{ height: '100%', minHeight: 480, ...props.style }}>
      {importError && <p role="alert">Assembly could not be loaded: {importError}</p>}
      {recognition.error && <p role="alert">Recognition is disabled: {recognition.error}</p>}
      <App config={buildUiConfig(props)} recognitionConfig={recognition.config} />
    </div>
  );
}

export default SpatialArViewer;
