/**
 * @module @zona/sim/core/ecs
 *
 * Тонкая типизированная обёртка над bitecs 0.4 — единственное место в ядре,
 * где импортируется движок. Оборачивает сырой API (`createWorld`, `addEntity`,
 * `removeEntity`, `entityExists`, `getAllEntities`), приводя `EntityId` bitecs
 * (обычный `number`) к branded-`EntityId` из `@zona/shared` (D-003).
 *
 * НИЗКОУРОВНЕВЫЙ слой: работает напрямую с bitecs-миром (`EcsWorld`) и НЕ знает
 * про ResourceStore. Поэтому `destroyEcsEntity` чистит только ECS. Публичное
 * удаление сущности идёт через `destroyEntity(world: SimWorld, …)` в `world.ts`,
 * которое дополнительно вычищает ресурсы (иначе — «призраки», см. world.ts).
 * Этот модуль НЕ реэкспортируется из публичного `@zona/sim` (index.ts): им
 * пользуется только код внутри пакета (системы, сериализация).
 *
 * Пример:
 * ```ts
 * const w = createEcsWorld();
 * const eid = spawnEntity(w);          // EntityId
 * existsEntity(w, eid);                // true
 * destroyEcsEntity(w, eid);            // низкоуровневый destroy (без purge)
 * existsEntity(w, eid);                // false
 * ```
 */

import {
  createWorld,
  addEntity,
  removeEntity,
  entityExists,
  getAllEntities,
  addComponent as bitAddComponent,
  removeComponent as bitRemoveComponent,
  hasComponent as bitHasComponent,
  query as bitQuery,
  $internal,
  type World,
  type InternalWorld,
  type WorldContext,
  type ComponentRef as BitComponentRef,
} from 'bitecs';
import type { EntityId, JsonValue } from '@zona/shared';

/** Тип аллокатора сущностей bitecs (`EntityIndex`). Главный вход движка не
 * реэкспортирует его, поэтому выводим из `WorldContext` — так тип касания
 * `$internal` остаётся внутри этого модуля (слой D-008). */
type BitEntityIndex = WorldContext['entityIndex'];

/** Тип bitecs-мира без пользовательского контекста. Внутренний для @zona/sim. */
export type EcsWorld = World;

/**
 * Создаёт свежий пустой bitecs-мир. Каждый вызов независим и детерминирован:
 * никакого глобального состояния, id сущностей раздаются от начального.
 *
 * Версионирование eid (`withVersioning`) на шаге 0.1 сознательно НЕ включаем:
 * оно меняет кодировку eid (id+version в одном числе) и усложнит сериализацию
 * 0.5. Проблему «призраков» после переиспользования eid полностью закрывает
 * purge ресурсов в `world.ts`, а не версии (см. D-007, риск C-6).
 */
export function createEcsWorld(): EcsWorld {
  return createWorld();
}

/** Создаёт новую сущность и возвращает её branded-id. */
export function spawnEntity(world: EcsWorld): EntityId {
  return addEntity(world) as EntityId;
}

/**
 * НИЗКОУРОВНЕВОЕ удаление: убирает сущность и её компоненты ТОЛЬКО из bitecs.
 * НЕ трогает ResourceStore — поэтому не является публичным способом удаления.
 * Используй `destroyEntity(world: SimWorld, eid)` из `world.ts`.
 */
export function destroyEcsEntity(world: EcsWorld, eid: EntityId): void {
  removeEntity(world, eid);
}

/** true, если сущность с таким id жива в мире. */
export function existsEntity(world: EcsWorld, eid: EntityId): boolean {
  return entityExists(world, eid);
}

/**
 * Все живые сущности мира, ОТСОРТИРОВАННЫЕ по возрастанию eid (закон №8).
 *
 * Сырой `getAllEntities` bitecs 0.4 отдаёт eid в порядке вставки во внутреннюю
 * Map (`entityComponents`), а после переиспользования освобождённых eid этот
 * порядок ещё и немонотонен (freelist). Полагаться на него нельзя — обёртка
 * сортирует явно, чтобы обходы и сериализация (0.5) были воспроизводимы.
 */
