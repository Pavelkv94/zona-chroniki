/**
 * Юниты ЧИСТОЙ ЛОГИКИ нарративного слоя карты (задача 4.7): затухание черепа (игровой
 * tick), стопка смертей, вспышка боя из окна лога, очередь радио-тостов (wall-clock,
 * мок-время, без наложений), центрирование слежения, тултип (имя/вид + задача). Всё —
 * детерминированные функции над логом/видом: тестируются БЕЗ DOM/canvas/воркера.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EntityName, EntityView, EventId, LocationId, SimEvent, Tick } from '@zona/shared';
import { makeTemplateId } from '@zona/sim';
import {
  skullAlpha,
  collectDeathMarkers,
  collectCombatFlashes,
  buildRadioToasts,
  enqueueToasts,
  stepToastQueue,
  visibleToasts,
  maxEventId,
  followOffset,
  tooltipLabel,
  EMPTY_TOAST_QUEUE,
} from './overlays';
import type { ToastQueue } from './overlays';

const DAY = 1440; // TICKS_PER_DAY (mirror; функции берут его параметром)

// ── Фабрики событий (branded-типы кастуем — форма важна, не бренд) ────────────
let seq = 0;
function died(eid: number, tick: number, id = ++seq): SimEvent {
  return {
    id: id as EventId,
    tick: tick as Tick,
    type: 'entity/died',
    causedBy: null,
    payload: { eid: eid as EntityId, cause: 'combat' },
  };
}
function corpse(eid: number, loc: number, tick: number, id = ++seq): SimEvent {
  return {
    id: id as EventId,
    tick: tick as Tick,
    type: 'corpse/created',
    causedBy: null,
    payload: { eid: eid as EntityId, loc: loc as LocationId, items: [] },
  };
}
function encounter(loc: number, tick: number, id = ++seq): SimEvent {
  return {
    id: id as EventId,
    tick: tick as Tick,
    type: 'encounter/started',
    causedBy: null,
    payload: { sides: [[1 as EntityId], [2 as EntityId]], loc: loc as LocationId },
  };
}
function radio(
  speakerEid: number,
  loc: number | undefined,
  id: number,
  tick = 100,
  over: { templateId?: string; params?: Record<string, unknown> } = {},
): SimEvent {
  return {
    id: id as EventId,
    tick: tick as Tick,
    type: 'radio/message',
    causedBy: null,
    payload: {
      speakerEid: speakerEid as EntityId,
      subjects: [],
      ...(loc !== undefined ? { loc: loc as LocationId } : {}),
      templateId: over.templateId ?? 'bogus', // 'bogus' → renderMessage даёт фолбэк-строку (текст неважен для очереди)
      params: (over.params ?? {}) as never,
      isFirsthand: true,
    },
  };
}

/** Слух (`radio/relayed`) — ретрансляция услышанного; в ТОСТЫ не берётся (только личная озвучка). */
function relayed(speakerEid: number, loc: number, id: number, tick = 100): SimEvent {
  return {
    id: id as EventId,
    tick: tick as Tick,
    type: 'radio/relayed',
    causedBy: null,
    payload: {
      speakerEid: speakerEid as EntityId,
      subjects: [],
      loc: loc as LocationId,
      sourceMessageId: 1 as EventId,
      hop: 1,
      templateId: 'bogus',
      params: {} as never,
      isFirsthand: false,
    },
  };
}

describe('skullAlpha — затухание черепа за ИГРОВЫЕ сутки', () => {
  it('t=0 → 1 (только что умер)', () => {
    expect(skullAlpha(1000, 1000, DAY)).toBe(1);
  });
  it('t=сутки → 0 (исчез ровно через сутки)', () => {
    expect(skullAlpha(1000, 1000 + DAY, DAY)).toBe(0);
  });
  it('t>сутки → 0 (черепа нет)', () => {
    expect(skullAlpha(1000, 1000 + DAY + 500, DAY)).toBe(0);
  });
  it('середина суток → ~0.5', () => {
    expect(skullAlpha(1000, 1000 + DAY / 2, DAY)).toBeCloseTo(0.5, 6);
  });
  it('будущая смерть (age<0) → 0 (робастность)', () => {
    expect(skullAlpha(2000, 1000, DAY)).toBe(0);
  });
  it('за тик до суток (age=сутки−1) → ещё виден (>0)', () => {
    expect(skullAlpha(1000, 1000 + DAY - 1, DAY)).toBeGreaterThan(0);
    expect(skullAlpha(1000, 1000 + DAY - 1, DAY)).toBeLessThan(0.01);
  });
});

