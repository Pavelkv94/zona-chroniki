/**
 * Юниты чистой геометрии карты (задача 4.2): перевод раскладки в пиксели,
 * интерполяция вдоль ребра, кластеризация, хит-тест. Без DOM — детерминизм.
 */

import { describe, it, expect } from 'vitest';
import {
  clusterOffset,
  edgeProgress,
  hitTest,
  layoutToPixels,
  lerpPoint,
  type HitCandidate,
} from './geometry';

describe('layoutToPixels', () => {
  it('крайние нормированные координаты ложатся на поля холста', () => {
    expect(layoutToPixels({ x: 0, y: 0 }, 800, 600, 40)).toEqual({ x: 40, y: 40 });
    expect(layoutToPixels({ x: 1, y: 1 }, 800, 600, 40)).toEqual({ x: 760, y: 560 });
    expect(layoutToPixels({ x: 0.5, y: 0.5 }, 800, 600, 40)).toEqual({ x: 400, y: 300 });
  });
});

describe('lerpPoint', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 40 };
  it('t=0 → a, t=1 → b, t=0.5 → середина', () => {
    expect(lerpPoint(a, b, 0)).toEqual(a);
    expect(lerpPoint(a, b, 1)).toEqual(b);
    expect(lerpPoint(a, b, 0.5)).toEqual({ x: 50, y: 20 });
  });
});

describe('edgeProgress', () => {
  it('eta=total → 0 (в loc); eta=0 → 1 (в dest); середина → 0.5', () => {
    expect(edgeProgress(40, 40)).toBe(0);
    expect(edgeProgress(0, 40)).toBe(1);
    expect(edgeProgress(20, 40)).toBe(0.5);
  });
  it('кламп за пределы и защита от total<=0', () => {
    expect(edgeProgress(-5, 40)).toBe(1); // eta<0 → t>1 → 1
    expect(edgeProgress(50, 40)).toBe(0); // eta>total → t<0 → 0
    expect(edgeProgress(10, 0)).toBe(1); // нет длины → считаем прибывшим
  });
});

describe('clusterOffset', () => {
  it('один в узле → центр (0,0)', () => {
    expect(clusterOffset(0, 1, 12)).toEqual({ x: 0, y: 0 });
    expect(clusterOffset(0, 0, 12)).toEqual({ x: 0, y: 0 });
  });
  it('несколько → на кольце радиуса, детерминированно и различимо', () => {
    const a = clusterOffset(0, 4, 12);
    const b = clusterOffset(1, 4, 12);
    // радиус сохранён
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(12, 6);
    expect(Math.hypot(b.x, b.y)).toBeCloseTo(12, 6);
    // разные индексы дают разные точки
    expect(a).not.toEqual(b);
    // тот же индекс → тот же результат (детерминизм)
    expect(clusterOffset(1, 4, 12)).toEqual(b);
  });
});

describe('hitTest', () => {
  const cands: HitCandidate[] = [
    { eid: 1, x: 100, y: 100, r: 8 },
    { eid: 2, x: 120, y: 100, r: 8 },
    { eid: 3, x: 400, y: 400, r: 8 },
  ];
  it('возвращает eid под точкой', () => {
    expect(hitTest(cands, 100, 100)).toBe(1);
    expect(hitTest(cands, 400, 402)).toBe(3);
  });
  it('промах → null', () => {
    expect(hitTest(cands, 250, 250)).toBeNull();
  });
  it('перекрытие → ближайший', () => {
    // точка ближе к eid2 (x=112 ближе к 120? |112-100|=12 vs |112-120|=8 → eid2)
    expect(hitTest(cands, 112, 100)).toBe(2);
  });
  it('пустой список кандидатов → null (карта без сущностей — клик в пустоту)', () => {
    expect(hitTest([], 100, 100)).toBeNull();
  });
  it('граница радиуса: ровно на кромке круга — попадание, чуть дальше — промах', () => {
    const one: HitCandidate[] = [{ eid: 9, x: 200, y: 200, r: 8 }];
    // dist == r → накрыто (<=): ловим сущность на самой кромке глифа.
    expect(hitTest(one, 208, 200)).toBe(9);
    // dist чуть больше r → мимо (никакой «магнит» за пределами радиуса).
    expect(hitTest(one, 208.001, 200)).toBeNull();
  });
  it('равные расстояния → детерминированно меньший индекс (стабильный выбор)', () => {
    // Две сущности симметрично вокруг точки клика на равном расстоянии.
    const tie: HitCandidate[] = [
      { eid: 5, x: 90, y: 100, r: 20 },
      { eid: 6, x: 110, y: 100, r: 20 },
    ];
    // Клик ровно посередине (dist=10 к обоим) → выигрывает ПЕРВЫЙ в списке (eid 5).
    expect(hitTest(tie, 100, 100)).toBe(5);
    // Тот же вход → тот же выбор (детерминизм).
    expect(hitTest(tie, 100, 100)).toBe(5);
  });
});

describe('clusterOffset — кольцевая раскладка перекрытых глифов', () => {
  it('двое в узле разлетаются в противоположные точки кольца (не сливаются)', () => {
    const a = clusterOffset(0, 2, 10);
    const b = clusterOffset(1, 2, 10);
    expect(a).not.toEqual(b);
    // антиподы на кольце: сумма координат ≈ центр узла.
    expect(a.x + b.x).toBeCloseTo(0, 6);
    expect(a.y + b.y).toBeCloseTo(0, 6);
  });
  it('каждый индекс лежит на кольце заданного радиуса (никто не в центре при count>1)', () => {
    const count = 6;
    for (let i = 0; i < count; i++) {
      const o = clusterOffset(i, count, 14);
      expect(Math.hypot(o.x, o.y)).toBeCloseTo(14, 6);
    }
  });
});
