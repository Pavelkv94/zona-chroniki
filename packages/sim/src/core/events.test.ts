/**
 * @module @zona/sim/core/events.test
 *
 * Юниты шины событий (задача 0.4, D-005): монотонность и детерминизм id,
 * сохранение causedBy, порядок лога = порядок публикации, двухфазная модель
 * буфер→endTick, изоляция at(tick)/drainSince, переживание eventSeq через
 * endTick (C-4), неизменяемость лога, интеграция bus↔world.tick.
 */

import { describe, it, expect } from 'vitest';
import type { EventId, Seed, SimEvent, Tick } from '@zona/shared';
import { createEventBus, type EventBus } from './events';
import { createSimWorld } from './world';

/**
 * Прогоняет фиксированную последовательность публикаций на свежей шине с
 * тиком, управляемым извне. Возвращает снятые id и итоговый лог — для сверки
 * двух прогонов на идентичность (детерминизм).
 */
function runSequence(): { ids: EventId[]; log: readonly unknown[] } {
  let tick: Tick = 0;
  const bus = createEventBus(() => tick);
  const ids: EventId[] = [];

  ids.push(
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } }),
  );
  const root = ids[0] as EventId;
  ids.push(
    bus.publish({ type: 'sim/snapshotTaken', causedBy: root, payload: { hash: 'a' } }),
  );
  bus.endTick(tick);

  tick = 1;
  ids.push(
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } }),
  );
  bus.endTick(tick);

  return { ids, log: bus.log };
}

describe('EventBus: монотонность и детерминизм id', () => {
  it('id монотонны, начинаются с 1', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    const a = bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    const b = bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'x' } });
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it('два прогона одной последовательности → идентичные id и лог', () => {
    const first = runSequence();
    const second = runSequence();
    expect(second.ids).toEqual(first.ids);
    expect(second.log).toEqual(first.log);
  });
});

describe('EventBus: causedBy', () => {
  it('null сохраняется для корня, id-родителя — для потомка', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    const root = bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    const child = bus.publish({ type: 'sim/snapshotTaken', causedBy: root, payload: { hash: 'h' } });
    bus.endTick(tick);

    const [ev0, ev1] = bus.log;
    expect(ev0?.causedBy).toBeNull();
    expect(ev1?.causedBy).toBe(root);
    expect(ev1?.id).toBe(child);
  });
});

describe('EventBus: порядок лога = порядок публикации', () => {
  it('фиксирует три события в порядке publish', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'a' } });
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'b' } });
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'c' } });
    bus.endTick(tick);
    const hashes = bus.log.map((e) => (e.type === 'sim/snapshotTaken' ? e.payload.hash : ''));
    expect(hashes).toEqual(['a', 'b', 'c']);
    expect(bus.log.map((e) => e.id)).toEqual([1, 2, 3]);
  });
});

describe('EventBus: буфер и endTick', () => {
  it('до endTick события не видны в log/at; после — видны', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    expect(bus.log).toHaveLength(0);
    expect(bus.at(0)).toHaveLength(0);

    bus.endTick(tick);
    expect(bus.log).toHaveLength(1);
    expect(bus.at(0)).toHaveLength(1);
  });

  it('повторный endTick без publish не дублирует лог', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    bus.endTick(tick);
    bus.endTick(tick);
    bus.endTick(tick);
    expect(bus.log).toHaveLength(1);
  });

  it('буфер очищается: события тика 0 не «протекают» в тик 1', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    bus.endTick(tick);
    tick = 1;
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    bus.endTick(tick);
    expect(bus.at(0)).toHaveLength(1);
    expect(bus.at(1)).toHaveLength(1);
    expect(bus.log).toHaveLength(2);
  });
});

describe('EventBus: at / drainSince', () => {
  const build = (): EventBus => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } }); // t0 id1
    bus.endTick(tick);
    tick = 1;
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } }); // t1 id2
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'q' } }); // t1 id3
    bus.endTick(tick);
    tick = 2;
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } }); // t2 id4
    bus.endTick(tick);
    return bus;
  };

  it('at(tick) изолирует конкретный тик', () => {
    const bus = build();
    expect(bus.at(0).map((e) => e.id)).toEqual([1]);
    expect(bus.at(1).map((e) => e.id)).toEqual([2, 3]);
    expect(bus.at(2).map((e) => e.id)).toEqual([4]);
    expect(bus.at(99)).toEqual([]);
  });

  it('drainSince(tick) возвращает всё с tick и позже в порядке id', () => {
    const bus = build();
    expect(bus.drainSince(1).map((e) => e.id)).toEqual([2, 3, 4]);
    expect(bus.drainSince(0).map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(bus.drainSince(2).map((e) => e.id)).toEqual([4]);
    expect(bus.drainSince(3)).toEqual([]);
  });
});

