/**
 * @module @zona/shared/events
 *
 * Контракт события шины (append-only лог, задача 0.4, D-005). Чистые типы без
 * зависимостей от bitecs/DOM/Node (закон №5): реализация шины живёт в
 * `@zona/sim/core/events`, а форму события знают все пакеты монорепо (ui читает
 * лог, headless прогоняет, narrative строит летопись).
 *
 * `SimEventBase` — общая «шапка» любого события:
 *  - `id`       — монотонный `EventId`, присваивается шиной при `publish`
 *                 (переживает save/load, C-4);
 *  - `tick`     — тик, на котором событие ОПУБЛИКОВАНО (берётся из мира);
 *  - `type`     — строковый дискриминант union'а;
 *  - `causedBy` — id события-причины или `null` для корня причинной цепочки
 *                 (закон №6: каждое событие несёт причину).
 *
 * `SimEvent` — расширяемый дискриминированный union. Фаза 0 знает только
 * СЛУЖЕБНЫЕ типы ядра (`sim/tickStarted`, `sim/snapshotTaken`); доменные события
 * (бой, миграция, торговля) профильные инженеры добавят позже, расширив union
 * новыми членами с уникальным `type` и своим `payload`. Фаза 1: система Movement
 * (1.4) добавляет `move/departed` (сущность вышла из локации в соседнюю) и
 * `move/arrived` (сущность достигла соседней локации). Причинность (закон №6):
 * `move/departed.causedBy` → событие выбора задачи (`task/selected` из 1.8), для
 * departure ЖИВОТНОГО (Animals 1.9) — `perception/spotted` при БЕГСТВЕ от человека
 * (ретрофит 1.10a: id взят из `Contact.spottedEvent`, D-030), либо `null` (корень:
 * стадность/приплод/иной экологический драйв); `move/arrived.causedBy` →
 * соответствующий `move/departed` этого шага.
 * Задача 1.6 (система Weather) добавляет `weather/changed` (среда сменила погоду);
 * `causedBy` → предыдущий `weather/changed` в логе (цепочка смен), `null` — первая
 * смена в истории мира (корень цепочки погоды). Задача 1.7 (система Perception)
 * добавляет `perception/spotted` (наблюдатель впервые заметил цель в локации);
 * `causedBy` → движение, сведшее их в поле зрения (`move/*`), либо `null`. Задача 1.9
 * (система Animals) добавляет `animal/born` (стадо принесло приплод по ПРИЧИННЫМ
 * порогам состояния мира — не «X% приплод»); `causedBy: null` — экологический порог
 * есть корень причинной цепочки (закон №2), как физиология Needs и генерация Weather.
 * Задача 2.0 (Фаза 2, EconomyInvariant, D-045) добавляет ПЯТЬ ЛЕДЖЕР-событий массы
 * (`item/produced`, `item/consumed`, `item/harvested`, `item/broughtIn`,
 * `item/exported`) — единственный легальный способ ИЗМЕНИТЬ суммарную массу
 * (Σ money + Σ inventory) замкнутой экономики (закон №3). Их дельта сверяется
 * read-only чекером EconomyInvariant (`@zona/headless`) с фактическим изменением
 * тоталов мира. Переводы (торговля/грабёж) массу СОХРАНЯЮТ и события не требуют.
 * В Фазе 2.0 РЕАЛЬНО эмитятся только `item/consumed` (расход еды/патронов) и
 * `item/harvested` (мясо с туши) — ретрофит дыр Фазы 1; остальные три — заготовки.
 *
 * Пример:
 * ```ts
 * const e: SimEvent = {
 *   id: 1 as EventId,
 *   tick: 0,
 *   type: 'sim/tickStarted',
 *   causedBy: null,
 *   payload: { tick: 0 },
 * };
 * ```
 */

import type { EntityId, EventId, ItemId, LocationId, Tick } from './ids';
import type { Subject } from './memory';

/**
 * Вид физиологической нужды (дискриминант в `needs/threshold`). Совпадает с
 * именами полей компонента `Needs` (hunger/thirst/fatigue/fear). Страх (fear)
 * порогов от системы Needs не даёт (она его только затухает); его пересечение
 * порога публикует Perception (1.7) — тип нужды перечислен здесь ради полноты
 * контракта события.
 */
export type NeedKind = 'hunger' | 'thirst' | 'fatigue' | 'fear';