export function allEntities(world: EcsWorld): readonly EntityId[] {
  return (getAllEntities(world) as readonly EntityId[])
    .slice()
    .sort((a, b) => a - b);
}

// ── SoA-компоненты (задача 1.0, D-018) ───────────────────────────────────────
//
// bitecs 0.4 НЕ навязывает форму компонента: `ComponentRef = any`, а сам движок
// хранит лишь ПРИНАДЛЕЖНОСТЬ (entity ↔ component) во внутренних масках/множествах
// (`entityComponents`, `componentMap`). ДАННЫЕ полей — целиком на нас: компонент
// у нас = объект-«хранилище», где каждое поле — ТИПИЗИРОВАННЫЙ массив, проиндексированный
// по eid (классический SoA: `Position.x[eid]`). Это единственная форма, которую
// сериализация 1.0 умеет читать детерминированно.
//
// ВАЖНО ПРО ДЕТЕРМИНИЗМ (закон №8): для полей f32 используем именно `Float32Array`,
// а не `number[]`. Тогда записанное значение сразу ОКРУГЛЯЕТСЯ до f32, и его
// `Number.prototype.toString` (в канонизаторе снапшота) стабилен между прогонами —
// double-массив хранил бы «шумные» младшие биты, различающиеся по пути вычисления.
//
// Порядок аргументов оболочек — `(world, comp, eid)` (comp раньше eid): это НАШ
// стабильный контракт ядра; внутри вызываем нативный bitecs-порядок `(world, eid, comp)`.

/** Тег типа поля SoA-компонента. Определяет ширину/семантику типизированного массива. */
export const Types = {
  /** 32-битный float (`Float32Array`). Округление до f32 при записи → детерминизм канона. */
  f32: 'f32',
  /** Беззнаковое 32-битное целое (`Uint32Array`). */
  ui32: 'ui32',
  /** Беззнаковое 8-битное целое (`Uint8Array`) — флаги/малые перечисления. */
  ui8: 'ui8',
  /** Ссылка на сущность (`Uint32Array`): хранит eid. НЕ ремапится при load (D-011). */
  eid: 'eid',
} as const;

/** Допустимый тег типа поля (значение `Types.*`). */
export type FieldType = (typeof Types)[keyof typeof Types];

/** Схема компонента: имя поля → тег типа. Порядок ключей фиксирует реестр (registry.ts). */
export type ComponentSchema = Readonly<Record<string, FieldType>>;

/** Типизированный массив-колонка одного поля SoA-компонента. */
export type FieldArray = Float32Array | Uint32Array | Uint8Array;

/**
 * SoA-компонент: объект-хранилище, где каждое поле — типизированный массив,
 * индексируемый по eid. Именно этот объект передаётся в bitecs как `ComponentRef`
 * (идентичность объекта = идентичность компонента) и хранится в реестре как `ref`.
 * Ёмкость колонок фиксирована при `defineComponentT` и лежит в скрытом symbol-поле.
 */
export type ComponentRef = Readonly<Record<string, FieldArray>>;

/**
 * Ёмкость колонок по умолчанию: максимальный eid+1, который компонент может нести.
 * Типизированные массивы имеют ФИКСИРОВАННУЮ длину, поэтому ёмкость выбирается при
 * создании компонента. Бюджет мира — сотни сущностей (перф-бюджет 250), а bitecs
 * переиспользует освобождённые eid (maxId растёт лишь при пустом freelist), поэтому
 * запас в тысячи слотов заведомо покрывает Фазу 1 при дешёвой памяти (Float32Array
 * на 4096 = 16 КБ на поле). Явный guard в `addComponent` превращает выход за ёмкость
 * из ТИХОЙ порчи данных (запись мимо массива) в ранний throw (закон №8).
 */
