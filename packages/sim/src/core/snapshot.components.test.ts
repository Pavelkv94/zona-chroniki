/**
 * @module @zona/sim/core/snapshot.components.test
 *
 * Гейт сериализации SoA-компонентов (задача 1.0, D-018). Расширяет round-trip/
 * resume-детерминизм Фазы 0 на реальные bitecs-компоненты через ТЕСТ-реестр
 * (изоляция: глобальный COMPONENT_REGISTRY пуст, поэтому детерминизм-гейт Фазы 0
 * не затрагивается). Проверяет:
 *  - round-trip: hash(serialize(deserialize(serialize(w,reg),reg),reg)) === hash(serialize(w,reg));
 *  - split save/load на середине наполненного мира === непрерывный прогон (хэш);
 *  - сериализуются ТОЛЬКО живые носители (destroy одного → его нет в components);
 *  - компонент на мёртвом eid в снапшоте → deserialize бросает (закон №3);
 *  - неизвестное имя компонента в снапшоте → throw;
 *  - дрейф полей / кривая форма колонки → throw;
 *  - пустой реестр (прод) → components === {} (голден-хэш не трогается).
 */

import { describe, it, expect } from 'vitest';
import type { JsonValue, Seed, SnapshotJSON, Tick } from '@zona/shared';
import { createSimWorld, destroyEntity, type SimWorld } from './world';
import {
  spawnEntity,
  addComponent,
  hasComponent,
  queryEntities,
  defineComponentT,
  Types,
  type ComponentRef,
} from './ecs';
import type { ComponentMeta } from './registry';
import { serialize, deserialize, hashSnapshot, canonicalize } from './snapshot';

/**
 * Свежий тест-компонент { a: f32, b: ui32 } + одноимённый реестр. КАЖДЫЙ тест
 * берёт свой экземпляр: колонки компонента — модульный singleton (глобальные
 * массивы), поэтому изоляция между тестами обеспечивается новым `defineComponentT`
 * (свежие массивы) на каждый вызов.
 */
function makeTestComp(): { ref: ComponentRef; registry: ComponentMeta[] } {
  const ref = defineComponentT({ a: Types.f32, b: Types.ui32 }, 64);
  const registry: ComponentMeta[] = [{ name: 'test', ref, fields: ['a', 'b'] }];
  return { ref, registry };
}

/** Прямой доступ к колонкам тест-компонента для чтения/записи значений. */
function cols(ref: ComponentRef): { a: Float32Array; b: Uint32Array } {
  return ref as unknown as { a: Float32Array; b: Uint32Array };
}

/** Пересобирает объект с ключами в обратном порядке (проверка независимости канона от порядка вставки). */
function reverseKeys<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).reverse()) out[k] = obj[k];
  return out as T;
}

describe('round-trip: serialize→deserialize→serialize компонентов (D-018)', () => {
  it('hash и канон совпадают; данные компонента восстановлены', () => {
    const w = createSimWorld(7 as Seed);
    const { ref, registry } = makeTestComp();
    const e1 = spawnEntity(w.ecs);
    const e2 = spawnEntity(w.ecs); // без компонента
    const e3 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1);
    addComponent(w.ecs, ref, e3);
    const c = cols(ref);
    c.a[e1] = 1.5;
    c.b[e1] = 10;
    c.a[e3] = 2.25;
    c.b[e3] = 20;

    const snap1 = serialize(w, registry);
    // Форма колонки: только живые носители (e1,e3), отсортированы; поля параллельны.
    expect(Object.keys(snap1.components)).toEqual(['test']);
    const col = snap1.components['test'] as unknown as {
      eids: number[];
      fields: { a: number[]; b: number[] };
    };
    expect(col.eids).toEqual([e1, e3]);
    expect(col.fields.a).toEqual([1.5, 2.25]);
    expect(col.fields.b).toEqual([10, 20]);

    const w2 = deserialize(snap1, registry);
    const snap2 = serialize(w2, registry);
    expect(hashSnapshot(snap2)).toBe(hashSnapshot(snap1));
    expect(canonicalize(snap2)).toBe(canonicalize(snap1));

    // Членство и значения восстановлены точно.
    expect(hasComponent(w2.ecs, ref, e1)).toBe(true);
    expect(hasComponent(w2.ecs, ref, e2)).toBe(false);
    expect(hasComponent(w2.ecs, ref, e3)).toBe(true);
    expect(cols(ref).a[e1]).toBe(1.5);
    expect(cols(ref).b[e3]).toBe(20);
  });

  it('f32-поле с «шумным» значением восстанавливается побитово (детерминизм)', () => {
    const w = createSimWorld(7 as Seed);
    const { ref, registry } = makeTestComp();
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1);
    cols(ref).a[e1] = 0.1 + 0.2; // хранится как f32(0.30000001…)
    const snap1 = serialize(w, registry);
    const w2 = deserialize(snap1, registry);
    expect(hashSnapshot(serialize(w2, registry))).toBe(hashSnapshot(snap1));
    expect(cols(ref).a[e1]).toBe(Math.fround(0.1 + 0.2));
  });
});

