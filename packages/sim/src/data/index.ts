/**
 * @module @zona/sim/data
 *
 * Загрузчик контент-данных Зоны (закон №10). Импортирует JSON как МОДУЛИ
 * (`import map from './map.json'`, resolveJsonModule) — НЕ читает диск: пакет
 * `@zona/sim` обязан работать headless без fs/path/process (закон №5). Данные
 * валидируются по формам `@zona/shared`, глубоко замораживаются (`Object.freeze`)
 * и отдаются наружу как неизменяемые типизированные структуры.
 *
 * Детерминизм (закон №8): вся навигация по данным идёт по плотным индексам и
 * заранее отсортированным массивам; ни одна итерация не зависит от порядка
 * вставки в Map/Set. Списки соседей отсортированы по возрастанию id.
 *
 * Валидация — fail-fast: любое нарушение формы/диапазона/связности бросает
 * `DataError` на этапе загрузки модуля (до старта симуляции), а не молча портит
 * мир. Это защита от опечаток-нулей в контенте (напр. weight:0, danger:2).
 *
 * Пример (относительный импорт ВНУТРИ пакета — данные не имеют subpath-export и
 * наружу пока не публикуются; потребители 1.2/1.3 внутри @zona/sim):
 * ```ts
 * import { MAP, getLocation, neighbors, edgeLen, isConnected } from './data/index';
 * const kordon = getLocation(0 as LocationId);
 * const around = neighbors(0 as LocationId); // отсортированный LocationId[]
 * ```
 */

import type {
  LocationId,
  MapData,
  LocationData,
  EdgeData,
  ItemData,
  ItemKind,
  SpeciesData,
  FactionData,
  ProfessionData,
  NamesData,
} from '@zona/shared';

import mapRaw from './map.json';
import itemsRaw from './items.json';
import speciesRaw from './species.json';
import namesRaw from './names.json';
import factionsRaw from './factions.json';
import professionsRaw from './professions.json';

/** Ошибка валидации/связности контента. Бросается при загрузке модуля. */
export class DataError extends Error {
  constructor(message: string) {
    super(`[data] ${message}`);
    this.name = 'DataError';
  }
}

/** Требует условие; иначе бросает DataError с контекстом. */
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new DataError(msg);
}

/** Проверка числа в замкнутом диапазоне [lo, hi]. */
function inRange(v: number, lo: number, hi: number): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

