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
  FactionRelation,
  ProfessionData,
  NamesData,
  MessagesData,
  SettlementData,
  AnomalyFieldData,
} from '@zona/shared';

import mapRaw from './map.json';
import itemsRaw from './items.json';
import speciesRaw from './species.json';
import namesRaw from './names.json';
import factionsRaw from './factions.json';
import professionsRaw from './professions.json';
import settlementsRaw from './settlements.json';
import anomalyFieldsRaw from './anomaly_fields.json';
import messagesRaw from './messages.json';

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

const VALID_ITEM_KINDS = new Set<ItemKind>([
  'weapon',
  'ammo',
  'food',
  'drink',
  'medical',
  'artifact',
  // Фаза 5 (задача 5.0): 'part' — часть туши мутанта (лапа/щупальце/коготь), без
  // обязательных доп-полей (как 'medical'). APPEND-ONLY; items.json наполнит 5.1.
  'part',
]);

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
    // basePrice — контент-якорь ценности (задача 2.5, D-047): целый >0 (закон №3:
    // предмет не может стоить 0/дробно — цена сделки DERIVED из него в priceOf).
    assert(
      Number.isInteger(it.basePrice) && it.basePrice > 0,
      `предмет "${it.id}": basePrice должен быть целым >0`,
    );
    if (it.kind === 'weapon' || it.kind === 'ammo') {
      assert(typeof it.caliber === 'string' && it.caliber.length > 0, `предмет "${it.id}": ${it.kind} требует caliber`);
    }
    if (it.kind === 'food') {
      assert(typeof it.nutrition === 'number' && it.nutrition > 0, `предмет "${it.id}": food требует nutrition>0`);
    }
    if (it.kind === 'drink') {
      assert(typeof it.hydration === 'number' && it.hydration > 0, `предмет "${it.id}": drink требует hydration>0`);
    }
    if (it.kind === 'artifact') {
      // Артефакт (2.9/D-054): обязателен `tier` — целое >=0, связывает предмет с
      // ступенью аномального поля (AnomalyField.tier). Закон №3/№10: артефакт —
      // контент с явной ступенью, а не безымянный «выпад».
      assert(
        Number.isInteger(it.tier) && (it.tier as number) >= 0,
        `предмет "${it.id}": artifact требует целый tier>=0`,
      );
    }
  });
  // Уникальность tier среди артефактов (2.9/D-054): getArtifactForTier сопоставляет
  // ступень поля с ОДНОЗНАЧНЫМ артефактом; дубль ступени сделал бы выбор неоднозначным.
  const artifactTiers = new Set<number>();
  items.forEach((it) => {
    if (it.kind !== 'artifact') return;
    const t = it.tier as number;
    assert(!artifactTiers.has(t), `артефакт "${it.id}": дублирующийся tier=${t} (ступени уникальны)`);
    artifactTiers.add(t);
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

/**
 * Валидирует `professions.json` (Фаза 2, задача 2.4). Поверх общей проверки
 * `{id, name}` (validateIdNameList) требует у КАЖДОЙ профессии поле `workTasks` —
 * массив непустых строк-id рабочих задач (может быть ПУСТЫМ: `[]` = «полевая»
 * профессия без рабочего места в поселении). Непустой список = профессия оседлая
 * (её резидент поселения трудоустраивается через assignJobs, WORK-утилити 2.4). Код
 * оперирует абстрактными id задач, не их семантикой (закон №10).
 */
function validateProfessions(data: unknown): readonly ProfessionData[] {
  const base = validateIdNameList(data, 'professions', 'professions');
  base.forEach((r) => {
    const wt = (r as unknown as { workTasks?: unknown }).workTasks;
    assert(Array.isArray(wt), `профессия "${r.id}": workTasks должен быть массивом (возможно пустым)`);
    (wt as unknown[]).forEach((t, j) =>
      assert(typeof t === 'string' && (t as string).length > 0, `профессия "${r.id}" workTasks #${j}: пустой id задачи`),
    );
  });
  return base as readonly ProfessionData[];
}

/**
 * Валидирует `factions.json.factions` (Фаза 2, задача 2.12/D-062). Поверх общей
 * проверки `{id, name}` (validateIdNameList) требует, чтобы опциональное поле
 * `predatory` — ДИСПОЗИЦИЯ грабежа (члены хищной фракции выбирают ROB) — было boolean,
 * если присутствует. Опущено ⇒ фракция не-хищная (ROB её NPC не выбирают). Код
 * поведения читает эту диспозицию из данных (isPredatoryFaction), а НЕ хардкодит id.
 */
function validateFactions(data: unknown): readonly FactionData[] {
  const base = validateIdNameList(data, 'factions', 'factions');
  base.forEach((r) => {
    const p = (r as unknown as { predatory?: unknown }).predatory;
    assert(
      p === undefined || typeof p === 'boolean',
      `фракция "${r.id}": predatory должен быть boolean (или опущен)`,
    );
  });
  return base;
}

// ── Валидация матрицы отношений фракций (закон №10) ──────────────────────────

/** Границы шкалы отношений (D-046 контекст: −100 враг … +100 союзник). */
const RELATION_MIN = -100;
const RELATION_MAX = 100;

/** Канонический ключ неупорядоченной пары фракций (сорт. по id — детерминизм). */
function relationKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Валидирует `factions.json.relations`: каждое ребро ссылается на СУЩЕСТВУЮЩИЕ id
 * (резолвятся в `validIds`), `a !== b` (петля-отношение не хранится, подразумевается
 * максимум), `value ∈ [−100, 100]`, и НЕТ дублей по неупорядоченной паре (симметрия:
 * `rel(a,b) === rel(b,a)` ⇒ обратное ребро было бы избыточным/противоречивым). Порядок
 * `a`/`b` в JSON произволен — канонизируется ключом (закон №8). Возвращает исходный
 * список (порядок сохранён для стабильности снапшота контента).
 */
function validateFactionRelations(
  data: unknown,
  validIds: ReadonlySet<string>,
): readonly FactionRelation[] {
  assert(data !== null && typeof data === 'object', 'factions.json: не объект');
  const arr = (data as { relations?: unknown }).relations;
  assert(Array.isArray(arr), 'factions.json: relations должен быть массивом');
  const relations = arr as FactionRelation[];
  const seen = new Set<string>();
  relations.forEach((r, i) => {
    assert(typeof r.a === 'string' && validIds.has(r.a), `relations #${i}: неизвестная фракция a="${r.a}"`);
    assert(typeof r.b === 'string' && validIds.has(r.b), `relations #${i}: неизвестная фракция b="${r.b}"`);
    assert(r.a !== r.b, `relations #${i}: отношение фракции "${r.a}" с собой не хранится`);
    assert(inRange(r.value, RELATION_MIN, RELATION_MAX), `relations #${i}: value ${r.value} вне [${RELATION_MIN},${RELATION_MAX}]`);
    const key = relationKey(r.a, r.b);
    assert(!seen.has(key), `relations #${i}: дубль пары ${key} (отношение симметрично)`);
    seen.add(key);
  });
  return relations;
}

// ── Валидация поселений (закон №10) ──────────────────────────────────────────

/**
 * Валидирует `settlements.json`: каждое поселение стоит на РЕАЛЬНОЙ локации-
 * поселении (`map.locations[loc].type === 'settlement'` — связность с картой),
 * владеющая `faction` резолвится, `shelterBase ∈ [0,10]`, подушевое потребление
 * неотрицательно, каждый рецепт ссылается на существующие itemId (`out` и все
 * `in.item`) с `qty>0` целым и `labor>0`, `buildQueue` — непустые строки, стартовый
 * склад — существующие itemId с целыми `qty>0` (закон №3), `startingTreasury >= 0`.
 * `loc` уникален (одно поселение на локацию). `resolveItem`/`resolveFaction` —
 * инъекция резолверов (модульные `getItem`/`getFaction` объявлены ниже по файлу).
 */
function validateSettlements(
  data: unknown,
  locCount: number,
  locType: (loc: number) => string | undefined,
  itemExists: (id: string) => boolean,
  factionExists: (id: string) => boolean,
): readonly SettlementData[] {
  assert(data !== null && typeof data === 'object', 'settlements.json: не объект');
  const arr = (data as { settlements?: unknown }).settlements;
  assert(Array.isArray(arr), 'settlements.json: settlements должен быть массивом');
  const settlements = arr as SettlementData[];
  assert(settlements.length > 0, 'settlements.json: список пуст');
  const seenLoc = new Set<number>();
  settlements.forEach((s, i) => {
    assert(Number.isInteger(s.loc) && s.loc >= 0 && s.loc < locCount, `поселение #${i}: loc=${s.loc} вне диапазона локаций`);
    assert(!seenLoc.has(s.loc), `поселение #${i}: дубль loc=${s.loc} (одно поселение на локацию)`);
    seenLoc.add(s.loc);
    // СВЯЗНОСТЬ С КАРТОЙ (D-025): поселение обязано стоять на type==='settlement'.
    assert(locType(s.loc) === 'settlement', `поселение loc=${s.loc}: локация не type 'settlement' (а '${locType(s.loc)}')`);
    assert(factionExists(s.faction), `поселение loc=${s.loc}: неизвестная фракция "${s.faction}"`);
    assert(inRange(s.shelterBase, 0, 10), `поселение loc=${s.loc}: shelterBase ${s.shelterBase} вне [0,10]`);
    // Потребление.
    assert(s.consumption !== null && typeof s.consumption === 'object', `поселение loc=${s.loc}: нет consumption`);
    const pc = s.consumption.perCapita;
    assert(pc !== null && typeof pc === 'object', `поселение loc=${s.loc}: нет consumption.perCapita`);
    assert(typeof pc.food === 'number' && pc.food >= 0, `поселение loc=${s.loc}: perCapita.food < 0`);
    assert(typeof pc.water === 'number' && pc.water >= 0, `поселение loc=${s.loc}: perCapita.water < 0`);
    // Рецепты (itemId существуют, закон №3).
    assert(Array.isArray(s.recipes), `поселение loc=${s.loc}: recipes не массив`);
    s.recipes.forEach((r, ri) => {
      assert(itemExists(r.out), `поселение loc=${s.loc} рецепт #${ri}: неизвестный out "${r.out}"`);
      assert(typeof r.labor === 'number' && r.labor > 0, `поселение loc=${s.loc} рецепт #${ri}: labor должен быть >0`);
      assert(Array.isArray(r.in) && r.in.length > 0, `поселение loc=${s.loc} рецепт #${ri}: пустой in`);
      r.in.forEach((ing: { item: string; qty: number }, ii: number) => {
        assert(itemExists(ing.item), `поселение loc=${s.loc} рецепт #${ri} in #${ii}: неизвестный предмет "${ing.item}"`);
        assert(Number.isInteger(ing.qty) && ing.qty > 0, `поселение loc=${s.loc} рецепт #${ri} in #${ii}: qty должен быть целым >0`);
      });
    });
    // Очередь стройки (непустые строки-id проектов).
    assert(Array.isArray(s.buildQueue), `поселение loc=${s.loc}: buildQueue не массив`);
    s.buildQueue.forEach((p, pi) => assert(typeof p === 'string' && p.length > 0, `поселение loc=${s.loc} buildQueue #${pi}: пустой projectId`));
    // Стартовый склад (закон №3: реальные предметы, целые qty>0).
    assert(Array.isArray(s.startingWarehouse) && s.startingWarehouse.length > 0, `поселение loc=${s.loc}: пустой startingWarehouse`);
    const seenItem = new Set<string>();
    s.startingWarehouse.forEach((w, wi) => {
      assert(itemExists(w.item), `поселение loc=${s.loc} склад #${wi}: неизвестный предмет "${w.item}"`);
      assert(!seenItem.has(w.item), `поселение loc=${s.loc} склад #${wi}: дубль предмета "${w.item}"`);
      seenItem.add(w.item);
      assert(Number.isInteger(w.qty) && w.qty > 0, `поселение loc=${s.loc} склад #${wi}: qty должен быть целым >0`);
    });
    // Касса.
    assert(typeof s.startingTreasury === 'number' && Number.isFinite(s.startingTreasury) && s.startingTreasury >= 0, `поселение loc=${s.loc}: startingTreasury должен быть >=0`);
  });
  return settlements;
}

// ── Валидация аномальных полей (закон №10, задача 2.16b) ─────────────────────

/**
 * Валидирует `anomaly_fields.json` (Фаза 2, задача 2.16b): каждое поле стоит на
 * РЕАЛЬНОЙ локации ГЛУБОКОЙ Зоны (`map.locations[loc].type ∈ {wild, ruins}` —
 * связность с картой + D-025 «аномалии живут в дикой/руинной глубине», выражено
 * через ДАННЫЕ-тип, а НЕ хардкод-id), `loc` в диапазоне карты, `tier` — целое >=0
 * (отображается в артефакт через `getArtifactForTier`, который клампит ступень выше
 * контента — поэтому достаточно неотрицательного целого; закон №3/№10). Несколько
 * полей на одной локации ДОПУСТИМЫ (несколько аномалий в одном узле — не ошибка).
 * `locType` — инъекция резолвера типа локации (модульный `MAP.locations[loc].type`).
 *
 * ── Закон №3: поля НЕ несут стартовой массы ────────────────────────────────
 * Здесь проверяется лишь РАЗМЕЩЕНИЕ и ступень: стартового склада у поля нет
 * (charge=0, лут пуст — материализует worldgen 2.16b), поэтому валидировать
 * инвентарь/кассу (как у поселений) не нужно — базлайн EconomyInvariant от полей
 * не растёт.
 */
function validateAnomalyFields(
  data: unknown,
  locCount: number,
  locType: (loc: number) => string | undefined,
): readonly AnomalyFieldData[] {
  assert(data !== null && typeof data === 'object', 'anomaly_fields.json: не объект');
  const arr = (data as { fields?: unknown }).fields;
  assert(Array.isArray(arr), 'anomaly_fields.json: fields должен быть массивом');
  const fields = arr as AnomalyFieldData[];
  assert(fields.length > 0, 'anomaly_fields.json: список пуст');
  fields.forEach((f, i) => {
    assert(
      Number.isInteger(f.loc) && f.loc >= 0 && f.loc < locCount,
      `поле #${i}: loc=${f.loc} вне диапазона локаций`,
    );
    // ГЛУБОКАЯ ЗОНА (D-025): поле обязано стоять в wild/ruins — выражено через ДАННЫЕ
    // (тип локации), а не через хардкод конкретной локации (future-proof для новых карт).
    const t = locType(f.loc);
    assert(
      t === 'wild' || t === 'ruins',
      `поле loc=${f.loc}: локация type '${t}' — аномальные поля живут только в wild/ruins (D-025)`,
    );
    assert(
      Number.isInteger(f.tier) && f.tier >= 0,
      `поле loc=${f.loc}: tier=${f.tier} должен быть целым >=0 (ступень артефакта, D-054)`,
    );
  });
  return fields;
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

// ── Валидация радио-шаблонов (закон №10, задача 3.4, D-069) ──────────────────

/**
 * Разрешённые ПЛЕЙСХОЛДЕРЫ шаблонов сообщений. `renderMessage` подставляет их из
 * `params`/`ctx`; любой иной токен `{...}` в контенте — опечатка (напр. `{loc }`,
 * `{name}`), которая молча осталась бы в эфире неразобранной. Держим набор ДАННЫМИ
 * рядом с валидатором (единый источник правды для рендера — см. `narrative/render`).
 */
const VALID_PLACEHOLDERS = new Set(['speaker', 'subject', 'loc', 'count', 'item']);

/** Извлекает имена всех плейсхолдеров `{name}` из строки шаблона. */
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/**
 * Обязательный БАЗОВЫЙ темперамент — фолбэк рендера. Каждый тип события ОБЯЗАН
 * иметь непустой пул под этим кодом (`narrative/render` откатывается на него,
 * если у события нет пула под темперамент говорящего).
 */
const FALLBACK_TEMPERAMENT = 'neutral';

/** Минимум шаблонов на ТИП события (GDD §8.3: пул 15–25, чтобы эфир не робел). */
const MIN_TEMPLATES_PER_EVENT = 15;

/**
 * Валидирует `messages.json` (задача 3.4, закон №10 — контент радио в данных, D-069).
 * Fail-fast на кривом контенте, чтобы битый шаблон не всплыл строкой-мусором в
 * эфире рантайма. Проверяет:
 *  - `version` — положительное целое; `temperaments` — непустой список непустых
 *    уникальных строк, СОДЕРЖИТ базовый `'neutral'` (фолбэк рендера);
 *  - `templates` — непустой объект; каждый ТИП события несёт непустой пул под
 *    `'neutral'` (фолбэк обязателен) и в сумме по темпераментам >= 15 шаблонов
 *    (GDD §8.3 — против роботизированного эфира);
 *  - каждый ключ-темперамент объявлен в `temperaments`; каждый пул — непустой
 *    массив непустых строк;
 *  - шаблоны — ТОЛЬКО текст+валидные плейсхолдеры: неизвестный `{...}` → throw;
 *    любой символ разметки `<`/`>` → throw (закон №5: сообщение = plain-строка,
 *    НЕ DOM/HTML; рендер отдаёт текст, стиль — забота UI Фазы 4).
 */
function validateMessages(data: unknown): MessagesData {
  assert(data !== null && typeof data === 'object', 'messages.json: не объект');
  const m = data as { version?: unknown; temperaments?: unknown; templates?: unknown };
  assert(
    Number.isInteger(m.version) && (m.version as number) > 0,
    'messages.json: version должен быть целым >0',
  );
  assert(Array.isArray(m.temperaments), 'messages.json: temperaments должен быть массивом');
  const temperaments = m.temperaments as string[];
  assert(temperaments.length > 0, 'messages.json: temperaments пуст');
  const tempSet = new Set<string>();
  temperaments.forEach((t, i) => {
    assert(typeof t === 'string' && t.length > 0, `messages.json: temperaments[${i}] пуст`);
    assert(!tempSet.has(t), `messages.json: дублирующийся темперамент "${t}"`);
    tempSet.add(t);
  });
  assert(
    tempSet.has(FALLBACK_TEMPERAMENT),
    `messages.json: в temperaments нет обязательного фолбэка "${FALLBACK_TEMPERAMENT}"`,
  );

  assert(m.templates !== null && typeof m.templates === 'object', 'messages.json: нет templates');
  const templates = m.templates as Record<string, Record<string, unknown>>;
  // Детерминированный обход ключей (закон №8): сортируем перед итерацией. На состояние
  // мира не влияет (загрузка), но держим порядок сообщений об ошибке стабильным.
  const eventTypes = Object.keys(templates).sort();
  assert(eventTypes.length > 0, 'messages.json: templates пуст (нет типов событий)');

  for (const evt of eventTypes) {
    const byTemp = templates[evt];
    assert(byTemp !== null && typeof byTemp === 'object', `messages.json[${evt}]: не объект`);
    const temps = Object.keys(byTemp).sort();
    assert(temps.length > 0, `messages.json[${evt}]: нет ни одного пула темперамента`);
    // Фолбэк обязателен (рендер откатывается на 'neutral').
    assert(
      temps.includes(FALLBACK_TEMPERAMENT),
      `messages.json[${evt}]: нет обязательного пула "${FALLBACK_TEMPERAMENT}"`,
    );
    let total = 0;
    for (const temp of temps) {
      assert(tempSet.has(temp), `messages.json[${evt}]: темперамент "${temp}" не объявлен в temperaments`);
      const pool = (byTemp as Record<string, unknown>)[temp];
      assert(Array.isArray(pool) && pool.length > 0, `messages.json[${evt}][${temp}]: пул пуст`);
      (pool as unknown[]).forEach((tpl, i) => {
        assert(
          typeof tpl === 'string' && tpl.length > 0,
          `messages.json[${evt}][${temp}][${i}]: шаблон пуст/не строка`,
        );
        const s = tpl as string;
        // Закон №5: никакой разметки — только текст+плейсхолдеры.
        assert(
          !s.includes('<') && !s.includes('>'),
          `messages.json[${evt}][${temp}][${i}]: разметка/HTML запрещена (символ '<'/'>')`,
        );
        // Плейсхолдеры — только из известного набора.
        for (const match of s.matchAll(PLACEHOLDER_RE)) {
          const name = match[1] ?? '';
          assert(
            VALID_PLACEHOLDERS.has(name),
            `messages.json[${evt}][${temp}][${i}]: неизвестный плейсхолдер "{${name}}"`,
          );
        }
        total += 1;
      });
    }
    assert(
      total >= MIN_TEMPLATES_PER_EVENT,
      `messages.json[${evt}]: ${total} шаблонов < минимума ${MIN_TEMPLATES_PER_EVENT} (GDD §8.3)`,
    );
  }

  return m as MessagesData;
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

/**
 * Валидированный и замороженный пул радио-шаблонов (задача 3.4, закон №10, D-069).
 * Читается ЧИСТЫМ рендером `narrative/render.ts` (из templateId+params собирает
 * plain-строку); в тик симуляции не входит — Radio (3.5) подключит выбор шаблона.
 */
export const MESSAGES: MessagesData = deepFreeze(validateMessages(messagesRaw));

/**
 * Валидированный и замороженный список фракций (контент, закон №10). Поверх общей
 * проверки `{id,name}` требует, чтобы опциональное поле `predatory` (диспозиция
 * грабежа, D-062) было boolean, если задано (иначе fail-fast, как прочая валидация
 * контента). Опущено ⇒ фракция не-хищная.
 */
export const FACTIONS: readonly FactionData[] = deepFreeze(
  validateFactions(factionsRaw),
);

/** Валидированный и замороженный список профессий (контент, закон №10). */
export const PROFESSIONS: readonly ProfessionData[] = deepFreeze(
  validateProfessions(professionsRaw),
);

/**
 * Валидированная и замороженная матрица отношений фракций (Фаза 2, закон №10).
 * Хранит по одному ребру на неупорядоченную пару; отношение симметрично (см.
 * `getRelation`). Резолвится против id из FACTIONS.
 */
export const RELATIONS: readonly FactionRelation[] = deepFreeze(
  validateFactionRelations(factionsRaw, new Set(FACTIONS.map((f) => f.id))),
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

/**
 * Артефакты (kind==='artifact'), ОТСОРТИРОВАННЫЕ по возрастанию `tier` (закон №8 —
 * детерминированный выбор в getArtifactForTier). Ступени уникальны (validateItems).
 * Пусто, если контент артефактов не заведён (getArtifactForTier тогда бросит —
 * fail-fast, а не молчаливый «нет артефакта»).
 */
const ARTIFACTS_BY_TIER: readonly ItemData[] = ITEMS.filter((it) => it.kind === 'artifact')
  .slice()
  .sort((a, b) => (a.tier as number) - (b.tier as number));

/** id фракции → FactionData. */
const FACTION_BY_ID: ReadonlyMap<string, FactionData> = new Map(FACTIONS.map((f) => [f.id, f]));

/** id профессии → ProfessionData. */
const PROFESSION_BY_ID: ReadonlyMap<string, ProfessionData> = new Map(
  PROFESSIONS.map((p) => [p.id, p]),
);

/**
 * Валидированный и замороженный список поселений (Фаза 2, закон №10). Резолверы
 * инъектируются как замыкания над уже загруженными данными: `map.locations[loc].type`,
 * членство itemId в `ITEM_BY_ID`, членство фракции в `FACTION_BY_ID`. Так валидатор
 * не тянет ещё-не-объявленные `getItem`/`getFaction` (объявлены ниже по файлу).
 */
export const SETTLEMENTS: readonly SettlementData[] = deepFreeze(
  validateSettlements(
    settlementsRaw,
    MAP.locations.length,
    (loc) => MAP.locations[loc]?.type,
    (id) => ITEM_BY_ID.has(id),
    (id) => FACTION_BY_ID.has(id),
  ),
);

/** loc поселения → SettlementData. */
const SETTLEMENT_BY_LOC: ReadonlyMap<number, SettlementData> = new Map(
  SETTLEMENTS.map((s) => [s.loc, s]),
);

/**
 * Валидированный и замороженный список аномальных полей (Фаза 2, задача 2.16b,
 * закон №10). Резолвер типа локации инъектируется замыканием над MAP (проверка
 * wild/ruins, D-025). worldgen 2.16b материализует по одному носителю AnomalyField
 * (charge=0, лут пуст) на каждую запись — дремлющая система ArtifactSpawn (2.9)
 * оживает и рождает артефакты В ПРОГОНЕ (item/harvested, EconomyInvariant держится).
 */
export const ANOMALY_FIELDS: readonly AnomalyFieldData[] = deepFreeze(
  validateAnomalyFields(
    anomalyFieldsRaw,
    MAP.locations.length,
    (loc) => MAP.locations[loc]?.type,
  ),
);

/** Каноническая пара фракций → value отношения (симметрично, детерминизм ключа). */
const RELATION_BY_PAIR: ReadonlyMap<string, number> = new Map(
  RELATIONS.map((r) => [relationKey(r.a, r.b), r.value]),
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

/**
 * Артефакт для ступени аномального поля `tier` (задача 2.9, D-054, закон №10 — код
 * оперирует id, контент-таблица в items.json). Возвращает артефакт с НАИБОЛЬШИМ
 * `tier <= запрошенного` (поле высокой ступени даёт лучший из достижимых артефактов;
 * ступень выше всего контента — самый ценный имеющийся). Ниже минимальной ступени —
 * артефакт минимальной ступени (клампинг). ДЕТЕРМИНИРОВАН (обход по возрастанию tier).
 * Бросает, если артефактов в контенте нет (fail-fast: система не должна молча родить
 * «ничто»).
 */
export function getArtifactForTier(tier: number): ItemData {
  assert(ARTIFACTS_BY_TIER.length > 0, 'getArtifactForTier: в items.json нет артефактов (kind==="artifact")');
  let chosen = ARTIFACTS_BY_TIER[0] as ItemData;
  for (const a of ARTIFACTS_BY_TIER) {
    if ((a.tier as number) <= tier) chosen = a;
    else break;
  }
  return chosen;
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

/**
 * ХИЩНА ли фракция `id` — читает ДИСПОЗИЦИЮ `predatory` из контента (factions.json,
 * D-062, закон №10: НЕ хардкод id 'bandits' в коде поведения). `true` ⇒ её NPC
 * по природе грабят (утилити-AI выбирает ROB). Неизвестный id ⇒ `false` (не бросаем:
 * потребитель — гейт выбора задачи, для него неизвестная/отсутствующая фракция просто
 * «не хищник», а не фатальная ошибка контента).
 */
export function isPredatoryFaction(id: string): boolean {
  return FACTION_BY_ID.get(id)?.predatory === true;
}

/** Профессия по строковому id. Бросает при неизвестном id (закон №10). */
export function getProfession(id: string): ProfessionData {
  const p = PROFESSION_BY_ID.get(id);
  assert(p !== undefined, `getProfession: неизвестная профессия "${id}"`);
  return p;
}

/** Все поселения (в порядке файла settlements.json). Иммутабельны. */
export function getSettlements(): readonly SettlementData[] {
  return SETTLEMENTS;
}

/** Все аномальные поля (в порядке файла anomaly_fields.json). Иммутабельны. */
export function getAnomalyFields(): readonly AnomalyFieldData[] {
  return ANOMALY_FIELDS;
}

/**
 * Поселение по id локации. Возвращает undefined, если на локации нет поселения
 * (не всякая локация — поселение). Потребитель (worldgen) сам решает, ошибка это
 * или норма.
 */
export function getSettlement(loc: number): SettlementData | undefined {
  return SETTLEMENT_BY_LOC.get(loc);
}

/**
 * Отношение фракций `a` и `b` (симметрично: `getRelation(a,b) === getRelation(b,a)`).
 * Отношение фракции с собой — `RELATION_MAX` (свои всегда «союзники»). Пара без явной
 * записи в матрице трактуется как нейтралитет (0). Бросает на неизвестном id (закон №10).
 */
export function getRelation(a: string, b: string): number {
  assert(FACTION_BY_ID.has(a), `getRelation: неизвестная фракция "${a}"`);
  assert(FACTION_BY_ID.has(b), `getRelation: неизвестная фракция "${b}"`);
  if (a === b) return RELATION_MAX;
  return RELATION_BY_PAIR.get(relationKey(a, b)) ?? 0;
}

/**
 * Пул шаблонов события `eventType` под темперамент `temperament` (задача 3.4).
 * Возвращает `undefined`, если такого типа события или темперамента нет в контенте
 * (рендер решает фолбэк — на `'neutral'` и/или служебную строку помех). НЕ бросает:
 * неизвестный templateId в рантайме — это баг вызывающей стороны (3.5), а не
 * фатальная порча контента (её ловит `validateMessages` при загрузке).
 */
export function getTemplatePool(eventType: string, temperament: string): readonly string[] | undefined {
  return MESSAGES.templates[eventType]?.[temperament];
}

/**
 * Конкретный шаблон `(eventType, temperament, index)` (задача 3.4). `undefined`,
 * если пул отсутствует или индекс вне диапазона. Детерминирован (индексация, без
 * итерации по Map/Set — закон №8).
 */
export function getTemplate(eventType: string, temperament: string, index: number): string | undefined {
  return getTemplatePool(eventType, temperament)?.[index];
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