describe('сериализуются ТОЛЬКО живые носители (закон №3)', () => {
  it('destroy носителя → его нет в components, стая-значение в массиве не течёт', () => {
    const w = createSimWorld(3 as Seed);
    const { ref, registry } = makeTestComp();
    const e1 = spawnEntity(w.ecs);
    const e2 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1);
    addComponent(w.ecs, ref, e2);
    cols(ref).a[e1] = 111; // «холодное» значение покойника останется в массиве
    cols(ref).a[e2] = 222;

    destroyEntity(w, e1); // e1 мёртв
    const snap = serialize(w, registry);
    const col = snap.components['test'] as unknown as { eids: number[]; fields: { a: number[] } };
    // Только e2; значение 111 мёртвого e1 в снапшот НЕ попало.
    expect(col.eids).toEqual([e2]);
    expect(col.fields.a).toEqual([222]);
  });

  it('компонент без единого живого носителя не пишется (ключа нет)', () => {
    const w = createSimWorld(3 as Seed);
    const { ref, registry } = makeTestComp();
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1);
    destroyEntity(w, e1);
    const snap = serialize(w, registry);
    expect(snap.components).toEqual({});
  });
});

describe('ghost SoA при reuse eid: addComponent зануляет поля (D-024, закон №3/№8)', () => {
  it('reuse-eid: новый носитель без записи поля читает 0, не значение покойника', () => {
    const w = createSimWorld(5 as Seed);
    const { ref, registry } = makeTestComp();
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1);
    cols(ref).a[e1] = 777; // «холодное» значение
    cols(ref).b[e1] = 888;
    destroyEntity(w, e1); // eid освобождён; массив ВСЁ ЕЩЁ держит 777/888

    const e2 = spawnEntity(w.ecs); // bitecs переиспользует освобождённый eid
    expect(e2).toBe(e1); // подтверждаем reuse (иначе тест не про ghost)
    addComponent(w.ecs, ref, e2); // БЕЗ записи полей — полагаемся на зануление

    // Без фикса здесь были бы 777/888 (остаток покойника) — регресс закона №3.
    expect(cols(ref).a[e2]).toBe(0);
    expect(cols(ref).b[e2]).toBe(0);

    // В снапшот попадает чистый носитель, а не ghost.
    const snap = serialize(w, registry);
    const col = snap.components['test'] as unknown as {
      eids: number[];
      fields: { a: number[]; b: number[] };
    };
    expect(col.eids).toEqual([e2]);
    expect(col.fields.a).toEqual([0]);
    expect(col.fields.b).toEqual([0]);
  });

  it('cross-process: load в СВЕЖИЙ ref даёт тот же хэш (нет зависимости от грязного массива)', () => {
    // Мир, где мёртвый eid оставил стухшее значение в массиве, а живой
    // ПЕРЕИСПОЛЬЗОВАННЫЙ носитель чист (полагается на зануление при add).
    const w = createSimWorld(8 as Seed);
    const { ref, registry } = makeTestComp();
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1);
    cols(ref).a[e1] = 999; // остаётся в глобальном массиве после смерти
    cols(ref).b[e1] = 111;
    destroyEntity(w, e1);
    const e1b = spawnEntity(w.ecs); // reuse eid
    expect(e1b).toBe(e1);
    addComponent(w.ecs, ref, e1b); // чистый носитель (зануление), поле не пишем
    const e3 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e3);
    cols(ref).a[e3] = 2.5;
    cols(ref).b[e3] = 5;

    const snap1 = serialize(w, registry);

    // «Свежий процесс»: НОВЫЙ экземпляр компонента (нулевые массивы) с тем же именем.
    const freshRef = defineComponentT({ a: Types.f32, b: Types.ui32 }, 64);
    const freshRegistry: ComponentMeta[] = [{ name: 'test', ref: freshRef, fields: ['a', 'b'] }];
    const w2 = deserialize(snap1, freshRegistry);
    const snap2 = serialize(w2, freshRegistry);

    // Хэш/канон идентичны исходным — результат НЕ зависит от «грязного» массива w.
    expect(hashSnapshot(snap2)).toBe(hashSnapshot(snap1));
    expect(canonicalize(snap2)).toBe(canonicalize(snap1));

    // Свежий ref держит ровно значения снапшота: переиспользованный носитель = 0.
    const fresh = freshRef as unknown as { a: Float32Array; b: Uint32Array };
    expect(fresh.a[e1b]).toBe(0);
    expect(fresh.b[e1b]).toBe(0);
    expect(fresh.a[e3]).toBe(2.5);
  });
});

