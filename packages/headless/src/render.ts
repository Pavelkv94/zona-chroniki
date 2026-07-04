/**
 * @module @zona/headless/render
 *
 * ЧЕЛОВЕКОЧИТАЕМЫЙ рендер лога событий (задача 1.12, флаг `--log verbose`).
 * Чистая ПРЕЗЕНТАЦИЯ (D-006, закон №6): читает финальный снапшот мира (лог шины
 * + «холодные» ресурсы с именами) и превращает append-only лог в строки для
 * человека. НИЧЕГО не мутирует — ни мир, ни лог, — поэтому хэш прогона с
 * `--log verbose` и без него ОБЯЗАН совпасть (инвариант D-006, покрыт тестом).
 *
 * Тайминг/вывод живут только в headless (единственный пакет с типами node),
 * `@zona/sim` о рендере не знает. Имена локаций/сущностей/видов берутся из
 * данных (map.json, species.json) и ResourceStore ('name'), НЕ хардкодятся
 * (закон №10). Русские подписи задач/погоды/причин — презентационные ярлыки для
 * человека (не влияют на симуляцию).
 *
 * Рендерятся ключевые типы (task/selected, move/arrived, encounter/resolved,
 * entity/died, weather/changed, animal/born); служебные и «шумные»
 * (needs/threshold, perception/spotted, move/departed, encounter/started,
 * corpse/created, sim/*) — опускаются, чтобы лог читался как хроника, а не дамп.
 */

import type { EntityId, LocationId, SimEvent } from '@zona/shared';
import {
  type SimWorld,
  getLocation,
  WEATHER_TYPES,
  TaskKind,
  type WeatherType,
} from '@zona/sim';

/** «Холодная» запись имени сталкера (см. worldgen NameRecord, D-007). */
interface NameRecord {
  readonly first: string;
  readonly last: string;
  readonly nickname: string;
}

/** Русские подписи задач по коду TaskKind (презентация, не влияет на мир). */
const TASK_LABEL: Readonly<Record<number, string>> = {
  [TaskKind.SLEEP]: 'сон',
  [TaskKind.EAT]: 'еда',
  [TaskKind.DRINK]: 'водопой',
  [TaskKind.FORAGE]: 'собирательство',
  [TaskKind.HUNT]: 'охота',
  [TaskKind.REST]: 'отдых',
  [TaskKind.FLEE]: 'бегство',
};

/** Русские подписи погоды по коду (индекс в WEATHER_TYPES). */
const WEATHER_LABEL: Readonly<Record<WeatherType, string>> = {
  clear: 'ясно',
  overcast: 'пасмурно',
  rain: 'дождь',
  fog: 'туман',
  storm: 'гроза',
};

/** Русские подписи причины смерти по метке entity/died.cause. */
const CAUSE_LABEL: Readonly<Record<string, string>> = {
  combat: 'ран в бою',
  starvation: 'голода',
  thirst: 'жажды',
  unknown: 'неизвестной причины',
};

/** Подпись погоды по коду; на неизвестном коде — сырой код (робастность). */
function weatherLabel(code: number): string {
  const key = WEATHER_TYPES[code];
  return key === undefined ? `код ${code}` : WEATHER_LABEL[key];
}

/** Имя локации из map.json (закон №10); на неизвестной — «локация #id». */
function locName(loc: LocationId): string {
  try {
    return getLocation(loc).name;
  } catch {
    return `локация #${loc}`;
  }
}

/**
 * Фамилия сущности из ResourceStore ('name', D-007) — как в примерах хроники
 * («Жуков», «Сидоров»). Ресурс переживает смерть (труп несёт имя), поэтому
 * работает и для покойников. Нет записи (животное/безымянный) → `undefined`.
 */
function surname(world: SimWorld, eid: EntityId): string | undefined {
  const rec = world.resources.get<NameRecord>('name', eid);
  return rec === undefined ? undefined : rec.last;
}

/** Имя сущности для лога: фамилия человека, либо «сущность #eid» (животное). */
function entityLabel(world: SimWorld, eid: EntityId): string {
  return surname(world, eid) ?? `сущность #${eid}`;
}

