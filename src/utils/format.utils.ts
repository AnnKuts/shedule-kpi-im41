import type { Lesson, ScheduleDay } from '../types/kpi.types';
import { dbService } from '../database/db';
import { parseStartMinutes, formatTime, abbrevToFullDayName } from './date.utils';
import { htmlEscape } from './htmlEscape';

// ─── Type icons & canonical DB type labels ────────────────────────────────────

interface TypeMeta {
    icon: string;
    dbLabel: string;
}

const TYPE_META: Array<{ prefix: string; meta: TypeMeta }> = [
    { prefix: 'Лек', meta: { icon: '🔵', dbLabel: 'Лекція' } },
    { prefix: 'Прак', meta: { icon: '🟠', dbLabel: 'Практика' } },
    { prefix: 'Лаб', meta: { icon: '🟢', dbLabel: 'Лаба' } },
];

function getTypeMeta(type: string): TypeMeta {
    for (const { prefix, meta } of TYPE_META) {
        if (type.startsWith(prefix)) return meta;
    }
    return { icon: '⚪', dbLabel: type };
}

/**
 * Converts a raw API lesson type (e.g. "Лек.", "Прак.") to the canonical
 * DB label ("Лекція", "Практика", "Лаба"). Unknown types are returned as-is.
 */
export function normalizeLessonType(rawType: string): string {
    return getTypeMeta(rawType).dbLabel;
}

// ─── Legend header ────────────────────────────────────────────────────────────

export const LEGEND_HEADER = 'Група: ІМ-41\n🔵 Лекція 🟠 Практика 🟢 Лаба';

// ─── Lesson grouping by time ──────────────────────────────────────────────────

interface LessonGroup {
    time: string;
    lessons: Lesson[];
}

function groupLessonsByTime(lessons: Lesson[]): LessonGroup[] {
    const map = new Map<string, Lesson[]>();

    const sorted = [...lessons].sort(
        (a, b) => parseStartMinutes(a.time) - parseStartMinutes(b.time),
    );

    for (const lesson of sorted) {
        const key = formatTime(lesson.time);
        const group = map.get(key);
        if (group) {
            group.push(lesson);
        } else {
            map.set(key, [lesson]);
        }
    }

    return Array.from(map.entries()).map(([time, ls]) => ({ time, lessons: ls }));
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Merges lessons that share the same name, type, time, and place.
 * Duplicate entries only differ in their `dates` array (e.g. specific one-off dates).
 * After merging, sorts by start time.
 */
export function normalizeLessons(lessons: Lesson[]): Lesson[] {
    const map = new Map<string, Lesson>();

    for (const lesson of lessons) {
        const key = `${lesson.name}_${lesson.type}_${lesson.time}_${lesson.place ?? ''}`;
        const existing = map.get(key);
        if (existing) {
            // Merge dates, deduplicate them
            existing.dates = [...new Set([...existing.dates, ...lesson.dates])];
        } else {
            map.set(key, { ...lesson, dates: [...lesson.dates] });
        }
    }

    return Array.from(map.values()).sort(
        (a, b) => parseStartMinutes(a.time) - parseStartMinutes(b.time),
    );
}

// ─── Single day block ─────────────────────────────────────────────────────────

export function formatDayBlock(dayAbbr: string, lessons: Lesson[]): string {
    const fullName = abbrevToFullDayName(dayAbbr);
    const header = `⬜⬜⬜ ${fullName}`;

    if (lessons.length === 0) {
        return `${header}\n\nПар немає 🎉`;
    }

    const groups = groupLessonsByTime(normalizeLessons(lessons));
    const lines: string[] = [header];

    for (const group of groups) {
        lines.push('');
        lines.push(group.time);

        for (const lesson of group.lessons) {
            const { icon, dbLabel } = getTypeMeta(lesson.type);
            const safeName = htmlEscape(lesson.name);
            const link = dbService.getLink(lesson.name, dbLabel);
            if (link) {
                lines.push(`${icon} <a href="${link}">${safeName}</a>`);
            } else {
                lines.push(`${icon} ${safeName}`);
            }
        }
    }

    return lines.join('\n');
}

// ─── /today and /tomorrow ─────────────────────────────────────────────────────

export function formatDay(dayAbbr: string, lessons: Lesson[]): string {
    return `${LEGEND_HEADER}\n\n${formatDayBlock(dayAbbr, lessons)}`;
}

// ─── /week and /fortnight ─────────────────────────────────────────────────────

export function formatWeekBody(days: ScheduleDay[]): string {
    return days.map((d) => formatDayBlock(d.day, d.pairs)).join('\n\n');
}

export function formatWeek(days: ScheduleDay[]): string {
    return `${LEGEND_HEADER}\n\n${formatWeekBody(days)}`;
}
