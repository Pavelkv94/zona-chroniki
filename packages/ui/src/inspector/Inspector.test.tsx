// @vitest-environment jsdom
/**
 * @module @zona/ui/inspector/Inspector.test
 *
 * jsdom-тесты ИНСПЕКТОРА СУЩНОСТИ (задача 4.5, D-076). Читается как «наблюдатель кликнул
 * NPC и видит его нутро»: шапка/нужды/задача/инвентарь/память/отношения/недавние события.
 * Под прицелом:
 *  - detail===null → подсказка (нет выбора).
 *  - Все секции рендерятся из фиксированного `EntityDetail` (мок стора через setState).
 *  - ПАМЯТЬ: subject-резолв (e:→имя из name-map, f:→фракция), salience, метка лично/слух.
 *  - ОТНОШЕНИЯ: цвет/знак по value (враг −, союзник +).
 *  - ЗАДАЧА: код TaskKind → человекочитаемая подпись.
 *  - НЕДАВНИЕ: radio-событие → текст renderMessage; иное → подпись типа; вне лога → #id.
 *  - Клик «закрыть» → clearSelection (detail и selectedEid обнулены).
 *  - Чистые хелперы (taskLabel/resolveSubject/resolveRecentEvent) — без DOM.
 *
 * Живой воркер НЕ поднимается: состояние стора выставляется напрямую (setState), как в
 * store.test/RadioLog.test. renderMessage/getLocation/parseSubject — публичное чтение @zona/sim.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { EntityDetail, EntityId, EntityName, EventId, ItemId, LocationId, SimEvent, Tick } from '@zona/shared';
import Inspector, { taskLabel, kindLabel, resolveSubject, resolveRecentEvent, dayOf } from './Inspector';
import { useUiStore } from '../store/store';

const NAMES: Record<number, EntityName> = {
  5: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' },
  7: { first: 'Иван', last: 'Сорока', nickname: '' },
};

/** Полный EntityDetail для человека (все секции наполнены). */
function human(over: Partial<EntityDetail> = {}): EntityDetail {
  return {
    eid: 5 as EntityId,
    kind: 'human',
    faction: 'loners' as unknown as EntityDetail['faction'],
    name: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' },
    loc: 1 as LocationId,
    needs: { hunger: 40, thirst: 20, fatigue: 60, fear: 0 },
    hp: 85,
    task: { kind: 4, targetEid: 7 as EntityId }, // HUNT, цель — Сорока
    inventory: [['bread' as ItemId, 3]],
    money: 120,
    memory: [
      { kind: 'robbed', subject: 'e:7', salience: 0.9, tick: 1440, causeEvent: 42, isFirsthand: true },
      { kind: 'seen', subject: 'f:bandits', salience: 0.3, tick: 100, causeEvent: 0, isFirsthand: false },
    ],
    relations: [
      ['e:7', -0.6] as EntityDetail['relations'][number],
      ['f:loners', 0.4] as EntityDetail['relations'][number],
    ],
    fame: 12,
    recentEvents: [42 as EventId, 99 as EventId],
    ...over,
  };
}

/** Радио-сообщение для окна лога (недавнее событие id=42). */
function radioEvent(id: number): SimEvent {
  return {
    id: id as never,
    tick: 2 as Tick,
    type: 'radio/message',
    causedBy: null,
    payload: {
      speakerEid: 5 as EntityId,
      subjects: [],
      loc: 1 as LocationId,
      templateId: 'entity/died|neutral|0',
      params: { subject: 7, loc: 1 },
      isFirsthand: true,
    },
  } as SimEvent;
}

/** Не-радио событие (encounter/started) для окна лога id=99. */
function combatEvent(id: number): SimEvent {
  return {
    id: id as never,
    tick: 2 as Tick,
    type: 'encounter/started',
    causedBy: null,
    payload: { loc: 1 as LocationId, sides: [[5 as EntityId], [7 as EntityId]] },
  } as SimEvent;
}

/** Ретранслированный слух (radio/relayed) — тоже раскручивается через renderMessage. */
function relayedEvent(id: number): SimEvent {
  return {
    id: id as never,
    tick: 3 as Tick,
    type: 'radio/relayed',
    causedBy: null,
    payload: {
      speakerEid: 5 as EntityId,
      subjects: [],
      loc: 1 as LocationId,
      sourceMessageId: 42 as EventId,
      hop: 1,
      templateId: 'entity/died|neutral|0',
      params: { subject: 7, loc: 1 },
      isFirsthand: false,
    },
  } as SimEvent;
}

