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

export type {
  SimEvent,
  SimEventBase,
  NeedKind,
  NeedLevel,
  ItemConsumeReason,
  ItemHarvestSource,
  RadioMessageParams,
} from './events';

export type { Contact } from './contacts';

export type { Subject, MemoryRecord, RelationEntry, AvoidEntry } from './memory';

// Контракт «вид на мир» Sim→UI (задача 4.1, D-076): plain-снимок состояния сущностей
// для наблюдателя Фазы 4 (карта/список/инспектор). Формы БЕЗ bitecs/DOM (закон №5);
// экспортёры (`@zona/sim/view/export`) собирают их read-only (D-006/D-080).
export type {
  EntityKind,
  EntityView,
  WorldView,
  EntityName,
  EntityTask,
  EntityDetail,
} from './view';

export type { JsonValue, SnapshotJSON, ComponentColumnJSON } from './snapshot';

// Контракт Worker-моста Sim⇄UI (задача 4.0, D-077/D-078): plain-сериализуемые команды
// (UiToWorker) и обновления (WorkerToUi) через границу postMessage + форма дельты вида
// (ViewDelta). Формы БЕЗ bitecs/DOM (закон №5); UI-команды влияют лишь на темп (закон №8).
export type { ViewDelta, UiToWorker, WorkerToUi } from './worker-protocol';

export type {
  LocationType,
  LocationData,
  EdgeData,
  MapData,
  ItemKind,
  ItemData,
  SpeciesData,
  FactionData,
  FactionRelation,
  FactionsData,
  ProfessionData,
  NicknamePattern,
  NamesData,
  MessageTemperament,
  MessagesData,
  SettlementItemQty,
  SettlementRecipe,
  SettlementConsumption,
  SettlementData,
  SettlementsData,
  AnomalyFieldData,
  AnomalyFieldsData,
} from './data';
