import axios from 'axios';
import { Telegraf, Context, Markup } from 'telegraf';
import { config } from './config';
import { logger } from './utils/logger';
import { scheduleService, fetchActiveWeek } from './services/schedule.service';
import { dbService } from './database/db';
import { formatDay, formatWeek, LEGEND_HEADER, normalizeLessonType } from './utils/format.utils';
import { splitWeekMessageByDay } from './utils/messageSplitter';
import { getUkrainianDayAbbr, getTomorrow } from './utils/date.utils';
import { isAdmin } from './utils/admin.guard';
import { createRateLimiterMiddleware } from './services/rateLimiter.service';
import { createConcurrencyMiddleware } from './services/concurrency.service';
import { getCurrentLesson, formatNowMessage, getNextLesson, formatNextMessage } from './utils/currentLesson';
import { toggleReminder } from './services/reminder.service';

import { handleTeacherCommand } from './services/teacher.service';
import { generateCsv, parseCsv } from './services/linkCsv.service';
import type { NotificationRepo } from './database/notificationRepo';

// ─── Telegram message size limit ─────────────────────────────────────────────

const TELEGRAM_SAFE_LENGTH = 3800;

/**
 * Sends an HTML message, automatically splitting it into multiple parts when it
 * exceeds the safe character threshold (3 800 chars — below the 4 096 hard limit
 * to account for entity overhead).
 */
async function replyWithHtmlSafe(ctx: Context, text: string): Promise<void> {
    if (text.length <= TELEGRAM_SAFE_LENGTH) {
        await ctx.replyWithHTML(text);
        return;
    }
    const parts = splitWeekMessageByDay(text);
    for (const part of parts) {
        if (part.trim()) {
            await ctx.replyWithHTML(part);
        }
    }
}

// ─── URL validation for /setlink ─────────────────────────────────────────────

const MAX_URL_LENGTH = 2000;

/**
 * Validates that a URL is safe to store:
 * - Must be parseable by the WHATWG URL parser
 * - Protocol must be exactly `https:`
 * - Length must not exceed 2 000 characters
 *
 * Returns null on success, or an error string to show the user.
 */
function validateUrl(raw: string): string | null {
    if (raw.length > MAX_URL_LENGTH) {
        return `⚠️ URL занадто довгий (максимум ${MAX_URL_LENGTH} символів).`;
    }

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return '⚠️ Некоректне посилання. Перевірте URL.';
    }

    if (parsed.protocol !== 'https:') {
        return '⚠️ Некоректне посилання. Дозволені тільки https:// URL.';
    }

    return null; // valid
}

// ─── Inline keyboard for /fortnight ──────────────────────────────────────────

function makeFortnightMarkup(activeWeek: 1 | 2) {
    return Markup.inlineKeyboard([
        Markup.button.callback(
            activeWeek === 1 ? '• Тиждень 1' : 'Тиждень 1',
            'fortnight_1',
        ),
        Markup.button.callback(
            activeWeek === 2 ? '• Тиждень 2' : 'Тиждень 2',
            'fortnight_2',
        ),
    ]);
}

// ─── Bot factory ──────────────────────────────────────────────────────────────

