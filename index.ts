/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { moment } from "@webpack/common";
import * as DataStore from "@api/DataStore";

interface ScheduledMessage {
    channelId: string;
    content: string;
    scheduledTime: number;
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
    const toSave = scheduledMessages.map(({ channelId, content, scheduledTime }) => ({ channelId, content, scheduledTime }));
    // Fire-and-forget async save
    try {
        void DataStore.set(SCHEDULED_MESSAGES_KEY, toSave);
    } catch { }
}

// Load scheduled messages via DataStore
async function loadScheduledMessages() {
    try {
        const data = await DataStore.get<Array<{ channelId: string; content: string; scheduledTime: number; }>>(SCHEDULED_MESSAGES_KEY);
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

// Schedule a message to be sent
function scheduleMessage(
    channelId: string,
    content: string,
    delay: number,
    scheduledTimeOverride?: number
): void {
    const SEND_BUFFER_MS = 500; // 0.5-second Discord safety buffer
    const scheduledTime =
        (scheduledTimeOverride ?? (Date.now() + delay)) + SEND_BUFFER_MS;

    const timeoutId = setTimeout(() => {
        sendMessage(channelId, { content });

        const index = scheduledMessages.findIndex(
            msg => msg.timeoutId === timeoutId
        );
        if (index !== -1) {
            scheduledMessages.splice(index, 1);
            saveScheduledMessages();
        }

        if (settings.store.showNotifications) {
            Vencord.Webpack.Common.Toasts.show({
                type: Vencord.Webpack.Common.Toasts.Type.SUCCESS,
                message: "Scheduled message sent!",
                id: "vc-scheduled-message-sent"
            });
        }
    }, delay + SEND_BUFFER_MS);

    scheduledMessages.push({
        channelId,
        content,
        scheduledTime,
        timeoutId
    });

    saveScheduledMessages();

    if (settings.store.showNotifications) {
        Vencord.Webpack.Common.Toasts.show({
            type: Vencord.Webpack.Common.Toasts.Type.SUCCESS,
            message: `Message scheduled for ${moment(scheduledTime).format("LT")}`,
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
                }
            ],
            execute: (args, ctx) => {
                const message = args.find(arg => arg.name === "message")?.value as string;
                const timeStr = args.find(arg => arg.name === "time")?.value as string;

                if (!message || !timeStr) {
                    sendBotMessage(ctx.channel.id, {
                        content: "❌ Please provide both a message and a time."
                    });
                    return;
                }

                // Use advanced time parser
                let delay = parseAdvancedTime(timeStr);
                if (delay === null || delay <= 0) {
                    sendBotMessage(ctx.channel.id, {
                        content: "❌ Invalid or past time format. Use 17h00, +17h00, +17h00+3d, 1h30m, etc."
                    });
                    return;
                }
                scheduleMessage(ctx.channel.id, message, delay);
                sendBotMessage(ctx.channel.id, {
                    content: `✅ Message scheduled to be sent ${moment().add(delay, "ms").fromNow()}.`
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
                
                    return `${index + 1}. **${exactTime}** (${relativeTime}, ~${hoursLeft}h): ${preview}`;
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
            const delay = msg.scheduledTime - Date.now();
            if (delay > 0) {
                // Restore timer for future messages
                scheduleMessage(msg.channelId, msg.content, delay, msg.scheduledTime);
            } else {
                // If missed, send immediately and remove from storage
                sendMessage(msg.channelId, { content: msg.content });
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
