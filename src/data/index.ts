import type { AssemblyDef } from '../engine/types';
import { gearbox } from './gearbox';
import { equipmentRack } from './equipmentRack';

/** Every assembly the app can load, small to large. */
export const ASSEMBLIES: AssemblyDef[] = [gearbox, equipmentRack];

export { gearbox, equipmentRack };
