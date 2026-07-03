import { TypedArray, PrimitiveBrand, ArrayType } from './SoASerializer';
type AnyAoSComponent = PrimitiveBrand | TypedArray | ArrayType<any> | Record<string, any>;
export type AoSSerializerOptions = {
    diff?: boolean;
    buffer?: ArrayBuffer;
    epsilon?: number;
};
export declare const createAoSSerializer: (components: AnyAoSComponent[], options?: AoSSerializerOptions) => (entityIds: number[] | readonly number[]) => ArrayBuffer;
export type AoSDeserializerOptions = {
    diff?: boolean;
};
export declare const createAoSDeserializer: (components: AnyAoSComponent[], options?: AoSDeserializerOptions) => (packet: ArrayBuffer, entityIdMapping?: Map<number, number>) => void;
export {};
//# sourceMappingURL=AoSSerializer.d.ts.map