export const DEFAULT_COMPONENT_CAPACITY = 4096;

/** Скрытое (не-перечислимое) поле компонента с его ёмкостью — для guard'а по eid. */
const CAPACITY: unique symbol = Symbol('zona.component.capacity');

/** Аллоцирует колонку нужного типа заданной ёмкости (все поля компонента — одной длины). */
function allocateField(type: FieldType, capacity: number): FieldArray {
  switch (type) {
    case 'f32':
      return new Float32Array(capacity);
    case 'ui32':
    case 'eid':
      return new Uint32Array(capacity);
    case 'ui8':
      return new Uint8Array(capacity);
  }
}

/** Валидирует ёмкость колонок (общая для `defineComponentT`/`defineTag`). */
function validateCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(
      `ёмкость должна быть положительным целым, получено ${String(capacity)}.`,
    );
  }
}

/**
 * Записывает ёмкость в НЕ перечислимое symbol-поле хранилища: не попадает в
 * `Object.keys(store)` (не мешает обходу полей) и не мутируется случайно.
 * Возвращает тот же объект как `ComponentRef`.
 */
function attachCapacity(store: Record<string, FieldArray>, capacity: number): ComponentRef {
  Object.defineProperty(store, CAPACITY, {
    value: capacity,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return store as ComponentRef;
}

/**
 * Создаёт SoA-компонент из схемы: на каждое поле — типизированный массив ёмкости
 * `capacity`. Компонент — МОДУЛЬНЫЙ singleton (как все bitecs-компоненты): его
 * колонки глобальны и разделяются всеми мирами, использующими этот компонент;
 * значение живёт по индексу eid. Поэтому в снапшот пишутся ТОЛЬКО живые носители
 * (serialize пересекает с `hasComponent`), а load перезаписывает колонки заново.
 *
 * `capacity` аддитивен (по умолчанию `DEFAULT_COMPONENT_CAPACITY`): совместимо с
 * контрактом `defineComponentT(schema)`; при необходимости 1.2 задаёт свой размер.
 */
export function defineComponentT(
  schema: ComponentSchema,
  capacity: number = DEFAULT_COMPONENT_CAPACITY,
): ComponentRef {
  validateCapacity(capacity);
  const entries = Object.entries(schema);
  if (entries.length === 0) {
    // Компонент С ДАННЫМИ обязан иметь ≥1 поле: пустая схема — почти всегда
    // опечатка (забыли поля). Для маркеров-без-полей есть отдельный `defineTag`.
    throw new TypeError('defineComponentT: схема компонента пуста (нужно ≥1 поле; для тега используй defineTag).');
  }
  const store: Record<string, FieldArray> = {};
  for (const [field, type] of entries) {
    store[field] = allocateField(type, capacity);
  }
  return attachCapacity(store, capacity);
}

/**
 * Создаёт ТЕГ — компонент-МАРКЕР без полей (D-019): движок хранит лишь
 * принадлежность (entity ↔ tag), данных нет. Используется для булевых состояний
 * («это человек», «это труп», «жив»), которые в SoA выродились бы в лишнюю
 * колонку-флаг. Хранилище — пустой объект (только скрытая ёмкость для guard'а
 * `addComponent` по eid); `Object.keys(tag)` пуст, поэтому:
 *  - `addComponent` не пишет полей (цикл зануления пуст) — просто регистрирует
 *    членство;
 *  - сериализация (`serializeComponents`) даёт колонку `{ eids:[живые,сорт], fields:{} }`,
 *    а `deserialize` навешивает тег `addComponent`'ом без полей — round-trip членства.
 * Отдельная функция (а не `defineComponentT({})`) делает намерение явным и
 * сохраняет guard «компонент с данными без полей = опечатка».
 */
export function defineTag(capacity: number = DEFAULT_COMPONENT_CAPACITY): ComponentRef {
  validateCapacity(capacity);
  return attachCapacity({}, capacity);
}

/** Ёмкость колонок компонента (из скрытого поля). */
function componentCapacity(comp: ComponentRef): number {
  const cap = (comp as unknown as Record<symbol, number | undefined>)[CAPACITY];
  if (cap === undefined) {
    // Компонент создан не через defineComponentT — программерская ошибка.
    throw new TypeError('addComponent: компонент без ёмкости (создан не через defineComponentT).');
  }
  return cap;
}

/**
 * Guard закона №8: eid обязан помещаться в ёмкость колонок. Иначе запись
 * `field[eid]=…` ушла бы мимо типизированного массива (тихий no-op → потеря
 * данных и рассинхрон снапшота). Ловим рано и явно.
 */
function assertEidWithinCapacity(comp: ComponentRef, eid: EntityId): void {
  const cap = componentCapacity(comp);
  if (eid < 0 || eid >= cap) {
    throw new RangeError(
      `addComponent: eid=${String(eid)} вне ёмкости компонента [0, ${cap}). ` +
        `Увеличьте capacity в defineComponentT.`,
    );
  }
}

/**
 * Добавляет компонент сущности (регистрирует компонент в мире при первом
 * использовании). ЗАНУЛЯЕТ все поля носителя ПЕРЕД тем как сущность станет
 * носителем (D-024, симметрия активной очистки D-008): bitecs переиспользует
 * освобождённые eid, а `removeComponent`/`destroyEntity` НЕ трогают SoA-массивы,
 * поэтому в слоте мог остаться «холодный» остаток покойника. Без зануления он
 * протёк бы в снапшот (закон №3) и рассинхронил continuous-vs-resume между
 * процессами (закон №8: сохранивший процесс держит остаток в массиве, свежий
 * после load стартует с нуля). Зануление на входе даёт КАЖДОМУ носителю известное
 * чистое стартовое состояние независимо от прошлого владельца eid; дальше его
 * пишет система. Не-носители в снапшот не попадают, поэтому этого достаточно.
 */
export function addComponent(world: EcsWorld, comp: ComponentRef, eid: EntityId): void {
  assertEidWithinCapacity(comp, eid);
  const store = comp as Record<string, FieldArray>;
  for (const field of Object.keys(store)) {
    (store[field] as FieldArray)[eid] = 0;
  }
  bitAddComponent(world, eid, comp);
}

/** Снимает компонент с сущности. Значения колонок НЕ обнуляет (перезапишутся при повторном add). */
export function removeComponent(world: EcsWorld, comp: ComponentRef, eid: EntityId): void {
  bitRemoveComponent(world, eid, comp);
}

/** true, если сущность несёт компонент. На незарегистрированном компоненте — false (без throw). */
export function hasComponent(world: EcsWorld, comp: ComponentRef, eid: EntityId): boolean {
  return bitHasComponent(world, eid, comp);
}

/**
 * Все сущности, несущие ВСЕ перечисленные компоненты (AND), ОТСОРТИРОВАННЫЕ по
 * возрастанию eid (закон №8). Сырой `query` bitecs 0.4 отдаёт eid в порядке
 * внутреннего SparseSet (зависит от порядка add/remove) — сортируем явно, чтобы
 * обходы и сериализация были воспроизводимы.
 */
export function queryEntities(
  world: EcsWorld,
  comps: readonly ComponentRef[],
): readonly EntityId[] {
  const res = bitQuery(world, comps as BitComponentRef[]);
  const out = Array.from(res as ArrayLike<number>) as EntityId[];
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Клонирует аллокатор сущностей bitecs (`world[$internal].entityIndex`) в
 * JSON-безопасную форму для снапшота (D-011). Возвращает НЕПРОЗРАЧНЫЙ blob:
 * `snapshot.ts` кладёт его в `SnapshotJSON.ecsIndex` не вникая в структуру, а
 * восстановление (0.5b) передаёт обратно в `createWorld(index)`. Это ЕДИНСТВЕННОЕ
 * место, где ядро касается bitecs `$internal` (слой D-008): форму `EntityIndex`
 * знает только этот модуль.
 *
 * ── Реальная структура `EntityIndex` bitecs 0.4 ─────────────────────────────
 *  - `aliveCount`   — число живых сущностей (префикс `dense`, где они лежат);
 *  - `dense`        — ВСЕ выданные eid длиной `maxId`; первые `aliveCount` —
 *                     живые, хвост — freelist мёртвых (порядок переиспользования);
 *  - `sparse`       — eid → индекс в `dense`. РАЗРЕЖЕН: индекс 0 (id 0 зарезервирован)
 *                     — ДЫРА (empty item, `typeof === undefined`);
 *  - `maxId`        — наибольший выданный id (= длине `dense`);
 *  - `versioning`   — false (D-008: без версионирования eid);
 *  - `versionBits`, `entityMask`, `versionShift`, `versionMask` — параметры
 *     кодирования версии (не используются при `versioning:false`, но копируются
 *     verbatim, чтобы восстановленный индекс был побитово тем же).
 *
 * НОРМАЛИЗАЦИЯ (закон №8, требование «без дыр/undefined»): `dense` и `sparse`
 * пересобираются в ПЛОТНЫЕ массивы фиксированной длины; любая дыра заменяется на
 * `0`. Для `sparse` это безопасно: единственная дыра — индекс 0 (id 0 никогда не
 * жив, `dense[sparse[0]] !== 0`), поэтому подстановка `0` не оживляет id 0 при
 * восстановлении (проверено round-trip-тестом). Результат детерминирован (bitecs
 * детерминирован) и полностью сериализуем (`JSON.parse(JSON.stringify(...))` не
 * бросает, канонизатор не встретит `undefined`).
 */
export function exportEntityIndex(world: EcsWorld): JsonValue {
  // Тип `EntityIndex` bitecs не реэкспортирует из главного входа — выводим его
  // из `InternalWorld` (единственная точка касания `$internal`, слой D-008).
  const index = (world as unknown as InternalWorld)[$internal].entityIndex;
  return {
    aliveCount: index.aliveCount,
    dense: densifyNumbers(index.dense),
    sparse: densifyNumbers(index.sparse),
    maxId: index.maxId,
    versioning: index.versioning,
    versionBits: index.versionBits,
    entityMask: index.entityMask,
    versionShift: index.versionShift,
    versionMask: index.versionMask,
  };
}

/**
 * Копирует числовой массив в плотный: заполняет дыры (empty items разреженного
 * массива) нулём, чтобы результат не содержал `undefined` и был JSON-safe.
 * Длина сохраняется точно.
 */
function densifyNumbers(src: readonly number[]): number[] {
  const out: number[] = new Array<number>(src.length);
  for (let i = 0; i < src.length; i++) {
    // `i in src` отличает дыру разреженного массива от реального значения.
    out[i] = i in src ? (src[i] as number) : 0;
  }
  return out;
}

// ── Восстановление аллокатора из blob (read-path, D-011) ─────────────────────

/** Плоский объект неизвестной формы — узкий тип для парсинга blob снапшота. */
type UnknownRecord = Record<string, unknown>;

/**
 * Читает конечное число под ключом `key`; бросает на отсутствии/NaN/±Infinity
 * (защита от битого/подделанного `ecsIndex`, D-012).
 */
function reqFiniteNumber(rec: UnknownRecord, key: string): number {
  const v = rec[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(
      `createEcsWorldFromIndex: поле ecsIndex.${key} — не конечное число (${String(v)}).`,
    );
  }
  return v;
}

/** Читает булево под ключом `key`; бросает на ином типе. */
function reqBoolean(rec: UnknownRecord, key: string): boolean {
  const v = rec[key];
  if (typeof v !== 'boolean') {
    throw new TypeError(
      `createEcsWorldFromIndex: поле ecsIndex.${key} — не boolean (${String(v)}).`,
    );
  }
  return v;
}

/**
 * Читает числовой массив под ключом `key` и КЛОНИРУЕТ его в новый плотный
 * массив (восстановленный мир владеет своими массивами, не разделяя ссылку с
 * blob снапшота). Бросает на не-массиве, дыре или не-числовом элементе.
 */
function reqNumberArray(rec: UnknownRecord, key: string): number[] {
  const v = rec[key];
  if (!Array.isArray(v)) {
    throw new TypeError(
      `createEcsWorldFromIndex: поле ecsIndex.${key} — не массив.`,
    );
  }
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) {
    if (!(i in v)) {
      throw new TypeError(
        `createEcsWorldFromIndex: дыра в ecsIndex.${key}[${i}].`,
      );
    }
    const n = v[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new TypeError(
        `createEcsWorldFromIndex: ecsIndex.${key}[${i}] — не конечное число (${String(n)}).`,
      );
    }
    out[i] = n;
  }
  return out;
}

/**
 * Восстанавливает bitecs-`EntityIndex` из непрозрачного blob снапшота
 * (`SnapshotJSON.ecsIndex`, продукт `exportEntityIndex`). Симметрична экспорту:
 * читает те же девять полей verbatim, клонируя массивы.
 *
 * Строгая валидация (ранний throw), чтобы битый/подделанный blob не создал
 * мусорный мир с кривым `entityExists`/`spawnEntity`. Проверяем НЕ только форму
 * полей, но и ВНУТРЕННЮЮ СОГЛАСОВАННОСТЬ аллокатора:
 *  - `aliveCount ∈ [0, dense.length]` (живой префикс dense);
 *  - `maxId === dense.length` (инвариант bitecs: dense содержит все выданные id;
 *    в снапшоте dense уже уплотнён `densifyNumbers`, дыр нет);
 *  - обратимость sparse↔dense для живых: для `i ∈ [0, aliveCount)` обязано
 *    `sparse[dense[i]] === i` (иначе `isEntityIdAlive` вернул бы неверное — eid
 *    «жив» в dense, но sparse на него не указывает: рассогласованный индекс).
 */
function reviveEntityIndex(indexBlob: JsonValue): BitEntityIndex {
  if (indexBlob === null || typeof indexBlob !== 'object' || Array.isArray(indexBlob)) {
    throw new TypeError('createEcsWorldFromIndex: ecsIndex — не объект.');
  }
  const rec = indexBlob as UnknownRecord;
  const dense = reqNumberArray(rec, 'dense');
  const sparse = reqNumberArray(rec, 'sparse');
  const aliveCount = reqFiniteNumber(rec, 'aliveCount');
  const maxId = reqFiniteNumber(rec, 'maxId');
  // aliveCount — префикс живых в dense; вне [0, dense.length] blob невалиден.
  if (!Number.isInteger(aliveCount) || aliveCount < 0 || aliveCount > dense.length) {
    throw new TypeError(
      `createEcsWorldFromIndex: aliveCount=${aliveCount} вне [0, dense.length=${dense.length}].`,
    );
  }
  // Согласованность аллокатора: dense перечисляет ВСЕ выданные id, поэтому его
  // длина = maxId (инвариант bitecs/exportEntityIndex). Расхождение = битый blob.
  if (maxId !== dense.length) {
    throw new TypeError(
      `createEcsWorldFromIndex: рассогласованный ecsIndex — maxId=${maxId} != dense.length=${dense.length}.`,
    );
  }
  // Обратимость sparse↔dense для ЖИВЫХ eid: sparse[dense[i]] обязан указывать
  // обратно на i, иначе восстановленный entityExists/spawn работали бы неверно.
  for (let i = 0; i < aliveCount; i++) {
    const id = dense[i] as number;
    if (sparse[id] !== i) {
      throw new TypeError(
        `createEcsWorldFromIndex: рассогласованный ecsIndex — sparse[dense[${i}]=${id}]=` +
          `${String(sparse[id])} != ${i} (нарушена обратимость sparse↔dense).`,
      );
    }
  }
  return {
    aliveCount,
    dense,
    sparse,
    maxId,
    versioning: reqBoolean(rec, 'versioning'),
    versionBits: reqFiniteNumber(rec, 'versionBits'),
    entityMask: reqFiniteNumber(rec, 'entityMask'),
    versionShift: reqFiniteNumber(rec, 'versionShift'),
    versionMask: reqFiniteNumber(rec, 'versionMask'),
  };
}

/**
 * Симметрично `exportEntityIndex`: воссоздаёт bitecs-мир с ТЕМ ЖЕ аллокатором
 * (eid + freelist), поэтому переиспользование eid после load идёт в том же
 * порядке, что и в непрерывном прогоне (D-011, resume побитово). Внутренняя,
 * НЕ реэкспортируется из `@zona/sim` (слой D-008): формой `EntityIndex` владеет
 * только этот модуль.
 *
 * ── Почему одного `createWorld(index)` НЕДОСТАТОЧНО (критичный хвост) ─────────
 * `createWorld` распознаёт объект с `dense/sparse/aliveCount` как `EntityIndex`
 * и кладёт его как `ctx.entityIndex` verbatim — `entityExists`/`spawnEntity`
 * сразу работают на восстановленном аллокаторе. НО `getAllEntities` читает
 * ДРУГУЮ структуру — `ctx.entityComponents` (`Map<eid, Set<component>>`), а её
 * `createWorld` оставляет ПУСТОЙ. Без заполнения `allEntities(restored)` вернул
 * бы `[]`, хотя eid «живы» в индексе.
 *
 * РЕШЕНИЕ: населяем `entityComponents` вручную по живым eid из индекса. Живые —
 * это первые `aliveCount` элементов `dense` (хвост `dense` — freelist мёртвых).
 * Каждому живому eid кладём ПУСТОЙ `Set` компонентов (Фаза 0 SoA-компонентов не
 * хранит, D-012). Делаем это БЕЗ `addEntity`: `addEntity` выдал бы НОВЫЙ eid
 * (recycle из freelist или `++maxId`) и сдвинул аллокатор — сломав тождество
 * eid и порядок freelist. Прямая запись в Map не трогает индекс. После этого
 * `getAllEntities` (а значит и `allEntities`) видит ровно живые eid снапшота.
 * (См. resume-тест в `snapshot.test.ts`: split-прогон через save/load совпадает
 * с непрерывным по хэшу и логу.)
 */
export function createEcsWorldFromIndex(indexBlob: JsonValue): EcsWorld {
  const index = reviveEntityIndex(indexBlob);
  // createWorld кладёт `index` как ctx.entityIndex verbatim (аллокатор восстановлен).
  const world = createWorld(index);
  // Хвост: населяем entityComponents живыми eid (первые aliveCount из dense),
  // иначе getAllEntities вернёт пусто. Единственная точка касания $internal при
  // восстановлении (слой D-008).
  const components = (world as unknown as InternalWorld)[$internal].entityComponents;
  // Порядок вставки в Map на allEntities не влияет (обёртка сортирует), но
  // вставляем по возрастанию eid — детерминизм как инвариант (закон №8).
  const live = index.dense.slice(0, index.aliveCount).sort((a, b) => a - b);
  for (let i = 0; i < live.length; i++) {
    const eid = live[i] as EntityId;
    components.set(eid, new Set<BitComponentRef>());
  }
  return world;
}
