/**
 * @module @zona/sim/core/snapshot
 *
 * Сериализация мира (задачи 0.5a write-path + 0.5b read-path, D-011..D-014):
 *  - `canonicalize` — детерминированная каноничная строка любого JSON-значения;
 *  - `hashSnapshot` — FNV-1a по канонизации снапшота;
 *  - `serialize`    — `SimWorld → SnapshotJSON` (write-path);
 *  - `deserialize`  — `SnapshotJSON → SimWorld` (read-path, 0.5b).
 *
 * ── deserialize (read-path, 0.5b) ───────────────────────────────────────────
 * Симметрична `serialize`, восстанавливает РАБОЧИЙ `SimWorld` из снимка:
 *  - проверяет `version === 1` (иначе throw — чужой/будущий формат);
 *  - воссоздаёт bitecs-мир с ТЕМ ЖЕ аллокатором через `createEcsWorldFromIndex`
 *    (verbatim eid + freelist, D-011) — resume после load идёт побитово как
 *    непрерывный прогон;
 *  - GUARD: `allEntities(ecs)` обязан совпасть с `snap.entities` (авторитет по
 *    живым eid — `ecsIndex`; `entities` — производное). Расхождение = битый или
 *    подделанный снапшот → throw (D-012);
 *  - восстанавливает корневой rng (`restoreRng`, D-014) и шину через seam
 *    `createEventBus(getTick, { eventSeq, log })` (C-4) — с той же аккуратностью
 *    инициализации `bus ↔ world.tick`, что в `createSimWorld`;
 *  - регидратирует ResourceStore, DEEP-КЛОНИРУЯ каждое значение (`cloneJsonValue`):
 *    восстановленный мир владеет своими копиями, снапшот можно переиспользовать
 *    (мутация `snap` после load не протекает в мир, и наоборот).
 *
 * ── Канонизатор (D-012/D-013) ───────────────────────────────────────────────
 * Зачем свой, а не `JSON.stringify`: у `JSON.stringify` порядок ключей объекта =
 * порядок вставки, поэтому одно и то же логическое состояние, собранное разными
 * путями, даёт РАЗНЫЕ строки → нестабильный хэш (нарушение закона №8, риск C-3).
 * Канонизатор:
 *  - КЛЮЧИ объектов сортирует по возрастанию (UTF-16, `Array.prototype.sort`);
 *  - МАССИВЫ оставляет в исходном порядке (это упорядоченные данные: dense/sparse,
 *    лог событий, пары ресурсов по eid);
 *  - числа — `Number.prototype.toString`; `NaN`/`±Infinity` → throw;
 *  - строки — через `JSON.stringify` (корректное экранирование, детерминизм);
 *  - `null` допустим (например `causedBy: null`);
 *  - `undefined`/функции/символы/`bigint`/`Map`/`Set`/экземпляры классов → throw
 *    с указанием пути (`ctx`), чтобы нарушение (например, недопустимое значение
 *    ресурса под конкретным ключом/eid) сразу читалось в тесте/ревью (D-013);
 *  - ДЫРА разреженного массива (empty item) → throw (в снапшот они не попадают:
 *    `exportEntityIndex` уже уплотняет индекс).
 *
 * ── Хэш ─────────────────────────────────────────────────────────────────────
 * `hashSnapshot` = FNV-1a **32-бит** по кодовым единицам (UTF-16) каноничной
 * строки, результат — 8 hex-символов. 32-бит достаточно для сверки идентичности
 * прогонов и регрессий детерминизма в тестах; при необходимости криптостойкости
 * save-файлов хэш можно усилить, не меняя канонизатор. Константы FNV — часть
 * алгоритма (те же, что в `core/rng.ts`), не баланс (закон №7).
 *
 * Пример:
 * ```ts
 * const snap = serialize(world);
 * const h = hashSnapshot(snap);          // '1a2b3c4d'
 * // Два мира с одним seed и одной программой → одинаковый snap и h.
 * ```
 */