describe('resume: split save/load === непрерывный прогон (хэш + компоненты)', () => {
  /** Наполненный стартовый мир: 3 сущности, 2 носителя компонента. */
  function buildWorld(seed: number, ref: ComponentRef): SimWorld {
    const w = createSimWorld(seed as Seed);
    const e1 = spawnEntity(w.ecs);
    spawnEntity(w.ecs); // e2 без компонента
    const e3 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1);
    addComponent(w.ecs, ref, e3);
    const c = cols(ref);
    c.a[e1] = 0.1;
    c.b[e1] = 1;
    c.a[e3] = 0.2;
    c.b[e3] = 3;
    return w;
  }

  /** Детерминированный «тик»: мутирует поля носителей, двигает rng/tick, пишет событие. */
  function advanceOneTick(w: SimWorld, ref: ComponentRef): void {
    const t = w.tick;
    const c = cols(ref);
    for (const e of queryEntities(w.ecs, [ref])) {
      c.a[e] = (c.a[e] as number) + 0.5; // f32-накопление
      c.b[e] = ((c.b[e] as number) + t + e) >>> 0; // ui32
    }
    w.rng.next(); // продвигаем корневой rng → rngState участвует
    w.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: t as Tick } });
    w.bus.endTick(t as Tick);
    w.tick = (t + 1) as Tick;
  }

  it('прогон 0..10 непрерывно == прогон 0..5, save/load, 5..10 (один хэш)', () => {
    const { ref, registry } = makeTestComp();

    // Непрерывный прогон до тика 10.
    const wc = buildWorld(9, ref);
    for (let i = 0; i < 10; i++) advanceOneTick(wc, ref);
    const hashCont = hashSnapshot(serialize(wc, registry));

    // Split-прогон: 0..5, снапшот, load, 5..10 (последовательно — те же глобальные
    // массивы перезаписываются, но hashCont уже зафиксирован строкой).
    const ws = buildWorld(9, ref);
    for (let i = 0; i < 5; i++) advanceOneTick(ws, ref);
    const mid = serialize(ws, registry);
    const wr = deserialize(mid, registry);
    for (let i = 5; i < 10; i++) advanceOneTick(wr, ref);
    const hashResume = hashSnapshot(serialize(wr, registry));

    expect(hashResume).toBe(hashCont);
  });
});

