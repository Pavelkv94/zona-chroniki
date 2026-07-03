import { PrimitiveBrand } from './SoASerializer';
import { World, ComponentRef } from 'bitecs';
export declare const createSnapshotSerializer: (world: World, components: (Record<string, PrimitiveBrand> | ComponentRef)[], buffer?: ArrayBuffer) => (selectedEntities?: readonly number[]) => ArrayBuffer;
export declare const createSnapshotDeserializer: (world: World, components: (Record<string, PrimitiveBrand> | ComponentRef)[], idMap?: Map<number, number>) => (packet: ArrayBuffer, idMapOverride?: Map<number, number>) => Map<number, number>;
export declare const test: (w: any) => boolean;
//# sourceMappingURL=SnapshotSerializer.d.ts.map