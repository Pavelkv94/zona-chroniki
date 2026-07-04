/**
 * @module @zona/sim/systems/economy
 *
 * Система Economy (задача 2.3, B5, D-045/D-046) — ЖИЗНЬ поселений: подушевое
 * ПОТРЕБЛЕНИЕ провизии со склада, ПРОИЗВОДСТВО товара из сырья трудом работников,
 * СТРОИТЕЛЬСТВО проектов и МОРАЛЬ/защита как отклик на достаток/дефицит. Общение —
 * только через ECS-компоненты, «холодный» ResourceStore (склад/касса/долг поселения)
 * и шину событий с `causedBy` (закон №6): других систем Economy напрямую не зовёт.
 *
 * Главный тест закона №1: всё здесь работает БЕЗ игрока — поселения проедают запасы,
 * плодят товар, строят и распадаются от голода по состоянию мира, даже если ни одного
 * игрока (и ни одной внешней команды) нет.
 *
 * ── ЧТО ЧИТАЕТ/ПИШЕТ (только своё, закон №6) ──────────────────────────────────
 * Читает Settlement(morale/security/buildTarget/buildProgress), Position(loc)
 * поселения, Home(loc)/Job(employer) ЛЮДЕЙ (население/работники), склад/кассу/долг
 * поселения (ResourceStore), КОНТЕНТ поселения из data (consumption/recipes/
 * buildQueue). Пишет Settlement (мораль/защита/стройка), склад поселения (расход/
 * выработка), долг потребления (ResourceStore), снимает Job у работников при
 * заброшенности. Публикует ЛЕДЖЕР `item/consumed`(upkeep/production)/`item/produced`
 * (D-045) и `settlement/built`/`settlement/abandoned` (B5). rng НЕ используется —
 * экономика ДЕТЕРМИНИРОВАНА от состояния (закон №2: не «X% исхода», а арифметика/пороги).
 *
 * ── НАСЕЛЕНИЕ и ТРУД ──────────────────────────────────────────────────────────
 * НАСЕЛЕНИЕ поселения = число ЖИВЫХ Human, чей `Home.loc` == локация поселения
 * (жители-резиденты; торговец поселения тоже резидент — его Home на loc поселения).
 * Критерий Home.loc (а не co-located Position) выбран как СТАБИЛЬНАЯ приписка: житель
 * потребляет со склада, даже уйдя в рейд (склад держит провизию на своё население).
 * Он сериализуем (Home/Alive) ⇒ resume-safe и детерминирован (обход по eid). ТРУД =
 * число живых Human с `Job.employer` == eid поселения (наём даёт 2.4; в 2.3 Job никто
 * не навешивает штатно ⇒ производство/стройка без работников = 0 — это ОК и
 * задокументировано; тесты навешивают Job вручную). Когда 2.4 введёт наём, население
 * можно будет уточнить до «Home.loc ИЛИ Job.employer», не меняя контракт события.
 *
 * ── ПОТРЕБЛЕНИЕ: ДРОБНЫЙ СПРОС, ЦЕЛЫЙ РАСХОД (resume-safe, закон №3) ───────────
 * Подушевой спрос задан «в день» (data.perCapita.food/water). За запуск (`every` тиков)
 * спрос = `perCapita × население × (every / TICKS_PER_DAY)` — величина ДРОБНАЯ (при
 * реалистичном населении << 1 единицы за запуск). Предметы же ДИСКРЕТНЫ (закон №3), а
 * массовый инвариант EconomyInvariant сверяет ЦЕЛЫЕ суммы точным равенством — дробный
 * склад дал бы плавающую ошибку в 1 ULP и ложно ронял инвариант. Поэтому:
 *   • дробный спрос КОПИТСЯ в СЕРИАЛИЗУЕМОМ поле `consumptionDebt {food,water}`
 *     (ResourceStore поселения, D-007) — НЕ в несериализуемом рантайм-накопителе и
 *     НЕ лишним полем Settlement (это сдвинуло бы формат снапшота/голдены);
 *   • со склада списываются ТОЛЬКО целые единицы: `want = floor(debt)`, из склада
 *     берётся `min(want, наличие)`, `debt -= want` (в долге остаётся дробный хвост
 *     [0,1) до следующего запуска). Так склад ВСЕГДА целочислен, леджер целочислен,
 *     инвариант держится ТОЧНО (без плавающей арифметики в массе).
 * RESUME-БЕЗОПАСНОСТЬ: `consumptionDebt` — в снапшоте (ResourceStore сериализуется),
 * поэтому split (run→save→load→run) продолжает накопление ТОЖДЕСТВЕННО непрерывному
 * прогону (доказано хэшем в тесте). Дефицит: если `want > наличия`, берём что есть,
 * НЕизрасходованный спрос ТЕРЯЕТСЯ (голод — не долг, debt хранит лишь дробный хвост),
 * и запуск помечается ДЕФИЦИТНЫМ. Каждое реальное списание → `item/consumed
 * {who:поселение, item, qty, reason:'upkeep'}` (`causedBy: null` — потребление есть
 * эндогенный корень, как физиология). Расход по видам-провизии: food = предметы kind
 * 'food', water = kind 'drink' (items.json); внутри вида — по возрастанию itemId
 * (детерминизм, закон №8).
 *
 * ── ПРОИЗВОДСТВО: сырьё + труд → товар (атомарно, целочисленно) ────────────────
 * Для каждого рецепта поселения (порядок = settlements.json): партий по труду =
 * `floor(работники / recipe.labor)` (labor — человеко-единиц труда на партию), партий
 * по сырью = min по `in` из `floor(наличие / нужно)`; берём МИНИМУМ. При >0: физически
 * тратим сырьё (`item/consumed reason:'production'`) и создаём `out` (по 1 на партию,
 * `item/produced`). Только при наличии сырья И труда — иначе 0 (без работников
 * производства нет: закон №1 — товар не берётся из воздуха, его вырабатывают руки).
 *
 * ── МОРАЛЬ / ЗАЩИТА / ЗАБРОШЕННОСТЬ ───────────────────────────────────────────
 * Мораль (Settlement.morale, 0..1): ДЕФИЦИТНЫЙ запуск (спрос был, склад не покрыл)
 * роняет её на `MORALE_DEFICIT_DROP`; запуск с ПОЛНОСТЬЮ покрытым спросом поднимает к
 * `MORALE_MAX` на `MORALE_RECOVER`; запуск БЕЗ целого спроса (дробный спрос малого
 * поселения ещё не накопил юнит) — НЕЙТРАЛЕН (иначе частые «пустые» запуски ложно
 * разгоняли бы мораль, и голод не проявлялся бы). Ставки — balance/economy. Как
 * только мораль просела до/ниже `MORALE_ABANDON_THRESHOLD` — поселение ЗАБРОШЕНО:
 * `settlement/abandoned` (`causedBy` = id ПОСЛЕДНЕГО дефицитного `item/consumed(upkeep)`
 * этого запуска, либо `null`, если склад был пуст и списания-события не возникло),
 * ResourceStore-флаг `settlementAbandoned=true` (сериализуем ⇒ событие эмитится РОВНО
 * раз, resume-safe), работники теряют `Job`. Сущность поселения НЕ удаляется — Economy
 * лишь перестаёт её обслуживать. «Затяжной дефицит» кодируется без счётчика дней:
 * мораль (сериализуемая) пробивает порог лишь после многих дефицитных запусков подряд.
 * Защита (Settlement.security) — ПРОИЗВОДНАЯ: `clamp(население × SECURITY_PER_CAPITA,
 * 0, SECURITY_MAX)` (упрощённо, D-046; на грабёж влияет 2.12). Чисто от населения ⇒
 * resume-safe без хранимого состояния.
 *
 * ── СТРОИТЕЛЬСТВО ─────────────────────────────────────────────────────────────
 * При наличии труда `buildProgress += BUILD_PROGRESS_PER_WORKER × работники`. Стройка
 * стартует, когда `buildTarget==0` и очередь непуста (buildTarget := 1 — 1-based индекс
 * текущего проекта в buildQueue; 0 = ничего не строится, совпадает с занулением
 * addComponent). На 100% → `settlement/built {settlement, project}` (`causedBy: null` —
 * завершение есть эндогенный корень), прогресс сбрасывается, buildTarget переходит к
 * следующему проекту очереди (или 0, если очередь исчерпана). Ресурсы стройки в 2.3
 * не расходуются (упрощённо — только труд).
 *
 * ── ДЕТЕРМИНИЗМ (закон №8) ────────────────────────────────────────────────────
 * Обход поселений — `queryEntities([Settlement])` (сорт. по eid). Перепись населения/
 * труда строится обходом `queryEntities([Human, Alive])` (сорт. по eid) ⇒ списки
 * работников в порядке eid. Внутри склада расход/выработка идут по ОТСОРТИРОВАННЫМ
 * itemId. rng не участвует. Долг/склад/мораль/прогресс — сериализуемы ⇒ split ≡
 * continuous (P0). Система в registerPhase1Systems НЕ входит (подключит 2.16), поэтому
 * голдены Фазы 1 не сдвигаются.
 */