describe('deserialize GUARD-ы компонентов (D-018, закон №3)', () => {
  /** Валидный снапшот с одним живым носителем e1 и его тампер-хелпер. */
  function validSnap(): { snap: SnapshotJSON; registry: ComponentMeta[] } {
    const w = createSimWorld(1 as Seed);
    const { ref, registry } = makeTestComp();
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1);
    cols(ref).a[e1] = 5;
    cols(ref).b[e1] = 7;
    return { snap: serialize(w, registry), registry };
  }

  function tamper(snap: SnapshotJSON, components: Record<string, JsonValue>): SnapshotJSON {
    return { ...snap, components };
  }

  it('компонент на НЕ живом eid → throw (закон №3)', () => {
    const { snap, registry } = validSnap();
    const bad = tamper(snap, {
      test: { eids: [1, 99], fields: { a: [5, 0], b: [7, 0] } },
    });
    expect(() => deserialize(bad, registry)).toThrow(/не живом|eid=99/i);
  });

  it('неизвестное имя компонента → throw', () => {
    const { snap, registry } = validSnap();
    const bad = tamper(snap, {
      ghost: { eids: [1], fields: { a: [5], b: [7] } },
    });
    expect(() => deserialize(bad, registry)).toThrow(/неизвестн|ghost/i);
  });

  it('дрейф полей (лишнее/недостающее поле) → throw', () => {
    const { snap, registry } = validSnap();
    const missing = tamper(snap, { test: { eids: [1], fields: { a: [5] } } });
    expect(() => deserialize(missing, registry)).toThrow(/пол/i);
    const extra = tamper(snap, { test: { eids: [1], fields: { a: [5], b: [7], z: [0] } } });
    expect(() => deserialize(extra, registry)).toThrow(/пол/i);
  });

  it('несовпадение длин eids/поля → throw', () => {
    const { snap, registry } = validSnap();
    const bad = tamper(snap, { test: { eids: [1], fields: { a: [5, 6], b: [7] } } });
    expect(() => deserialize(bad, registry)).toThrow(/длин/i);
  });

  it('кривая форма колонки (не объект / не массив eids / не число) → throw', () => {
    const { snap, registry } = validSnap();
    expect(() => deserialize(tamper(snap, { test: 42 as unknown as JsonValue }), registry)).toThrow(
      /колонк|объект/i,
    );
    expect(() =>
      deserialize(tamper(snap, { test: { eids: 5, fields: { a: [1], b: [1] } } }), registry),
    ).toThrow(/не массив/i);
    expect(() =>
      deserialize(
        tamper(snap, { test: { eids: [1], fields: { a: ['x'], b: [1] } } as unknown as JsonValue }),
        registry,
      ),
    ).toThrow(/не конечное число/i);
  });
});

describe('инъецированный реестр валидируется (defensive, закон №8)', () => {
  it('дубль имени в переданном реестре → serialize и deserialize бросают', () => {
    const w = createSimWorld(1 as Seed);
    const ref = defineComponentT({ a: Types.f32, b: Types.ui32 }, 16);
    const dupReg: ComponentMeta[] = [
      { name: 'test', ref, fields: ['a', 'b'] },
      { name: 'test', ref, fields: ['a', 'b'] },
    ];
    expect(() => serialize(w, dupReg)).toThrow(/дубл/i);
    const snap = serialize(w); // валидный (пустой глобальный реестр)
    expect(() => deserialize(snap, dupReg)).toThrow(/дубл/i);
  });
});

describe('изоляция: пустой (прод) реестр не пишет components', () => {
  it('serialize без реестра (default COMPONENT_REGISTRY пуст) → components === {}', () => {
    const w = createSimWorld(1 as Seed);
    const { ref } = makeTestComp();
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1); // компонент есть, но НЕ в глобальном реестре
    const snap = serialize(w); // без второго аргумента
    expect(snap.components).toEqual({});
    expect(() => deserialize(snap)).not.toThrow(); // пустой components — не бросает
  });

  it('голден-хэш пустого мира не сдвигается ни от прод-, ни от тест-реестра без носителей', () => {
    // Регистрация тест-компонента без единого живого носителя не должна протечь
    // в снапшот: components остаётся {}, а голден-якорь пустого мира (481914ae)
    // держится. Так тест-реестр не отравляет детерминизм-гейт Фазы 0.
    const w = createSimWorld(0 as Seed);
    const { registry } = makeTestComp(); // реестр есть, носителей нет
    const snapDefault = serialize(w);
    const snapTestReg = serialize(w, registry);
    expect(snapDefault.components).toEqual({});
    expect(snapTestReg.components).toEqual({});
    expect(hashSnapshot(snapDefault)).toBe('481914ae');
    expect(hashSnapshot(snapTestReg)).toBe('481914ae');
  });
});