describe('collectDeathMarkers — черепа из окна лога', () => {
  const locOfNone = (): number | null => null;

  it('смерть с парным corpse/created → череп на узле смерти, alpha от tick', () => {
    const log = [died(10, 5000, 1), corpse(10, 3, 5000, 2)];
    const m = collectDeathMarkers(log, 5000, DAY, locOfNone);
    expect(m).toHaveLength(1);
    expect(m[0]!.loc).toBe(3);
    expect(m[0]!.count).toBe(1);
    expect(m[0]!.alpha).toBe(1);
  });

  it('несколько смертей на узле → стопка count, alpha от САМОЙ СВЕЖЕЙ', () => {
    const log = [
      died(10, 5000, 1),
      corpse(10, 3, 5000, 2),
      died(11, 5000 + DAY / 2, 3),
      corpse(11, 3, 5000 + DAY / 2, 4),
    ];
    const now = 5000 + DAY / 2;
    const m = collectDeathMarkers(log, now, DAY, locOfNone);
    expect(m).toHaveLength(1);
    expect(m[0]!.count).toBe(2);
    expect(m[0]!.alpha).toBe(1); // свежая смерть в now → alpha 1
  });

  it('смерть старше суток → череп исчез (не в списке)', () => {
    const log = [died(10, 1000, 1), corpse(10, 3, 1000, 2)];
    const m = collectDeathMarkers(log, 1000 + DAY + 1, DAY, locOfNone);
    expect(m).toHaveLength(0);
  });

  it('нет corpse/created → loc берётся из fallback locOf (позиция трупа)', () => {
    const log = [died(10, 5000, 1)];
    const m = collectDeathMarkers(log, 5000, DAY, (eid) => (eid === 10 ? 7 : null));
    expect(m).toHaveLength(1);
    expect(m[0]!.loc).toBe(7);
  });

  it('локация не восстановима (нет corpse, fallback null) → череп пропущен', () => {
    const log = [died(10, 5000, 1)];
    expect(collectDeathMarkers(log, 5000, DAY, locOfNone)).toHaveLength(0);
  });

  it('corpse/created — АВТОРИТЕТНЫЙ источник места смерти (перекрывает fallback locOf)', () => {
    // Труп сдвинулся во WorldView (locOf=99), но место СМЕРТИ несёт corpse/created (loc 3).
    const log = [died(10, 5000, 1), corpse(10, 3, 5000, 2)];
    const m = collectDeathMarkers(log, 5000, DAY, () => 99);
    expect(m).toHaveLength(1);
    expect(m[0]!.loc).toBe(3); // место смерти, а не текущая позиция трупа
  });

  it('смерть РОВНО в границе суток (age=сутки) → череп исчез (полуинтервал)', () => {
    const log = [died(10, 1000, 1), corpse(10, 3, 1000, 2)];
    // Ровно через сутки alpha=0 → маркера нет (граница включена в «исчез»).
    expect(collectDeathMarkers(log, 1000 + DAY, DAY, locOfNone)).toHaveLength(0);
  });

  it('сорт. по loc (детерминизм)', () => {
    const log = [
      died(1, 5000, 1),
      corpse(1, 5, 5000, 2),
      died(2, 5000, 3),
      corpse(2, 1, 5000, 4),
    ];
    const m = collectDeathMarkers(log, 5000, DAY, locOfNone);
    expect(m.map((x) => x.loc)).toEqual([1, 5]);
  });
});

describe('collectCombatFlashes — вспышка боя из окна лога', () => {
  it('свежий encounter/started (в окне) → активная вспышка на узле', () => {
    const f = collectCombatFlashes([encounter(4, 1000, 1)], 1010, 45);
    expect(f).toHaveLength(1);
    expect(f[0]!.loc).toBe(4);
    expect(f[0]!.startTick).toBe(1000);
  });

  it('старый бой (за окном flashTicks) → вспышки нет', () => {
    const f = collectCombatFlashes([encounter(4, 1000, 1)], 1000 + 45, 45);
    expect(f).toHaveLength(0);
  });

  it('несколько боёв на узле → один флаг, tick самого свежего', () => {
    const f = collectCombatFlashes([encounter(4, 1000, 1), encounter(4, 1020, 2)], 1030, 45);
    expect(f).toHaveLength(1);
    expect(f[0]!.startTick).toBe(1020);
  });

  it('бои на разных узлах → сорт. по loc', () => {
    const f = collectCombatFlashes([encounter(6, 1000, 1), encounter(2, 1000, 2)], 1010, 45);
    expect(f.map((x) => x.loc)).toEqual([2, 6]);
  });
});

