import { createContext, useContext } from 'react';
import { DEFAULT_UI_CONFIG, type UiConfig } from './config';

/** Resolved UI config, read by any component to decide what it shows. */
const UiConfigContext = createContext<UiConfig>(DEFAULT_UI_CONFIG);

export const UiConfigProvider = UiConfigContext.Provider;
export const useUiConfig = (): UiConfig => useContext(UiConfigContext);