describe('EventBus: eventSeq (C-4)', () => {
  it('растёт монотонно и переживает endTick', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    expect(bus.eventSeq).toBe(0);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    expect(bus.eventSeq).toBe(1);
    bus.endTick(tick); // не сбрасывает счётчик
    expect(bus.eventSeq).toBe(1);
    tick = 1;
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    expect(bus.eventSeq).toBe(2);
    bus.endTick(tick);
    // id продолжает последовательность, а не начинается заново
    expect(bus.log.map((e) => e.id)).toEqual([1, 2]);
  });
});

describe('EventBus: append-only, лог не мутирует', () => {
  it('зафиксированное событие заморожено (запись в поле не проходит)', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    bus.endTick(tick);
    const ev = bus.log[0] as { id: number };
    expect(() => {
      'use strict';
      (ev as { id: number }).id = 999;
    }).toThrow();
    expect(bus.log[0]?.id).toBe(1);
  });

  it('новые публикации не переписывают прошлые записи', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'first' } });
    bus.endTick(tick);
    const before = bus.log[0];
    tick = 1;
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'second' } });
    bus.endTick(tick);
    expect(bus.log[0]).toBe(before);
    expect(bus.log[0]).toEqual(before);
  });
});

describe('EventBus: многотиковый сценарий (изоляция тиков)', () => {
  it('publish на 0/1/2 с endTick каждый: at изолирует тик, drainSince склеивает хвост, лог в порядке id', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);

    // Тик 0: одно событие.
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } }); // id1@t0
    bus.endTick(tick);
    // Тик 1: два события.
    tick = 1;
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } }); // id2@t1
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'x' } }); // id3@t1
    bus.endTick(tick);
    // Тик 2: одно событие.
    tick = 2;
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'y' } }); // id4@t2
    bus.endTick(tick);

    // Каждый at видит ТОЛЬКО свой тик — соседние тики не протекают.
    expect(bus.at(0).map((e) => e.id)).toEqual([1]);
    expect(bus.at(1).map((e) => e.id)).toEqual([2, 3]);
    expect(bus.at(2).map((e) => e.id)).toEqual([4]);

    // drainSince(1) = тики 1 и 2, без тика 0, в порядке id.
    expect(bus.drainSince(1).map((e) => e.id)).toEqual([2, 3, 4]);
    // Весь лог отсортирован по возрастанию id (= порядок публикации).
    expect(bus.log.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    // Тики в логе неубывающие.
    expect(bus.log.map((e) => e.tick)).toEqual([0, 1, 1, 2]);
  });
});

describe('EventBus: причинная цепочка A→B→C', () => {
  it('цепочку из трёх событий можно пройти назад по causedBy до корня', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    const a = bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    const b = bus.publish({ type: 'sim/snapshotTaken', causedBy: a, payload: { hash: 'B' } });
    const c = bus.publish({ type: 'sim/snapshotTaken', causedBy: b, payload: { hash: 'C' } });
    bus.endTick(tick);

    // Индекс id → событие для обхода цепочки.
    const byId = new Map(bus.log.map((e) => [e.id, e] as const));
    const evC = byId.get(c);
    expect(evC?.causedBy).toBe(b);
    const evB = byId.get(evC?.causedBy as EventId);
    expect(evB?.causedBy).toBe(a);
    const evA = byId.get(evB?.causedBy as EventId);
    expect(evA?.causedBy).toBeNull(); // достигли корня

    // Полная восстановленная цепочка причин C ← B ← A ← null.
    const chain: (EventId | null)[] = [];
    let cursor: EventId | null = c;
    while (cursor !== null) {
      chain.push(cursor);
      cursor = byId.get(cursor)?.causedBy ?? null;
    }
    expect(chain).toEqual([c, b, a]);
  });
});

