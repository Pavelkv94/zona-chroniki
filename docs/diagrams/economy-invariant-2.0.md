# EconomyInvariant 2.0 — предохранитель закона №3 (масса вне леджера = падение)

Задача 2.0 (Фаза 2, ПЕРВОЙ, D-045). Замкнутая экономика проверяется ОДНОЙ
формулой: «масса мира» = Σ `money` + Σ `inventory`.qty по item по ВСЕМ eid
(NPC/трупы/поселения единообразно, D-046). Единственный легальный способ
ИЗМЕНИТЬ массу — 5 ЛЕДЖЕР-событий `item/*` в `@zona/shared/events`. Read-only
чекер `@zona/headless/economy-invariant` сверяет для каждого `upToTick`:

```
worldTotals(now) − baseline  ==  ledgerDelta(0, upToTick)
```

`baseline` = `worldTotals` сразу ПОСЛЕ worldgen (t0): стартовый инвентарь/деньги —
БАЗЛАЙН, worldgen НЕ эмитит леджер. Расхождение ⇒ масса появилась/исчезла БЕЗ
события (дыра закона №3) ⇒ `assertEconomyInvariant` БРОСАЕТ (роняет sim:100days).

Чекер — НЕ система (не публикует, не мутирует мир, не входит в хэш/лог, вне
бюджета D-006): он живёт в headless как determinism-gate. Ретрофит дыр Фазы 1:
`TaskEffects.EAT → item/consumed(eat)`, `Encounters → item/consumed(combat) +
item/harvested(carcass)`. `produced/broughtIn/exported` — заготовки (форма
замёрзла, реально не эмитятся в 2.0). Стрелка A → B = «A зависит от B / A → B поток».

```mermaid
graph TD
  subgraph shared["@zona/shared (чистые типы, закон №5)"]
    ev["events.ts (+5 ЛЕДЖЕР-типов, форма замёрзла)<br/>item/produced {settlement,item,qty} · causedBy null<br/>item/consumed {who,item,qty,reason} <br/>item/harvested {who,item,qty,source}<br/>item/broughtIn {who,items[],money}<br/>item/exported {who,item,qty,moneyIn}<br/>+ ItemConsumeReason 'eat'|'combat'<br/>+ ItemHarvestSource 'carcass'"]
  end

  subgraph sim["@zona/sim (ретрофит дыр Фазы 1 — механику НЕ трогаем)"]
    te["systems/task-effects.ts (РЕТРОФИТ)<br/>EAT съел 1 еду → publish item/consumed<br/>{who,item,qty:1,reason:'eat'}<br/>causedBy = Task.causeEvent (0→null)"]
    enc["systems/encounters.ts (РЕТРОФИТ)<br/>spendAmmo → item/consumed(reason:'combat')<br/>addMeat → item/harvested(source:'carcass')<br/>causedBy = id encounter/resolved"]
    wg["worldgen.ts (БАЗЛАЙН, НЕ эмитит леджер)<br/>set('money'/'inventory') = стартовая масса t0"]
    death["systems/death.ts (масса НЕ меняется)<br/>труп хранит inventory на своём eid<br/>(Death не purge) ⇒ лут УЧТЁН"]
    bus["core/events.ts<br/>publish/log (append-only, D-005)"]
    res["core/world.ts · ResourceStore<br/>entries('money')/('inventory') сорт. eid"]
  end

  subgraph headless["@zona/headless (чекер = determinism-gate, вне мира/хэша)"]
    ei["economy-invariant.ts (READ-ONLY, НЕ System)<br/>worldTotals(world): Σ money + Σ inventory.qty<br/>ledgerDelta(bus,from,to): +produced/harvested/broughtIn<br/>−consumed/exported; money +broughtIn/+exported<br/>assertEconomyInvariant(world,bus,baseline,upToTick)<br/>throw при (totals−baseline)≠ledger + диагностика"]
    cli["cli.ts / runHeadless<br/>baseline=worldTotals ПОСЛЕ worldgen<br/>прогон ПО-ДНЕВНО: run(TICKS_PER_DAY)+assert<br/>(mid-run дыра ловится раз в игровой день)"]
  end

  te --> ev
  enc --> ev
  te --> bus
  enc --> bus
  death -.масса сохранена.-> res
  wg --> res

  ei --> res
  ei --> bus
  ei --> ev
  cli --> ei
  cli --> wg

  classDef new fill:#173,stroke:#5c8,color:#fff;
  classDef retro fill:#734,stroke:#c58,color:#fff;
  class ev,ei,cli new;
  class te,enc retro;
```

## Инвариант, который доказан

- **Наследие чисто (0 магии):** на полном конвейере Фазы 1 (worldgen + 9 систем)
  формула держится на КАЖДОМ дне для seed 42/7/999 (тест `economy-invariant.test.ts`)
  и на 100 днях в `sim:100days` (не бросает). Единственные изменения массы —
  `item/consumed` (еда/патроны) и `item/harvested` (мясо с туш).
- **Чекер реально ловит:** искусственная подкладка предмета/денег или удаление
  инвентаря БЕЗ леджера → `assertEconomyInvariant` бросает (проверено тестом).
- **Детерминизм:** ретрофит добавил события в лог → новые голдены живого мира
  `8a8faff4 → cb104eca` (day1/seed42), `f4cc990d → 84359104` (sim:100days).
  Core-голден пустого мира `481914ae` НЕ тронут (чекер вне ядра).
```