/**
 * Причина расхода предмета в `item/consumed` (задача 2.0, D-045). Именованный
 * union (а не сырая строка) держит леджер читаемым и типобезопасным. Фаза 1
 * эмитит `'eat'` (TaskEffects съел еду) и `'combat'` (Encounters потратил патроны).
 * Задача 2.3 (Economy) добавляет `'upkeep'` (поселение проело провизию со склада —
 * подушевое потребление жителей) и `'production'` (мастерская израсходовала сырьё
 * рецепта, превратив его в готовый товар — парно к `item/produced`). Форма замёрзла,
 * значения union'а добавляются APPEND-ONLY по мере появления новых источников расхода.
 */
export type ItemConsumeReason = 'eat' | 'combat' | 'upkeep' | 'production';

/**
 * Источник добытого предмета в `item/harvested` (задача 2.0, D-045). `'carcass'` —
 * мясо с туши убитого животного (Encounters, Фаза 1). `'anomaly'` — артефакт,
 * РОЖДЁННЫЙ аномальным полем по накоплению заряда (ArtifactSpawn 2.9, D-054): масса
 * возникает В МИРЕ (наземный лут поля) из физического источника — самого поля.
 * APPEND-ONLY по мере новых добывающих источников.
 */
export type ItemHarvestSource = 'carcass' | 'anomaly';

/**
 * Уровень серьёзности пересечённого порога нужды. Пока единственный —
 * `'critical'` (порог `*_CRITICAL` из balance/needs). Именованный уровень (а не
 * сырое число из balance) держит payload читаемым для летописи/логики и
 * расширяемым, если balance введёт промежуточные уровни (например `'warning'`).
 */
export type NeedLevel = 'critical';

/** Общая «шапка» любого события шины. */
export interface SimEventBase {
  /** Монотонный id, присваивается шиной при публикации (C-4). */
  readonly id: EventId;
  /** Тик публикации события (берётся из состояния мира). */
  readonly tick: Tick;
  /** Строковый дискриминант конкретного типа события. */
  readonly type: string;
  /** id события-причины; `null` — корень причинной цепочки (закон №6). */
  readonly causedBy: EventId | null;
}

/**
 * Дискриминированный union всех событий симуляции. Расширяется добавлением
 * новых членов `SimEventBase & { type: '<домен>/<имя>'; payload: … }`.
 */