import type { EntityId, EventId, ItemId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { EventBus } from '../core/events';
import type { ResourceStore } from '../core/world';
import { queryEntities, hasComponent, removeComponent } from '../core/ecs';
import { Settlement, Position, Home, Job, Human, Alive } from '../core/components';
import { getSettlement, getItem } from '../data/index';
import { TICKS_PER_DAY } from '../balance/time';
import {
  ECONOMY_CADENCE,
  MORALE_MAX,
  MORALE_MIN,
  MORALE_DEFICIT_DROP,
  MORALE_RECOVER,
  MORALE_ABANDON_THRESHOLD,
  SECURITY_PER_CAPITA,
  SECURITY_MAX,
  BUILD_PROGRESS_PER_WORKER,
} from '../balance/economy';

/** Склад/личный инвентарь под ключом 'inventory' (D-046, форма worldgen 2.2). */
const INVENTORY_KEY = 'inventory';
/** Дробный долг потребления поселения (сериализуем, resume-safe накопитель). */
const DEBT_KEY = 'consumptionDebt';
/** Флаг заброшенности поселения (сериализуем; событие эмитится ровно раз). */
const ABANDONED_KEY = 'settlementAbandoned';

/** Единица склада (форма worldgen 2.2 / систем, сорт. по item). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/** Дробный долг потребления по видам провизии (копит хвост < 1 единицы). */
interface ConsumptionDebt {
  readonly food: number;
  readonly water: number;
}

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const SETTLE = Settlement as unknown as {
  morale: Float32Array;
  security: Float32Array;
  buildTarget: Uint8Array;
  buildProgress: Float32Array;
};
const POS = Position as unknown as { readonly loc: Uint32Array };
const HOME = Home as unknown as { readonly loc: Uint32Array };
const JOB = Job as unknown as { readonly employer: Uint32Array };

/** Значение, зажатое в отрезок [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** true, если предмет — провизия-ЕДА (kind 'food'). */
function isFood(item: string): boolean {
  return getItem(item).kind === 'food';
}

/** true, если предмет — провизия-ПИТЬЁ (kind 'drink'). */
function isDrink(item: string): boolean {
  return getItem(item).kind === 'drink';
}

/** Перепись населения (по loc) и работников (по eid работодателя) из ЖИВЫХ людей. */
interface Census {
  /** loc поселения → число резидентов (Human, Alive, Home.loc == loc). */
  readonly residentsByLoc: Map<number, number>;
  /** eid поселения-работодателя → список работников (Human, Alive, Job.employer), сорт. eid. */
  readonly workersByEmployer: Map<number, EntityId[]>;
}

/** Строит перепись, обходя людей по возрастанию eid (закон №8 — списки в порядке eid). */
function buildCensus(ecs: SystemCtx['world']['ecs']): Census {
  const residentsByLoc = new Map<number, number>();
  const workersByEmployer = new Map<number, EntityId[]>();
  for (const h of queryEntities(ecs, [Human, Alive])) {
    if (hasComponent(ecs, Home, h)) {
      const loc = HOME.loc[h] as number;
      residentsByLoc.set(loc, (residentsByLoc.get(loc) ?? 0) + 1);
    }
    if (hasComponent(ecs, Job, h)) {
      const emp = JOB.employer[h] as number;
      let list = workersByEmployer.get(emp);
      if (list === undefined) {
        list = [];
        workersByEmployer.set(emp, list);
      }
      list.push(h);
    }
  }
  return { residentsByLoc, workersByEmployer };
}

/**
 * Результат списания одного вида провизии: сколько ЦЕЛЫХ единиц реально снято и
 * EventId ПОСЛЕДНЕГО опубликованного `item/consumed(upkeep)` (0 — ничего не снято).
 */
interface Drawdown {
  readonly taken: number;
  readonly lastEventId: number;
}

/**
 * Списывает `want` целых единиц провизии, подходящей под `matches`, из `stock`
 * (мутирует Map), по ВОЗРАСТАНИЮ itemId (детерминизм). На каждое реальное списание —
 * `item/consumed {who, item, qty, reason:'upkeep'}` (`causedBy: null`). Возвращает,
 * сколько снято суммарно и id последнего события (для причинности заброшенности).
 */
function drawdown(
  stock: Map<string, number>,
  matches: (item: string) => boolean,
  want: number,
  eid: EntityId,
  bus: EventBus,
): Drawdown {
  if (want <= 0) return { taken: 0, lastEventId: 0 };
  let remaining = want;
  let lastEventId = 0;
  // Обход itemId по возрастанию — детерминированный порядок расхода (закон №8).
  for (const item of Array.from(stock.keys()).sort()) {
    if (remaining <= 0) break;
    if (!matches(item)) continue;
    const have = stock.get(item) as number;
    if (have <= 0) continue;
    const take = Math.min(remaining, have);
    stock.set(item, have - take);
    remaining -= take;
    const id = bus.publish({
      type: 'item/consumed',
      causedBy: null,
      payload: { who: eid, item: item as ItemId, qty: take, reason: 'upkeep' },
    });
    lastEventId = id;
  }
  return { taken: want - remaining, lastEventId };
}

/** Перезаписывает склад поселения из `stock`: только qty>0, ОТСОРТИРОВАН по itemId. */
function writeInventory(resources: ResourceStore, eid: EntityId, stock: Map<string, number>): void {
  const out: InventoryEntry[] = [];
  for (const item of Array.from(stock.keys()).sort()) {
    const qty = stock.get(item) as number;
    if (qty > 0) out.push({ item: item as ItemId, qty });
  }
  resources.set<readonly InventoryEntry[]>(INVENTORY_KEY, eid, out);
}

/**
 * Система Economy (`every: ECONOMY_CADENCE`). На каждый носитель Settlement (сорт. по
 * eid, не заброшенный): потребление → мораль → защита → (заброшенность?) →
 * производство → стройка. Детерминирована, rng не использует.
 */
export const Economy: System = {
  name: 'Economy',
  schedule: { every: ECONOMY_CADENCE },
  update(ctx: SystemCtx): void {
    const { world, bus } = ctx;
    const ecs = world.ecs;
    const resources = world.resources;

    const settlements = queryEntities(ecs, [Settlement]);
    if (settlements.length === 0) return;

    const census = buildCensus(ecs);
    const dayFraction = ECONOMY_CADENCE / TICKS_PER_DAY;

    for (const eid of settlements) {
      // Заброшенное поселение инертно (Economy его больше не обслуживает).
      if (resources.get<boolean>(ABANDONED_KEY, eid) === true) continue;

      const loc = POS.loc[eid] as number;
      const data = getSettlement(loc);
      if (data === undefined) continue; // носитель Settlement без контент-записи — пропуск

      const pop = census.residentsByLoc.get(loc) ?? 0;
      const workers = census.workersByEmployer.get(eid) ?? [];

      // Рабочая копия склада (Map: item → qty). Пишется обратно один раз в конце.
      const inv = resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid) ?? [];
      const stock = new Map<string, number>();
      for (const e of inv) stock.set(e.item, (stock.get(e.item) ?? 0) + e.qty);

      // ── ПОТРЕБЛЕНИЕ (дробный долг → целый расход) ─────────────────────────
      const debt = resources.get<ConsumptionDebt>(DEBT_KEY, eid) ?? { food: 0, water: 0 };
      let debtFood = debt.food + data.consumption.perCapita.food * pop * dayFraction;
      let debtWater = debt.water + data.consumption.perCapita.water * pop * dayFraction;
      const wantFood = Math.floor(debtFood);
      const wantWater = Math.floor(debtWater);
      debtFood -= wantFood; // в долге остаётся дробный хвост [0,1)
      debtWater -= wantWater;
      resources.set<ConsumptionDebt>(DEBT_KEY, eid, { food: debtFood, water: debtWater });

      const foodDraw = drawdown(stock, isFood, wantFood, eid, bus);
      const waterDraw = drawdown(stock, isDrink, wantWater, eid, bus);

      // Был ли в этом запуске РЕАЛЬНЫЙ спрос (накопился хотя бы 1 целый юнит)? При
      // малом населении спрос копится дробно и целый юнит запрашивается редко —
      // запуск БЕЗ целого спроса НЕЙТРАЛЕН для морали (не «сыты», а «пока не ели»).
      const anyDemand = wantFood > 0 || wantWater > 0;
      // Дефицит: спрос был, а склад не покрыл (голод/жажда). Неснятое ТЕРЯЕТСЯ.
      const deficit =
        (wantFood > 0 && foodDraw.taken < wantFood) ||
        (wantWater > 0 && waterDraw.taken < wantWater);
      // id последнего дефицитного списания (для причинности заброшенности): вода
      // публикуется ПОСЛЕ еды ⇒ её id новее; пусто → id еды; оба пусты → 0.
      const lastUpkeepId = waterDraw.lastEventId !== 0 ? waterDraw.lastEventId : foodDraw.lastEventId;

      // ── МОРАЛЬ ────────────────────────────────────────────────────────────
      // Дефицит роняет; спрос ПОКРЫТ полностью — поднимает; НЕТ целого спроса —
      // без изменений (иначе частые «пустые» запуски малого поселения ложно
      // разгоняли бы мораль вверх, и голод никогда не проявлялся бы).
      let moraleDelta = 0;
      if (deficit) moraleDelta = -MORALE_DEFICIT_DROP;
      else if (anyDemand) moraleDelta = MORALE_RECOVER;
      const morale = clamp((SETTLE.morale[eid] as number) + moraleDelta, MORALE_MIN, MORALE_MAX);
      SETTLE.morale[eid] = morale;

      // ── ЗАЩИТА (производная от населения) ─────────────────────────────────
      SETTLE.security[eid] = clamp(pop * SECURITY_PER_CAPITA, 0, SECURITY_MAX);

      // ── ЗАБРОШЕННОСТЬ (затяжной дефицит просадил мораль до порога) ─────────
      if (morale <= MORALE_ABANDON_THRESHOLD) {
        writeInventory(resources, eid, stock); // зафиксировать уже случившийся расход
        const reason =
          `заброшено: затяжной дефицит провизии (мораль ${morale.toFixed(2)} <= ` +
          `порог ${MORALE_ABANDON_THRESHOLD}); население ${pop}`;
        bus.publish({
          type: 'settlement/abandoned',
          causedBy: lastUpkeepId !== 0 ? (lastUpkeepId as EventId) : null,
          payload: { settlement: eid, reason },
        });
        resources.set<boolean>(ABANDONED_KEY, eid, true);
        // Работники теряют занятость (поселения-работодателя больше нет).
        for (const w of workers) removeComponent(ecs, Job, w);
        continue; // заброшенное не производит и не строит
      }

      // ── ПРОИЗВОДСТВО (сырьё + труд → товар, целочисленно, атомарно) ────────
      for (const recipe of data.recipes) {
        const batchesByLabor = Math.floor(workers.length / recipe.labor);
        if (batchesByLabor <= 0) continue; // нет труда — нет выработки
        let batchesByMat = Infinity;
        for (const ing of recipe.in) {
          batchesByMat = Math.min(batchesByMat, Math.floor((stock.get(ing.item) ?? 0) / ing.qty));
        }
        const batches = Math.min(batchesByLabor, batchesByMat);
        if (batches <= 0) continue; // не хватает сырья

        // Физически тратим сырьё (леджер consumed:production).
        for (const ing of recipe.in) {
          const used = ing.qty * batches;
          stock.set(ing.item, (stock.get(ing.item) ?? 0) - used);
          bus.publish({
            type: 'item/consumed',
            causedBy: null,
            payload: { who: eid, item: ing.item as ItemId, qty: used, reason: 'production' },
          });
        }
        // Физически создаём товар (леджер produced): по 1 out на партию.
        stock.set(recipe.out, (stock.get(recipe.out) ?? 0) + batches);
        bus.publish({
          type: 'item/produced',
          causedBy: null,
          payload: { settlement: eid, item: recipe.out as ItemId, qty: batches },
        });
      }

      // ── СТРОИТЕЛЬСТВО (только при наличии труда) ──────────────────────────
      // buildTarget — 1-based индекс текущего проекта в buildQueue: 0 = «ещё не
      // начинали» (совпадает с занулением addComponent), значение > buildQueue.length
      // = «очередь ИСЧЕРПАНА» (done-сентинел). Различать эти два состояния критично:
      // иначе сброс в 0 после последнего проекта заставил бы стройку зацикливаться
      // (0 снова читается как «начать первый»). Поэтому по завершении buildTarget
      // РАСТЁТ дальше (nextTarget), а не сбрасывается в 0.
      if (workers.length > 0) {
        let buildTarget = SETTLE.buildTarget[eid] as number;
        // Старт стройки: ещё не начинали (ровно 0) и очередь непуста → первый проект.
        if (buildTarget === 0 && data.buildQueue.length > 0) buildTarget = 1;
        // Прогресс идёт, только если buildTarget указывает на РЕАЛЬНЫЙ проект очереди.
        if (buildTarget >= 1 && buildTarget - 1 < data.buildQueue.length) {
          let progress = (SETTLE.buildProgress[eid] as number) + BUILD_PROGRESS_PER_WORKER * workers.length;
          if (progress >= 1) {
            const project = data.buildQueue[buildTarget - 1] as string;
            bus.publish({
              type: 'settlement/built',
              causedBy: null,
              payload: { settlement: eid, project },
            });
            progress = 0;
            // Переходим к следующему проекту; если он за концом очереди — buildTarget
            // становится done-сентинелом (> length), и стройка больше НЕ запускается.
            buildTarget += 1;
          }
          SETTLE.buildProgress[eid] = progress;
          SETTLE.buildTarget[eid] = buildTarget;
        }
      }

      // Единая запись склада после потребления+производства (сорт. по itemId).
      writeInventory(resources, eid, stock);
    }
  },
};