describe('EventBus: тик «упал» посреди исполнения (нет endTick)', () => {
  it('опубликованное, но не зафиксированное событие не попадает в лог/at/drainSince; после endTick — появляется', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });

    // Симуляция «упала» до endTick — событие невидимо ни одним каналом чтения.
    expect(bus.log).toHaveLength(0);
    expect(bus.at(0)).toEqual([]);
    expect(bus.drainSince(0)).toEqual([]);
    // Но id уже выдан и счётчик сдвинут (переживёт сериализацию, C-4).
    expect(bus.eventSeq).toBe(1);

    // Тик доигран (или восстановлен) — фиксация делает событие видимым.
    bus.endTick(tick);
    expect(bus.log).toHaveLength(1);
    expect(bus.at(0).map((e) => e.id)).toEqual([1]);
  });
});

describe('EventBus: иммутабельность и утечка внутреннего массива', () => {
  it('at()/drainSince() отдают КОПИЮ: мутация результата не трогает лог', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    bus.endTick(tick);

    const snapAt = bus.at(0) as SimEvent[];
    const snapDrain = bus.drainSince(0) as SimEvent[];
    snapAt.length = 0;
    snapDrain.push({ id: 777 as EventId, tick: 0, type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'fake' } });

    // Лог остался цел — at/drainSince не выдали ссылку на внутренний массив.
    expect(bus.log.map((e) => e.id)).toEqual([1]);
    expect(bus.at(0).map((e) => e.id)).toEqual([1]);
  });

  // ГАРД (была находка QA, сер. средняя; закрыта в 0.4): геттер `log` отдаёт
  // КОПИЮ (`slice`), а не ссылку на внутренний массив. `readonly SimEvent[]` —
  // защита лишь на компиляции; в рантайме внешний push/pop/splice/reverse/sort
  // должен бить по копии и НЕ разрушать append-only лог и его порядок
  // (закон №8, D-005).
  it('log НЕ должен отдавать мутируемый внутренний массив', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    bus.endTick(tick);

    const lenBefore = bus.log.length;
    (bus.log as SimEvent[]).push({
      id: 999 as EventId, tick: 0, type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'INJECTED' },
    });
    // Инъекция НЕ должна была пройти — append-only.
    expect(bus.log.length).toBe(lenBefore);
  });

  it('порядок лога нельзя переставить снаружи (reverse/sort по внутреннему массиву)', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'z' } });
    bus.endTick(tick);

    (bus.log as SimEvent[]).reverse();
    // Порядок = порядок публикации, снаружи его менять нельзя (закон №8).
    expect(bus.log.map((e) => e.id)).toEqual([1, 2]);
  });

  // ГАРД (была находка QA, сер. низкая→средняя; закрыта в 0.4): freeze в publish
  // теперь ГЛУБОКИЙ — `payload` тоже заморожен, поэтому содержимое
  // зафиксированного события неизменяемо (append-only не только для «шапки»).
  // Летопись и снапшоты (0.5) строятся из payload — правка исказила бы историю.
  it('payload зафиксированного события должен быть неизменяем', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'orig' } });
    bus.endTick(tick);

    const ev = bus.log[0] as SimEvent & { payload: { hash: string } };
    try {
      (ev.payload as { hash: string }).hash = 'EVIL';
    } catch {
      /* strict-mode бросок — тоже приемлемая защита */
    }
    expect(ev.payload.hash).toBe('orig');
  });
});

describe('EventBus: граничные случаи', () => {
  const build = (): EventBus => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } }); // id1@t0
    bus.endTick(tick);
    tick = 3;
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } }); // id2@t3
    bus.endTick(tick);
    return bus;
  };

  it('at() на несуществующем тике = []', () => {
    expect(build().at(2)).toEqual([]); // между занятыми тиками 0 и 3
    expect(build().at(999)).toEqual([]);
  });

  it('drainSince() на будущем тике = []', () => {
    expect(build().drainSince(4)).toEqual([]);
  });

  it('drainSince(0) отдаёт весь лог', () => {
    expect(build().drainSince(0).map((e) => e.id)).toEqual([1, 2]);
  });

  it('endTick на пустом буфере ничего не делает (лог не меняется, повторно безопасно)', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.endTick(0); // буфер пуст с самого начала
    expect(bus.log).toEqual([]);
    expect(bus.eventSeq).toBe(0);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    bus.endTick(0);
    bus.endTick(0); // пустой буфер второй раз
    expect(bus.log.map((e) => e.id)).toEqual([1]);
  });

  it('at() пустой шины = []', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    expect(bus.at(0)).toEqual([]);
    expect(bus.drainSince(0)).toEqual([]);
  });
});

