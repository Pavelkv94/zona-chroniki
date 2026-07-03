/**
 * @module @zona/sim/core/world
 *
 * `SimWorld` — корневой контейнер состояния симуляции, и `ResourceStore` —
 * хранилище «холодных» не-числовых данных сущностей (имена, инвентари, память,
 * отношения), которые не ложатся в SoA-массивы bitecs (D-007).
 *
 * Ключевой инвариант ResourceStore — ДЕТЕРМИНИЗМ ИТЕРАЦИИ (закон №8): `entries`
 * всегда отдаёт пары в порядке возрастания `eid`, независимо от порядка вставки.
 * Поэтому сериализация и любые проходы по хранилищу воспроизводимы при одном
 * seed. Внутри — `Map<key, Map<eid, value>>`; сортировка ключей выполняется
 * только в `entries`/`purgeEntity` (в горячем `get/set/has` сортировки нет).
 *
 * ЕДИНАЯ ТОЧКА УДАЛЕНИЯ сущности — `destroyEntity(world, eid)`: она убирает
 * сущность и из bitecs, и из ResourceStore (`purgeEntity`). Это закрывает риск
 * C-6: bitecs 0.4 переиспользует освобождённые eid, и без вычистки ресурсов
 * новая сущность унаследовала бы имя/инвентарь покойника — предметы «из воздуха»
 * (нарушение закона №3). Низкоуровневый `destroyEcsEntity` (ecs.ts) чистит
 * только ECS и наружу как способ удаления не выдаётся.
 *
 * `SimWorld = { ecs, resources, tick, seed, rng, bus }`. Поле `rng` (seeded
 * PRNG, задача 0.3) — корневой генератор мира; планировщик даёт системам
 * подпоток `rng.fork(`${system.name}@${tick}`)` (D-009). Поле `bus` (шина
 * событий, задача 0.4) — append-only лог событий; см. `core/events.ts`.
 *
 * Пример:
 * ```ts
 * const world = createSimWorld(42 as Seed);
 * const eid = spawnEntity(world.ecs);
 * world.resources.set('name', eid, 'Sidorovich');
 * world.resources.get<string>('name', eid); // 'Sidorovich'
 * destroyEntity(world, eid);                 // ECS + ресурсы очищены
 * ```
 */

import type { EntityId, Seed, Tick } from '@zona/shared';
import {
  createEcsWorld,
  destroyEcsEntity,
  type EcsWorld,
} from './ecs';
import { createRng, type Rng } from './rng';
import { createEventBus, type EventBus } from './events';

/**
 * Хранилище объектных данных сущностей с детерминированной итерацией.
 * Значения типизируются на стороне вызова через дженерик `<T>`; хранилище
 * не проверяет типы между `set` и `get` (ответственность вызывающего кода).
 */
export interface ResourceStore {
  /** Записать/перезаписать значение под ключом `key` для сущности `eid`. */
  set<T>(key: string, eid: EntityId, value: T): void;
  /** Прочитать значение; `undefined`, если пары (key, eid) нет. */
  get<T>(key: string, eid: EntityId): T | undefined;
  /**
   * true, если пара (key, eid) существует. Отличает «нет пары» от «значение
   * === undefined»: `get` для обоих случаев вернёт `undefined`, `has` — нет.
   */
  has(key: string, eid: EntityId): boolean;
  /** Удалить значение для (key, eid). Отсутствующая пара игнорируется. */
  delete(key: string, eid: EntityId): void;
  /**
   * Удалить ВСЕ пары для сущности `eid` по всем ключам. Вызывается при удалении
   * сущности (`destroyEntity`), чтобы освобождённый eid не унёс за собой данные
   * покойника (риск C-6). Детерминированно: обход ключей по отсортированному
   * списку (закон №8).
   */
  purgeEntity(eid: EntityId): void;
  /** Все пары под ключом `key`, отсортированные ТОЛЬКО по eid по возрастанию. */
  entries<T>(key: string): ReadonlyArray<readonly [EntityId, T]>;
  /**
   * Все НЕПУСТЫЕ ключи хранилища, отсортированные по возрастанию (UTF-16, закон
   * №8). Нужна сериализации (0.5), чтобы детерминированно перечислить ресурсы:
   * `entries(key)` требует знать ключ заранее. Пустые бакеты не хранятся
   * (см. `delete`/`purgeEntity`), поэтому в выдаче только ключи с данными.
   */
  keys(): readonly string[];
}

/** Корневой контейнер состояния мира. */
export interface SimWorld {
  /** bitecs-мир: SoA-компоненты и жизненный цикл сущностей. */
  readonly ecs: EcsWorld;
  /** Хранилище «холодных» объектных данных сущностей (D-007). */
  readonly resources: ResourceStore;
  /** Текущий номер тика. Мутируется планировщиком (0.2). */
  tick: Tick;
  /** Seed мира: одинаковый seed → одинаковая история (закон №8). */
  readonly seed: Seed;
  /**
   * Корневой seeded PRNG мира (задача 0.3). Единственный источник случайности
   * (закон №2). Планировщик даёт каждой системе собственный подпоток
   * `rng.fork(`${system.name}@${tick}`)` (D-009 — метка включает НОМЕР ТИКА,
   * поэтому поток различается по тикам, оставаясь детерминированным), чтобы
   * системы не влияли на последовательности друг друга.
   */
  readonly rng: Rng;
  /**
   * Шина событий (задача 0.4, D-005): append-only лог с монотонным `EventId` и
   * `causedBy`. ЕДИНСТВЕННЫЙ канал общения систем помимо ECS-компонентов
   * (закон №6). `publish` берёт `tick` из `world.tick` этого же объекта.
   */
  readonly bus: EventBus;
}

