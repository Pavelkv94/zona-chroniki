# Конвейер Фазы 1 (1.12) — порядок систем + причинные стыки

`registerPhase1Systems(scheduler)` регистрирует 9 систем в КАНОНИЧЕСКОМ порядке (B.1).
Порядок КРИТИЧЕН (D-032): производитель штампа причины стоит РАНЬШЕ потребителя —
иначе `causedBy` прочитает старое значение (внутритиковая невидимость D-005).
`runHeadless` (headless): `createSimWorld → worldgen → registerPhase1Systems → run`.

## Порядок и стыки причинности (производитель → потребитель)

```mermaid
graph TD
  W["1. Weather"] --> N["2. Needs"]
  N --> P["3. Perception"]
  P --> TS["4. TaskSelection"]
  TS --> M["5. Movement"]
  M --> TE["6. TaskEffects"]
  TE --> E["7. Encounters"]
  E --> A["8. Animals"]
  A --> D["9. Death"]

  TS -. "Task.causeEvent → move/departed.causedBy" .-> M
  M -. "Position.moveCause → move/arrived.causedBy" .-> M
  P -. "contacts.spottedEvent → encounter/started.causedBy" .-> E
  P -. "contacts.spottedEvent → flee.causedBy" .-> A
  N -. "Health.lethalCause (голод) → entity/died.causedBy" .-> D
  E -. "Health.lethalCause (бой) → entity/died.causedBy" .-> D
```

Инвариант (закреплён `pipeline.test.ts`): Needs<Death, Perception<{TaskSelection,Encounters,Animals},
TaskSelection<Movement, Encounters<Death, Movement<{TaskEffects,Animals}. Weather первой, Death последней.
Реверсивных стыков нет; 4 нарочные перестановки ловятся негативным тестом.

## Презентация (D-006, вне мира)

```mermaid
graph LR
  RUN["runHeadless: serialize + hashSnapshot"] --> HASH["хэш живого мира<br/>(e04c0d77 day1/seed42)"]
  RUN --> REND["renderEventLog(world)<br/>(headless/render.ts)"]
  REND --> LOG["человекочитаемая хроника<br/>(--log verbose)"]
  RES["ResourceStore 'name'"] -. читает .-> REND
  MAP["map.json (имена локаций)"] -. читает .-> REND
```

`renderEventLog` — ЧИСТОЕ чтение (лог/ResourceStore/data), НЕ мутирует мир: хэш с `--log verbose`
и без совпадает (инвариант D-006, покрыт тестом). Тайминг `ms` — только headless, в хэш не входит.

## Голдены
- Живой CLI: `e04c0d77` (day1/seed42, events≈6734), `925aa279` (day100/seed42, events≈215494).
- Core пустого мира `481914ae` (createSimWorld без систем/worldgen) — НЕ трогается (другой путь).

## Хвост здоровья мира (для гейта 1.13 / balance-analyst)
За 10 дней — смертельная спираль (70–80% смертность людей, прей-база вымирает к дню 30):
перевылов (26–49 охот) ≫ приплод (1–3), большинство смертей БОЕВЫЕ (охота на кабанов летальна),
притока/размножения людей нет. Детерминизм/причинность целы — это балансовая проблема (D-043, 1.13).
