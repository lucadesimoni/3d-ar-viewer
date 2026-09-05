import type { AssemblyDef } from '../engine/types';
import { gearbox } from './gearbox';
import { equipmentRack } from './equipmentRack';
import { kallax } from './kallax';

/** Every assembly the app can load, small to large. */
export const ASSEMBLIES: AssemblyDef[] = [gearbox, kallax, equipmentRack];

export { gearbox, kallax, equipmentRack };
