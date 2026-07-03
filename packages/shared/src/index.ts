/**
 * @module @zona/shared
 *
 * Общие типы и контракты, разделяемые всеми пакетами монорепо. Пакет чистый:
 * НЕ импортирует bitecs, DOM, React или Node (закон №5, D-003). Здесь живут
 * branded-идентификаторы ядра и контракт расписания систем; остальные контракты
 * добавляются по мере проектирования Фазы 0.
 */

export type {
  EntityId,
  EventId,
  LocationId,
  Tick,
  Seed,
  FactionId,
  ItemId,
} from './ids';

export type { SystemSchedule, SystemName } from './schedule';

export type { SimEvent, SimEventBase, NeedKind, NeedLevel } from './events';

export type { Contact } from './contacts';

export type { JsonValue, SnapshotJSON, ComponentColumnJSON } from './snapshot';

export type {
  LocationType,
  LocationData,
  EdgeData,
  MapData,
  ItemKind,
  ItemData,
  SpeciesData,
  FactionData,
  ProfessionData,
  NicknamePattern,
  NamesData,
} from './data';