import type {
  ComponentColumnJSON,
  EntityId,
  JsonValue,
  SnapshotJSON,
} from '@zona/shared';
import { createResourceStore, type SimWorld } from './world';
import {
  allEntities,
  exportEntityIndex,
  createEcsWorldFromIndex,
  addComponent,
  hasComponent,
  type ComponentRef,
  type FieldArray,
} from './ecs';
import { COMPONENT_REGISTRY, assertRegistrySorted, type ComponentMeta } from './registry';
import { restoreRng } from './rng';
import { createEventBus, type EventBus } from './events';

// ── Константы FNV-1a (часть алгоритма хэша, НЕ баланс; ср. core/rng.ts) ───────
/** FNV-1a offset basis (32-бит). */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a prime (32-бит). */
const FNV_PRIME = 0x01000193;

/**
 * true, если `v` — «plain object» (литерал/`Object.create(null)`), а не
 * экземпляр класса/`Map`/`Set`/`Date` и т.п. Различаем по прототипу: у plain —
 * `Object.prototype` или `null`.
 */
function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

/** Имя конструктора значения для сообщений об ошибке (лучшая читаемость throw). */
function ctorName(v: object): string {
  const proto = Object.getPrototypeOf(v) as { constructor?: { name?: string } } | null;
  return proto?.constructor?.name ?? 'object';
}

/**
 * Рекурсивное ядро канонизатора. `path` — человекочитаемый путь до значения
 * (для сообщений об ошибке). Возвращает каноничную строку поддерева.
 */
function encode(value: unknown, path: string): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(
        `canonicalize: недопустимое число ${String(n)} (NaN/±Infinity запрещены) — путь: ${path}`,
      );
    }
    return n.toString();
  }

  if (t === 'string') {
    // JSON.stringify даёт детерминированное экранирование строки (кавычки,
    // спецсимволы, суррогатные пары) — стабильно между прогонами.
    return JSON.stringify(value);
  }

  if (t === 'undefined') {
    throw new TypeError(`canonicalize: undefined запрещён — путь: ${path}`);
  }
  if (t === 'function') {
    throw new TypeError(`canonicalize: функция запрещена — путь: ${path}`);
  }
  if (t === 'symbol') {
    throw new TypeError(`canonicalize: symbol запрещён — путь: ${path}`);
  }
  if (t === 'bigint') {
    throw new TypeError(`canonicalize: bigint не представим в JSON — путь: ${path}`);
  }

  // Дальше — только объекты.
  if (Array.isArray(value)) {
    const parts = new Array<string>(value.length);
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        // Дыра разреженного массива: в снапшот не должна попадать (закон №8).
        throw new TypeError(
          `canonicalize: дыра в массиве (индекс ${i}) — путь: ${path}`,
        );
      }
      parts[i] = encode(value[i], `${path}[${i}]`);
    }
    return `[${parts.join(',')}]`;
  }

  const obj = value as object;

  if (obj instanceof Map) {
    throw new TypeError(
      `canonicalize: Map запрещён (D-013: храни как отсортированный массив [eid,value]) — путь: ${path}`,
    );
  }
  if (obj instanceof Set) {
    throw new TypeError(`canonicalize: Set запрещён (D-013) — путь: ${path}`);
  }
  if (!isPlainObject(obj)) {
    throw new TypeError(
      `canonicalize: не-plain объект (${ctorName(obj)}) запрещён (D-013) — путь: ${path}`,
    );
  }

  // Plain object: сортируем ключи по возрастанию (UTF-16) — детерминизм (закон №8).
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = new Array<string>(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] as string;
    parts[i] = `${JSON.stringify(k)}:${encode(record[k], `${path}.${k}`)}`;
  }
  return `{${parts.join(',')}}`;
}