/**
 * Строит хронику: массив читаемых строк по логу событий финального мира.
 * Порядок строк = порядок событий в логе (EventId, закон №8). Только чтение.
 */
export function renderEventLog(world: SimWorld): string[] {
  const log = world.bus.log;

  // Индекс encounter/started по id: encounter/resolved несёт winnerSide/жертв,
  // но НЕ стороны — восстанавливаем участников по causedBy (D-030).
  const startedById = new Map<number, Extract<SimEvent, { type: 'encounter/started' }>>();
  // Индекс места смерти: entity/died не несёт loc, а corpse/created (та же смерть)
  // несёт — сопоставляем по eid, чтобы дописать «у <локации>».
  const deathLoc = new Map<EntityId, LocationId>();
  for (const ev of log) {
    if (ev.type === 'encounter/started') startedById.set(ev.id, ev);
    else if (ev.type === 'corpse/created') deathLoc.set(ev.payload.eid, ev.payload.loc);
  }

  const lines: string[] = [];
  for (const ev of log) {
    const line = renderEvent(world, ev, startedById, deathLoc);
    if (line !== undefined) lines.push(`Тик ${ev.tick}: ${line}`);
  }
  return lines;
}

/** Одна строка события (без префикса тика) либо undefined — если тип опускаем. */
function renderEvent(
  world: SimWorld,
  ev: SimEvent,
  startedById: ReadonlyMap<number, Extract<SimEvent, { type: 'encounter/started' }>>,
  deathLoc: ReadonlyMap<EntityId, LocationId>,
): string | undefined {
  switch (ev.type) {
    case 'weather/changed':
      return `погода сменилась — ${weatherLabel(ev.payload.from)} → ${weatherLabel(ev.payload.to)}`;

    case 'task/selected': {
      const who = entityLabel(world, ev.payload.eid);
      const task = TASK_LABEL[ev.payload.kind] ?? `задача #${ev.payload.kind}`;
      let s = `${who} выбрал задачу «${task}»`;
      if (ev.payload.targetLoc !== undefined) s += `, цель — ${locName(ev.payload.targetLoc)}`;
      if (ev.payload.targetEid !== undefined) {
        s += ` (жертва: ${entityLabel(world, ev.payload.targetEid)})`;
      }
      return s;
    }

    case 'move/arrived':
      return `${entityLabel(world, ev.payload.eid)} пришёл в ${locName(ev.payload.at)}`;

    case 'encounter/resolved': {
      const started = ev.causedBy === null ? undefined : startedById.get(ev.causedBy);
      const where = started === undefined ? '' : ` в ${locName(started.payload.loc)}`;
      const casualties = ev.payload.casualties;
      if (ev.payload.winnerSide === null) {
        return `стычка${where} окончилась вничью (жертв: ${casualties.length})`;
      }
      const winners = started?.payload.sides[ev.payload.winnerSide];
      const winnerName =
        winners !== undefined && winners.length > 0
          ? entityLabel(world, winners[0] as EntityId)
          : 'кто-то';
      const preyNames = casualties.map((c) => entityLabel(world, c)).join(', ');
      const prey = casualties.length === 0 ? '' : ` (добыча: ${preyNames})`;
      return `${winnerName} победил в стычке${where}${prey}`;
    }

    case 'entity/died': {
      const who = surname(world, ev.payload.eid) ?? ev.payload.name ?? `сущность #${ev.payload.eid}`;
      const cause = CAUSE_LABEL[ev.payload.cause] ?? ev.payload.cause;
      const loc = deathLoc.get(ev.payload.eid);
      const where = loc === undefined ? '' : ` у ${locName(loc)}`;
      return `${who} умер от ${cause}${where}`;
    }

    case 'animal/born':
      // species-код особи живёт в SoA-компоненте Animal (внутренний тип bitecs,
      // наружу не течёт, закон №5) — вид в презентации не вскрываем; хроника
      // фиксирует факт приплода и место. Родословную даст narrative (Фаза 3).
      return `в стаде родился детёныш в ${locName(ev.payload.loc)}`;

    // Служебные и «шумные» типы опускаем (см. docblock).
    default:
      return undefined;
  }
}