/**
 * Рекурсивная глубокая заморозка. Замораживает объект и все вложенные объекты/
 * массивы. Возвращает тот же объект (уже readonly на уровне типов). Данные — граф
 * без циклов, поэтому простая рекурсия безопасна.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// ── Валидация карты ─────────────────────────────────────────────────────────

const VALID_LOC_TYPES = new Set(['settlement', 'wild', 'anomaly', 'ruins']);

function validateMap(data: unknown): MapData {
  assert(data !== null && typeof data === 'object', 'map.json: не объект');
  const m = data as { locations?: unknown; edges?: unknown };
  assert(Array.isArray(m.locations), 'map.json: locations должен быть массивом');
  assert(Array.isArray(m.edges), 'map.json: edges должен быть массивом');

  const locations = m.locations as LocationData[];
  const edges = m.edges as EdgeData[];

  // Локации: id плотный 0..N-1, поля в диапазонах.
  locations.forEach((loc, i) => {
    assert(loc.id === i, `map.json: локация #${i} имеет id=${loc.id}, ожидался плотный индекс ${i}`);
    assert(typeof loc.name === 'string' && loc.name.length > 0, `локация ${i}: пустое name`);
    assert(VALID_LOC_TYPES.has(loc.type), `локация ${i}: неизвестный type "${loc.type}"`);
    assert(typeof loc.water === 'boolean', `локация ${i}: water не boolean`);
    assert(inRange(loc.shelter, 0, 10), `локация ${i}: shelter ${loc.shelter} вне [0,10]`);
    assert(inRange(loc.danger, 0, 1), `локация ${i}: danger ${loc.danger} вне [0,1]`);
    assert(inRange(loc.game, 0, 1), `локация ${i}: game ${loc.game} вне [0,1]`);
    assert(inRange(loc.forage, 0, 1), `локация ${i}: forage ${loc.forage} вне [0,1]`);
  });

  const n = locations.length;
  assert(n > 0, 'map.json: нет локаций');

  // Рёбра: валидные id, без петель, без дублей (неориентированные).
  const seen = new Set<string>();
  edges.forEach((e, i) => {
    assert(Number.isInteger(e.a) && e.a >= 0 && e.a < n, `ребро #${i}: a=${e.a} вне диапазона локаций`);
    assert(Number.isInteger(e.b) && e.b >= 0 && e.b < n, `ребро #${i}: b=${e.b} вне диапазона локаций`);
    assert(e.a !== e.b, `ребро #${i}: петля на локации ${e.a}`);
    assert(inRange(e.len, 1, 240), `ребро #${i}: len ${e.len} вне (0,240] тиков-минут`);
    assert(inRange(e.cover, 0, 1), `ребро #${i}: cover ${e.cover} вне [0,1]`);
    const lo = Math.min(e.a, e.b);
    const hi = Math.max(e.a, e.b);
    const key = `${lo}-${hi}`;
    assert(!seen.has(key), `ребро #${i}: дубль ${key} (граф неориентированный)`);
    seen.add(key);
  });

  return { locations, edges };
}

// ── Валидация предметов ─────────────────────────────────────────────────────

const VALID_ITEM_KINDS = new Set<ItemKind>(['weapon', 'ammo', 'food', 'drink', 'medical']);

function validateItems(data: unknown): readonly ItemData[] {
  assert(data !== null && typeof data === 'object', 'items.json: не объект');
  const arr = (data as { items?: unknown }).items;
  assert(Array.isArray(arr), 'items.json: items должен быть массивом');
  const items = arr as ItemData[];
  const ids = new Set<string>();
  items.forEach((it, i) => {
    assert(typeof it.id === 'string' && it.id.length > 0, `предмет #${i}: пустой id`);
    assert(!ids.has(it.id), `предмет #${i}: дублирующийся id "${it.id}"`);
    ids.add(it.id);
    assert(VALID_ITEM_KINDS.has(it.kind), `предмет "${it.id}": неизвестный kind "${it.kind}"`);
    assert(typeof it.weight === 'number' && it.weight > 0, `предмет "${it.id}": weight должен быть >0`);
    if (it.kind === 'weapon' || it.kind === 'ammo') {
      assert(typeof it.caliber === 'string' && it.caliber.length > 0, `предмет "${it.id}": ${it.kind} требует caliber`);
    }
    if (it.kind === 'food') {
      assert(typeof it.nutrition === 'number' && it.nutrition > 0, `предмет "${it.id}": food требует nutrition>0`);
    }
    if (it.kind === 'drink') {
      assert(typeof it.hydration === 'number' && it.hydration > 0, `предмет "${it.id}": drink требует hydration>0`);
    }
  });
  return items;
}

// ── Валидация видов ─────────────────────────────────────────────────────────

function validateSpecies(data: unknown): readonly SpeciesData[] {
  assert(data !== null && typeof data === 'object', 'species.json: не объект');
  const arr = (data as { species?: unknown }).species;
  assert(Array.isArray(arr), 'species.json: species должен быть массивом');
  const species = arr as SpeciesData[];
  species.forEach((s, i) => {
    assert(s.id === i, `вид #${i}: id=${s.id}, ожидался плотный индекс ${i}`);
    assert(typeof s.key === 'string' && s.key.length > 0, `вид ${i}: пустой key`);
    assert(Number.isInteger(s.herdMin) && s.herdMin >= 1, `вид "${s.key}": herdMin должен быть >=1`);
    assert(Number.isInteger(s.herdMax) && s.herdMax >= s.herdMin, `вид "${s.key}": herdMax < herdMin`);
    assert(typeof s.flees === 'boolean', `вид "${s.key}": flees не boolean`);
    assert(s.power >= 0, `вид "${s.key}": power < 0`);
    assert(s.melee >= 0, `вид "${s.key}": melee < 0`);
    assert(Number.isInteger(s.reproCap) && s.reproCap >= s.herdMax, `вид "${s.key}": reproCap < herdMax`);
    assert(Number.isInteger(s.gestationTicks) && s.gestationTicks > 0, `вид "${s.key}": gestationTicks должен быть >0`);
    assert(s.foragePerTick > 0, `вид "${s.key}": foragePerTick должен быть >0`);
    assert(s.meatYield > 0, `вид "${s.key}": meatYield должен быть >0`);
  });
  return species;
}

// ── Валидация фракций и профессий (контент, закон №10) ───────────────────────

/**
 * Валидирует записи `{id, name}` с непустыми уникальными id и непустым name.
 * Общая форма для factions.json и professions.json (обе — плоские списки
 * абстрактных id → читаемое имя). `label` — для сообщений об ошибке.
 */