export type SimEvent =
  | (SimEventBase & { type: 'sim/tickStarted'; payload: { readonly tick: Tick } })
  | (SimEventBase & { type: 'sim/snapshotTaken'; payload: { readonly hash: string } })
  | (SimEventBase & {
      type: 'move/departed';
      /** `eid` вышел из локации `from` в СОСЕДНЮЮ `to` (первый шаг маршрута). */
      payload: { readonly eid: EntityId; readonly from: LocationId; readonly to: LocationId };
    })
  | (SimEventBase & {
      type: 'move/arrived';
      /** `eid` достиг локации `at` (конец текущего шага маршрута). */
      payload: { readonly eid: EntityId; readonly at: LocationId };
    })
  | (SimEventBase & {
      type: 'weather/changed';
      /**
       * Среда сменила погоду с `from` на `to` (задача 1.6, система Weather). Оба
       * значения — КОДЫ погоды = индексы в `WEATHER_TYPES` (balance/weather), они
       * же `WorldClock.weather` (`WEATHER_CODE`). Число, а не строка-литерал, чтобы
       * `@zona/shared` не тянул перечень погод из `@zona/sim` (shared не зависит от
       * sim) и не дублировал контент (закон №10) — сопоставление кода с именем
       * делает потребитель (narrative) через `WEATHER_TYPES`. Погода — процедурная
       * генерация СРЕДЫ (детерминирована от seed), а не «X% исхода у сущности»,
       * поэтому `causedBy` ссылается на ПРЕДЫДУЩИЙ `weather/changed` (цепочка смен,
       * D-005/закон №6), либо `null` для самой первой смены в истории мира.
       */
      payload: { readonly from: number; readonly to: number };
    })
  | (SimEventBase & {
      type: 'needs/threshold';
      /**
       * Нужда `need` сущности `eid` ПЕРЕСЕКЛА порог `level` вверх (задача 1.5,
       * система Needs). Публикуется РОВНО ОДИН раз на пересечение (пока нужда
       * держится выше порога — не повторяется; упала и снова выросла — новое
       * событие). `causedBy: null` — физиология корень причинной цепочки (№2).
       */
      payload: { readonly eid: EntityId; readonly need: NeedKind; readonly level: NeedLevel };
    })
  | (SimEventBase & {
      type: 'task/selected';
      /**
       * NPC `eid` ВЫБРАЛ новую задачу `kind` (код `TaskKind`: SLEEP/EAT/DRINK/
       * FORAGE/HUNT/REST/FLEE — число, чтобы `@zona/shared` не тянул перечень из
       * `@zona/sim`, закон №10). Публикуется системой TaskSelection (1.8, D-020)
       * РОВНО при СМЕНЕ задачи (пока состояние ведёт к той же задаче — молчит,
       * D-032), НЕ каждый тик. `targetLoc` — целевая локация задачи (у on-the-spot
       * задач = текущая loc), `targetEid` — целевая сущность (жертва охоты; опущен,
       * если задача бесцелевая). `causedBy: null` — выбор задачи корневой
       * (физиологический драйв из нужд/обстановки, закон №2: не «X% шанс», а argmax
       * по состоянию). Нисходящие системы читают причину задачи через
       * `Task.causeEvent` (штамп этого id, D-030), а не сканом лога: Movement (1.4)
       * ставит `move/departed.causedBy = Task.causeEvent`.
       */
      payload: {
        readonly eid: EntityId;
        readonly kind: number;
        readonly targetLoc?: LocationId;
        readonly targetEid?: EntityId;
      };
    })
  | (SimEventBase & {
      type: 'perception/spotted';
      /**
       * `observer` ВПЕРВЫЕ заметил `target` в локации `loc` (задача 1.7, система
       * Perception, D-023). Публикуется РОВНО на НОВЫЙ контакт: `target` появился
       * в `contacts[observer]` этого тика, которого НЕ было на прошлом (контакт
       * пропал и снова возник — новое событие; держится — не повторяется). Контакт
       * = co-located сущность ИЛИ сущность из смежной локации, идущая в `loc`
       * (`dest === loc`, «замечен на подходе»). `loc` — локация НАБЛЮДАТЕЛЯ.
       * `causedBy` → последнее релевантное `move/departed`/`move/arrived`
       * наблюдателя или цели в логе (движение свело их в поле зрения), либо `null`.
       * Восприятие детерминировано (замечает ВСЕХ co-located, без «X% заметить» —
       * закон №2), поэтому rng не участвует.
       */
      payload: { readonly observer: EntityId; readonly target: EntityId; readonly loc: LocationId };
    })
  | (SimEventBase & {
      type: 'encounter/started';
      /**
       * В локации `loc` ЗАВЯЗАЛОСЬ столкновение (задача 1.10b, система Encounters,
       * D-022). `sides` — стороны боя как массивы eid-бойцов (Фаза 1: `[[охотники…],
       * [дичь]]`; та же форма понесёт человек-vs-человек в Фазе 2 — резолвер и
       * событие вида не хардкодят). Число сторон >= 2. Столкновение — следствие
       * СОСТОЯНИЯ мира (человек с задачей HUNT встал в локации с живой дичью), НЕ
       * «X% шанс встречи»: решение о завязке детерминировано (закон №2). `causedBy`
       * → `perception/spotted` цели из `contacts` охотника (id взят из
       * `Contact.spottedEvent`, D-030), либо `task/selected` (штамп `Task.causeEvent`),
       * либо `null` (нет прослеживаемой причины).
       */
      payload: { readonly sides: ReadonlyArray<readonly EntityId[]>; readonly loc: LocationId };
    })
  | (SimEventBase & {
      type: 'encounter/resolved';
      /**
       * Столкновение РАЗРЕШЕНО в тот же тик (задача 1.10b). `winnerSide` — индекс
       * победившей стороны (0-based) или `null` (взаимный слом/пат — никто не
       * победил). `casualties` — eid выбывших бойцов (их `Health.hp <= 0`; система
       * НЕ удаляет их — это делает Death 1.11, читая проштампованный
       * `Health.lethalCause = id этого события`, D-030). `ammoSpent` — сколько
       * патронов ФИЗИЧЕСКИ израсходовал каждый стрелок (списано из инвентаря,
       * закон №3), парами `[eid, кол-во]`, сорт. по eid. Исход вероятностен по
       * РАЗБРОСУ попаданий (seeded rng, физиология выстрела — закон №2), но при
       * фиксированном rng детерминирован; `causedBy` → соответствующий
       * `encounter/started`.
       */
      payload: {
        readonly winnerSide: number | null;
        readonly casualties: readonly EntityId[];
        readonly ammoSpent: ReadonlyArray<readonly [EntityId, number]>;
      };
    })
  | (SimEventBase & {
      type: 'animal/born';
      /**
       * Стадо `herd` принесло приплод — новорождённое животное `eid` появилось в
       * локации `loc` (задача 1.9, система Animals). Рождение ПРИЧИННО (закон №2):
       * оно наступает на детерминированном «племенном тике» стада И ТОЛЬКО ПРИ
       * выполнении порогов СОСТОЯНИЯ мира (локальная популяция вида < `reproCap`,
       * корм локации > порога, в стаде >= 2 взрослых-родителей) — это НЕ «X% шанс
       * приплода» и НЕ спавн из воздуха: новорождённый физически рождён стадом
       * (закон №3), его родители существуют. `herd` — id стада (число, чтобы
       * `@zona/shared` не тянул перечень стад из `@zona/sim`). `causedBy: null` —
       * экологический порог есть КОРЕНЬ причинной цепочки (как физиология Needs и
       * генерация среды Weather), а не следствие другого события.
       */
      payload: { readonly eid: EntityId; readonly herd: number; readonly loc: LocationId };
    })
  | (SimEventBase & {
      type: 'artifact/spawned';
      /**
       * Аномальное поле `field` РОДИЛО артефакт `item` (ступени `tier`) в своей
       * локации `loc` (задача 2.9, система ArtifactSpawn, D-054). Рождение ПРИЧИННО
       * (закон №2/№3, НЕ «X% выпадения»): заряд поля (`AnomalyField.charge`) копится
       * ДЕТЕРМИНИРОВАННО каждый тик (физика аномалии, как физиология Needs), и при
       * достижении порога поле «разряжается» в физический предмет — наземный лут поля
       * (cold 'inventory' на eid поля, D-046), а заряд списывается на стоимость
       * артефакта. `item` определён `tier` поля через данные (`getArtifactForTier`,
       * закон №10). `causedBy: null` — накопление заряда до порога есть КОРЕНЬ причинной
       * цепочки (как `animal/born`/`needs/threshold`); при появлении выбросов (emission,
       * Фаза 3) сюда встанет id события выброса, спровоцировавшего разряд (seam D-054).
       * За этим событием СРАЗУ следует ЛЕДЖЕР `item/harvested{who:field,source:'anomaly'}`
       * (`causedBy` = id ЭТОГО события): масса артефакта видима EconomyInvariant.
       * Подбор артефакта NPC (SEARCH, 2.10) — ПЕРЕВОД лута поля в инвентарь (масса
       * сохраняется, леджер не нужен, как торговля D-047), НЕ повторный harvested.
       */
      payload: {
        readonly field: EntityId;
        readonly item: ItemId;
        readonly tier: number;
        readonly loc: LocationId;
      };
    })
  | (SimEventBase & {
      type: 'item/produced';
      /**
       * ЛЕДЖЕР-событие массы (задача 2.0, B5, D-045). Поселение `settlement`
       * ПРОИЗВЕЛО `qty` единиц предмета `item` из сырья (заготовка на 2.2:
       * мастерская превращает сырьё в товар). Это ЭНДОГЕННЫЙ КОРЕНЬ появления
       * массы в мире (закон №3: предмет не из воздуха — он выработан), поэтому
       * `causedBy: null` (как физиология Needs и генерация Weather). EconomyInvariant
       * (headless) засчитывает `qty` в СОЗДАННУЮ массу интервала. В Фазе 2.0
       * реально НЕ эмитится (нет производства) — тип добавлен, чтобы форма леджера
       * замёрзла до появления первого источника массы. `settlement` — eid поселения
       * (D-046: поселение — сущность со складом под ключом 'inventory').
       */
      payload: { readonly settlement: EntityId; readonly item: ItemId; readonly qty: number };
    })
  | (SimEventBase & {
      type: 'item/consumed';
      /**
       * ЛЕДЖЕР-событие массы (задача 2.0, B5, D-045). Сущность `who` УНИЧТОЖИЛА
       * (израсходовала) `qty` единиц предмета `item` по причине `reason` (закон №3:
       * предмет ФИЗИЧЕСКИ ушёл из инвентаря, не «испарился»). EconomyInvariant
       * засчитывает `qty` в УНИЧТОЖЕННУЮ массу. Фаза 1 (ретрофит 2.0): TaskEffects
       * при EAT эмитит `reason:'eat'` (`causedBy` = `Task.causeEvent`, штамп
       * `task/selected`, D-030); Encounters при расходе патронов — `reason:'combat'`
       * (`causedBy` = id `encounter/resolved`). Расход есть СЛЕДСТВИЕ задачи/боя, а
       * не корень, поэтому `causedBy` не null (кроме случаев без штампа причины).
       */
      payload: {
        readonly who: EntityId;
        readonly item: ItemId;
        readonly qty: number;
        readonly reason: ItemConsumeReason;
      };
    })
  | (SimEventBase & {
      type: 'item/harvested';
      /**
       * ЛЕДЖЕР-событие массы (задача 2.0, B5, D-045). Сущность `who` ДОБЫЛА `qty`
       * единиц предмета `item` из источника `source` (закон №3: масса возникла из
       * ФИЗИЧЕСКОГО источника — туши/поля, не из воздуха). EconomyInvariant
       * засчитывает `qty` в СОЗДАННУЮ массу. Фаза 1 (ретрофит 2.0): Encounters при
       * разделке победитель получает `item:'meat', source:'carcass'` (`causedBy` =
       * id `encounter/resolved` — добыча есть следствие исхода боя). Задача 2.9
       * (D-054): аномальное поле рождает артефакт — `who`=eid поля, `item`=артефакт,
       * `qty`=1, `source:'anomaly'` (`causedBy` = id `artifact/spawned`). Иной
       * добывающий труд — `causedBy` = `Task.causeEvent`, либо `null`.
       */
      payload: {
        readonly who: EntityId;
        readonly item: ItemId;
        readonly qty: number;
        readonly source: ItemHarvestSource;
      };
    })
  | (SimEventBase & {
      type: 'item/broughtIn';
      /**
       * ЛЕДЖЕР-событие массы (задача 2.0, B5, D-045). Сущность `who` ВНЕСЛА в мир
       * из-за Периметра `items` (пары `[itemId, qty]`, сорт. по itemId) и `money`
       * денег — приток извне замкнутой экономики (закон №3: физический ввоз, не
       * эмиссия). EconomyInvariant засчитывает `items`/`money` в СОЗДАННУЮ массу.
       * Заготовка на 2.7/2.14 (прибытие нового населения/колонны из-за Периметра);
       * `causedBy` → `population/arrived` (будущий тип) либо `null`. В Фазе 2.0
       * реально НЕ эмитится (стартовый инвентарь worldgen — БАЗЛАЙН, а не событие,
       * D-045); тип добавлен для заморозки формы. NB: worldgen НЕ эмитит это событие.
       */
      payload: {
        readonly who: EntityId;
        readonly items: ReadonlyArray<readonly [ItemId, number]>;
        readonly money: number;
      };
    })
  | (SimEventBase & {
      type: 'item/exported';
      /**
       * ЛЕДЖЕР-событие массы (задача 2.0, B5, D-045). Сущность `who` ВЫВЕЗЛА за
       * Периметр `qty` единиц `item`, получив `moneyIn` денег взамен — отток товара
       * из замкнутой экономики и ПРИТОК денег (закон №3). EconomyInvariant
       * засчитывает `qty` в УНИЧТОЖЕННУЮ массу товара, а `moneyIn` — в СОЗДАННУЮ
       * массу денег. Заготовка на 2.14 (экспортная колонна за Периметр); `causedBy`
       * → событие сделки/прибытия колонны, либо `null` (эндогенный отток). В Фазе
       * 2.0 реально НЕ эмитится — тип добавлен для заморозки формы леджера.
       */
      payload: {
        readonly who: EntityId;
        readonly item: ItemId;
        readonly qty: number;
        readonly moneyIn: number;
      };
    })
  | (SimEventBase & {
      type: 'entity/died';
      /**
       * Сущность `eid` УМЕРЛА (задача 1.11, система Death): её `Health.hp <= 0` и она
       * ещё несла тег `Alive`. Death снимает `Alive`/`Needs`/`Task`/`Animal`, вешает
       * `Corpse` и публикует это событие РОВНО ОДИН раз (детекция «жив И hp<=0»; после
       * снятия `Alive` сущность больше не переопределяется как «только что умершая» —
       * resume-safe без рантайм-флага, закон №8). Смерть НЕ порождает свою причину
       * (закон №6): она НАСЛЕДУЕТ её от урона/истощения, добравшего носителя, поэтому
       * `causedBy` = `Health.lethalCause` (id `encounter/resolved` для боя или
       * `needs/threshold` для голода/жажды, штамп D-030), либо `null`, если причина не
       * проштампована (0). `name` — имя покойника (закон №4: у человека есть имя-
       * фамилия; у животного имени нет — поле опущено) для летописи. `cause` —
       * ПРОИЗВОДНАЯ метка вида причины (`'combat'`/`'starvation'`/`'thirst'`/`'unknown'`),
       * выведенная из типа события-причины; АВТОРИТЕТНА связь через `causedBy`, метка
       * вторична. `killer` — eid убийцы, если извлекаем (Фаза 1 обычно опускает).
       */
      payload: {
        readonly eid: EntityId;
        readonly name?: string;
        readonly cause: 'combat' | 'starvation' | 'thirst' | 'unknown';
        readonly killer?: EntityId;
      };
    })
  | (SimEventBase & {
      type: 'corpse/created';
      /**
       * Из умершей сущности `eid` возник ТРУП в локации `loc` (задача 1.11, система
       * Death). Труп ПЕРСИСТИТ (тег `Corpse` + `Position` + `Health` с hp<=0 +
       * `name`/`inventory` в ResourceStore): лут покойника ФИЗИЧЕСКИ остаётся на трупе
       * (закон №3 — ничего из воздуха, инвентарь не исчезает и не переносится), а
       * летопись может ссылаться на существующий труп. `items` — инвентарь покойника
       * парами `[itemId, qty]` (сорт. по itemId, как в ResourceStore), пустой массив —
       * если инвентаря нет. Распад/лутание трупов — будущая фаза. `causedBy` → id
       * `entity/died` этой же смерти (труп есть следствие смерти).
       */
      payload: {
        readonly eid: EntityId;
        readonly loc: LocationId;
        readonly items: ReadonlyArray<readonly [ItemId, number]>;
      };
    })
  | (SimEventBase & {
      type: 'settlement/built';
      /**
       * Поселение `settlement` ЗАВЕРШИЛО стройку проекта `project` (задача 2.3,
       * Economy, B5). Наступает детерминированно: `Settlement.buildProgress`
       * достиг 100% под накопленным трудом работников (`Job.employer === settlement`),
       * НЕ «X% шанс достроить» (закон №2). После события прогресс сбрасывается и
       * поселение берёт следующий проект из `buildQueue` (settlements.json). `project`
       * — строковый id проекта из очереди (контент, закон №10; код оперирует
       * абстрактным id). `causedBy: null` — завершение стройки есть ЭНДОГЕННЫЙ корень
       * (порог накопленного труда), как эконом-производство `item/produced` (D-045).
       * `settlement` — eid поселения (D-046).
       */
      payload: { readonly settlement: EntityId; readonly project: string };
    })
  | (SimEventBase & {
      type: 'settlement/abandoned';
      /**
       * Поселение `settlement` ПОКИНУТО жителями (задача 2.3, Economy, B5). Наступает
       * детерминированно: `Settlement.morale` просела до/ниже порога заброшенности
       * (balance/economy) под ЗАТЯЖНЫМ дефицитом провизии — это следствие СОСТОЯНИЯ
       * мира (пустеющий склад → голод → падение морали), НЕ «X% шанс распада» (закон
       * №2). Поселение НЕ удаляется (сущность остаётся носителем Settlement/Position),
       * но помечается заброшенным (Economy перестаёт его обслуживать) и его работники
       * теряют `Job`. `reason` — человекочитаемое объяснение (закон объяснимости
       * решений: какой дефицит и до какой морали довёл), для летописи/лога. `causedBy`
       * → id ПОСЛЕДНЕГО `item/consumed{reason:'upkeep'}` дефицитного расхода, добившего
       * мораль (причинная цепочка «дефицит → мораль → заброшено»), либо `null`, если
       * склад был пуст и расхода-события не возникло. `settlement` — eid (D-046).
       */
      payload: { readonly settlement: EntityId; readonly reason: string };
    })
  | (SimEventBase & {
      type: 'trade/executed';
      /**
       * СДЕЛКА исполнена (задача 2.5, система Trade, D-047). `seller` отдал `qty`
       * единиц `item`, `buyer` заплатил `money` денег — это ПЕРЕВОД (закон №3):
       * предметы и деньги ФИЗИЧЕСКИ сменили владельца, суммарная масса мира НЕ
       * изменилась, поэтому событие НЕ леджерится (EconomyInvariant его игнорирует —
       * денежная/товарная дельта леджера остаётся 0). Одна из сторон — сущность-
       * поселение (её склад/касса под ключами 'inventory'/'money', D-046), другая —
       * NPC с Task=TRADE. `price` — ФАКТИЧЕСКАЯ цена ЕДИНИЦЫ, использованная в сделке
       * (DERIVED из дефицитности склада, `priceOf`, D-047; цена не хранится — несётся
       * здесь для летописи/анализа), `money === price × qty`. Сделка ДЕТЕРМИНИРОВАНА
       * (закон №2: цена и решение — функции состояния склада/инвентаря, без rng).
       * `causedBy` = `Task.causeEvent` NPC (событие `task/selected`, выбравшее TRADE,
       * D-047/D-030), либо `null`, если причина не проштампована.
       */
      payload: {
        readonly buyer: EntityId;
        readonly seller: EntityId;
        readonly item: ItemId;
        readonly qty: number;
        readonly price: number;
        readonly money: number;
      };
    })
  | (SimEventBase & {
      type: 'artifact/collected';
      /**
       * NPC `collector` ПОДОБРАЛ `qty` единиц артефакта `item` с наземного лута
       * аномального поля `field` в локации `loc` (задача 2.10, система ArtifactSearch,
       * D-057). Это ПЕРЕВОД (закон №3), а НЕ добыча из воздуха: запись артефакта
       * ФИЗИЧЕСКИ переезжает из inventory поля (куда её положил ArtifactSpawn 2.9,
       * D-054, уже отледжерив рождение как `item/harvested{source:'anomaly'}`) в
       * inventory NPC. Суммарная масса мира (Σ 'inventory' по всем eid) НЕ меняется,
       * поэтому событие НЕ леджерится (EconomyInvariant его игнорирует — товарная
       * дельта леджера 0, как у `trade/executed`, D-047). Подбор ПРИЧИНЕН из состояния
       * (закон №2, НЕ «X% находки»): NPC с Task=SEARCH стоит в локации поля, на луте
       * которого лежит артефакт; решение выбрано utility-AI (TaskSelection 2.10), rng
       * не участвует. `causedBy` = `Task.causeEvent` NPC (событие `task/selected`,
       * выбравшее SEARCH, D-030/D-047), либо `null`, если причина не проштампована.
       */
      payload: {
        readonly collector: EntityId;
        readonly field: EntityId;
        readonly item: ItemId;
        readonly qty: number;
        readonly loc: LocationId;
      };
    })
  | (SimEventBase & {
      type: 'loot/transferred';
      /**
       * ЛУТ ПОБЕЖДЁННОГО перешёл к победителю столкновения (задача 2.11, система
       * Encounters, человек-vs-человек, D-060/D-049). После разрешения боя
       * (`encounter/resolved`) деньги и ВЕСЬ инвентарь ПРОИГРАВШЕГО `from`
       * ФИЗИЧЕСКИ переезжают к победителю `to` в локации `loc`. Это ПЕРЕВОД (закон
       * №3), НЕ создание/уничтожение массы: Σ денег и Σ каждого предмета мира НЕ
       * меняются, поэтому событие НЕ леджерится (EconomyInvariant его игнорирует —
       * дельта леджера 0, как `trade/executed` D-047 и `artifact/collected` D-057).
       * `items` — что перешло, парами `[itemId, qty]` (сорт. по itemId), `money` —
       * переведённые деньги (>=0). Событие эмитится ТОЛЬКО когда реально что-то
       * перешло (`money>0 || items.length>0`). ПРОИГРАВШИЙ обнуляется ДО того, как
       * Death (1.11) сделает труп: если `from` погиб, его труп несёт УЖЕ пустой
       * инвентарь (лут не задваивается — он на победителе; масса сохранена). Грабёж
       * ПРИЧИНЕН из состояния (закон №2): атакующий с Task=ROB встал у co-located
       * цели, исход — seeded резолвер (D-022); `causedBy` = id `encounter/resolved`
       * этого боя (перевод лута есть СЛЕДСТВИЕ исхода).
       */
      payload: {
        readonly from: EntityId;
        readonly to: EntityId;
        readonly items: ReadonlyArray<readonly [ItemId, number]>;
        readonly money: number;
        readonly loc: LocationId;
      };
    })
  | (SimEventBase & {
      type: 'population/arrived';
      /**
       * Новоприбывший сталкер `eid` вошёл в Зону из-за Периметра в точке входа `loc`
       * (задача 2.14, система PopulationInflux, D-061). Приток ПРИЧИНЕН (закон №2, НЕ
       * «X% спавн/тик»): он наступает, когда ДЕТЕРМИНИРОВАННАЯ привлекательность Зоны —
       * взвешенное окно недавних событий лога (притягивающие: находка/подбор артефакта
       * `artifact/spawned`/`artifact/collected`, экспорт хабара за Периметр
       * `item/exported`; отталкивающие: волны смертей `entity/died`, бандитские грабежи
       * человек-vs-человек `encounter/started`) — достигает порога `INFLUX_THRESHOLD`
       * (balance/population). Новичок ФИЗИЧЕСКИ приходит из-за Периметра (закон №1: точка
       * входа, НЕ «возле игрока»; закон №3: его инвентарь/деньги леджерятся `item/broughtIn`
       * — источник «из-за Периметра» — СРАЗУ за этим событием, `causedBy` = id ЭТОГО
       * события, чтобы EconomyInvariant держался). Личность генерируется seeded (категория
       * «генерация мира», D-021 — rng допустим), новичок с именем-фамилией и НЕ idle (Task
       * назначит TaskSelection, закон №4). `causedBy: null` — привлекательность выведена из
       * АГРЕГАТА окна событий, единой прослеживаемой причины нет ⇒ прибытие есть КОРЕНЬ
       * причинной цепочки (как `animal/born`/`artifact/spawned`/`item/produced` — все
       * пороговые события из состояния мира). `reason` — человекочитаемое объяснение решения
       * (какая привлекательность и вклад слагаемых довели до порога, D-030) для летописи.
       */
      payload: { readonly eid: EntityId; readonly loc: LocationId; readonly reason: string };
    })
  | (SimEventBase & {
      type: 'chronicle/recorded';
      /**
       * Значимое событие мира ВНЕСЕНО в летопись (задача 3.2, система Chronicle, D-068).
       * Публикуется РЕАКТИВНО на закоммиченный прошлый тик: Chronicle читает `bus.at(tick−1)`,
       * оценивает `significance(ev, world)` (чистая функция 3.1/D-067) и, если та
       * `>= CHRONICLE_THRESHOLD` (balance/narrative, закон №7), эмитит ЭТО событие. Летопись
       * НЕ хранится отдельно (нет своего стора): она = read-time фильтр лога по
       * `chronicle/recorded` (хелпер `chronicle(bus)`), поэтому запись — обычное событие
       * шины, а не мутация состояния. `eventId` — id ЗНАЧИМОГО события-первопричины (та же
       * величина, что `causedBy`: само значимое событие есть причина своей записи, D-030). `day`
       * выведен из `ev.tick` (`Math.floor(tick / TICKS_PER_DAY)`, 0-based: day 0 — первый день) для
       * строки «День N: …» (GDD §10.2). `significance` — оценка ∈ [0..1] (несётся для UI/анализа,
       * не пересчитывается на чтении). `kind` — ТИП исходного события (`ev.type`), по нему read-time
       * рендер соберёт летописную строку. `subjects` — участники записи, закодированные как `Subject`
       * (кодировка memory.ts 2.15: `"e:<eid>"` для сущностей; encoding поддерживает и `"f:<faction>"`,
       * но текущие payload'ы несут только eid), отсортированы/уникальны для детерминизма (закон №8).
       * `loc` — локация исходного события, если оно её несёт (иначе опущено). `templateId` —
       * ОПЦИОНАЛЕН и в 3.2 НЕ ставится: выбор шаблона летописной строки отложен в Radio 3.5
       * (seeded-выбор из пула), read-time рендер собирает строку по `kind` + `subjects`. Запись
       * НЕ творит массу/деньги (закон №3): нарративное событие, EconomyInvariant (D-045) его не
       * видит. `causedBy = eventId` (значимое событие → его запись, закон №6).
       */
      payload: {
        readonly eventId: EventId;
        readonly day: number;
        readonly significance: number;
        readonly kind: string;
        readonly subjects: readonly Subject[];
        readonly loc?: LocationId;
        readonly templateId?: string;
      };
    });
