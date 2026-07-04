# Задача 3.2 — Chronicle (летопись мира) (D-068)

ЛЕТОПИСЬ ЗНАЧИМЫХ событий мира БЕЗ отдельного хранилища: летопись = **read-time фильтр**
append-only лога по типу `chronicle/recorded`. Система `Chronicle` лишь ПОМЕЧАЕТ значимые
события записью-событием в тот же лог. Реактив на закоммиченный прошлый тик (закон №6, как
RobberyMemory D-063). В конвейер до 3.7 НЕ подключена (батч сдвига голденов + запуск fame-петли
вместе с Radio 3.5 / Rumors 3.6).

## Тик: реактивная запись (bus.at(tick−1)) + fame-петля

```mermaid
flowchart TD
  PREV["bus.at(tick−1)<br/>ЗАКОММИЧЕННЫЕ события прошлого тика (D-005)"] --> LOOP{"для каждого ev<br/>(кроме chronicle/recorded — страж от петли)"}
  LOOP --> SIG["significance(ev, world)<br/>чистая функция 3.1 / D-067"]
  SIG -->|"< CHRONICLE_THRESHOLD"| SKIP["пропуск — рутина мимо летописи"]
  SIG -->|">= CHRONICLE_THRESHOLD (balance/narrative, закон №7)"| REC
  REC["publish chronicle/recorded<br/>{eventId, day=floor(tick/TICKS_PER_DAY), significance, kind,<br/>subjects: Subject[], loc?, templateId?}<br/>causedBy = ev.id (D-030)"] --> FAME
  FAME["на КАЖДОГО eid-субъекта:<br/>incFame(resources, eid, FAME_PER_CHRONICLE)"] --> FKEY[("ResourceStore 'fame'<br/>D-067")]
  FKEY -.лифт значимости будущих событий (§10.2).-> SIG
  SUB["participantsOf(ev) (3.1)<br/>+ dedup/sort → entitySubject"] --> REC
```

## Read-time летопись и раскрутка причин (§10.1, не хранит состояние)

```mermaid
flowchart LR
  LOG[("bus.log<br/>append-only, сорт. по id")] -->|filter type==='chronicle/recorded'| CHR["chronicle(bus): ChronicleEntry[]"]
  CHR --> EXPORT["экспорт «День N: …» / UI летописи (Фаза 4)"]
  CHR -->|для каждой записи| UNR["unrollCauses(bus, id)<br/>обход causedBy назад: запись→значимое событие→…→корень"]
  UNR -->|bus.findLast(e=>e.id===cur)| LOG
```

## Инварианты (законы 1–10)

- **Закон №1 (без игрока)**: значимость — свойство события мира (смерть/бой/гибель поселения),
  запись пишется по порогу значимости, не по наблюдателю. Игрок исчез — хроника ведётся.
- **Закон №2 (причинность, без rng)**: порог `significance >= CHRONICLE_THRESHOLD` выводится из
  состояния (тип события + fame участников), не «X% попасть в летопись». Никакого rng-потока.
- **Закон №3 (не масса)**: `chronicle/recorded` — нарративное событие; `incFame` двигает ключ
  `'fame'` (дизъюнктен `money`/`inventory`) ⇒ EconomyInvariant (D-045) не видит и не затронут.
- **Закон №6 (шина, не прямой вызов)**: читает `bus.at(tick−1)` (закоммиченный прошлый тик),
  ничего не зовёт напрямую; `causedBy = eventId` линкует запись на её значимое событие.
- **Закон №7 (константы в balance)**: `CHRONICLE_THRESHOLD` (0.4) и `FAME_PER_CHRONICLE` (5) —
  в `balance/narrative.ts`, в системе магических чисел нет.
- **Закон №8 (детерминизм / resume)**: обход событий в порядке id; субъекты dedup+sort; выбор
  шаблона (если появится в 3.5) — seeded по eventId, не rng-поток. Летопись — read-time фильтр
  (состояния не держит) ⇒ save/load ≡ непрерывный прогон АВТОМАТИЧЕСКИ; `fame` сериализуется.
- **Нет петли записей**: `significance('chronicle/recorded')` = `UNKNOWN_WEIGHT` (0.0) < порога +
  явный страж `ev.type === 'chronicle/recorded'` ⇒ запись не порождает запись о записи.
- **fame-петля (§10.2)**: `incFame` на субъектов запускает обратную связь — повторные упоминания
  поднимают `fame`, а значит будущую значимость (лифт D-067), особенно смерти известных.
- **Изоляция / голдены**: система НЕ в конвейере до 3.7, worldgen не зовёт ⇒ голдены Фазы 3
  не двигаются (sim:100days `fd0bec10`, пустой мир `481914ae` — подтверждено прогоном).

## templateId — отложен в Radio 3.5

Поле `templateId?` в 3.2 НЕ ставится: seeded-выбор шаблона летописной строки из пула
`messages.json` — забота Radio 3.5 (единая точка выбора шаблонов, чтобы не дублировать логику
пула в двух местах). Read-time рендер собирает строку по `kind` + `subjects`; поле замёрзло в
контракте для 3.5.
