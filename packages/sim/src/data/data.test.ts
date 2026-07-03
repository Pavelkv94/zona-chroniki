/**
 * @module @zona/sim/data/data.test
 *
 * Юниты загрузчика контента (задача 1.1): детерминизм и стабильность ссылок,
 * СВЯЗНОСТЬ графа карты (BFS достигает все 10 локаций, нет изолятов, рёбра
 * ссылаются на валидные id, neighbors симметричны и отсортированы), диапазоны
 * полей локаций/предметов/видов/имён, глубокая заморожённость. Всё детерминично
 * (закон №8).
 */

import { describe, it, expect } from 'vitest';
import type { LocationId } from '@zona/shared';
import {
  MAP,
  ITEMS,
  SPECIES,
  NAMES,
  getLocation,
  neighbors,
  edgeLen,
  getItem,
  getSpecies,
  isConnected,
} from './index';
import { THIRST_PER_TICK, THIRST_CRITICAL } from '../balance/needs';

const N = 10;

// ── Общие графовые хелперы (детерминированные, из сырых данных) ───────────────

/**
 * Список смежности из СЫРЫХ рёбер map.json (а не из ADJ загрузчика). Служит
 * независимой опорой: если buildAdjacency в загрузчике сломается, тесты ниже
 * поймают расхождение с фактическими рёбрами.
 */
function rawAdjacency(): number[][] {
  const adj: number[][] = MAP.locations.map(() => []);
  for (const e of MAP.edges) {
    adj[e.a]!.push(e.b);
    adj[e.b]!.push(e.a);
  }
  return adj;
}

/** BFS-множество достижимых из src по сырым рёбрам. */
function reachableFrom(src: number, adj: number[][]): Set<number> {
  const seen = new Set<number>([src]);
  const q = [src];
  while (q.length) {
    const cur = q.shift()!;
    for (const nb of adj[cur]!) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
  }
  return seen;
}

/**
 * Дистанция (в тиках-минутах, по edge.len) от src до ближайшей локации, где
 * предикат pred(loc)===true. Dijkstra по сырым рёбрам. Infinity — недостижимо.
 */
function nearestByTicks(src: number, pred: (l: (typeof MAP.locations)[number]) => boolean): number {
  const lenAdj: Array<Array<[number, number]>> = MAP.locations.map(() => []);
  for (const e of MAP.edges) { lenAdj[e.a]!.push([e.b, e.len]); lenAdj[e.b]!.push([e.a, e.len]); }
  const dist = new Array<number>(N).fill(Infinity);
  const done = new Array<boolean>(N).fill(false);
  dist[src] = 0;
  for (let it = 0; it < N; it++) {
    let u = -1; let best = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i]! < best) { best = dist[i]!; u = i; }
    if (u < 0) break;
    done[u] = true;
    for (const [v, w] of lenAdj[u]!) if (dist[u]! + w < dist[v]!) dist[v] = dist[u]! + w;
  }
  let bestWater = Infinity;
  for (let i = 0; i < N; i++) if (pred(MAP.locations[i]!) && dist[i]! < bestWater) bestWater = dist[i]!;
  return bestWater;
}

describe('загрузчик: детерминизм и стабильность', () => {
  it('MAP имеет ровно 10 локаций с плотными id', () => {
    expect(MAP.locations.length).toBe(N);
    MAP.locations.forEach((loc, i) => expect(loc.id).toBe(i));
  });

  it('повторные вызовы хелперов дают ту же (замороженную) ссылку', () => {
    expect(getLocation(0 as LocationId)).toBe(getLocation(0 as LocationId));
    expect(neighbors(0 as LocationId)).toBe(neighbors(0 as LocationId));
    expect(getItem('pm')).toBe(getItem('pm'));
    expect(getSpecies(0)).toBe(getSpecies(0));
  });
});