/**
 * DEEP-CLONE plain-JSON-значения (для изоляции значений ресурсов в снапшоте).
 * По той же причине, по которой `exportEntityIndex` клонирует индекс: снапшот
 * обязан быть НЕЗАВИСИМ от живого мира. Иначе мутация значения in-place между
 * тиками (например `push` в массив-инвентарь) задним числом изменила бы уже
 * снятый снимок (и его хэш/запись на диск), а мутация `snap.resources[...][1]`
 * испортила бы живой мир. `serialize` кладёт в снапшот КЛОН, а не ссылку.
 *
 * Одновременно ВАЛИДИРУЕТ (ранний throw с контекстом `path`, как канонизатор):
 * клонировать можно только plain-JSON (`null`/boolean/number/string/массив/plain
 * object); `undefined`/функция/символ/`bigint`/`NaN`/`±Infinity`/`Map`/`Set`/
 * экземпляр класса/дыра массива → throw. Порядок ключей объекта НЕ важен —
 * детерминизм обеспечивает канонизатор при хэше (здесь сохраняем insertion order).
 */
function cloneJsonValue(value: unknown, path: string): JsonValue {
  if (value === null) return null;

  const t = typeof value;

  if (t === 'boolean') return value as boolean;

  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(
        `cloneJsonValue: недопустимое число ${String(n)} (NaN/±Infinity запрещены) — путь: ${path}`,
      );
    }
    return n;
  }

  if (t === 'string') return value as string;

  if (t === 'undefined') {
    throw new TypeError(`cloneJsonValue: undefined запрещён — путь: ${path}`);
  }
  if (t === 'function') {
    throw new TypeError(`cloneJsonValue: функция запрещена — путь: ${path}`);
  }
  if (t === 'symbol') {
    throw new TypeError(`cloneJsonValue: symbol запрещён — путь: ${path}`);
  }
  if (t === 'bigint') {
    throw new TypeError(`cloneJsonValue: bigint не представим в JSON — путь: ${path}`);
  }

  if (Array.isArray(value)) {
    const out = new Array<JsonValue>(value.length);
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new TypeError(
          `cloneJsonValue: дыра в массиве (индекс ${i}) — путь: ${path}`,
        );
      }
      out[i] = cloneJsonValue(value[i], `${path}[${i}]`);
    }
    return out;
  }

  const obj = value as object;

  if (obj instanceof Map) {
    throw new TypeError(
      `cloneJsonValue: Map запрещён (D-013: храни как отсортированный массив [eid,value]) — путь: ${path}`,
    );
  }
  if (obj instanceof Set) {
    throw new TypeError(`cloneJsonValue: Set запрещён (D-013) — путь: ${path}`);
  }
  if (!isPlainObject(obj)) {
    throw new TypeError(
      `cloneJsonValue: не-plain объект (${ctorName(obj)}) запрещён (D-013) — путь: ${path}`,
    );
  }

  const record = obj as Record<string, unknown>;
  const out: Record<string, JsonValue> = {};
  for (const k of Object.keys(record)) {
    out[k] = cloneJsonValue(record[k], `${path}.${k}`);
  }
  return out;
}

/**
 * Каноничная строка значения (D-012/D-013). Стабильна между прогонами:
 * ключи объектов сортируются, массивы сохраняют порядок. Бросает `TypeError` на
 * непредставимом в JSON значении (`undefined`/функция/символ/`bigint`/`NaN`/
 * `±Infinity`/`Map`/`Set`/экземпляр класса/дыра массива) с указанием `ctx`.
 *
 * @param ctx необязательная метка корня для сообщений об ошибке (например,
 *            `resources["name"] eid=5`). По умолчанию — `<root>`.
 */
export function canonicalize(value: unknown, ctx?: string): string {
  return encode(value, ctx ?? '<root>');
}

/**
 * FNV-1a (32-бит) по каноничной строке снапшота. Детерминирован: одинаковый
 * `SnapshotJSON` → одинаковый хэш; порядок вставки ключей на результат не влияет
 * (за это отвечает `canonicalize`). Возвращает 8 hex-символов (uint32).
 */
