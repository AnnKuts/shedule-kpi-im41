import type { Lesson, LessonLink } from '../types/kpi.types';
import { normalizeLessonType } from '../utils/format.utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CsvRow {
    lessonName: string;
    lessonType: string;
    /** Empty string means "delete this link from DB" */
    link: string;
}

export type ParseCsvResult =
    | { ok: true; rows: CsvRow[] }
    | { ok: false; error: string };

// ─── Constants ────────────────────────────────────────────────────────────────

const CSV_SEPARATOR = '|';
const CSV_HEADER = `lesson_name${CSV_SEPARATOR}lesson_type${CSV_SEPARATOR}link`;

const TYPE_ORDER: Record<string, number> = {
    'Лекція': 0,
    'Практика': 1,
    'Лаба': 2,
};

// ─── Generate ─────────────────────────────────────────────────────────────────

/**
 * Builds a pipe-separated CSV string from all unique (name, type) lesson pairs
 * found in the API schedule, pre-filling any existing links from the DB.
 *
 * Rows are sorted alphabetically by lesson_name, then by canonical type order
 * (Лекція → Практика → Лаба → other).
 */
export function generateCsv(lessons: Lesson[], existingLinks: LessonLink[]): string {
    // Collect unique (name, normalizedType) pairs
    const seen = new Set<string>();
    const pairs: Array<{ name: string; type: string }> = [];

    for (const lesson of lessons) {
        const type = normalizeLessonType(lesson.type);
        const key = `${lesson.name}${CSV_SEPARATOR}${type}`;
        if (!seen.has(key)) {
            seen.add(key);
            pairs.push({ name: lesson.name, type });
        }
    }

    // Sort: by name alphabetically, then by canonical type order
    pairs.sort((a, b) => {
        const nameCmp = a.name.localeCompare(b.name, 'uk');
        if (nameCmp !== 0) return nameCmp;
        const aOrder = TYPE_ORDER[a.type] ?? 99;
        const bOrder = TYPE_ORDER[b.type] ?? 99;
        return aOrder - bOrder;
    });

    // Build lookup map for existing links
    const linkMap = new Map<string, string>();
    for (const row of existingLinks) {
        linkMap.set(`${row.lesson_name}${CSV_SEPARATOR}${row.lesson_type}`, row.link);
    }

    const lines: string[] = [CSV_HEADER];
    for (const { name, type } of pairs) {
        const link = linkMap.get(`${name}${CSV_SEPARATOR}${type}`) ?? '';
        lines.push(`${name}${CSV_SEPARATOR}${type}${CSV_SEPARATOR}${link}`);
    }

    return lines.join('\n');
}

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parses a pipe-separated CSV string back into structured rows.
 *
 * - Strips UTF-8 BOM if present
 * - Skips the header row (lesson_name|lesson_type|link)
 * - Skips blank lines
 * - Returns { ok: false } if no valid data rows are found
 * - Rows with fewer than 2 fields are skipped (counted separately by caller)
 */
export function parseCsv(text: string): ParseCsvResult {
    // Strip UTF-8 BOM
    const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const lines = clean.split('\n');
    const rows: CsvRow[] = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // Skip header row (case-insensitive to be safe)
        if (line.toLowerCase().startsWith('lesson_name')) continue;

        const parts = line.split(CSV_SEPARATOR);

        // Need at least lesson_name and lesson_type; link may be absent (= empty)
        if (parts.length < 2) continue;

        const lessonName = (parts[0] ?? '').trim();
        const lessonType = (parts[1] ?? '').trim();
        const link = (parts[2] ?? '').trim();

        if (!lessonName || !lessonType) continue;

        rows.push({ lessonName, lessonType, link });
    }

    if (rows.length === 0) {
        return { ok: false, error: 'CSV файл не містить жодного рядка з даними.' };
    }

    return { ok: true, rows };
}