describe('очередь радио-тостов — wall-clock, без наложений (мок-время)', () => {
  const names: Record<number, EntityName> = {};

  it('buildRadioToasts: только radio/message с id > sinceId', () => {
    const log = [radio(1, 3, 10), radio(2, 4, 11), encounter(4, 100, 12)];
    const built = buildRadioToasts(log, names, 10); // строго выше 10
    expect(built.map((t) => t.id)).toEqual([11]);
    expect(built[0]!.loc).toBe(4);
    expect(built[0]!.speakerEid).toBe(2);
    expect(typeof built[0]!.text).toBe('string');
  });

  it('buildRadioToasts: слух radio/relayed в тосты НЕ берётся (тост — только личная озвучка)', () => {
    // В окне лога и личное сообщение (id 20), и слух-пересказ (id 21) — тост даёт лишь личное.
    const log = [radio(1, 3, 20), relayed(2, 4, 21)];
    const built = buildRadioToasts(log, names, -1);
    expect(built.map((t) => t.id)).toEqual([20]);
  });

  it('buildRadioToasts: событие БЕЗ loc → toast.loc === null (плашка без узла)', () => {
    const built = buildRadioToasts([radio(1, undefined, 30)], names, -1);
    expect(built).toHaveLength(1);
    expect(built[0]!.loc).toBeNull();
  });

  it('buildRadioToasts: реальный шаблон+names → строка с ИМЕНЕМ (renderMessage), без «{плейсхолдеров}»', () => {
    // "Минус {subject}. {loc}." — субъект-eid резолвится в кличку из кэша имён.
    const named: Record<number, EntityName> = { 7: { first: 'Иван', last: 'Петров', nickname: 'Меченый' } };
    const ev = radio(1, 0, 40, 100, {
      templateId: makeTemplateId('entity/died', 'neutral', 1),
      params: { subject: 7, loc: 0 },
    });
    const built = buildRadioToasts([ev], named, -1);
    expect(built).toHaveLength(1);
    expect(built[0]!.text).toContain('Меченый'); // имя подставлено через ctx.nameOf
    expect(built[0]!.text).not.toContain('{'); // ни один плейсхолдер не утёк в текст
  });

  it('enqueueToasts: две порции сохраняют FIFO-порядок, ничего не теряется', () => {
    let q = EMPTY_TOAST_QUEUE;
    q = enqueueToasts(q, buildRadioToasts([radio(1, 3, 1), radio(2, 4, 2)], names, q.lastId));
    q = enqueueToasts(q, buildRadioToasts([radio(3, 5, 3), radio(4, 6, 4)], names, q.lastId));
    // Все 4 в очереди, строго по порядку прихода (лог → хвост), водомер на максимуме.
    expect(q.items.map((t) => t.id)).toEqual([1, 2, 3, 4]);
    expect(q.lastId).toBe(4);
  });

  it('enqueueToasts: дедуп по id-водомеру (двигает lastId, не переигрывает старое)', () => {
    let q = EMPTY_TOAST_QUEUE;
    q = enqueueToasts(q, buildRadioToasts([radio(1, 3, 5)], names, q.lastId));
    expect(q.items).toHaveLength(1);
    expect(q.lastId).toBe(5);
    // Повторный тот же лог — ничего не добавит (id 5 <= lastId 5).
    q = enqueueToasts(q, buildRadioToasts([radio(1, 3, 5)], names, q.lastId));
    expect(q.items).toHaveLength(1);
  });

  it('stepToastQueue: запускает таймеры до maxVisible; истёкшие снимает', () => {
    let q = EMPTY_TOAST_QUEUE;
    q = enqueueToasts(q, [
      { id: 1, loc: 3, speakerEid: 1, text: 'a', shownAt: null },
      { id: 2, loc: 3, speakerEid: 1, text: 'b', shownAt: null },
      { id: 3, loc: 3, speakerEid: 1, text: 'c', shownAt: null },
    ]);
    // t=0: показываем не больше maxVisible=2 (без наложения — третий ждёт).
    q = stepToastQueue(q, 0, { durationMs: 3000, maxVisible: 2 });
    expect(visibleToasts(q).map((t) => t.id)).toEqual([1, 2]);

    // t=1000: те же два видимы (3 сек не прошли), третий всё ждёт.
    q = stepToastQueue(q, 1000, { durationMs: 3000, maxVisible: 2 });
    expect(visibleToasts(q).map((t) => t.id)).toEqual([1, 2]);

    // t=3000: первые два истекли (>=3000 с shownAt=0) → сняты; третий встаёт (слот освободился).
    q = stepToastQueue(q, 3000, { durationMs: 3000, maxVisible: 2 });
    expect(q.items.map((t) => t.id)).toEqual([3]);
    expect(visibleToasts(q).map((t) => t.id)).toEqual([3]);

    // t=6000: третий истёк → очередь пуста.
    q = stepToastQueue(q, 6000, { durationMs: 3000, maxVisible: 2 });
    expect(q.items).toHaveLength(0);
  });

  it('stepToastQueue: без изменений возвращает ТУ ЖЕ ссылку (нет лишних ре-рендеров)', () => {
    let q = EMPTY_TOAST_QUEUE;
    q = enqueueToasts(q, [{ id: 1, loc: null, speakerEid: 1, text: 'a', shownAt: null }]);
    const after = stepToastQueue(q, 0, { durationMs: 3000, maxVisible: 2 });
    const again = stepToastQueue(after, 500, { durationMs: 3000, maxVisible: 2 });
    expect(again).toBe(after); // ничего не истекло, новых не запущено
  });

  it('maxEventId: наибольшая id в окне (или -1 для пустого)', () => {
    expect(maxEventId([])).toBe(-1);
    expect(maxEventId([radio(1, 3, 7), radio(2, 4, 42), radio(3, 5, 12)])).toBe(42);
  });
});