function validateIdNameList(data: unknown, key: string, label: string): readonly FactionData[] {
  assert(data !== null && typeof data === 'object', `${label}.json: не объект`);
  const arr = (data as Record<string, unknown>)[key];
  assert(Array.isArray(arr), `${label}.json: ${key} должен быть массивом`);
  const list = arr as FactionData[];
  assert(list.length > 0, `${label}.json: список ${key} пуст`);
  const ids = new Set<string>();
  list.forEach((r, i) => {
    assert(typeof r.id === 'string' && r.id.length > 0, `${label} #${i}: пустой id`);
    assert(!ids.has(r.id), `${label} #${i}: дублирующийся id "${r.id}"`);
    ids.add(r.id);
    assert(typeof r.name === 'string' && r.name.length > 0, `${label} "${r.id}": пустое name`);
  });
  return list;
}

// ── Валидация имён ──────────────────────────────────────────────────────────

/** Минимум имён/фамилий для приемлемого разнообразия NPC (закон №4). */
const MIN_NAMES = 15;

function validateNames(data: unknown): NamesData {
  assert(data !== null && typeof data === 'object', 'names.json: не объект');
  const n = data as NamesData;
  assert(Array.isArray(n.first) && n.first.length >= MIN_NAMES, `names.json: нужно >=${MIN_NAMES} имён`);
  assert(Array.isArray(n.last) && n.last.length >= MIN_NAMES, `names.json: нужно >=${MIN_NAMES} фамилий`);
  n.first.forEach((s, i) => assert(typeof s === 'string' && s.length > 0, `first[${i}] пуст`));
  n.last.forEach((s, i) => assert(typeof s === 'string' && s.length > 0, `last[${i}] пуст`));
  assert(Array.isArray(n.nicknamePatterns) && n.nicknamePatterns.length > 0, 'names.json: нет nicknamePatterns');
  n.nicknamePatterns.forEach((p, i) => {
    assert(typeof p.trait === 'string' && p.trait.length > 0, `nicknamePatterns[${i}]: пустой trait`);
    assert(Array.isArray(p.options) && p.options.length > 0, `nicknamePatterns[${i}]: нет options`);
    p.options.forEach((o: string, j: number) => assert(typeof o === 'string' && o.length > 0, `nicknamePatterns[${i}].options[${j}] пуст`));
  });
  return n;
}

// ── Загрузка (единожды на модуль) ───────────────────────────────────────────

/** Валидированная и замороженная карта Зоны. */
export const MAP: MapData = deepFreeze(validateMap(mapRaw));

/** Валидированный и замороженный список предметов. */
export const ITEMS: readonly ItemData[] = deepFreeze(validateItems(itemsRaw));

/** Валидированный и замороженный список видов животных. */
export const SPECIES: readonly SpeciesData[] = deepFreeze(validateSpecies(speciesRaw));

/** Валидированный и замороженный пул имён. */
export const NAMES: NamesData = deepFreeze(validateNames(namesRaw));

/** Валидированный и замороженный список фракций (контент, закон №10). */
export const FACTIONS: readonly FactionData[] = deepFreeze(
  validateIdNameList(factionsRaw, 'factions', 'factions'),
);

/** Валидированный и замороженный список профессий (контент, закон №10). */
export const PROFESSIONS: readonly ProfessionData[] = deepFreeze(
  validateIdNameList(professionsRaw, 'professions', 'professions') as readonly ProfessionData[],
);

// ── Индексы для O(1)/детерминированного доступа ──────────────────────────────

/**
 * Список отсортированных соседей на локацию. Индекс массива = id локации;
 * значение — отсортированный по возрастанию массив id соседей. Строится один раз;
 * сам массив и вложенные заморожены (иммутабельность наружу).
 */