describe('точность типов полей переживает round-trip побитово (закон №8)', () => {
  it('f32: 0.1, 1/3, большое число хранятся КАК Float32Array (не f64) и восстанавливаются', () => {
    const w = createSimWorld(1 as Seed);
    const ref = defineComponentT({ a: Types.f32, b: Types.ui32 }, 64);
    const registry: ComponentMeta[] = [{ name: 'test', ref, fields: ['a', 'b'] }];
    const c = ref as unknown as { a: Float32Array; b: Uint32Array };
    const e1 = spawnEntity(w.ecs);
    const e2 = spawnEntity(w.ecs);
    const e3 = spawnEntity(w.ecs);
    for (const e of [e1, e2, e3]) addComponent(w.ecs, ref, e);
    c.a[e1] = 0.1;
    c.a[e2] = 1 / 3;
    c.a[e3] = 16_777_217; // 2^24+1: не представимо точно в f32
    const snap = serialize(w, registry);
    const col = snap.components['test'] as unknown as { fields: { a: number[] } };
    // Снапшот несёт РОВНО то, что даёт запись в Float32Array — не исходный double.
    expect(col.fields.a[0]).toBe(Math.fround(0.1));
    expect(col.fields.a[1]).toBe(Math.fround(1 / 3));
    expect(col.fields.a[2]).toBe(Math.fround(16_777_217));
    expect(col.fields.a[0]).not.toBe(0.1); // именно f32, не f64
    // round-trip: значения возвращаются в массив побитово.
    const w2 = deserialize(snap, registry);
    const c2 = ref as unknown as { a: Float32Array };
    expect(c2.a[e1]).toBe(Math.fround(0.1));
    expect(c2.a[e3]).toBe(Math.fround(16_777_217));
    expect(hashSnapshot(serialize(w2, registry))).toBe(hashSnapshot(snap));
  });

  it('ui32/ui8/eid границы переживают round-trip', () => {
    const w = createSimWorld(1 as Seed);
    const ref = defineComponentT({ big: Types.ui32, flag: Types.ui8, link: Types.eid }, 64);
    const registry: ComponentMeta[] = [{ name: 'bounds', ref, fields: ['big', 'flag', 'link'] }];
    const s = ref as unknown as { big: Uint32Array; flag: Uint8Array; link: Uint32Array };
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1);
    s.big[e1] = 4294967295; // max ui32
    s.flag[e1] = 255; // max ui8
    s.link[e1] = 12345; // eid-ссылка, без ремапа (D-011)
    const snap = serialize(w, registry);
    const w2 = deserialize(snap, registry);
    const s2 = ref as unknown as { big: Uint32Array; flag: Uint8Array; link: Uint32Array };
    expect(s2.big[e1]).toBe(4294967295);
    expect(s2.flag[e1]).toBe(255);
    expect(s2.link[e1]).toBe(12345);
    expect(hashSnapshot(serialize(w2, registry))).toBe(hashSnapshot(snap));
  });
});

