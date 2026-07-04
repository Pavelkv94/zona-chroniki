# Экспорт за Периметр (2.7, D-055) — зависимости и поток

Система `Export` — ЕДИНСТВЕННЫЙ санкционированный money-faucet замкнутого мира
(закон №3). Поселение по СОСТОЯНИЮ склада на детерминированном логистическом тике
вывозит накопленный ХАБАР (артефакты) «за Периметр»: товар ФИЗИЧЕСКИ покидает мир,
деньги ФИЗИЧЕСКИ входят — оба факта проводит леджер `item/exported` (D-045), поэтому
EconomyInvariant держится. НЕ в pipeline/worldgen до 2.16 (голдены Фазы 1 не двигаются).

## Граф зависимостей

```mermaid
graph TD
  Export["systems/export.ts<br/>Export (every: EXPORT_CADENCE_DAYS×TICKS_PER_DAY)"]
  ECS["core/ecs.ts<br/>queryEntities([Settlement])"]
  SET["core/components.ts<br/>Settlement (носитель поселения)"]
  RES["ResourceStore<br/>'inventory' · 'money' · 'settlementAbandoned'"]
  PRICE["systems/pricing.ts<br/>exportPriceOf(item) = round(basePrice×FACTOR)"]
  DATA["data/index.ts<br/>getItem(id).kind === 'artifact' (isExportable)"]
  BALE["balance/economy.ts<br/>EXPORT_CADENCE_DAYS · EXPORT_SURPLUS_THRESHOLD · EXPORT_PRICE_FACTOR"]
  BALT["balance/time.ts<br/>TICKS_PER_DAY"]
  BUS["core/events.ts (world.bus)<br/>publish / log"]
  EV["@zona/shared/events.ts<br/>item/exported {who,item,qty,moneyIn}"]
  INV["@zona/headless/economy-invariant.ts<br/>ledgerDelta: money += moneyIn, item -= qty"]

  Export --> ECS
  ECS --> SET
  Export --> RES
  Export --> PRICE
  Export --> DATA
  Export --> BALE
  Export --> BALT
  Export --> BUS
  BUS --> EV
  PRICE --> BALE
  PRICE --> DATA
  EV -. учитывается read-only .-> INV
  Export -. "causedBy: null (эндогенный корень: склад+тик-фаза)" .-> BUS
```

## Поток одного логистического тика (на носитель Settlement, сорт. по eid)

```mermaid
flowchart TD
  A["Settlement не заброшен?"] -->|нет| SKIP["пропуск"]
  A -->|да| B["Σ хабара (kind='artifact') на складе"]
  B --> C{"Σ >= EXPORT_SURPLUS_THRESHOLD?"}
  C -->|нет| SKIP2["копит дальше (колонна не гоняется полупустой)"]
  C -->|да| D["для каждого артефакта (сорт. itemId):<br/>qty = наличие; unit = exportPriceOf; moneyIn = unit×qty"]
  D --> E["склад[item] = 0 (товар покинул мир)<br/>касса += moneyIn (деньги вошли извне)"]
  E --> F["publish item/exported {who,item,qty,moneyIn}<br/>causedBy: null"]
  F --> G["запись НОВЫМИ массивами через resources.set (D-035)"]
```

## Инварианты

- **Закон №1 (без игрока):** поселение само шлёт колонну по состоянию склада.
- **Закон №3 (масса):** деньги появляются ТОЛЬКО здесь и ТОЛЬКО через `item/exported`;
  склад не в минус (вывозится лишь наличие). `worldTotals − baseline == ledgerDelta`.
- **Закон №2 (причинность):** тик-фаза логистики + порог склада, никакого «X% отправки».
- **Закон №8 (детерминизм):** обход по eid, позиции по itemId, rng не используется;
  склад/касса сериализуемы ⇒ split ≡ continuous.
- **Закон №10 (данные):** экспортность — КАТЕГОРИЯ `kind==='artifact'`, не хардкод id.

## Хвост

Подключение в `registerPhase2Systems` и полный цикл поле → сталкер (SEARCH) →
торговля → накопление хабара на складе → экспорт — задача 2.16.
