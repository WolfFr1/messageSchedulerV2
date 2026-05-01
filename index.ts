/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { moment } from "@webpack/common";

interface ScheduledMessage {
    channelId: string;
    content: string;
    scheduledTime: number;
    intervalMs?: number;
    await?: boolean;
    timeoutId?: NodeJS.Timeout;
}

const settings = definePluginSettings({
    showNotifications: {
        type: OptionType.BOOLEAN,
        description: "Show notifications when scheduled messages are sent",
        default: true
    }
});

// Store for scheduled messages
let scheduledMessages: ScheduledMessage[] = [];
const SCHEDULED_MESSAGES_KEY = "vc_scheduledMessages";
// Save scheduled messages via DataStore (excluding timeoutId)
function saveScheduledMessages() {
    const toSave = scheduledMessages.map(({ channelId, content, scheduledTime, intervalMs }) => ({ channelId, content, scheduledTime, intervalMs }));
    // Fire-and-forget async save
    try {
        void DataStore.set(SCHEDULED_MESSAGES_KEY, toSave);
    } catch { }
}

// Load scheduled messages via DataStore
async function loadScheduledMessages() {
    try {
        const data = await DataStore.get<Array<{ channelId: string; content: string; scheduledTime: number; intervalMs?: number; }>>(SCHEDULED_MESSAGES_KEY);
        return data ?? [];
    } catch {
        return [];
    }
}
const logger = new Logger("MessageScheduler");

// Parse time string supporting 17h00, +17h00, +17h00+3d, and relative formats
function parseAdvancedTime(timeStr: string): number | null {
    // +17h00+3d, +17h00, +3d, 17h00, 1h30m, etc.
    const now = moment();
    let delayMs = 0;
    let matched = false;

    // Handle +17h00+3d or +17h00
    if (timeStr.startsWith("+")) {
        matched = true;
        // Remove leading +
        let str = timeStr.slice(1);
        // Match 17h00 (hours and minutes)
        const timeMatch = str.match(/(\d{1,2})h(\d{2})?/);
        if (timeMatch) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
            delayMs += hours * 60 * 60 * 1000 + minutes * 60 * 1000;
            str = str.replace(timeMatch[0], "");
        }
        // Match +Xd (days), +Xh (hours), +Xm (minutes), +Xs (seconds)
        const regex = /(\d+)([dhms])/g;
        let match;
        while ((match = regex.exec(str)) !== null) {
            const value = parseInt(match[1], 10);
            switch (match[2]) {
                case "d": delayMs += value * 24 * 60 * 60 * 1000; break;
                case "h": delayMs += value * 60 * 60 * 1000; break;
                case "m": delayMs += value * 60 * 1000; break;
                case "s": delayMs += value * 1000; break;
            }
        }
        return delayMs > 0 ? delayMs : null;
    }

    // Handle 1h00, 01h00, 12h00, etc. (next occurrence)
    const timeMatch = timeStr.match(/^(\d{1,2})h(\d{2})$/);
    if (timeMatch) {
        matched = true;
        const hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        const next = moment().set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
        // If the time is later today, schedule for today; if earlier, schedule for tomorrow
        if (next.isSameOrBefore(now)) next.add(1, "day");
        return next.valueOf() - now.valueOf();
    }

    // Fallback to relative time (1h30m, 2d, 30s)
    const regex = /(\d+)([dhms])/g;
    let match;
    while ((match = regex.exec(timeStr)) !== null) {
        matched = true;
        const value = parseInt(match[1], 10);
        switch (match[2]) {
            case "d": delayMs += value * 24 * 60 * 60 * 1000; break;
            case "h": delayMs += value * 60 * 60 * 1000; break;
            case "m": delayMs += value * 60 * 1000; break;
            case "s": delayMs += value * 1000; break;
        }
    }
    return matched ? delayMs : null;
}

// Parse exact time like "3:30pm", "15:45", etc.
function parseExactTime(timeStr: string): number | null {
    // Try to parse various time formats
    const formats = [
        "h:mma", "h:mm a", "H:mm", // 3:30pm, 3:30 pm, 15:30
        "ha", "h a", "H", // 3pm, 3 pm, 15
    ];

    for (const format of formats) {
        const date = moment(timeStr, format);
        if (date.isValid()) {
            let timestamp = date.valueOf();

            // If the time is in the past, add a day
            if (timestamp < Date.now()) {
                timestamp += 24 * 60 * 60 * 1000;
            }

            return timestamp;
        }
    }

    return null;
}

function parseInterval(intervalStr: string): number | null {
    const normalized = intervalStr.trim().toLowerCase();
    if (!normalized) return null;

    const regex = /(\d+)\s*(d|day|days|h|hr|hour|hours|m|min|minute|minutes|s|sec|second|seconds)/g;
    let totalMs = 0;
    let matched = false;
    let consumed = "";
    let match: RegExpExecArray | null;

    while ((match = regex.exec(normalized)) !== null) {
        matched = true;
        consumed += match[0];
        const value = parseInt(match[1], 10);
        const unit = match[2];

        if (["d", "day", "days"].includes(unit)) totalMs += value * 24 * 60 * 60 * 1000;
        else if (["h", "hr", "hour", "hours"].includes(unit)) totalMs += value * 60 * 60 * 1000;
        else if (["m", "min", "minute", "minutes"].includes(unit)) totalMs += value * 60 * 1000;
        else if (["s", "sec", "second", "seconds"].includes(unit)) totalMs += value * 1000;
    }

    const leftovers = normalized
        .replace(regex, "")
        .replace(/[\s,]+/g, "");

    if (!matched || leftovers.length > 0 || totalMs <= 0) return null;
    return totalMs;
}