/**
 * Реализация ResourceStore поверх вложенных Map.
 * Внешняя Map: ключ данных → внутренняя Map: eid → значение.
 */
class MapResourceStore implements ResourceStore {
  private readonly byKey = new Map<string, Map<EntityId, unknown>>();

  set<T>(key: string, eid: EntityId, value: T): void {
    let bucket = this.byKey.get(key);
    if (bucket === undefined) {
      bucket = new Map<EntityId, unknown>();
      this.byKey.set(key, bucket);
    }
    bucket.set(eid, value);
  }

  get<T>(key: string, eid: EntityId): T | undefined {
    const bucket = this.byKey.get(key);
    if (bucket === undefined) return undefined;
    return bucket.get(eid) as T | undefined;
  }

  has(key: string, eid: EntityId): boolean {
    const bucket = this.byKey.get(key);
    if (bucket === undefined) return false;
    return bucket.has(eid);
  }

  delete(key: string, eid: EntityId): void {
    const bucket = this.byKey.get(key);
    if (bucket === undefined) return;
    bucket.delete(eid);
    if (bucket.size === 0) this.byKey.delete(key);
  }

  purgeEntity(eid: EntityId): void {
    // Закон №8: обходим ключи в отсортированном порядке для детерминизма
    // (набор мутируемых бакетов и итоговое состояние от порядка не зависят,
    // но фиксируем порядок обхода как инвариант ядра).
    const keys = Array.from(this.byKey.keys()).sort();
    for (const key of keys) {
      const bucket = this.byKey.get(key);
      if (bucket === undefined) continue;
      bucket.delete(eid);
      if (bucket.size === 0) this.byKey.delete(key);
    }
  }

  keys(): readonly string[] {
    // Закон №8: детерминированный порядок — сортируем ключи по возрастанию.
    // Внутренняя Map хранит только непустые бакеты (delete/purge удаляют пустые).
    return Array.from(this.byKey.keys()).sort();
  }

  entries<T>(key: string): ReadonlyArray<readonly [EntityId, T]> {
    const bucket = this.byKey.get(key);
    if (bucket === undefined) return [];
    // Закон №8: сортируем ключи-eid по возрастанию перед выдачей.
    const eids = Array.from(bucket.keys()).sort((a, b) => a - b);
    const result: Array<readonly [EntityId, T]> = new Array(eids.length);
    for (let i = 0; i < eids.length; i++) {
      const eid = eids[i] as EntityId;
      result[i] = [eid, bucket.get(eid) as T];
    }
    return result;
  }
}

/**
 * Создаёт пустой ResourceStore. ВНУТРЕННИЙ seam для сериализации (0.5b): чтобы
 * `deserialize` собрал `SimWorld` из восстановленных частей, ему нужен свежий
 * store для регидратации `snap.resources`, а реализация (`MapResourceStore`)
 * приватна. НЕ реэкспортируется из `@zona/sim` (index.ts): store всегда живёт
 * внутри `SimWorld`, наружу отдаётся только через `world.resources`.
 */
export function createResourceStore(): ResourceStore {
  return new MapResourceStore();
}

/**
 * Создаёт новый мир симуляции: свежий bitecs-мир, пустой ResourceStore,
 * `tick = 0` и заданный `seed`. Детерминирован: результат зависит только от
 * seed, без обращений к времени/энтропии (закон №8).
 */
export function createSimWorld(seed: Seed): SimWorld {
  // Порядок инициализации bus ↔ world.tick: шине нужен `getTick`, который
  // читает `world.tick`, а планировщик (0.2) мутирует `world.tick` ИМЕННО на
  // возвращаемом объекте. Поэтому создаём объект мира сначала (с временной
  // «дырой» под bus), а затем присваиваем bus замыканием на ЭТОТ ЖЕ объект —
  // так `() => world.tick` всегда видит актуальный тик. Возврат нового объекта
  // (например, через spread) разорвал бы связь: замыкание держало бы старый
  // объект, чей tick планировщик не трогает.
  const world: SimWorld = {
    ecs: createEcsWorld(),
    resources: new MapResourceStore(),
    tick: 0,
    seed,
    rng: createRng(seed),
    bus: undefined as unknown as EventBus,
  };
  (world as { bus: EventBus }).bus = createEventBus(() => world.tick);
  return world;
}

/**
 * ЕДИНСТВЕННЫЙ публичный способ удалить сущность. Убирает её из bitecs и
 * вычищает все её данные из ResourceStore. Обязателен из-за переиспользования
 * eid в bitecs 0.4 (риск C-6): без purge новая сущность на том же eid читалась
 * бы как носитель имени/инвентаря покойника (нарушение закона №3).
 * Идемпотентен: повторный вызов и несуществующий eid безопасны.
 */
export function destroyEntity(world: SimWorld, eid: EntityId): void {
  destroyEcsEntity(world.ecs, eid);
  world.resources.purgeEntity(eid);
}