/** Событие с известной подписью типа (EVENT_LABEL[entity/died] = «гибель»). */
function deathEvent(id: number): SimEvent {
  return {
    id: id as never,
    tick: 2 as Tick,
    type: 'entity/died',
    causedBy: null,
    payload: { eid: 7 as EntityId, cause: 'combat' },
  } as SimEvent;
}

/** Событие без записи в EVENT_LABEL — фолбэк резолва отдаёт сам `type`. */
function unlabeledEvent(id: number): SimEvent {
  return {
    id: id as never,
    tick: 1 as Tick,
    type: 'sim/tickStarted',
    causedBy: null,
    payload: { tick: 1 as Tick },
  } as SimEvent;
}

function setStore(detail: EntityDetail | null, log: SimEvent[] = [], names = NAMES): void {
  useUiStore.setState({ detail, log, names, selectedEid: detail ? detail.eid : null });
}

beforeEach(() => {
  setStore(null);
});
afterEach(() => {
  cleanup();
  useUiStore.setState({ detail: null, log: [], names: {}, selectedEid: null });
});

// ── Чистые хелперы (без DOM) ──────────────────────────────────────────────────
describe('чистые хелперы', () => {
  it('taskLabel: код TaskKind → подпись; неизвестный → «код N»', () => {
    expect(taskLabel(4)).toBe('охота'); // HUNT
    expect(taskLabel(0)).toBe('сон'); // SLEEP
    expect(taskLabel(9)).toBe('грабёж'); // ROB
    expect(taskLabel(999)).toBe('код 999');
  });

  it('kindLabel: вид сущности → русская подпись; неизвестный — сам код', () => {
    expect(kindLabel('human')).toBe('сталкер');
    expect(kindLabel('corpse')).toBe('труп');
    expect(kindLabel('mutant')).toBe('mutant'); // append-only union → проброс
  });

  it('resolveSubject: e:<eid> → имя (кличка/Имя Фамилия/#eid), f:<faction> → фракция', () => {
    expect(resolveSubject('e:5', NAMES)).toBe('Лис'); // кличка приоритетнее
    expect(resolveSubject('e:7', NAMES)).toBe('Иван Сорока'); // нет клички
    expect(resolveSubject('e:404', NAMES)).toBe('#404'); // нет в name-map
    expect(resolveSubject('f:bandits', NAMES)).toBe('фракция bandits');
  });

  it('taskLabel: КАЖДЫЙ TaskKind (0..10) → человекочитаемо, не «код N»', () => {
    // Полный охват фазовых кодов задач: наблюдатель не должен видеть сырое «код N».
    const expected: Record<number, string> = {
      0: 'сон', // SLEEP
      1: 'еда', // EAT
      2: 'водопой', // DRINK
      3: 'собирательство', // FORAGE
      4: 'охота', // HUNT
      5: 'отдых', // REST
      6: 'бегство', // FLEE
      7: 'работа', // WORK
      8: 'торговля', // TRADE
      9: 'грабёж', // ROB
      10: 'поиск артефакта', // SEARCH
    };
    for (const [code, label] of Object.entries(expected)) {
      expect(taskLabel(Number(code))).toBe(label);
      expect(taskLabel(Number(code))).not.toMatch(/^код /); // ни один код не «сырой»
    }
    // Границы неизвестного диапазона → фолбэк «код N» (робастность к append-only).
    expect(taskLabel(11)).toBe('код 11');
    expect(taskLabel(-1)).toBe('код -1');
  });

  it('resolveRecentEvent: radio → renderMessage; иное → подпись типа; вне лога → #id', () => {
    const log = [radioEvent(42), combatEvent(99)];
    const radioText = resolveRecentEvent(42, log, NAMES);
    expect(radioText.startsWith('«')).toBe(true); // текст реплики в кавычках
    expect(radioText).toContain('погиб'); // из шаблона entity/died|neutral|0
    expect(resolveRecentEvent(99, log, NAMES)).toBe('столкновение'); // подпись типа
    expect(resolveRecentEvent(7, log, NAMES)).toBe('событие #7'); // вытеснено из окна
  });

  it('resolveRecentEvent: слух (radio/relayed) тоже раскручивается в текст реплики', () => {
    // Пересказ (D-073) несёт templateId/params как radio/message → renderMessage читает его.
    const relayText = resolveRecentEvent(50, [relayedEvent(50)], NAMES);
    expect(relayText.startsWith('«')).toBe(true);
    expect(relayText).toContain('погиб');
  });

  it('resolveRecentEvent: известный тип → подпись из EVENT_LABEL; неизвестный → сам type', () => {
    const log = [deathEvent(70), unlabeledEvent(71)];
    expect(resolveRecentEvent(70, log, NAMES)).toBe('гибель'); // entity/died в EVENT_LABEL
    expect(resolveRecentEvent(71, log, NAMES)).toBe('sim/tickStarted'); // фолбэк — сам код типа
  });

  it('dayOf: тик → день (TICKS_PER_DAY)', () => {
    expect(dayOf(0)).toBe(0);
    expect(dayOf(1440)).toBe(1);
  });
});