describe('EventBus: eventSeq независим от endTick', () => {
  it('после K publish (без endTick) eventSeq == K и продолжает расти на след. тике', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    const K = 5;
    for (let i = 0; i < K; i++) {
      bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: `h${i}` } });
    }
    // Ни одного endTick — но счётчик уже равен числу выданных id.
    expect(bus.eventSeq).toBe(K);
    expect(bus.log).toHaveLength(0); // при этом лог ещё пуст

    bus.endTick(tick);
    expect(bus.eventSeq).toBe(K); // фиксация счётчик не трогает

    tick = 1;
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick } });
    expect(bus.eventSeq).toBe(K + 1); // растёт дальше, без сброса
    bus.endTick(tick);
    // id непрерывны через границу тика.
    expect(bus.log.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('EventBus: детерминизм двух независимых миров', () => {
  it('одинаковая программа publish/endTick → идентичные (id,tick,type,causedBy)', () => {
    const program = (): { id: EventId; tick: Tick; type: string; causedBy: EventId | null }[] => {
      let tick: Tick = 0;
      const bus = createEventBus(() => tick);
      for (let t = 0; t < 4; t++) {
        tick = t as Tick;
        const root = bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: t } });
        bus.publish({ type: 'sim/snapshotTaken', causedBy: root, payload: { hash: `h${t}` } });
        bus.endTick(t);
      }
      return bus.log.map((e) => ({ id: e.id, tick: e.tick, type: e.type, causedBy: e.causedBy }));
    };
    expect(program()).toEqual(program());
  });
});

describe('EventBus: tick захватывается на publish; endTick сверяет целостность', () => {
  // `tick` события берётся из мира в МОМЕНТ publish. endTick(tick) — инвариант
  // целостности: все события буфера обязаны иметь ровно этот tick, иначе бросок
  // (ловит рассинхрон планировщика 0.2 — публикацию без endTick между тиками).
  it('endTick(tick) с чужим tick в буфере → бросок', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 } }); // tick 0
    tick = 1;
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'q' } }); // tick 1
    // Буфер содержит tick 0 и 1 — рассинхрон. Любой аргумент endTick не совпадёт
    // с частью буфера.
    expect(() => bus.endTick(1)).toThrow(/endTick/);
  });

  it('endTick(tick) с аргументом, не равным тику публикаций, → бросок', () => {
    let tick: Tick = 5;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 5 } });
    expect(() => bus.endTick(6)).toThrow(/tick=5/);
  });

  it('корректный цикл publish→endTick на каждом тике проходит без броска', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 } });
    bus.endTick(0);
    tick = 1;
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'q' } });
    bus.endTick(1);
    expect(bus.log.map((e) => e.tick)).toEqual([0, 1]);
  });
});