export function createBot(deps?: { notificationRepo?: NotificationRepo }): Telegraf {
    const bot = new Telegraf(config.bot.token);

    // ─── Security middleware ──────────────────────────────────────────────────
    bot.use(createRateLimiterMiddleware());
    bot.use(createConcurrencyMiddleware());

    // ─── Stale update guard ─────────────────────────────────────────────────────
    // Drops message updates that are older than 60 seconds. Safe for
    // callback_query / inline_query which have no .date field on the message.
    bot.use((ctx, next) => {
        const updateDate = ctx.message?.date;
        if (updateDate !== undefined) {
            const nowSec = Math.floor(Date.now() / 1000);
            if (nowSec - updateDate > 60) {
                logger.warn(
                    `[SECURITY] Stale update ignored (age=${nowSec - updateDate}s, ` +
                    `userId=${ctx.from?.id ?? 'unknown'})`,
                );
                return;
            }
        }
        return next();
    });

    // ─── /start ──────────────────────────────────────────────────────────────
    bot.start(async (ctx: Context) => {
        const msg =
            `${LEGEND_HEADER}\n\n` +
            'Доступні команди:\n' +
            '/today — розклад на сьогодні\n' +
            '/tomorrow — розклад на завтра\n' +
            '/week — розклад на тиждень\n' +
            '/fortnight — переглянути та перемикати тижні\n' +
            '/exportlinks — завантажити CSV з посиланнями\n' +
            '/setlink &lt;назва&gt; &lt;тип&gt; &lt;url&gt; — зберегти посилання\n' +
            '/deletelink &lt;назва&gt; &lt;тип&gt; — видалити посилання\n\n' +
            'Типи: Лекція | Практика | Лаба';
        await ctx.replyWithHTML(msg);
    });

    // ─── /fortnight ──────────────────────────────────────────────────────────
    bot.command('fortnight', async (ctx: Context) => {
        try {
            const activeWeek = await fetchActiveWeek();
            const days = await scheduleService.getWeekSchedule(activeWeek);
            const fullMessage = formatWeek(days);
            const parts = splitWeekMessageByDay(fullMessage);
            const keyboard = makeFortnightMarkup(activeWeek);

            // Send all parts; attach keyboard to the last one
            for (let i = 0; i < parts.length - 1; i++) {
                await ctx.replyWithHTML(parts[i] ?? '');
            }
            const lastPart = parts[parts.length - 1] ?? '';
            await ctx.replyWithHTML(lastPart, keyboard);
        } catch (err) {
            logger.error('Error in /fortnight:', err);
            await ctx.reply('❌ Не вдалося отримати розклад. Спробуйте пізніше.');
        }
    });

    // ─── Callback: fortnight_1 / fortnight_2 ─────────────────────────────────
    bot.action(/^fortnight_([12])$/, async (ctx) => {
        try {
            const raw = ctx.match[1] ?? '1';
            const requestedWeek = (raw === '2' ? 2 : 1) as 1 | 2;
            const activeWeek = await fetchActiveWeek();

            const days = await scheduleService.getWeekSchedule(requestedWeek);
            const fullMessage = formatWeek(days);
            // editMessageText limit is 4096 — use first chunk only
            const displayText = splitWeekMessageByDay(fullMessage)[0] ?? '';

            try {
                await ctx.editMessageText(displayText, {
                    parse_mode: 'HTML',
                    ...makeFortnightMarkup(activeWeek),
                });
            } catch (editErr: unknown) {
                // Telegram returns 400 "message is not modified" when the user
                // clicks the button for the week that is already displayed.
                // This is harmless — just ignore it.
                const msg = editErr instanceof Error ? editErr.message : String(editErr);
                if (!msg.includes('message is not modified')) {
                    throw editErr;
                }
            }
            await ctx.answerCbQuery();
        } catch (err) {
            logger.error('Error in fortnight callback:', err);
            await ctx.answerCbQuery('❌ Помилка. Спробуйте ще раз.');
        }
    });

    // ─── /today ──────────────────────────────────────────────────────────────
    bot.command('today', async (ctx: Context) => {
        try {
            const week = await fetchActiveWeek();
            const dayName = getUkrainianDayAbbr(new Date());
            const day = await scheduleService.getScheduleForDay(dayName, week);
            await replyWithHtmlSafe(ctx, formatDay(dayName, day?.pairs ?? []));
        } catch (err) {
            logger.error('Error in /today:', err);
            await ctx.reply('❌ Не вдалося отримати розклад. Спробуйте пізніше.');
        }
    });

    // ─── /tomorrow ───────────────────────────────────────────────────────────
    bot.command('tomorrow', async (ctx: Context) => {
        try {
            const week = await fetchActiveWeek();
            const dayName = getUkrainianDayAbbr(getTomorrow(new Date()));
            const day = await scheduleService.getScheduleForDay(dayName, week);
            await replyWithHtmlSafe(ctx, formatDay(dayName, day?.pairs ?? []));
        } catch (err) {
            logger.error('Error in /tomorrow:', err);
            await ctx.reply('❌ Не вдалося отримати розклад. Спробуйте пізніше.');
        }
    });

    // ─── /week ───────────────────────────────────────────────────────────────
    bot.command('week', async (ctx: Context) => {
        try {
            const week = await fetchActiveWeek();
            const days = await scheduleService.getWeekSchedule(week);
            const parts = splitWeekMessageByDay(formatWeek(days));
            for (const part of parts) {
                await ctx.replyWithHTML(part);
            }
        } catch (err) {
            logger.error('Error in /week:', err);
            await ctx.reply('❌ Не вдалося отримати розклад. Спробуйте пізніше.');
        }
    });

    // ─── /setlink ────────────────────────────────────────────────────────────
    bot.command('setlink', async (ctx: Context) => {
        if (!isAdmin(ctx)) {
            logger.warn(
                `[SECURITY] Unauthorized admin attempt: /setlink by userId=${ctx.from?.id ?? 'unknown'} username=@${ctx.from?.username ?? 'unknown'}`,
            );
            await ctx.reply('У вас немає прав для цієї команди.');
            return;
        }
        try {
            const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
            const withoutCmd = text.replace(/^\/setlink\s*/i, '').trim();

            let lessonName: string;
            let rest: string;

            const quotedMatch = withoutCmd.match(/^"([^"]+)"\s+(.*)/s);
            if (quotedMatch) {
                lessonName = quotedMatch[1] ?? '';
                rest = (quotedMatch[2] ?? '').trim();
            } else {
                const parts = withoutCmd.split(/\s+/);
                if (parts.length < 3) {
                    await ctx.reply(
                        '⚠️ Використання:\n/setlink "Назва предмету" Тип https://url\n\n' +
                        'Типи: Лекція | Практика | Лаба\n' +
                        'Приклад:\n/setlink "Системне програмування" Лекція https://zoom.us/j/123',
                    );
                    return;
                }
                const url = parts.pop() ?? '';
                const type = parts.pop() ?? '';
                lessonName = parts.join(' ');
                rest = `${type} ${url}`;
            }

            const restParts = rest.split(/\s+/);
            if (restParts.length < 2) {
                await ctx.reply('⚠️ Вкажіть тип та URL.\nТипи: Лекція | Практика | Лаба');
                return;
            }

            const lessonType = restParts[0] ?? '';
            const rawUrl = restParts[restParts.length - 1] ?? '';
            const url = rawUrl.replace(/^<|>$/g, '');
            const cleanName = lessonName.replace(/^<|>$/g, '');

            const validTypes = ['Лекція', 'Практика', 'Лаба'];
            if (!validTypes.includes(lessonType)) {
                await ctx.reply(`⚠️ Невідомий тип: "${lessonType}"\nДопустимі: Лекція | Практика | Лаба`);
                return;
            }

            // ── URL validation (https-only, WHATWG-parsed, max 2000 chars) ────
            const urlError = validateUrl(url);
            if (urlError) {
                logger.warn(
                    `[SECURITY] Invalid URL in /setlink by userId=${ctx.from?.id ?? 'unknown'}: ${url}`,
                );
                await ctx.reply(urlError);
                return;
            }

            dbService.setLink(cleanName, lessonType, url);
            await ctx.replyWithHTML(`✅ Посилання збережено:\n<b>${cleanName}</b> [${lessonType}]`);
        } catch (err) {
            logger.error('Unexpected error in /setlink:', err);
            await ctx.reply('❌ Не вдалося зберегти посилання.');
        }
    });

    // ─── /deletelink ─────────────────────────────────────────────────────────
    bot.command('deletelink', async (ctx: Context) => {
        if (!isAdmin(ctx)) {
            logger.warn(
                `[SECURITY] Unauthorized admin attempt: /deletelink by userId=${ctx.from?.id ?? 'unknown'} username=@${ctx.from?.username ?? 'unknown'}`,
            );
            await ctx.reply('У вас немає прав для цієї команди.');
            return;
        }
        try {
            const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
            const withoutCmd = text.replace(/^\/deletelink\s*/i, '').trim();

            let lessonName: string;
            let lessonType: string;

            const quotedMatch = withoutCmd.match(/^"([^"]+)"\s+(\S+)/);
            if (quotedMatch) {
                lessonName = quotedMatch[1] ?? '';
                lessonType = quotedMatch[2] ?? '';
            } else {
                const parts = withoutCmd.split(/\s+/);
                if (parts.length < 2) {
                    await ctx.reply(
                        '⚠️ Використання: /deletelink "Назва предмету" Тип\nТипи: Лекція | Практика | Лаба',
                    );
                    return;
                }
                lessonType = parts.pop() ?? '';
                lessonName = parts.join(' ');
            }

            const deleted = dbService.deleteLink(lessonName, lessonType);
            if (deleted) {
                await ctx.replyWithHTML(`🗑 Посилання для <b>${lessonName}</b> [${lessonType}] видалено.`);
            } else {
                await ctx.replyWithHTML(`⚠️ Посилання для <b>${lessonName}</b> [${lessonType}] не знайдено.`);
            }
        } catch (err) {
            logger.error('Unexpected error in /deletelink:', err);
            await ctx.reply('❌ Не вдалося видалити посилання.');
        }
    });

    // ─── /exportlinks ────────────────────────────────────────────────────────
    // Available to all users. Sends a pipe-separated CSV of all known lesson
    // pairs with their current links pre-filled (empty = no link saved).
    bot.command('exportlinks', async (ctx: Context) => {
        try {
            const lessons = await scheduleService.getAllLessons();
            const links = dbService.getAllLinks();
            const csv = generateCsv(lessons, links);
            // BOM prefix so the file opens correctly in Excel / LibreOffice
            const buffer = Buffer.from('\uFEFF' + csv, 'utf-8');
            await ctx.replyWithDocument({ source: buffer, filename: 'links.csv' });
        } catch (err) {
            logger.error('Error in /exportlinks:', err);
            await ctx.reply('❌ Не вдалося згенерувати файл. Спробуйте пізніше.');
        }
    });

    // ─── /importlinks (via document caption) ─────────────────────────────────
    // Admin-only. User attaches the filled CSV file with caption "/importlinks"
    // (or "/importlinks@botname"). Bot downloads the file, parses each row, and
    // either sets or deletes the link depending on whether the link column is
    // empty.
    bot.on('document', async (ctx) => {
        const caption = ('caption' in ctx.message ? ctx.message.caption : undefined) ?? '';
        if (!/^\/importlinks(@\w+)?\s*$/i.test(caption.trim())) return;

        if (!isAdmin(ctx)) {
            logger.warn(
                `[SECURITY] Unauthorized admin attempt: /importlinks by userId=${ctx.from?.id ?? 'unknown'} username=@${ctx.from?.username ?? 'unknown'}`,
            );
            await ctx.reply('У вас немає прав для цієї команди.');
            return;
        }

        try {
            const doc = ctx.message.document;
            const fileLink = await ctx.telegram.getFileLink(doc.file_id);
            const { data: csvText } = await axios.get<string>(fileLink.href, {
                responseType: 'text',
                timeout: 10_000,
            });

            const parsed = parseCsv(csvText);
            if (!parsed.ok) {
                await ctx.reply(`⚠️ ${parsed.error}`);
                return;
            }

            let set = 0;
            let deleted = 0;
            let skipped = 0;

            for (const row of parsed.rows) {
                if (row.link) {
                    const urlError = validateUrl(row.link);
                    if (urlError) {
                        logger.warn(
                            `[SECURITY] Invalid URL in /importlinks by userId=${ctx.from?.id ?? 'unknown'}: ${row.link}`,
                        );
                        skipped++;
                        continue;
                    }
                    dbService.setLink(row.lessonName, row.lessonType, row.link);
                    set++;
                } else {
                    const wasDeleted = dbService.deleteLink(row.lessonName, row.lessonType);
                    if (wasDeleted) deleted++;
                }
            }

            await ctx.reply(
                `✅ Імпорт завершено:\n` +
                `• збережено: ${set}\n` +
                `• видалено: ${deleted}\n` +
                `• пропущено (некоректний URL): ${skipped}`,
            );
        } catch (err) {
            logger.error('Error in /importlinks:', err);
            await ctx.reply('❌ Не вдалося обробити файл. Перевірте формат CSV.');
        }
    });

    // ─── /next ────────────────────────────────────────────────────────
    bot.command('next', async (ctx: Context) => {
        try {
            const week = await fetchActiveWeek();
            const dayAbbr = getUkrainianDayAbbr(new Date());
            const scheduleDay = await scheduleService.getScheduleForDay(dayAbbr, week);

            const next = getNextLesson(scheduleDay);
            if (!next) {
                await ctx.reply('Сьогодні більше пар немає.');
                return;
            }

            const { lesson } = next;
            const link = dbService.getLink(lesson.name, normalizeLessonType(lesson.type));

            await ctx.replyWithHTML(formatNextMessage(next, link));
        } catch (err) {
            logger.error('Error in /next:', err);
            await ctx.reply('Не вдалося отримати розклад.');
        }
    });

    // ─── /now ────────────────────────────────────────────────────────────────
    bot.command('now', async (ctx: Context) => {
        try {
            const week = await fetchActiveWeek();
            const dayAbbr = getUkrainianDayAbbr(new Date());
            const scheduleDay = await scheduleService.getScheduleForDay(dayAbbr, week);

            const active = getCurrentLesson(scheduleDay);
            if (!active) {
                await ctx.reply('Зараз пар немає.');
                return;
            }

            const { lesson } = active;
            const link = dbService.getLink(lesson.name, normalizeLessonType(lesson.type));

            await ctx.replyWithHTML(formatNowMessage(active, link));
        } catch (err) {
            logger.error('Error in /now:', err);
            await ctx.reply('Тимчасово не вдалося отримати розклад.');
        }
    });

    // ─── /left ───────────────────────────────────────────────────────────────
    bot.command('left', async (ctx: Context) => {
        try {
            const week = await fetchActiveWeek();
            const dayAbbr = getUkrainianDayAbbr(new Date());
            const scheduleDay = await scheduleService.getScheduleForDay(dayAbbr, week);

            const active = getCurrentLesson(scheduleDay);
            if (!active) {
                await ctx.reply('Зараз пар немає.');
                return;
            }

            await ctx.reply(`До кінця пари: ${active.minutesLeft} хв`);
        } catch (err) {
            logger.error('Error in /left:', err);
            await ctx.reply('Тимчасово не вдалося отримати розклад.');
        }
    });

    // ─── /enable ───────────────────────────────────────────────────────────
    // Regex: /enable or /enable@botname, with optional space + digits
    // Group 1: optional @botname  Group 2: optional minutes digits
    bot.hears(/^\/enable(@\w+)?(?:\s+(\S+))?$/, async (ctx) => {
        const userId = ctx.from?.id;
        if (!userId) return;

        const repo = deps?.notificationRepo;
        if (!repo) {
            await ctx.reply('Нагадування недоступні (не налаштовано).');
            return;
        }

        const rawArg = ctx.match[2]; // captured minutes token (string | undefined)
        const VALIDATION_ERROR = 'Вкажіть кількість хвилин від 1 до 60.';

        // No argument → toggle on/off
        if (rawArg === undefined) {
            const result = toggleReminder(repo, userId, undefined);
            if (result.enabled) {
                await ctx.reply(`Нагадування увімкнено (за ${result.minutesBefore} хв).`);
            } else {
                await ctx.reply('Нагадування вимкнено.');
            }
            return;
        }

        // Argument provided — must be a whole integer in 1..60
        const minutes = Number(rawArg);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
            await ctx.reply(VALIDATION_ERROR);
            return;
        }

        const result = toggleReminder(repo, userId, minutes);
        if (result.enabled) {
            await ctx.reply(`Нагадування увімкнено (за ${result.minutesBefore} хв).`);
        } else {
            await ctx.reply('Нагадування вимкнено.');
        }
    });


    // ─── /teacher ────────────────────────────────────────────────────────
    bot.command('teacher', async (ctx: Context) => {
        try {
            const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
            const html = await handleTeacherCommand(text);
            await ctx.replyWithHTML(html);
        } catch (err) {
            logger.error('Error in /teacher:', err);
            await ctx.reply('Тимчасово не вдалося отримати розклад.');
        }
    });

    // ─── Error handler ────────────────────────────────────────────────────────
    bot.catch((err: unknown, ctx: Context) => {
        logger.error(`[UNEXPECTED] Bot error for update ${ctx.update.update_id}:`, err);
    });

    return bot;
}