// ── Рендер ────────────────────────────────────────────────────────────────────
describe('Inspector — рендер секций', () => {
  it('detail===null → подсказка «кликни сущность»', () => {
    setStore(null);
    render(<Inspector />);
    expect(screen.getByText(/Кликни сущность/i)).toBeTruthy();
  });

  it('шапка: кличка «Имя Фамилия», вид, фракция, локация', () => {
    setStore(human());
    render(<Inspector />);
    expect(screen.getByTestId('insp-name').textContent).toContain('Сергей Лисенко');
    expect(screen.getByTestId('insp-name').textContent).toContain('Лис');
    expect(screen.getByText('сталкер')).toBeTruthy();
    expect(screen.getByText('loners')).toBeTruthy();
  });

  it('шапка без имени → #eid', () => {
    setStore(human({ name: undefined, eid: 88 as EntityId }));
    render(<Inspector />);
    expect(screen.getByTestId('insp-name').textContent).toBe('#88');
  });

  it('нужды: 5 полосок (hp + 4 нужды) с заполнением по доле', () => {
    setStore(human());
    render(<Inspector />);
    const bars = screen.getAllByTestId('insp-bar');
    expect(bars.length).toBe(5); // hp, голод, жажда, усталость, страх
    // hp=85 → ширина ~85%
    const hpFill = screen.getAllByTestId('insp-bar-fill')[0]!;
    expect(hpFill.style.width).toBe('85%'); // 85/100 (jsdom нормализует «85.0%»→«85%»)
  });

  it('задача: код HUNT → «охота», цель-кто → имя из name-map', () => {
    setStore(human());
    render(<Inspector />);
    expect(screen.getByTestId('insp-task').textContent).toBe('охота');
    expect(screen.getAllByText('Иван Сорока').length).toBeGreaterThan(0); // targetEid=7 резолвлен
  });

  it('задача отсутствует → «без задачи»', () => {
    setStore(human({ task: undefined }));
    render(<Inspector />);
    expect(screen.getByTestId('insp-task-none')).toBeTruthy();
  });

  it('инвентарь: предмет+кол-во, деньги, слава', () => {
    setStore(human());
    render(<Inspector />);
    expect(screen.getByTestId('insp-item').textContent).toContain('bread');
    expect(screen.getByTestId('insp-item').textContent).toContain('×3');
    expect(screen.getByText('120')).toBeTruthy(); // деньги
    expect(screen.getByText('12')).toBeTruthy(); // слава
  });

  it('память: subject-резолв (e:→имя, f:→фракция), сила, метка лично/слух', () => {
    setStore(human());
    render(<Inspector />);
    const subjects = screen.getAllByTestId('insp-mem-subject').map((n) => n.textContent);
    expect(subjects).toContain('Иван Сорока'); // e:7
    expect(subjects).toContain('фракция bandits'); // f:bandits
    const srcs = screen.getAllByTestId('insp-mem-src').map((n) => n.textContent);
    expect(srcs).toContain('лично'); // isFirsthand=true
    expect(srcs).toContain('слух'); // isFirsthand=false
    const sal = screen.getAllByTestId('insp-mem-salience').map((n) => n.textContent);
    expect(sal.some((s) => s?.includes('0.90'))).toBe(true);
  });

  it('отношения: знак/цвет по value (враг −, союзник +)', () => {
    setStore(human());
    render(<Inspector />);
    const vals = screen.getAllByTestId('insp-rel-value');
    const foe = vals.find((n) => n.getAttribute('data-sign') === 'foe')!;
    const friend = vals.find((n) => n.getAttribute('data-sign') === 'friend')!;
    expect(foe.textContent).toBe('-0.60'); // e:7 = −0.6
    expect(friend.textContent).toBe('+0.40'); // f:loners = +0.4
    const subs = screen.getAllByTestId('insp-rel-subject').map((n) => n.textContent);
    expect(subs).toContain('Иван Сорока');
    expect(subs).toContain('фракция loners');
  });

  it('недавние события: radio → текст, иное → подпись типа', () => {
    setStore(human(), [radioEvent(42), combatEvent(99)]);
    render(<Inspector />);
    const events = screen.getAllByTestId('insp-event').map((n) => n.textContent);
    expect(events.some((e) => e?.includes('погиб'))).toBe(true); // 42 radio
    expect(events).toContain('столкновение'); // 99 encounter/started
  });

  it('клик «закрыть» → clearSelection (detail и selectedEid обнулены)', () => {
    setStore(human());
    render(<Inspector />);
    fireEvent.click(screen.getByTestId('insp-close'));
    expect(useUiStore.getState().detail).toBeNull();
    expect(useUiStore.getState().selectedEid).toBeNull();
  });

  it('животное: species показан, имя опущено → #eid', () => {
    setStore(
      human({ kind: 'animal', name: undefined, species: 'boar', faction: null, task: undefined, eid: 30 as EntityId }),
    );
    render(<Inspector />);
    expect(screen.getByText('boar')).toBeTruthy();
    expect(screen.getByTestId('insp-name').textContent).toBe('#30');
  });

  it('шапка: «Имя Фамилия» без клички (nickname пуст → полное имя, не #eid)', () => {
    // eid 7 = Иван Сорока (nickname === '') — заголовок должен быть именем, не «#7».
    setStore(human({ eid: 7 as EntityId, name: NAMES[7] }));
    render(<Inspector />);
    expect(screen.getByTestId('insp-name').textContent).toBe('Иван Сорока');
  });

  it('в пути: показано «идёт в» (dest резолвится в имя места)', () => {
    setStore(human({ dest: 1 as LocationId }));
    render(<Inspector />);
    expect(screen.getByText('идёт в')).toBeTruthy();
  });

  it('задача с целью-местом: показано «цель — место» (targetLoc резолвится)', () => {
    setStore(human({ task: { kind: 10, targetLoc: 1 as LocationId } })); // SEARCH к полю
    render(<Inspector />);
    expect(screen.getByTestId('insp-task').textContent).toBe('поиск артефакта');
    expect(screen.getByText('цель — место')).toBeTruthy();
  });

  it('отношения нейтральные (value=0) → знак neutral, без + и −', () => {
    setStore(human({ relations: [['e:7', 0] as EntityDetail['relations'][number]] }));
    render(<Inspector />);
    const val = screen.getByTestId('insp-rel-value');
    expect(val.getAttribute('data-sign')).toBe('neutral');
    expect(val.textContent).toBe('0.00'); // без ведущего «+»
  });

  it('пустые секции: пустой инвентарь/память/отношения/события → заглушки, а не мусор', () => {
    setStore(human({ inventory: [], memory: [], relations: [], recentEvents: [] }));
    render(<Inspector />);
    expect(screen.getByText('пусто')).toBeTruthy(); // инвентарь
    expect(screen.getByText('ничего не помнит')).toBeTruthy(); // память
    expect(screen.getByText('нейтрален ко всем')).toBeTruthy(); // отношения
    expect(screen.getByText('ничего не произошло')).toBeTruthy(); // события
    // Ни одной строки-записи не отрисовано.
    expect(screen.queryAllByTestId('insp-item').length).toBe(0);
    expect(screen.queryAllByTestId('insp-mem').length).toBe(0);
    expect(screen.queryAllByTestId('insp-rel').length).toBe(0);
    expect(screen.queryAllByTestId('insp-event').length).toBe(0);
  });

  it('память: слух показан день из tick (tick=100 → день 0; tick=1440 → день 1)', () => {
    setStore(human());
    render(<Inspector />);
    const mems = screen.getAllByTestId('insp-mem').map((n) => n.textContent);
    expect(mems.some((t) => t?.includes('день 1'))).toBe(true); // robbed @ tick 1440
    expect(mems.some((t) => t?.includes('день 0'))).toBe(true); // seen @ tick 100
  });

  it('детерминизм рендера: тот же EntityDetail → идентичная разметка при двух прогонах', () => {
    // Наблюдатель дважды открыл ту же карточку — пиксель-в-пиксель одинаково (закон №8:
    // рендер — чистая функция состояния, ни rng, ни Date.now в разметке).
    const detail = human();
    const log = [radioEvent(42), combatEvent(99)];
    setStore(detail, log);
    const first = render(<Inspector />).container.innerHTML;
    cleanup();
    setStore(detail, log);
    const second = render(<Inspector />).container.innerHTML;
    expect(second).toBe(first);
  });
});