describe('EventBus: восстановление из снапшота (init, C-4, seam для 0.5)', () => {
  it('init.eventSeq продолжает последовательность id без коллизий', () => {
    let tick: Tick = 10;
    const bus = createEventBus(() => tick, { eventSeq: 42 });
    const id = bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 10 } });
    expect(id).toBe(43);
    expect(bus.eventSeq).toBe(43);
  });

  it('init.log восстанавливает историю; новые события append-ятся следом', () => {
    // Сначала «живая» шина накапливает лог.
    let tick: Tick = 0;
    const src = createEventBus(() => tick);
    src.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 } });
    src.endTick(0);
    tick = 1;
    src.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'h1' } });
    src.endTick(1);
    const savedLog = src.log;
    const savedSeq = src.eventSeq;

    // Восстанавливаем в новую шину.
    let t2: Tick = 1;
    const restored = createEventBus(() => t2, { log: savedLog, eventSeq: savedSeq });
    expect(restored.log.map((e) => e.id)).toEqual([1, 2]);
    expect(restored.at(0).map((e) => e.id)).toEqual([1]);
    expect(restored.drainSince(1).map((e) => e.id)).toEqual([2]);

    // Новое событие продолжает id без коллизии с восстановленными.
    t2 = 2;
    const id = restored.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 2 } });
    expect(id).toBe(3);
    restored.endTick(2);
    expect(restored.log.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('восстановленный лог так же неизменяем: события заморожены, геттер — копия', () => {
    let tick: Tick = 0;
    const src = createEventBus(() => tick);
    src.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'orig' } });
    src.endTick(0);

    const restored = createEventBus(() => tick, { log: src.log, eventSeq: src.eventSeq });
    const ev = restored.log[0] as SimEvent & { payload: { hash: string } };
    expect(() => {
      (ev.payload as { hash: string }).hash = 'EVIL';
    }).toThrow();
    expect(restored.log[0]?.payload).toEqual({ hash: 'orig' });

    // Геттер отдаёт копию — внешний push не портит внутренний лог.
    (restored.log as SimEvent[]).push({
      id: 9 as EventId, tick: 0, type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'x' },
    });
    expect(restored.log).toHaveLength(1);
  });
});

describe('EventBus: discardTick (атомарность тика, аддитивно к 0.4)', () => {
  it('отбрасывает буфер без коммита: лог не меняется, at пуст', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 } });
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'x' } });
    bus.discardTick();
    expect(bus.log).toHaveLength(0);
    expect(bus.at(0)).toEqual([]);
  });

  it('eventSeq НЕ откатывается — id отброшенных событий сгорают (пропуски допустимы, C-4)', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 } }); // id1
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'x' } }); // id2
    bus.discardTick();
    expect(bus.eventSeq).toBe(2); // счётчик не откатан
    // Следующая публикация продолжает id с 3 — монотонность/уникальность целы,
    // но 1 и 2 «сгорели» (непрерывность не гарантируется).
    const id = bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 } });
    expect(id).toBe(3);
    bus.endTick(0);
    expect(bus.log.map((e) => e.id)).toEqual([3]); // единственное закоммиченное
  });

  it('идемпотентен на пустом буфере; не трогает уже закоммиченный лог', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 } });
    bus.endTick(0); // закоммитили id1
    bus.discardTick(); // буфер уже пуст
    bus.discardTick();
    expect(bus.log.map((e) => e.id)).toEqual([1]); // лог цел
  });

  it('discard одного тика не мешает коммиту следующего', () => {
    let tick: Tick = 0;
    const bus = createEventBus(() => tick);
    bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 } });
    bus.discardTick(); // тик 0 отброшен целиком
    tick = 1;
    bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: 'y' } });
    bus.endTick(1);
    expect(bus.log.map((e) => e.tick)).toEqual([1]);
    expect(bus.at(0)).toEqual([]);
  });
});

describe('createSimWorld: интеграция bus ↔ world.tick', () => {
  it('bus присутствует в мире', () => {
    const world = createSimWorld(42 as Seed);
    expect(world.bus).toBeDefined();
    expect(typeof world.bus.publish).toBe('function');
  });

  it('publish берёт tick из текущего world.tick', () => {
    const world = createSimWorld(42 as Seed);
    world.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: world.tick } });
    world.bus.endTick(world.tick);

    world.tick = 7; // планировщик продвинул время
    world.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: world.tick } });
    world.bus.endTick(world.tick);

    expect(world.bus.at(0).map((e) => e.id)).toEqual([1]);
    expect(world.bus.at(7).map((e) => e.id)).toEqual([2]);
    expect(world.bus.log[1]?.tick).toBe(7);
  });

  it('два мира с одним seed → идентичная последовательность id/tick', () => {
    const publishOn = (): readonly [number, number][] => {
      const w = createSimWorld(1 as Seed);
      const out: [number, number][] = [];
      for (let t = 0; t < 3; t++) {
        w.tick = t;
        const idA = w.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: t } });
        const idB = w.bus.publish({ type: 'sim/snapshotTaken', causedBy: idA, payload: { hash: `h${t}` } });
        out.push([idA, w.tick], [idB, w.tick]);
        w.bus.endTick(t);
      }
      return out;
    };
    expect(publishOn()).toEqual(publishOn());
  });
});