export function hashSnapshot(snap: SnapshotJSON): string {
  const s = canonicalize(snap, 'snapshot');
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // Math.imul — корректное 32-битное умножение без переполнения double.
    h = Math.imul(h, FNV_PRIME);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * `SimWorld → SnapshotJSON` (write-path, D-012/D-014). Детерминирован: результат
 * зависит только от состояния мира, без обращений к времени/энтропии (закон №8).
 *
 * ЗАКОН №3 (ничего из воздуха): в снапшот попадают ТОЛЬКО живые eid. `entities`
 * берём из `allEntities` (живые, отсортированы). Ресурсы фильтруем по множеству
 * живых eid — даже если бы purge пропустил запись покойника (не должен, D-008),
 * она не утечёт в снапшот. Значения ресурсов DEEP-КЛОНИРУЕМ (`cloneJsonValue`),
 * чтобы снапшот был НЕЗАВИСИМ от живого мира (как `exportEntityIndex` для
 * индекса); клон попутно валидирует значение (D-013) с контекстом ключ/eid —
 * недопустимое значение падает здесь, а не позже при хэше.
 */
export function serialize(
  world: SimWorld,
  registry: readonly ComponentMeta[] = COMPONENT_REGISTRY,
): SnapshotJSON {
  // Инъецированный реестр обязан быть валиден (уник./сорт.): дубль имени молча
  // перезатёр бы колонку снапшота (закон №8). Глобальный проверен при загрузке;
  // здесь ловим кривой ТЕСТ/будущий реестр дёшево и defensive.
  assertRegistrySorted(registry);

  const entities = allEntities(world.ecs);
  const aliveSet = new Set<EntityId>(entities);

  const resources: Record<string, Array<readonly [EntityId, JsonValue]>> = {};
  for (const key of world.resources.keys()) {
    const pairs = world.resources.entries<unknown>(key); // уже отсортированы по eid
    const out: Array<readonly [EntityId, JsonValue]> = [];
    for (const [eid, value] of pairs) {
      // Закон №3: покойник (нет среди живых) в снапшот не попадает.
      if (!aliveSet.has(eid)) continue;
      // DEEP-CLONE (+ ранняя валидация D-013 с контекстом ключ/eid): снапшот
      // независим от живого мира — мутация значения in-place между тиками не
      // изменит уже снятый снимок, и наоборот. Консистентно с exportEntityIndex.
      const cloned = cloneJsonValue(value, `resources[${JSON.stringify(key)}] eid=${eid}`);
      out.push([eid, cloned]);
    }
    // Пустой после фильтрации ключ не включаем — снапшот несёт только живое.
    if (out.length > 0) resources[key] = out;
  }

  return {
    version: 1,
    seed: world.seed,
    tick: world.tick,
    rngState: world.rng.state,
    eventSeq: world.bus.eventSeq,
    ecsIndex: exportEntityIndex(world.ecs),
    entities,
    resources,
    // SoA-компоненты по реестру (D-018). Пустой реестр → `{}` (голден-хэш
    // пустого мира не меняется, D-012). `entities` уже отсортированы по возр.
    components: serializeComponents(world, registry, entities),
    eventLog: world.bus.log, // копия append-only лога в порядке EventId.
  };
}

/**
 * Собирает `components` снапшота из реестра (D-018). Для каждого компонента
 * (реестр отсортирован по имени, закон №8) берёт ЖИВЫХ носителей — пересечение
 * `entities` (живые, сорт. по возр.) и `hasComponent` — и читает поля из SoA в
 * ФИКСИРОВАННОМ порядке `meta.fields`. Пустые компоненты (нет живых носителей) не
 * пишутся — снапшот несёт только присутствующее (закон №3).
 *
 * `entities` уже отсортированы (`allEntities`), поэтому `eids` колонки тоже
 * возрастают, и `fields[f][i] ↔ eids[i]`. Значения f32 читаются из `Float32Array`
 * уже округлёнными — канон детерминирован (закон №8).
 */
function serializeComponents(
  world: SimWorld,
  registry: readonly ComponentMeta[],
  entities: readonly EntityId[],
): SnapshotJSON['components'] {
  // Тип свойства снапшота — `Record<string, JsonValue>` (недоверенный вход при
  // чтении); строим ЗАМОРОЖЕННУЮ форму `ComponentColumnJSON` и проверяем её через
  // `satisfies` при присвоении. Структурно колонка — валидный JsonValue.
  const components: Record<string, JsonValue> = {};
  for (const meta of registry) {
    // Живые носители: entities отсортированы по возр., фильтр порядок сохраняет.
    const carriers: EntityId[] = [];
    for (const eid of entities) {
      if (hasComponent(world.ecs, meta.ref, eid)) carriers.push(eid);
    }
    if (carriers.length === 0) continue; // пустой компонент не пишем.

    const store = meta.ref as Record<string, FieldArray>;
    const fields: Record<string, number[]> = {};
    for (const f of meta.fields) {
      const column = store[f] as FieldArray;
      const out = new Array<number>(carriers.length);
      for (let i = 0; i < carriers.length; i++) {
        out[i] = column[carriers[i] as number] as number;
      }
      fields[f] = out;
    }
    components[meta.name] = { eids: carriers, fields } satisfies ComponentColumnJSON;
  }
  return components;
}

/**
 * `SnapshotJSON → SimWorld` (read-path, 0.5b, D-011/D-012/D-014). Симметрична
 * `serialize`: восстанавливает рабочий мир, готовый продолжить прогон с того же
 * места (resume). Детерминирована: результат зависит только от снимка.
 *
 * Бросает `TypeError`/`Error` на битом или подделанном снапшоте (симметрия
 * GUARD'ов, D-012, закон №3 — ничего из воздуха):
 *  - `version !== 1` (чужой/будущий формат);
 *  - `snap.entities` не совпадает с живыми eid восстановленного `ecsIndex`
 *    (авторитет — `ecsIndex`, `entities` — производное, сверяется);
 *  - ресурс на НЕ живом eid: пара `[eid, value]`, чей `eid` ∉ живого набора,
 *    иначе следующий `spawnEntity` переиспользовал бы eid и УНАСЛЕДОВАЛ бы этот
 *    «призрак» (данные из воздуха, закон №3) — симметрично entities-GUARD;
 *  - SoA-компоненты (D-018, `registry`): неизвестное имя компонента, кривая форма
 *    колонки, дрейф полей или компонент на НЕ живом eid → throw (см.
 *    `deserializeComponents`). Реестр берётся из параметра (по умолчанию —
 *    глобальный `COMPONENT_REGISTRY`), чтобы тесты 1.0 передавали свой без утечки
 *    тест-компонента в глобальный singleton (изоляция детерминизм-гейта Фазы 0).
 *
 * Значения ресурсов DEEP-КЛОНИРУЮТСЯ (`cloneJsonValue`), поэтому восстановленный
 * мир владеет своими копиями: снапшот можно переиспользовать (например, держать
 * для повторного resume), и мутация одной стороны не заражает другую.
 */
export function deserialize(
  snap: SnapshotJSON,
  registry: readonly ComponentMeta[] = COMPONENT_REGISTRY,
): SimWorld {
  if (snap.version !== 1) {
    throw new TypeError(
      `deserialize: неподдерживаемая версия снапшота ${String(snap.version)} (ожидается 1).`,
    );
  }
  // Реестр обязан быть валиден (симметрия serialize): дубль имени дал бы неоднозначное
  // отображение имени снапшота в колонку. Defensive и дёшево.
  assertRegistrySorted(registry);

  // Аллокатор восстановлен verbatim (eid + freelist, D-011); entityComponents
  // населены живыми eid — см. createEcsWorldFromIndex.
  const ecs = createEcsWorldFromIndex(snap.ecsIndex);

  // GUARD (D-012): ecsIndex — авторитет по живым eid, snap.entities — производное.
  // Расхождение = битый/подделанный снапшот. Обе стороны отсортированы по eid
  // (allEntities и serialize сортируют), поэтому сверяем поэлементно.
  const restored = allEntities(ecs);
  if (restored.length !== snap.entities.length) {
    throw new TypeError(
      `deserialize: snap.entities (${snap.entities.length}) не совпадает с живыми ` +
        `eid ecsIndex (${restored.length}) — битый/подделанный снапшот.`,
    );
  }
  for (let i = 0; i < restored.length; i++) {
    if (restored[i] !== snap.entities[i]) {
      throw new TypeError(
        `deserialize: snap.entities[${i}]=${String(snap.entities[i])} != ` +
          `живой eid ${String(restored[i])} — битый/подделанный снапшот.`,
      );
    }
  }

  // Корневой rng: restoreRng(seed, state) продолжает последовательность и даёт
  // те же форки (fork зависит от rootSeed, D-004/D-014).
  const rng = restoreRng(snap.seed, snap.rngState);

  // Собираем SimWorld с той же аккуратностью bus ↔ world.tick, что в
  // createSimWorld: сначала объект мира (bus — временная «дыра»), затем bus
  // замыканием на ЭТОТ ЖЕ объект, чтобы `() => world.tick` видел актуальный тик
  // (планировщик мутирует world.tick именно на возвращаемом объекте).
  const world: SimWorld = {
    ecs,
    resources: createResourceStore(),
    tick: snap.tick,
    seed: snap.seed,
    rng,
    bus: undefined as unknown as EventBus,
  };
  // Шина восстановлена через seam (C-4): eventSeq продолжает монотонность id без
  // коллизий с восстановленным логом, log — накопленная история.
  (world as { bus: EventBus }).bus = createEventBus(() => world.tick, {
    eventSeq: snap.eventSeq,
    log: snap.eventLog,
  });

  // Множество живых eid для GUARD ресурсов (симметрия entities-GUARD, закон №3).
  const aliveSet = new Set<EntityId>(restored);

  // Регидратация ResourceStore: DEEP-CLONE каждого значения (изоляция от снапшота).
  // Ключи сортируем — детерминизм обхода (закон №8); на итог entries() (тоже
  // сортирует) порядок вставки не влияет, но фиксируем как инвариант.
  for (const key of Object.keys(snap.resources).sort()) {
    const pairs = snap.resources[key];
    if (pairs === undefined) continue;
    for (const [eid, value] of pairs) {
      // GUARD (D-012, закон №3): ресурс на НЕ живом eid — битый/подделанный
      // снапшот. Загрузив его молча, мы бы дали следующему spawnEntity (reuse
      // eid) унаследовать «призрак» — предмет/имя из воздуха. serialize такое не
      // производит (фильтрует по живым), поэтому источник — только порча снимка.
      if (!aliveSet.has(eid)) {
        throw new TypeError(
          `deserialize: ресурс "${key}" на НЕ живом eid=${String(eid)} — ` +
            `битый/подделанный снапшот (нарушил бы закон №3 при reuse eid).`,
        );
      }
      const cloned = cloneJsonValue(value, `resources[${JSON.stringify(key)}] eid=${eid}`);
      world.resources.set(key, eid, cloned);
    }
  }

  // Регидратация SoA-компонентов (D-018): восстанавливаем реальные носители и их
  // поля. aliveSet — тот же авторитет живых eid, что для ресурсов (закон №3).
  deserializeComponents(world, snap.components, registry, aliveSet);

  return world;
}

/**
 * Восстанавливает SoA-компоненты из снапшота в живой мир (D-018). Симметрична
 * `serializeComponents` и строга к недоверенному входу (`components` — `JsonValue`):
 *  - имя компонента не найдено в реестре → throw (снапшот из чужой схемы);
 *  - колонка не той формы (`eids`/`fields`, длины, конечные числа) → throw;
 *  - набор полей колонки не совпал с `meta.fields` → throw (дрейф схемы);
 *  - eid носителя НЕ жив → throw (симметрия GUARD ресурсов, закон №3: иначе
 *    следующий `spawnEntity` (reuse eid) унаследовал бы «призрачный» компонент).
 * Порядок обхода — `Object.keys().sort()` (детерминизм, закон №8). `addComponent`
 * заодно валидирует ёмкость (eid в границах колонок).
 */
function deserializeComponents(
  world: SimWorld,
  components: SnapshotJSON['components'],
  registry: readonly ComponentMeta[],
  aliveSet: ReadonlySet<EntityId>,
): void {
  const byName = new Map<string, ComponentMeta>();
  for (const meta of registry) byName.set(meta.name, meta);

  for (const name of Object.keys(components).sort()) {
    const meta = byName.get(name);
    if (meta === undefined) {
      throw new TypeError(
        `deserialize: неизвестный компонент "${name}" в snap.components — ` +
          `снапшот из чужой схемы (нет в реестре).`,
      );
    }
    const column = reqComponentColumn(components[name], name);

    // eids: массив конечных чисел, каждый — ЖИВОЙ носитель (закон №3).
    const eids = reqNumberArray(column.eids, `components["${name}"].eids`);
    for (let i = 0; i < eids.length; i++) {
      const id = eids[i] as EntityId;
      if (!aliveSet.has(id)) {
        throw new TypeError(
          `deserialize: компонент "${name}" на НЕ живом eid=${String(id)} — ` +
            `битый/подделанный снапшот (нарушил бы закон №3 при reuse eid).`,
        );
      }
    }

    // Набор полей колонки обязан совпасть с meta.fields (дрейф схемы = throw).
    const columnFields = Object.keys(column.fields).sort();
    const metaFields = [...meta.fields].sort();
    if (columnFields.length !== metaFields.length) {
      throw new TypeError(
        `deserialize: компонент "${name}" — число полей ${columnFields.length} != ` +
          `${metaFields.length} по реестру (дрейф схемы).`,
      );
    }
    for (let i = 0; i < metaFields.length; i++) {
      if (columnFields[i] !== metaFields[i]) {
        throw new TypeError(
          `deserialize: компонент "${name}" — поля ${JSON.stringify(columnFields)} != ` +
            `${JSON.stringify(metaFields)} по реестру (дрейф схемы).`,
        );
      }
    }

    // Читаем колонки в ФИКСИРОВАННОМ порядке meta.fields; длины равны eids.
    const store = meta.ref as Record<string, FieldArray>;
    const columns: Array<readonly [string, readonly number[]]> = [];
    for (const f of meta.fields) {
      const col = reqNumberArray(column.fields[f], `components["${name}"].fields["${f}"]`);
      if (col.length !== eids.length) {
        throw new TypeError(
          `deserialize: компонент "${name}" поле "${f}" длины ${col.length} != ` +
            `eids ${eids.length} — битый снапшот.`,
        );
      }
      columns.push([f, col]);
    }

    // Навешиваем компонент и пишем поля. addComponent проверяет ёмкость по eid.
    for (let i = 0; i < eids.length; i++) {
      const id = eids[i] as EntityId;
      addComponent(world.ecs, meta.ref as ComponentRef, id);
      for (const [f, col] of columns) {
        (store[f] as FieldArray)[id as number] = col[i] as number;
      }
    }
  }
}

/**
 * Узкий тип-guard недоверенной колонки компонента: объект с `eids` (массив) и
 * `fields` (plain object). Бросает на иной форме (`JsonValue` из снапшота может
 * быть чем угодно). Элементы массивов проверяет `reqNumberArray`.
 */
function reqComponentColumn(
  value: JsonValue | undefined,
  name: string,
): { readonly eids: JsonValue; readonly fields: Record<string, JsonValue> } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`deserialize: components["${name}"] — не объект-колонка.`);
  }
  const rec = value as Record<string, JsonValue>;
  const fields = rec['fields'];
  if (fields === undefined || fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError(`deserialize: components["${name}"].fields — не объект.`);
  }
  return { eids: rec['eids'] as JsonValue, fields: fields as Record<string, JsonValue> };
}

/**
 * Читает недоверенный `JsonValue` как массив КОНЕЧНЫХ чисел, клонируя в новый
 * массив (как `reqNumberArray` в ecs.ts, но над `JsonValue`). Бросает на
 * не-массиве / не-числовом / нечисло-конечном элементе (защита от битого снапшота).
 */
function reqNumberArray(value: JsonValue | undefined, ctx: string): number[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`deserialize: ${ctx} — не массив.`);
  }
  const out = new Array<number>(value.length);
  for (let i = 0; i < value.length; i++) {
    const n = value[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new TypeError(`deserialize: ${ctx}[${i}] — не конечное число (${String(n)}).`);
    }
    out[i] = n;
  }
  return out;
}