const ADJ: readonly (readonly LocationId[])[] = deepFreeze(
  buildAdjacency(MAP),
);

/** key `${min}-${max}` → len. Для симметричного edgeLen(a,b). */
const EDGE_LEN = buildEdgeLenMap(MAP);

/** id предмета → ItemData. */
const ITEM_BY_ID: ReadonlyMap<string, ItemData> = new Map(ITEMS.map((it) => [it.id, it]));

/** id фракции → FactionData. */
const FACTION_BY_ID: ReadonlyMap<string, FactionData> = new Map(FACTIONS.map((f) => [f.id, f]));

/** id профессии → ProfessionData. */
const PROFESSION_BY_ID: ReadonlyMap<string, ProfessionData> = new Map(
  PROFESSIONS.map((p) => [p.id, p]),
);

function buildAdjacency(map: MapData): LocationId[][] {
  const adj: LocationId[][] = map.locations.map(() => []);
  for (const e of map.edges) {
    adj[e.a]!.push(e.b as LocationId);
    adj[e.b]!.push(e.a as LocationId);
  }
  // Детерминизм: соседи всегда по возрастанию id (закон №8).
  for (const list of adj) list.sort((x, y) => x - y);
  return adj;
}

function buildEdgeLenMap(map: MapData): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  for (const e of map.edges) {
    const lo = Math.min(e.a, e.b);
    const hi = Math.max(e.a, e.b);
    m.set(`${lo}-${hi}`, e.len);
  }
  return m;
}

// ── Публичные хелперы ────────────────────────────────────────────────────────

/** Локация по id. Бросает при выходе за диапазон. */
export function getLocation(id: LocationId): LocationData {
  const loc = MAP.locations[id];
  assert(loc !== undefined, `getLocation: нет локации ${id}`);
  return loc;
}

/** Отсортированный по возрастанию список id соседних локаций. */
export function neighbors(id: LocationId): readonly LocationId[] {
  const list = ADJ[id];
  assert(list !== undefined, `neighbors: нет локации ${id}`);
  return list;
}

/**
 * Длина ребра между a и b (симметрично). Возвращает undefined, если ребра нет
 * (локации не смежны). Порядок аргументов не важен.
 */
export function edgeLen(a: LocationId, b: LocationId): number | undefined {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return EDGE_LEN.get(`${lo}-${hi}`);
}

/** Предмет по строковому id. Бросает при неизвестном id (закон №3/№10). */
export function getItem(id: string): ItemData {
  const it = ITEM_BY_ID.get(id);
  assert(it !== undefined, `getItem: неизвестный предмет "${id}"`);
  return it;
}

/** Вид по плотному id. Бросает при выходе за диапазон. */
export function getSpecies(id: number): SpeciesData {
  const s = SPECIES[id];
  assert(s !== undefined, `getSpecies: нет вида ${id}`);
  return s;
}

/** Фракция по строковому id. Бросает при неизвестном id (закон №10). */
export function getFaction(id: string): FactionData {
  const f = FACTION_BY_ID.get(id);
  assert(f !== undefined, `getFaction: неизвестная фракция "${id}"`);
  return f;
}

/** Профессия по строковому id. Бросает при неизвестном id (закон №10). */
export function getProfession(id: string): ProfessionData {
  const p = PROFESSION_BY_ID.get(id);
  assert(p !== undefined, `getProfession: неизвестная профессия "${id}"`);
  return p;
}

/**
 * Связность графа карты: из локации 0 достижима любая другая (BFS по ADJ).
 * Детерминирован (обход по отсортированным соседям). Возвращает false, если
 * есть изолированный узел или несвязная компонента.
 */
export function isConnected(): boolean {
  const n = MAP.locations.length;
  if (n === 0) return false;
  const visited = new Array<boolean>(n).fill(false);
  const queue: number[] = [0];
  visited[0] = true;
  let count = 1;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of ADJ[cur]!) {
      if (!visited[nb]) {
        visited[nb] = true;
        count++;
        queue.push(nb);
      }
    }
  }
  return count === n;
}

// Инвариант загрузки: несвязный граф — фатальная ошибка контента (закон №8:
// мир, где локация недостижима, ломает движение/расселение). Проверяем сразу.
assert(isConnected(), 'map.json: граф не связен — есть недостижимые локации');
