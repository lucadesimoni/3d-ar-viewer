import type { AssemblyDef } from '../engine/types';
import { gearbox } from './gearbox';
import { equipmentRack } from './equipmentRack';
import { kallax, kallax4x2Assembly } from './kallax';
import { jetEngine } from './jetEngine';

/** Every assembly the app can load, small to large. */
export const ASSEMBLIES: AssemblyDef[] = [gearbox, kallax4x2Assembly, kallax, jetEngine, equipmentRack];

export { gearbox, kallax, kallax4x2Assembly, jetEngine, equipmentRack };