function formatInterval(intervalMs: number): string {
    const days = Math.floor(intervalMs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((intervalMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((intervalMs % (60 * 60 * 1000)) / (60 * 1000));
    const seconds = Math.floor((intervalMs % (60 * 1000)) / 1000);

    const parts: string[] = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds) parts.push(`${seconds}s`);
    return parts.join(" ") || "0s";
}

function removeScheduledMessage(msg: ScheduledMessage): void {
    const index = scheduledMessages.indexOf(msg);
    if (index !== -1) {
        scheduledMessages.splice(index, 1);
        saveScheduledMessages();
    }
}

function advanceToNextInterval(scheduledTime: number, intervalMs: number, now: number): number {
    if (scheduledTime > now) return scheduledTime;
    const skippedIntervals = Math.floor((now - scheduledTime) / intervalMs) + 1;
    return scheduledTime + skippedIntervals * intervalMs;
}

function armScheduledMessage(msg: ScheduledMessage): void {
    const delay = Math.max(0, msg.scheduledTime - Date.now());

    msg.timeoutId = setTimeout(async () => {
        if (msg.intervalMs && msg.await) {
            await sendMessage(msg.channelId, { content: msg.content });
        } else {
            sendMessage(msg.channelId, { content: msg.content });
        }

        if (msg.intervalMs && msg.intervalMs > 0) {
            const nextBaseTime = msg.scheduledTime + msg.intervalMs;
            msg.scheduledTime = advanceToNextInterval(nextBaseTime, msg.intervalMs, Date.now());
            saveScheduledMessages();
            armScheduledMessage(msg);
            return;
        }

        removeScheduledMessage(msg);

        if (settings.store.showNotifications) {
            Vencord.Webpack.Common.Toasts.show({
                type: Vencord.Webpack.Common.Toasts.Type.SUCCESS,
                message: "Scheduled message sent!",
                id: "vc-scheduled-message-sent"
            });
        }
    }, delay);
}

// Schedule a message to be sent
function scheduleMessage(
    channelId: string,
    content: string,
    delay: number,
    scheduledTimeOverride?: number,
    intervalMs?: number,
    await?: boolean
): void {
    const scheduledTime = scheduledTimeOverride ?? (Date.now() + delay);

    const scheduledMessage: ScheduledMessage = {
        channelId,
        content,
        scheduledTime,
        intervalMs,
        await
    };

    scheduledMessages.push(scheduledMessage);
    armScheduledMessage(scheduledMessage);

    saveScheduledMessages();

    if (settings.store.showNotifications) {
        Vencord.Webpack.Common.Toasts.show({
            type: Vencord.Webpack.Common.Toasts.Type.SUCCESS,
            message: intervalMs
                ? `Recurring message scheduled (every ${formatInterval(intervalMs)}), next send ${moment(scheduledTime).fromNow()}`
                : `Message scheduled for ${moment(scheduledTime).format("LT")}`,
            id: "vc-message-scheduled"
        });
    }
}

export default definePlugin({
    name: "MessageScheduler",
    description: "Schedule messages to be sent at a specific time or after a delay",
    authors: [{ name: "MessageScheduler", id: 0n }],
    settings,

    commands: [
        {
            name: "schedule",
            description: "Schedule a message to be sent later",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "message",
                    description: "The message to send",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                },
                {
                    name: "time",
                    description: "When to send the message (e.g. '1h30m', '3:30pm')",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                },
                {
                    name: "interval",
                    description: "Optional repeat interval (e.g. '10m', '2h', '3 days', '10m30s')",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                },
                {
                    name: "await",
                    description: "Whether to wait for the message to be sent before scheduling the next one (only useful for intervals)",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false
                }
            ],
            execute: (args, ctx) => {
                const message = args.find(arg => arg.name === "message")?.value as string;
                const timeStr = args.find(arg => arg.name === "time")?.value as string;
                const intervalStr = args.find(arg => arg.name === "interval")?.value as string | undefined;
                const awaitFlag = args.find(arg => arg.name === "await")?.value as boolean | undefined;

                if (!message || !timeStr) {
                    sendBotMessage(ctx.channel.id, {
                        content: "❌ Please provide both a message and a time."
                    });
                    return;
                }

                // Use advanced time parser
                const delay = parseAdvancedTime(timeStr);
                if (delay === null || delay <= 0) {
                    sendBotMessage(ctx.channel.id, {
                        content: "❌ Invalid or past time format. Use 17h00, +17h00, +17h00+3d, 1h30m, etc."
                    });
                    return;
                }

                let intervalMs: number | undefined;
                if (intervalStr) {
                    intervalMs = parseInterval(intervalStr) ?? undefined;
                    if (!intervalMs || intervalMs <= 0) {
                        sendBotMessage(ctx.channel.id, {
                            content: "❌ Invalid interval. Use formats like '10m', '2h', '3 days', or '10m30s'."
                        });
                        return;
                    }
                }

                scheduleMessage(ctx.channel.id, message, delay, undefined, intervalMs, awaitFlag);
                sendBotMessage(ctx.channel.id, {
                    content: intervalMs
                        ? `✅ Recurring message scheduled. First send ${moment().add(delay, "ms").fromNow()}, then every ${formatInterval(intervalMs)}.`
                        : `✅ Message scheduled to be sent ${moment().add(delay, "ms").fromNow()}.`
                });
            }
        },
        {
            name: "scheduled",
            description: "List all scheduled messages",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_, ctx) => {
                const channelMessages = scheduledMessages.filter(
                    msg => msg.channelId === ctx.channel.id
                );

                if (channelMessages.length === 0) {
                    sendBotMessage(ctx.channel.id, {
                        content: "No scheduled messages for this channel."
                    });
                    return;
                }

                const now = Date.now();

                const messageList = channelMessages.map((msg, index) => {
                    const exactTime = moment(msg.scheduledTime).format("LT");
                    const relativeTime = moment(msg.scheduledTime).fromNow();
                    const hoursLeft = Math.max(
                        0,
                        Math.round((msg.scheduledTime - now) / (1000 * 60 * 60) * 10) / 10
                    );

                    const preview =
                        msg.content.length > 50
                            ? msg.content.substring(0, 47) + "..."
                            : msg.content;

                    const intervalInfo = msg.intervalMs
                        ? `, repeats every ${formatInterval(msg.intervalMs)}`
                        : "";

                    return `${index + 1}. **${exactTime}** (${relativeTime}, ~${hoursLeft}h${intervalInfo}): ${preview}`;
                }).join("\n");

                sendBotMessage(ctx.channel.id, {
                    content: `**Scheduled Messages:**\n${messageList}`
                });
            }
        },
        {
            name: "cancel-scheduled",
            description: "Cancel a scheduled message",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "index",
                    description: "The index of the message to cancel (use /scheduled to see indices)",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true
                }
            ],
            execute: (args, ctx) => {
                const indexArg = args.find(arg => arg.name === "index")?.value;
                const index = typeof indexArg === "number" ? indexArg : 0;

                if (index <= 0) {
                    sendBotMessage(ctx.channel.id, {
                        content: "❌ Please provide a valid message index (use /scheduled to see indices)."
                    });
                    return;
                }

                const channelMessages = scheduledMessages.filter(msg => msg.channelId === ctx.channel.id);

                if (channelMessages.length === 0) {
                    sendBotMessage(ctx.channel.id, {
                        content: "No scheduled messages for this channel."
                    });
                    return;
                }

                if (index > channelMessages.length) {
                    sendBotMessage(ctx.channel.id, {
                        content: `❌ Invalid index. There are only ${channelMessages.length} scheduled messages.`
                    });
                    return;
                }

                const messageToCancel = channelMessages[index - 1];
                if (messageToCancel.timeoutId) clearTimeout(messageToCancel.timeoutId);
                const globalIndex = scheduledMessages.findIndex(msg => msg.timeoutId === messageToCancel.timeoutId);
                if (globalIndex !== -1) {
                    scheduledMessages.splice(globalIndex, 1);
                    saveScheduledMessages();
                }
                sendBotMessage(ctx.channel.id, {
                    content: "✅ Scheduled message cancelled."
                });
            }
        }
    ],

    async start() {
        logger.info("Plugin started");
        // Load and reschedule messages
        const loaded = await loadScheduledMessages();
        scheduledMessages = [];
        let changed = false;
        for (const msg of loaded) {
            const now = Date.now();
            const restored: ScheduledMessage = {
                channelId: msg.channelId,
                content: msg.content,
                scheduledTime: msg.scheduledTime,
                intervalMs: msg.intervalMs
            };

            if (restored.intervalMs && restored.intervalMs > 0) {
                const nextTime = advanceToNextInterval(restored.scheduledTime, restored.intervalMs, now);
                if (nextTime !== restored.scheduledTime) {
                    restored.scheduledTime = nextTime;
                    changed = true;
                }
            }

            const delay = restored.scheduledTime - now;
            if (delay > 0) {
                // Restore timer for future messages
                scheduledMessages.push(restored);
                armScheduledMessage(restored);
            } else {
                // Drop missed one-time messages while the plugin was offline.
                changed = true;
            }
        }
        if (changed) saveScheduledMessages();
    },

    stop() {
        // Clear all scheduled messages when plugin is disabled
        for (const msg of scheduledMessages) {
            if (msg.timeoutId) clearTimeout(msg.timeoutId);
        }
        scheduledMessages.length = 0;
        saveScheduledMessages();
        logger.info("Plugin stopped, all scheduled messages cleared");
    }
});