describe('несколько компонентов и сущностей: колонки независимы, ключи сортированы', () => {
  it('разные наборы у жителей → каждая колонка несёт своих носителей; ключи components сорт. по имени', () => {
    // Реестр объявлен ОТСОРТИРОВАННЫМ по имени (health < position) — таков контракт
    // (assertRegistrySorted). serialize перечисляет ключи в порядке реестра, поэтому
    // при валидном реестре они уже отсортированы.
    const w = createSimWorld(5 as Seed);
    const position = defineComponentT({ x: Types.f32, y: Types.f32 }, 64);
    const health = defineComponentT({ hp: Types.f32 }, 64);
    const registry: ComponentMeta[] = [
      { name: 'health', ref: health, fields: ['hp'] },
      { name: 'position', ref: position, fields: ['x', 'y'] },
    ];
    const p = position as unknown as { x: Float32Array; y: Float32Array };
    const h = health as unknown as { hp: Float32Array };
    const barman = spawnEntity(w.ecs);
    const stalker = spawnEntity(w.ecs);
    const stash = spawnEntity(w.ecs);
    addComponent(w.ecs, position, barman);
    addComponent(w.ecs, health, barman);
    addComponent(w.ecs, position, stalker);
    addComponent(w.ecs, health, stash);
    p.x[barman] = 1; p.y[barman] = 2;
    p.x[stalker] = 3; p.y[stalker] = 4;
    h.hp[barman] = 100; h.hp[stash] = 50;

    const snap = serialize(w, registry);
    // Ключи отсортированы по имени: 'health' < 'position'.
    expect(Object.keys(snap.components)).toEqual(['health', 'position']);
    const hc = snap.components['health'] as unknown as { eids: number[]; fields: { hp: number[] } };
    const pc = snap.components['position'] as unknown as {
      eids: number[]; fields: { x: number[]; y: number[] };
    };
    // Носители независимы: health = {barman, stash}; position = {barman, stalker}.
    expect(hc.eids).toEqual([barman, stash]);
    expect(hc.fields.hp).toEqual([100, 50]);
    expect(pc.eids).toEqual([barman, stalker]);
    expect(pc.fields.x).toEqual([1, 3]);
    expect(pc.fields.y).toEqual([2, 4]);

    // round-trip восстанавливает членство и значения обоих компонентов.
    const w2 = deserialize(snap, registry);
    expect(hasComponent(w2.ecs, health, stash)).toBe(true);
    expect(hasComponent(w2.ecs, position, stash)).toBe(false);
    expect(hashSnapshot(serialize(w2, registry))).toBe(hashSnapshot(snap));
  });

  it('serialize пишет ключи в порядке реестра И отвергает несортированный реестр (Fix 3, закон №8)', () => {
    // serializeComponents итерирует registry КАК ДАН, но реестр обязан быть
    // отсортирован — теперь это проверяется и для инъецированного (assertRegistrySorted
    // в начале serialize/deserialize, Fix 3). Поэтому сырой Object.keys(components)
    // всегда следует за отсортированным реестром, а кривой реестр падает рано, а не
    // молча перезатирает колонку. Детерминизм хэша дополнительно защищён канонизатором
    // (сортирует ключи объектов).
    const w = createSimWorld(5 as Seed);
    const position = defineComponentT({ x: Types.f32 }, 32);
    const health = defineComponentT({ hp: Types.f32 }, 32);
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, position, e1);
    addComponent(w.ecs, health, e1);
    (position as unknown as { x: Float32Array }).x[e1] = 1;
    (health as unknown as { hp: Float32Array }).hp[e1] = 2;
    const sorted: ComponentMeta[] = [
      { name: 'health', ref: health, fields: ['hp'] },
      { name: 'position', ref: position, fields: ['x'] },
    ];
    const snap = serialize(w, sorted);
    // Реестр отсортирован → ключи components в том же порядке.
    expect(Object.keys(snap.components)).toEqual(['health', 'position']);
    // Несортированный инъецированный реестр → ранний throw (defensive, не тихая колонка).
    const unsorted: ComponentMeta[] = [sorted[1] as ComponentMeta, sorted[0] as ComponentMeta];
    expect(() => serialize(w, unsorted)).toThrow(/не отсортирован/i);
    // Канон снапшота всё равно устойчив к порядку ключей (канонизатор сортирует).
    const permuted = { ...snap, components: reverseKeys(snap.components) };
    expect(canonicalize(permuted)).toBe(canonicalize(snap));
    expect(hashSnapshot(permuted)).toBe(hashSnapshot(snap));
  });

  it('порядок полей в колонке фиксирован meta.fields, не зависит от порядка записи полей', () => {
    // Записываем поля в порядке b,a — снапшот всё равно перечисляет их по meta.fields.
    const w = createSimWorld(1 as Seed);
    const ref = defineComponentT({ a: Types.f32, b: Types.ui32 }, 16);
    const c = ref as unknown as { a: Float32Array; b: Uint32Array };
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1);
    c.b[e1] = 9; // пишем b раньше a
    c.a[e1] = 1.5;
    const fieldsReversed: ComponentMeta[] = [{ name: 't', ref, fields: ['a', 'b'] }];
    const snap = serialize(w, fieldsReversed);
    const col = snap.components['t'] as unknown as { fields: Record<string, number[]> };
    // Канон объекта сортирует ключи, но контракт колонки — присутствие ровно a,b.
    expect(Object.keys(col.fields).sort()).toEqual(['a', 'b']);
    expect(col.fields['a']).toEqual([1.5]);
    expect(col.fields['b']).toEqual([9]);
  });
});