describe('followOffset — центрирование слежения', () => {
  it('сдвиг центрирует цель: target + offset === center', () => {
    const target = { x: 200, y: 150 };
    const center = { x: 400, y: 300 };
    const off = followOffset(target, center);
    expect(off).toEqual({ x: 200, y: 150 });
    expect(target.x + off.x).toBe(center.x);
    expect(target.y + off.y).toBe(center.y);
  });
  it('цель уже в центре → нулевой сдвиг', () => {
    expect(followOffset({ x: 400, y: 300 }, { x: 400, y: 300 })).toEqual({ x: 0, y: 0 });
  });
});

describe('tooltipLabel — имя/вид + текущая задача', () => {
  const KIND: Record<string, string> = { human: 'человек', animal: 'зверь', corpse: 'труп' };
  const TASK = ['спит', 'ест', 'пьёт'];
  const mk = (over: Partial<EntityView>): EntityView => ({
    eid: 1 as EntityId,
    kind: 'human',
    faction: null,
    loc: 1 as LocationId,
    dest: null,
    etaTicks: 0,
    hpFrac: 1,
    task: null,
    inCombat: false,
    carrying: false,
    alive: true,
    ...over,
  });

  it('человек с именем в кэше → ИМЯ + задача', () => {
    const names: Record<number, EntityName> = { 1: { first: 'Иван', last: 'Петров', nickname: '' } };
    expect(tooltipLabel(mk({ task: 1 }), names, KIND, TASK)).toBe('Иван Петров · ест');
  });
  it('человек с кличкой → кличка вместо имени', () => {
    const names: Record<number, EntityName> = { 1: { first: 'Иван', last: 'Петров', nickname: 'Меченый' } };
    expect(tooltipLabel(mk({}), names, KIND, TASK)).toBe('Меченый');
  });
  it('человек без записи в кэше → откат на вид', () => {
    expect(tooltipLabel(mk({ task: 0 }), {}, KIND, TASK)).toBe('человек · спит');
  });
  it('зверь → вид + задача (имени нет)', () => {
    expect(tooltipLabel(mk({ eid: 2 as EntityId, kind: 'animal', task: 2 }), {}, KIND, TASK)).toBe('зверь · пьёт');
  });
  it('труп → просто «труп» (без задачи)', () => {
    expect(tooltipLabel(mk({ kind: 'corpse', task: null, alive: false }), {}, KIND, TASK)).toBe('труп');
  });
});

describe('чистота оверлеев (закон №8): сборщики ЧИТАЮТ лог, не мутируют его', () => {
  it('collectDeathMarkers/collectCombatFlashes не трогают входной лог (frozen проходит)', () => {
    // Object.freeze поймает любую попытку мутировать массив/элементы (strict-mode throw).
    const log = Object.freeze([
      died(10, 5000, 1),
      corpse(10, 3, 5000, 2),
      encounter(4, 5000, 3),
    ]) as readonly SimEvent[];
    const snapshot = JSON.stringify(log);
    collectDeathMarkers(log, 5000, DAY, () => null);
    collectCombatFlashes(log, 5010, 45);
    // Лог не изменился ни по ссылке-содержимому (frozen), ни по значению.
    expect(JSON.stringify(log)).toBe(snapshot);
  });

  it('stepToastQueue не мутирует переданное состояние очереди (возвращает новое)', () => {
    const state: ToastQueue = {
      items: [{ id: 1, loc: 3, speakerEid: 1, text: 'a', shownAt: null }],
      lastId: 1,
    };
    const before = JSON.stringify(state);
    const next = stepToastQueue(state, 0, { durationMs: 3000, maxVisible: 2 });
    expect(JSON.stringify(state)).toBe(before); // исходное состояние нетронуто
    expect(next).not.toBe(state); // запуск таймера → новая ссылка
    expect(next.items[0]!.shownAt).toBe(0);
  });
});