describe('карта: связность графа', () => {
  it('isConnected() === true (из любой достижима любая)', () => {
    expect(isConnected()).toBe(true);
  });

  it('BFS из локации 0 достигает все 10 узлов, нет изолятов', () => {
    const visited = new Set<number>([0]);
    const queue: number[] = [0];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of neighbors(cur as LocationId)) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
    expect(visited.size).toBe(N);
    // Ни одной локации без соседей.
    for (let i = 0; i < N; i++) {
      expect(neighbors(i as LocationId).length).toBeGreaterThan(0);
    }
  });

  it('каждое ребро ссылается на валидные id, без петель и дублей', () => {
    const seen = new Set<string>();
    for (const e of MAP.edges) {
      expect(e.a).toBeGreaterThanOrEqual(0);
      expect(e.a).toBeLessThan(N);
      expect(e.b).toBeGreaterThanOrEqual(0);
      expect(e.b).toBeLessThan(N);
      expect(e.a).not.toBe(e.b);
      const key = `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(e.len).toBeGreaterThan(0);
      expect(e.len).toBeLessThanOrEqual(120);
      expect(e.cover).toBeGreaterThanOrEqual(0);
      expect(e.cover).toBeLessThanOrEqual(1);
    }
  });

  it('neighbors симметричны и отсортированы по возрастанию', () => {
    for (let a = 0; a < N; a++) {
      const list = neighbors(a as LocationId);
      // Отсортированность.
      for (let i = 1; i < list.length; i++) {
        expect(list[i]!).toBeGreaterThan(list[i - 1]!);
      }
      // Симметрия: b в соседях a ⇔ a в соседях b.
      for (const b of list) {
        expect(neighbors(b).includes(a as LocationId)).toBe(true);
      }
    }
  });

  it('edgeLen симметричен и совпадает с map.json; несмежные → undefined', () => {
    for (const e of MAP.edges) {
      const forward = edgeLen(e.a as LocationId, e.b as LocationId);
      const backward = edgeLen(e.b as LocationId, e.a as LocationId);
      expect(forward).toBe(e.len);
      expect(backward).toBe(e.len);
    }
    // Пара без ребра.
    expect(edgeLen(0 as LocationId, 9 as LocationId)).toBeUndefined();
  });

  it('есть поселение-хаб (Кордон: water, высокий shelter, низкий danger)', () => {
    const kordon = getLocation(0 as LocationId);
    expect(kordon.type).toBe('settlement');
    expect(kordon.water).toBe(true);
    expect(kordon.shelter).toBeGreaterThanOrEqual(7);
    expect(kordon.danger).toBeLessThanOrEqual(0.15);
  });

  it('источники воды есть в нескольких точках', () => {
    const withWater = MAP.locations.filter((l) => l.water).length;
    expect(withWater).toBeGreaterThanOrEqual(3);
  });

  it('опасные глубины существуют (высокий danger)', () => {
    const deep = MAP.locations.filter((l) => l.danger >= 0.6);
    expect(deep.length).toBeGreaterThan(0);
  });
});

describe('локации: диапазоны полей', () => {
  it('все поля каждой локации в допустимых границах', () => {
    for (const loc of MAP.locations) {
      expect(loc.name.length).toBeGreaterThan(0);
      expect(['settlement', 'wild', 'anomaly', 'ruins']).toContain(loc.type);
      expect(loc.shelter).toBeGreaterThanOrEqual(0);
      expect(loc.shelter).toBeLessThanOrEqual(10);
      for (const v of [loc.danger, loc.game, loc.forage]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('предметы', () => {
  it('минимальный набор присутствует', () => {
    for (const id of ['pm', 'ammo_9mm', 'canned', 'water', 'bandage']) {
      expect(getItem(id).id).toBe(id);
    }
  });

  it('вес каждого предмета > 0; оружие/патроны имеют caliber', () => {
    for (const it of ITEMS) {
      expect(it.weight).toBeGreaterThan(0);
      if (it.kind === 'weapon' || it.kind === 'ammo') {
        expect(typeof it.caliber).toBe('string');
      }
      if (it.kind === 'food') expect(it.nutrition!).toBeGreaterThan(0);
      if (it.kind === 'drink') expect(it.hydration!).toBeGreaterThan(0);
    }
  });

  it('getItem бросает на неизвестном id', () => {
    expect(() => getItem('no_such_item')).toThrow();
  });
});

describe('виды', () => {
  it('есть олень и кабан', () => {
    const keys = SPECIES.map((s) => s.key);
    expect(keys).toContain('deer');
    expect(keys).toContain('boar');
  });

  it('herdMin<=herdMax, gestationTicks>0, meatYield>0, foragePerTick>0', () => {
    for (const s of SPECIES) {
      expect(s.herdMin).toBeLessThanOrEqual(s.herdMax);
      expect(s.herdMin).toBeGreaterThanOrEqual(1);
      expect(s.gestationTicks).toBeGreaterThan(0);
      expect(s.meatYield).toBeGreaterThan(0);
      expect(s.foragePerTick).toBeGreaterThan(0);
      expect(s.reproCap).toBeGreaterThanOrEqual(s.herdMax);
    }
  });

  it('олень пуглив и слабее кабана', () => {
    const deer = SPECIES.find((s) => s.key === 'deer')!;
    const boar = SPECIES.find((s) => s.key === 'boar')!;
    expect(deer.flees).toBe(true);
    expect(boar.flees).toBe(false);
    expect(boar.power).toBeGreaterThan(deer.power);
    expect(boar.melee).toBeGreaterThan(deer.melee);
  });
});

describe('имена', () => {
  it('>=15 имён и фамилий, есть шаблоны кличек', () => {
    expect(NAMES.first.length).toBeGreaterThanOrEqual(15);
    expect(NAMES.last.length).toBeGreaterThanOrEqual(15);
    expect(NAMES.nicknamePatterns.length).toBeGreaterThan(0);
    for (const p of NAMES.nicknamePatterns) {
      expect(p.options.length).toBeGreaterThan(0);
    }
  });
});

describe('заморожённость (иммутабельность наружу)', () => {
  it('данные глубоко заморожены — мутации не проходят', () => {
    expect(Object.isFrozen(MAP)).toBe(true);
    expect(Object.isFrozen(MAP.locations)).toBe(true);
    expect(Object.isFrozen(MAP.locations[0])).toBe(true);
    expect(Object.isFrozen(ITEMS)).toBe(true);
    expect(Object.isFrozen(SPECIES)).toBe(true);
    expect(Object.isFrozen(NAMES)).toBe(true);
    expect(Object.isFrozen(NAMES.first)).toBe(true);
    // Попытка мутации на замороженном объекте в strict-модуле бросает.
    expect(() => {
      // @ts-expect-error намеренная попытка мутации readonly-данных
      MAP.locations[0].danger = 99;
    }).toThrow();
    expect(() => {
      // @ts-expect-error намеренная попытка мутации замороженного массива
      (ITEMS as ItemMutable[]).push({});
    }).toThrow();
  });
});

// Локальный тип-хелпер для проверки заморожённости массива (см. тест выше).
type ItemMutable = { id: string };

// ── Усиление QA (задача 1.1): жёсткая связность, выживание, глубокая заморозка ──

describe('карта: сцена «из любого угла Зоны можно дойти до любого другого»', () => {
  it('транзитивное замыкание: КАЖДАЯ пара локаций взаимодостижима', () => {
    const adj = rawAdjacency();
    for (let src = 0; src < N; src++) {
      const reach = reachableFrom(src, adj);
      expect(reach.size, `из локации ${src} достижимы не все узлы`).toBe(N);
    }
  });

  it('граф строго неориентированный: neighbors(a) — это ТОЧНО проекция сырых рёбер', () => {
    // Не тавтология symmetry-теста: сверяем ADJ загрузчика с независимо
    // построенной из map.json смежностью. Ловит регресс buildAdjacency и
    // «односторонние» рёбра (которых в модели быть не должно).
    const adj = rawAdjacency().map((l) => [...new Set(l)].sort((x, y) => x - y));
    for (let a = 0; a < N; a++) {
      expect([...neighbors(a as LocationId)]).toEqual(adj[a]);
    }
  });

  it('порядок соседей детерминирован (строго возрастает, без дублей)', () => {
    for (let a = 0; a < N; a++) {
      const list = neighbors(a as LocationId);
      for (let i = 1; i < list.length; i++) {
        expect(list[i]!, `соседи ${a} не отсортированы/дублируются`).toBeGreaterThan(list[i - 1]!);
      }
    }
  });

  it('edgeLen симметричен на ВСЕХ парах, не только на рёбрах', () => {
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        expect(edgeLen(a as LocationId, b as LocationId)).toBe(edgeLen(b as LocationId, a as LocationId));
      }
    }
  });
});

describe('карта: выживание — «NPC не умрёт от жажды/голода в тупике»', () => {
  it('из КАЖДОЙ локации достижима вода (нет водяной изоляции)', () => {
    for (let i = 0; i < N; i++) {
      const d = nearestByTicks(i, (l) => l.water);
      expect(d, `из локации ${i} (${MAP.locations[i]!.name}) вода недостижима`).toBeLessThan(Infinity);
    }
  });

  it('до воды успеваешь дойти РАНЬШЕ, чем жажда станет критической', () => {
    // Сцена: NPC с нулевой жаждой выходит из худшей точки. Порог THIRST_CRITICAL
    // достигается за THIRST_CRITICAL/THIRST_PER_TICK тиков. Ближайшая вода
    // обязана быть ближе этого бюджета — иначе локация = смертельная ловушка.
    const ticksToCritical = THIRST_CRITICAL / THIRST_PER_TICK; // ~1214
    let worst = 0; let worstLoc = -1;
    for (let i = 0; i < N; i++) {
      const d = nearestByTicks(i, (l) => l.water);
      if (d > worst) { worst = d; worstLoc = i; }
      expect(d, `локация ${i} (${MAP.locations[i]!.name}): вода за ${d}t, бюджет жажды ${ticksToCritical}t`)
        .toBeLessThan(ticksToCritical);
    }
    // Зафиксировать текущий худший случай (Саркофаг, 205t) — регресс-якорь.
    expect(worstLoc).toBe(9);
    expect(worst).toBe(205);
  });

  it('ни одного тупика без еды: у каждой локации game>0 ИЛИ forage>0', () => {
    for (const l of MAP.locations) {
      expect(l.game > 0 || l.forage > 0, `локация ${l.id} (${l.name}) без источника еды`).toBe(true);
    }
  });

  it('из каждой локации достижим ощутимый корм (forage>=0.2 или game>=0.2)', () => {
    // Слабый forage самой локации (Саркофаг 0.05) допустим, если рядом есть
    // нормальный источник — иначе медленная голодная смерть.
    for (let i = 0; i < N; i++) {
      const d = nearestByTicks(i, (l) => l.forage >= 0.2 || l.game >= 0.2);
      expect(d, `из локации ${i} (${MAP.locations[i]!.name}) нет достижимого корма`).toBeLessThan(Infinity);
    }
  });
});

describe('карта: находка — Саркофаг как латентная ловушка (фиксация топологии)', () => {
  // Не падает: документирует опасную геометрию, чтобы её изменение было ЗАМЕЧЕНО
  // (регресс-якорь дизайна). Если топология поменяется — тест заставит осознать.
  it('Саркофаг (9) — тупик degree=1, danger=1.0, без воды, forage~0', () => {
    const sarcophagus = getLocation(9 as LocationId);
    expect(neighbors(9 as LocationId).length).toBe(1); // единственный вход — Припять
    expect(sarcophagus.danger).toBe(1.0);
    expect(sarcophagus.water).toBe(false);
    expect(sarcophagus.forage).toBeLessThanOrEqual(0.1);
  });

  it('глубокий кластер {Рыжий лес, Припять, Саркофаг} — водная пустыня без воды', () => {
    for (const id of [7, 8, 9]) {
      expect(getLocation(id as LocationId).water, `loc ${id} внезапно с водой — обнови находку`).toBe(false);
    }
  });
});

describe('доступ по id: поведение на границах диапазона', () => {
  it('getLocation бросает на несуществующем/отрицательном id', () => {
    expect(() => getLocation(10 as LocationId)).toThrow();
    expect(() => getLocation(-1 as LocationId)).toThrow();
  });

  it('getSpecies бросает вне диапазона видов', () => {
    expect(() => getSpecies(SPECIES.length)).toThrow();
    expect(() => getSpecies(-1)).toThrow();
  });

  it('edgeLen на несмежной паре и на петле → undefined (не throw)', () => {
    expect(edgeLen(0 as LocationId, 9 as LocationId)).toBeUndefined(); // разные концы
    expect(edgeLen(0 as LocationId, 5 as LocationId)).toBeUndefined(); // не смежны
    expect(edgeLen(3 as LocationId, 3 as LocationId)).toBeUndefined(); // петля отсутствует
  });
});

describe('уникальность id (нет молчаливого перезатирания)', () => {
  it('id локаций уникальны и плотны 0..N-1', () => {
    const ids = MAP.locations.map((l) => l.id);
    expect(new Set(ids).size).toBe(N);
    expect([...ids].sort((a, b) => a - b)).toEqual([...Array(N).keys()]);
  });

  it('id предметов уникальны', () => {
    const ids = ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ITEMS.length);
  });

  it('id и key видов уникальны', () => {
    expect(new Set(SPECIES.map((s) => s.id)).size).toBe(SPECIES.length);
    expect(new Set(SPECIES.map((s) => s.key)).size).toBe(SPECIES.length);
  });
});

describe('заморозка ГЛУБОКАЯ: мутация вложенных структур не проходит', () => {
  it('ребро и его поля заморожены (edges[0].len)', () => {
    expect(Object.isFrozen(MAP.edges)).toBe(true);
    expect(Object.isFrozen(MAP.edges[0])).toBe(true);
    expect(() => {
      // @ts-expect-error намеренная мутация readonly-ребра
      MAP.edges[0].len = 99999;
    }).toThrow();
  });

  it('вид и его поля заморожены (SPECIES[0].meatYield)', () => {
    expect(Object.isFrozen(SPECIES[0])).toBe(true);
    expect(() => {
      // @ts-expect-error намеренная мутация readonly-вида
      SPECIES[0].meatYield = -1;
    }).toThrow();
  });

  it('шаблоны кличек и их options заморожены (nicknamePatterns[0].options)', () => {
    const pat = NAMES.nicknamePatterns[0]!;
    expect(Object.isFrozen(pat)).toBe(true);
    expect(Object.isFrozen(pat.options)).toBe(true);
    expect(() => {
      (pat.options as string[]).push('Взлом');
    }).toThrow();
    expect(Object.isFrozen(NAMES.first)).toBe(true);
    expect(Object.isFrozen(NAMES.last)).toBe(true);
  });
});