describe('ПРИЗРАК КОМПОНЕНТА при reuse eid (аналог C-6 для SoA-полей)', () => {
  it('D-024 ЗАКРЫТ: reuse eid — новый носитель без записи поля читает 0, покойник НЕ течёт в снапшот', () => {
    // Прямой аналог риска C-6, закрытого для ResourceStore через purgeEntity. Для
    // SoA-колонок purge при destroy НЕТ, зато addComponent ЗАНУЛЯЕТ поля носителя
    // на входе (D-024, единая точка чистки как D-008). Поэтому переиспользованный
    // eid, получивший компонент, стартует с нуля, а не с «холодного» значения мертвеца.
    const w = createSimWorld(1 as Seed);
    const ref = defineComponentT({ a: Types.f32, b: Types.ui32 }, 64);
    const c = ref as unknown as { a: Float32Array; b: Uint32Array };
    const dead = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, dead);
    c.a[dead] = 777; c.b[dead] = 888;
    destroyEntity(w, dead); // массив ВСЁ ЕЩЁ держит 777/888 (destroy не чистит SoA)

    const reborn = spawnEntity(w.ecs);
    expect(reborn).toBe(dead); // bitecs переиспользовал eid из freelist
    addComponent(w.ecs, ref, reborn); // НОВЫЙ носитель, поле НЕ записано → зануление
    // Фикс D-024: значения покойника НЕ просвечивают.
    expect(c.a[reborn]).toBe(0);
    expect(c.b[reborn]).toBe(0);

    // И в снапшот попадает чистый носитель — никакого значения из воздуха (закон №3).
    const registry: ComponentMeta[] = [{ name: 'g', ref, fields: ['a', 'b'] }];
    const snap = serialize(w, registry);
    const col = snap.components['g'] as unknown as { eids: number[]; fields: { a: number[]; b: number[] } };
    expect(col.eids).toEqual([reborn]);
    expect(col.fields.a).toEqual([0]);
    expect(col.fields.b).toEqual([0]);
  });

  it('КОНТРОЛЬ: если новый носитель ЗАПИСАЛ поле — призрака нет (дисциплина записи закрывает риск)', () => {
    const w = createSimWorld(1 as Seed);
    const ref = defineComponentT({ a: Types.f32, b: Types.ui32 }, 64);
    const c = ref as unknown as { a: Float32Array; b: Uint32Array };
    const dead = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, dead);
    c.a[dead] = 777; c.b[dead] = 888;
    destroyEntity(w, dead);
    const reborn = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, reborn);
    c.a[reborn] = 1; c.b[reborn] = 2; // полная инициализация полей
    const registry: ComponentMeta[] = [{ name: 'g', ref, fields: ['a', 'b'] }];
    const col = serialize(w, registry).components['g'] as unknown as { fields: { a: number[]; b: number[] } };
    expect(col.fields.a).toEqual([1]);
    expect(col.fields.b).toEqual([2]);
  });

  it('read-path чист: deserialize пишет ВСЕ поля из колонки, поэтому resume не наследует призрака', () => {
    // Даже если бы SoA-массив нёс мусор, deserializeComponents перезаписывает
    // каждое поле meta.fields из снапшота — восстановленный носитель не читает
    // старьё. Это структурная гарантия read-path (в отличие от write-path выше).
    const w = createSimWorld(1 as Seed);
    const ref = defineComponentT({ a: Types.f32, b: Types.ui32 }, 64);
    const c = ref as unknown as { a: Float32Array; b: Uint32Array };
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e1);
    c.a[e1] = 3.5; c.b[e1] = 4;
    const registry: ComponentMeta[] = [{ name: 'g', ref, fields: ['a', 'b'] }];
    const snap = serialize(w, registry);
    // Загрязняем глобальный массив «мусором» ДО deserialize — он должен затереться.
    c.a[e1] = 99999; c.b[e1] = 12321;
    const w2 = deserialize(snap, registry);
    expect(c.a[e1]).toBe(3.5); // затёрто значением из снапшота, мусор ушёл
    expect(c.b[e1]).toBe(4);
    expect(hashSnapshot(serialize(w2, registry))).toBe(hashSnapshot(snap));
  });
});
