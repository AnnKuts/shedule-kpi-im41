import { describe, it, expect } from 'vitest';
import { generateCsv, parseCsv } from '../../src/services/linkCsv.service';
import type { Lesson, LessonLink } from '../../src/types/kpi.types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeLesson(name: string, type: string): Lesson {
    return {
        name,
        type,
        lecturer: { id: '1', name: 'Test Lecturer' },
        time: '08:30:00',
        place: '101',
        location: null,
        tag: '',
        dates: ['2024-01-01'],
    };
}

function makeLink(lesson_name: string, lesson_type: string, link: string): LessonLink {
    return { lesson_name, lesson_type, link };
}

// ─── generateCsv ──────────────────────────────────────────────────────────────

describe('generateCsv', () => {
    it('outputs header as first line', () => {
        const csv = generateCsv([], []);
        expect(csv.split('\n')[0]).toBe('lesson_name|lesson_type|link');
    });

    it('produces one row per unique (name, normalizedType) pair', () => {
        const lessons = [
            makeLesson('Математика', 'Лекція'),
            makeLesson('Математика', 'Лекція'), // duplicate
            makeLesson('Математика', 'Лаба'),
        ];
        const csv = generateCsv(lessons, []);
        const rows = csv.split('\n').slice(1); // skip header
        expect(rows).toHaveLength(2);
    });

    it('normalizes raw API types (e.g. "Лек." → "Лекція")', () => {
        const lessons = [makeLesson('ОС', 'Лек.')];
        const csv = generateCsv(lessons, []);
        expect(csv).toContain('ОС|Лекція|');
    });

    it('pre-fills existing link for matching row', () => {
        const lessons = [makeLesson('Фізика', 'Лекція')];
        const links = [makeLink('Фізика', 'Лекція', 'https://zoom.us/j/123')];
        const csv = generateCsv(lessons, links);
        expect(csv).toContain('Фізика|Лекція|https://zoom.us/j/123');
    });

    it('leaves link empty when no DB entry exists', () => {
        const lessons = [makeLesson('Хімія', 'Лаба')];
        const csv = generateCsv(lessons, []);
        expect(csv).toContain('Хімія|Лаба|');
        // Ensure no extra content after the last pipe
        const dataLine = csv.split('\n')[1];
        expect(dataLine).toBe('Хімія|Лаба|');
    });

    it('sorts rows by lesson_name alphabetically, then by type order (Лекція < Практика < Лаба)', () => {
        const lessons = [
            makeLesson('Математика', 'Лаба'),
            makeLesson('Математика', 'Лекція'),
            makeLesson('Алгебра', 'Практика'),
        ];
        const csv = generateCsv(lessons, []);
        const rows = csv.split('\n').slice(1);
        expect(rows[0]).toMatch(/^Алгебра/);
        expect(rows[1]).toMatch(/^Математика\|Лекція/);
        expect(rows[2]).toMatch(/^Математика\|Лаба/);
    });

    it('returns only header when lessons array is empty', () => {
        const csv = generateCsv([], []);
        expect(csv.trim()).toBe('lesson_name|lesson_type|link');
    });
});

// ─── parseCsv ─────────────────────────────────────────────────────────────────

describe('parseCsv', () => {
    it('parses a valid CSV with links', () => {
        const csv = [
            'lesson_name|lesson_type|link',
            'Математика|Лекція|https://zoom.us/j/123',
            'Фізика|Лаба|https://meet.google.com/abc',
        ].join('\n');

        const result = parseCsv(csv);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]).toEqual({
            lessonName: 'Математика',
            lessonType: 'Лекція',
            link: 'https://zoom.us/j/123',
        });
    });

    it('parses rows with empty link field', () => {
        const csv = 'lesson_name|lesson_type|link\nМатематика|Лекція|';
        const result = parseCsv(csv);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.rows[0]?.link).toBe('');
    });

    it('parses rows where link column is missing entirely', () => {
        const csv = 'lesson_name|lesson_type|link\nМатематика|Лекція';
        const result = parseCsv(csv);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.rows[0]?.link).toBe('');
    });

    it('strips UTF-8 BOM', () => {
        const csv = '\uFEFFlesson_name|lesson_type|link\nОС|Практика|https://example.com';
        const result = parseCsv(csv);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.rows[0]?.lessonName).toBe('ОС');
    });

    it('handles Windows CRLF line endings', () => {
        const csv = 'lesson_name|lesson_type|link\r\nМатематика|Лекція|https://zoom.us/j/1\r\n';
        const result = parseCsv(csv);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.rows).toHaveLength(1);
    });

    it('skips the header row (case-insensitive)', () => {
        const csv = 'LESSON_NAME|LESSON_TYPE|LINK\nМатематика|Лекція|https://example.com';
        const result = parseCsv(csv);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.rows).toHaveLength(1);
    });

    it('skips blank lines', () => {
        const csv = 'lesson_name|lesson_type|link\n\nМатематика|Лекція|\n\n';
        const result = parseCsv(csv);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.rows).toHaveLength(1);
    });

    it('skips rows with only one field (malformed)', () => {
        const csv = 'lesson_name|lesson_type|link\nМатематика\nФізика|Лаба|';
        const result = parseCsv(csv);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // "Математика" alone has only 1 field → skipped; "Фізика|Лаба|" is valid
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.lessonName).toBe('Фізика');
    });

    it('returns ok:false when no valid data rows exist', () => {
        const csv = 'lesson_name|lesson_type|link\n\n';
        const result = parseCsv(csv);
        expect(result.ok).toBe(false);
    });

    it('returns ok:false for completely empty input', () => {
        const result = parseCsv('');
        expect(result.ok).toBe(false);
    });

    it('trims whitespace from field values', () => {
        const csv = 'lesson_name|lesson_type|link\n  Математика  |  Лекція  |  https://example.com  ';
        const result = parseCsv(csv);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.rows[0]).toEqual({
            lessonName: 'Математика',
            lessonType: 'Лекція',
            link: 'https://example.com',
        });
    });
});
