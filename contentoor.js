require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials, ChannelType } = require('discord.js');
const UrlStorage = require('./urlStore');  // Changed to UrlStorage
const UrlTracker = require('./urlTracker');
const MemberTracker = require('./memberTracker');
const { logWithTimestamp } = require('./utils');
const { DB_TIMEOUT, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_COOLDOWN } = require('./config');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.User]
});

// Constants
const MAX_TEXT_LENGTH = 200;
const ERROR_COLOR = '#f2b518';
const AUTO_DELETE_TIMER_SECONDS = parseInt(process.env.AUTO_DELETE_TIMER) || 30;
const AUTO_DELETE_TIMER = AUTO_DELETE_TIMER_SECONDS * 1000;
const URL_CHECK_TIMEOUT = parseInt(process.env.URL_CHECK_TIMEOUT) || 5000;
const MAX_FETCH_RETRIES = 3;
const CACHE_CLEANUP_INTERVAL = 300000; // 5 minutes
const THREAD_CACHE_TTL = 3600000; // 1 hour
const URL_HISTORY_LIMIT = 10;

// Rate limiting and caching
const rateLimitMap = new Map();
const threadNameCache = new Map(); // Stores {threadId: {name: string, timestamp: number, pendingOps: number}}

function checkRateLimit(userId) {
    const now = Date.now();
    const userRateLimit = rateLimitMap.get(userId) || { timestamp: now, count: 0 };
    
    if (now - userRateLimit.timestamp > RATE_LIMIT_COOLDOWN) {
        userRateLimit.timestamp = now;
        userRateLimit.count = 1;
    } else {
        userRateLimit.count++;
        if (userRateLimit.count > RATE_LIMIT_MAX_REQUESTS) {
            logWithTimestamp(`Rate limit hit for user ID: ${userId}`, 'RATELIMIT');
            return true;
        }
    }
    
    rateLimitMap.set(userId, userRateLimit);
    return false;
}

function findHighestRole(memberRoles) {
    for (let i = 5; i >= 0; i--) {
        const roleId = process.env[`ROLE_${i}_ID`];
        if (memberRoles.has(roleId)) {
            return i;
        }
    }
    return -1;
}

async function validateEnvironmentVariables() {
    const requiredVariables = [
        'DISCORD_TOKEN',
        'MAIN_CHANNEL_ID',
        'AUTO_DELETE_TIMER',
        'DB_TIMEOUT',
        'MAX_MEMBERS',
        ...Array.from({length: 6}, (_, i) => `ROLE_${i}_ID`),
        ...Array.from({length: 6}, (_, i) => `THREAD_${i}_ID`)
    ];

    const missingVariables = requiredVariables.filter(varName => !process.env[varName]);
    if (missingVariables.length > 0) {
        logWithTimestamp(`Missing environment variables: ${missingVariables.join(', ')}`, 'ERROR');
        process.exit(1);
    }

    const idVariables = [
        'MAIN_CHANNEL_ID',
        ...Array.from({length: 6}, (_, i) => `ROLE_${i}_ID`),
        ...Array.from({length: 6}, (_, i) => `THREAD_${i}_ID`)
    ];

    idVariables.forEach(varName => {
        const value = process.env[varName];
        if (!/^\d+$/.test(value)) {
            logWithTimestamp(`Invalid Discord ID format for ${varName}: ${value}`, 'ERROR');
            process.exit(1);
        }
    });

    if (isNaN(parseInt(process.env.AUTO_DELETE_TIMER)) || parseInt(process.env.AUTO_DELETE_TIMER) < 0) {
        logWithTimestamp('Invalid AUTO_DELETE_TIMER value. Must be a positive number.', 'ERROR');
        process.exit(1);
    }

    if (isNaN(parseInt(process.env.DB_TIMEOUT)) || parseInt(process.env.DB_TIMEOUT) < 0) {
        logWithTimestamp('Invalid DB_TIMEOUT value. Must be a positive number.', 'ERROR');
        process.exit(1);
    }
    
    if (isNaN(parseInt(process.env.MAX_MEMBERS)) || parseInt(process.env.MAX_MEMBERS) <= 0) {
        logWithTimestamp('Invalid MAX_MEMBERS value. Must be a positive number.', 'ERROR');
        process.exit(1);
    }
    
    // Add logging for command permission configuration
    logWithTimestamp('Command access restricted to server administrators only', 'CONFIG');
    logWithTimestamp(`Last updated: 2025-04-14 19:57:33 UTC by noname9006`, 'INFO');
}


function hasCommandPermission(member) {
    // Only allow users with Administrator permission
    return member.permissions.has('Administrator');
}

function checkBotPermissions(guild, channel) {
    const botMember = guild.members.cache.get(client.user.id);
    if (!botMember) {
        logWithTimestamp('Bot member not found in guild', 'ERROR');
        return false;
    }

    const requiredPermissions = [
        'ViewChannel',
        'SendMessages',
        'ManageMessages',
        'EmbedLinks',
        'ManageThreads'
    ];

    const missingPermissions = requiredPermissions.filter(perm => !botMember.permissions.has(perm));
    if (missingPermissions.length > 0) {
        logWithTimestamp(`Missing permissions in ${channel.name}: ${missingPermissions.join(', ')}`, 'ERROR');
        return false;
    }

    return true;
}

const roleToThread = new Map();
const threadToRole = new Map();

function initializeMappings() {
    for (let i = 0; i <= 5; i++) {
        const roleId = process.env[`ROLE_${i}_ID`];
        const threadId = process.env[`THREAD_${i}_ID`];
        roleToThread.set(roleId, threadId);
        threadToRole.set(threadId, roleId);
    }
}

const ignoredRoles = new Set(
    process.env.IGNORED_ROLES
        ? process.env.IGNORED_ROLES.split(',').map(role => role.trim())
        : []
);

async function fetchAllMessagesWithPagination(channel, limit = 5000) {
    const allMessages = new Map();
    let lastId = null;
    let remaining = limit;
    let fetchCount = 0;
    
    logWithTimestamp(`Starting paginated message fetch for ${channel.id} (limit: ${limit})`, 'INFO');
    
    while (remaining > 0) {
        const options = { limit: Math.min(100, remaining) };
        if (lastId) {
            options.before = lastId;
        }
        
        try {
            fetchCount++;
            const messages = await channel.messages.fetch(options);
            
            if (messages.size === 0) {
                logWithTimestamp(`No more messages found after ${allMessages.size} messages`, 'INFO');
                break;
            }
            
            // Add all fetched messages to our collection
            for (const [id, message] of messages) {
                allMessages.set(id, message);
            }
            
            // Update the lastId for pagination
            lastId = messages.last().id;
            remaining -= messages.size;
            
            logWithTimestamp(`Fetched page ${fetchCount}: ${messages.size} messages (total: ${allMessages.size})`, 'INFO');
            
            // If we got fewer messages than requested, we've reached the end
            if (messages.size < Math.min(100, remaining + messages.size)) {
                break;
            }
            
            // Optional: Add a small delay to avoid rate limits
            if (remaining > 0) {
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        } catch (error) {
            logWithTimestamp(`Error fetching messages (page ${fetchCount}): ${error.message}`, 'ERROR');
            // Try to continue with next page despite errors
            if (allMessages.size > 0) {
                const lastMessage = Array.from(allMessages.values()).pop();
                lastId = lastMessage.id;
                continue;
            } else {
                break;
            }
        }
    }
    
    logWithTimestamp(`Completed message fetch: ${allMessages.size} total messages`, 'INFO');
    return allMessages;
}

async function getThreadName(threadId) {
    const cacheEntry = threadNameCache.get(threadId);
    if (cacheEntry) {
        cacheEntry.pendingOps++;
        return {
            name: cacheEntry.name,
            done: () => {
                const entry = threadNameCache.get(threadId);
                if (entry) {
                    entry.pendingOps--;
                }
            }
        };
    }

    try {
        const channel = await client.channels.fetch(threadId);
        if (!channel) {
            return { name: threadId, done: () => {} };
        }
        
        threadNameCache.set(threadId, {
            name: channel.name,
            timestamp: Date.now(),
            pendingOps: 1
        });
        
        return {
            name: channel.name,
            done: () => {
                const entry = threadNameCache.get(threadId);
                if (entry) {
                    entry.pendingOps--;
                }
            }
        };
    } catch (error) {
        logWithTimestamp(`Error fetching thread ${threadId}: ${error.message}`, 'ERROR');
        return { name: threadId, done: () => {} };
    }
}

async function isMessageInForumPost(message) {
    try {
        const channel = message.channel;
        if (!channel.isThread()) return false;
        
        const parent = await channel.parent?.fetch();
        return parent?.id === process.env.MAIN_CHANNEL_ID &&
               parent?.type === ChannelType.GuildForum;
    } catch (error) {
        logWithTimestamp(`Error checking forum post: ${error.message}`, 'ERROR');
        return false;
    }
}

async function checkMessageExists(message, retries = 0) {
    try {
        return await message.channel.messages.fetch(message.id)
            .then(() => true)
            .catch(async (error) => {
                if (retries < MAX_FETCH_RETRIES && error.code === 'NETWORK_ERROR') {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    return checkMessageExists(message, retries + 1);
                }
                return false;
            });
    } catch {
        return false;
    }
}

async function handleWrongThread(message, correctThreadId) {
    // Add this logging statement
    logWithTimestamp(`User ${message.author.tag} (${message.author.id}) posted in wrong thread ${message.channel.id}, should be in ${correctThreadId}`, 'INFO');
    
    const hasAttachments = message.attachments.size > 0;
    let embedDescription = hasAttachments 
        ? 'User uploaded file(s)'
        : message.content.length > MAX_TEXT_LENGTH
            ? message.content.substring(0, MAX_TEXT_LENGTH) + '...'
            : message.content || 'No content';

    const errorEmbed = new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setDescription(`${message.author}, please use the thread that matches your highest role.\nYour message has been removed because it was posted to a wrong thread.`)
        .addFields(
            {
                name: "Here's the right one for you:",
                value: `<#${correctThreadId}>`
            },
            { 
                name: 'Your message content:', 
                value: embedDescription
            }
        )
        .setFooter({
            text: 'Botanix Labs',
            iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
        })
        .setTimestamp();

    try {
        const replyMessage = await message.reply({ embeds: [errorEmbed] });
        if (message.deletable) {
            await message.delete();
        }

        if (AUTO_DELETE_TIMER > 0) {
            setTimeout(async () => {
                try {
                    if (replyMessage.deletable) {
                        await replyMessage.delete();
                    }
                } catch (error) {
                    logWithTimestamp(`Error deleting reply: ${error.message}`, 'ERROR');
                }
            }, AUTO_DELETE_TIMER);
        }
    } catch (error) {
        logWithTimestamp(`Error handling wrong thread: ${error.message}`, 'ERROR');
        if (message.deletable) {
            await message.delete().catch(() => {});
        }
    }
}

async function handleFetchLinksCommand(message) {
    try {
        // Permission check remains the same
        if (!hasCommandPermission(message.member)) {
            const embed = new EmbedBuilder()
                .setColor(ERROR_COLOR)
                .setDescription(`${message.author}, you don't have permission to use this command. Only server administrators can use it.`)
                .setFooter({
                    text: 'Botanix Labs',
                    iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                })
            
            await message.reply({ embeds: [embed] });
            logWithTimestamp(`Command access denied for user ${message.author.tag} (${message.author.id}) - Administrator permission required`, 'WARN');
            return;
        }

        // Command format check remains the same
        const args = message.content.split(' ');
        
        // Enhanced command options
        let channelId;
        let messageLimit = 5000; // Default limit
        
        if (args.length < 3) {
            await message.reply('Usage: !fetch links <channel_id> [message_limit]');
            return;
        }
        
        channelId = args[2];
        
        // Optional message limit parameter
        if (args.length >= 4 && !isNaN(parseInt(args[3]))) {
            messageLimit = Math.min(1000, parseInt(args[3])); // Cap at 1000 for safety
        }
        
        const processingMsg = await message.reply(`Processing... Fetching up to ${messageLimit} messages from <#${channelId}>`);
        
        const targetChannel = await client.channels.fetch(channelId).catch(() => null);
        if (!targetChannel) {
            await processingMsg.edit('Channel not found or bot has no access to it.');
            return;
        }

        logWithTimestamp(`Fetching URLs from channel ${channelId} (limit: ${messageLimit})`, 'INFO');
        
        // Get stored URLs
        const storedUrls = await urlStore.getUrls(channelId);
        const storedUrlMap = new Map(); // Create a map for quick duplicate checking
        
        // Create a map of existing URLs for efficient lookup
        storedUrls.forEach(url => {
            const key = `${url.messageId}_${url.url.trim()}`;
            storedUrlMap.set(key, url);
        });
        
        // Array to hold newly discovered URLs
        let newUrls = [];
        let fetchedUrls = 0;
        
        // Then fetch new URLs with pagination
        if (targetChannel.type === ChannelType.GuildForum) {
            const threads = await targetChannel.threads.fetch();
            
            for (const [threadId, thread] of threads.threads) {
                // Use our new pagination function instead of the simple fetch
                const messages = await fetchAllMessagesWithPagination(thread, messageLimit);
                
                messages.forEach(msg => {
                    if (msg.author.bot) return;
                    
                    const foundUrls = msg.content.match(urlTracker.urlRegex);
                    if (foundUrls) {
                        fetchedUrls += foundUrls.length;
                        const messageUrl = `https://discord.com/channels/${msg.guild.id}/${msg.channel.id}/${msg.id}`;
                        foundUrls.forEach(url => {
                            // Normalize URL by adding https:// if protocol is missing
                            const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
                            const key = `${msg.id}_${normalizedUrl.trim()}`;
                            
                            // Only add if not already in the store
                            if (!storedUrlMap.has(key)) {
                                newUrls.push({
                                    url: normalizedUrl,
                                    timestamp: msg.createdTimestamp,
                                    userId: msg.author.id,
                                    author: msg.author.tag,
                                    threadId: msg.channel.id,
                                    forumChannelId: msg.channel.parent?.id || null,
                                    messageId: msg.id,
                                    messageUrl: messageUrl,
                                    guildId: msg.guild.id
                                });
                            }
                        });
                    }
                });
                
                // Optional: Add progress updates for the user
                await processingMsg.edit(`Processing... Scanned thread "${thread.name}" (found ${newUrls.length} new URLs so far)`);
            }
        } else {
            // Regular channel - use pagination here too
            const messages = await fetchAllMessagesWithPagination(targetChannel, messageLimit);
            
            messages.forEach(msg => {
                if (msg.author.bot) return;
                
                const foundUrls = msg.content.match(urlTracker.urlRegex);
                if (foundUrls) {
                    fetchedUrls += foundUrls.length;
                    const messageUrl = `https://discord.com/channels/${msg.guild.id}/${msg.channel.id}/${msg.id}`;
                    foundUrls.forEach(url => {
                        // Normalize URL by adding https:// if protocol is missing
                        const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
                        const key = `${msg.id}_${normalizedUrl.trim()}`;
                        
                        // Only add if not already in the store
                        if (!storedUrlMap.has(key)) {
                            newUrls.push({
                                url: normalizedUrl,
                                timestamp: msg.createdTimestamp,
                                userId: msg.author.id,
                                author: msg.author.tag,
                                messageId: msg.id,
                                messageUrl: messageUrl,
                                channelId: msg.channel.id,
                                threadId: msg.channel.isThread() ? msg.channel.id : null,
                                forumChannelId: msg.channel.isThread() ? msg.channel.parent?.id : null,
                                guildId: msg.guild.id
                            });
                        }
                    });
                }
            });
        }

        // Sort by timestamp
        newUrls = newUrls.sort((a, b) => a.timestamp - b.timestamp);

        // Save only new URLs with retries
        let saved = false;
        let retries = 3;
        
        if (newUrls.length > 0) {
            await processingMsg.edit(`Found ${newUrls.length} new URLs. Saving to database...`);
            
            while (!saved && retries > 0) {
                try {
                    await urlStore.saveUrls(channelId, newUrls);
                    saved = true;
                    logWithTimestamp(`Successfully saved ${newUrls.length} new URLs for channel ${channelId}`, 'INFO');
                } catch (error) {
                    retries--;
                    if (retries === 0) {
                        throw error;
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        } else {
            saved = true; // No new URLs to save, but operation was successful
        }

        if (fetchedUrls === 0) {
            await processingMsg.edit('No URLs found in this channel.');
            return;
        }

        // Get channel name for better display
        let channelDisplay;
        try {
            // Format as a channel mention that will be clickable in Discord
            channelDisplay = `<#${channelId}>`;
        } catch (error) {
            // Fallback to just ID if we can't get proper format
            channelDisplay = channelId;
        }

        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('URLs fetched')
            .setDescription(`Analysis for channel: ${channelDisplay}`)
            .addFields(
                { name: 'URLs in Database', value: `${storedUrls.length}`, inline: true },
                { name: 'URLs Found', value: `${fetchedUrls}`, inline: true },
                { name: 'New URLs Added', value: `${newUrls.length}`, inline: true },
                { 
                    name: 'Storage Status', 
                    value: saved ? '✅ URLs saved successfully' : '❌ Failed to save URLs'
                },
            )
            .setFooter({
                text: 'Botanix Labs',
                iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
            })

        await processingMsg.edit({ content: null, embeds: [embed] });
        logWithTimestamp(`Fetch command complete - Found: ${fetchedUrls}, Added: ${newUrls.length}, Total in DB: ${storedUrls.length + newUrls.length}`, 'INFO');
    } catch (error) {
        logWithTimestamp(`Error handling fetch links command: ${error.message}`, 'ERROR');
        await message.reply('An error occurred while processing the command: ' + error.message).catch(() => {});
    }
}

// New function to handle check members command
async function handleCheckMembersCommand(message) {
    try {
        // Permission check
        if (!hasCommandPermission(message.member)) {
            const embed = new EmbedBuilder()
                .setColor(ERROR_COLOR)
                .setDescription(`${message.author}, you don't have permission to use this command. Only server administrators can use it.`)
                .setFooter({
                    text: 'Botanix Labs',
                    iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                });
            
            await message.reply({ embeds: [embed] });
            logWithTimestamp(`Command access denied for user ${message.author.tag} (${message.author.id}) - Administrator permission required`, 'WARN');
            return;
        }

        const args = message.content.split(' ');
        let threadId;
        
        if (args.length < 3) {
            const embed = new EmbedBuilder()
                .setColor(ERROR_COLOR)
                .setDescription('Usage: !check members <thread_id>')
                .setFooter({
                    text: 'Botanix Labs',
                    iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                });
            
            await message.reply({ embeds: [embed] });
            return;
        }
        
        threadId = args[2];
        
        const processingMsg = await message.reply(`Processing... Checking member count for thread ID: ${threadId}`);
        
        // Manually trigger member count check
        if (!memberTracker.trackedThreads.has(threadId)) {
            await processingMsg.edit(`Thread ID ${threadId} is not being tracked by the member tracker.`);
            return;
        }
        
        await memberTracker.checkThreadMemberCount(threadId);
        
        const threadConfig = memberTracker.trackedThreads.get(threadId);
        const thread = await client.channels.fetch(threadId).catch(() => null);
        
        if (!thread) {
            await processingMsg.edit(`Could not fetch thread with ID ${threadId}.`);
            return;
        }
        
        const memberCount = await memberTracker.getThreadMemberCount(thread);
        
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('Thread Member Check')
            .setDescription(`Member count for thread: ${thread.name}`)
            .addFields(
                { name: 'Current Member Count', value: `${memberCount}`, inline: true },
                { name: 'Maximum Members', value: `${threadConfig.maxMembers}`, inline: true },
                { name: 'Status', value: memberCount > threadConfig.maxMembers ? 
                    '⚠️ Exceeds maximum - members will be removed' : 
                    '✅ Within limit' }
            )
            .setFooter({
                text: 'Botanix Labs',
                iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
            })
            .setTimestamp();

        await processingMsg.edit({ content: null, embeds: [embed] });
        
    } catch (error) {
        logWithTimestamp(`Error handling check members command: ${error.message}`, 'ERROR');
        await message.reply('An error occurred while processing the command: ' + error.message).catch(() => {});
    }
}

// Cache cleanup
setInterval(() => {
    const now = Date.now();
    // Clean up rate limit map
    for (const [userId, timestamp] of rateLimitMap.entries()) {
        if (now - timestamp > RATE_LIMIT_COOLDOWN * 2) {
            rateLimitMap.delete(userId);
        }
    }
    // Clean up thread name cache
    for (const [threadId, data] of threadNameCache.entries()) {
                if (now - data.timestamp > THREAD_CACHE_TTL && data.pendingOps === 0) {
            threadNameCache.delete(threadId);
        }
    }
}, CACHE_CLEANUP_INTERVAL);

// Create instances
const urlStore = new UrlStorage();
const urlTracker = new UrlTracker(client, urlStore);
let memberTracker; // Will be initialized in the ready event

client.once('ready', async () => {
    try {
        await urlStore.init();  // Initialize urlStore first
        await urlTracker.init(); // Then initialize urlTracker
        
        // Initialize and start the member tracker
        memberTracker = new MemberTracker(client);
        await memberTracker.init();
        
        initializeMappings();
        
        const mainChannel = await client.channels.fetch(process.env.MAIN_CHANNEL_ID);
        if (!mainChannel || mainChannel.type !== ChannelType.GuildForum) {
            throw new Error('MAIN_CHANNEL_ID must be a forum channel');
        }
        
        logWithTimestamp('Bot initialized successfully', 'STARTUP');
        logWithTimestamp(`Monitoring forum channel: ${mainChannel.name}`, 'CONFIG');
        logWithTimestamp(`Last updated: 2025-04-14 19:57:33 UTC by noname9006`, 'INFO');

        // URL cleanup has been disabled
        logWithTimestamp('URL cleanup has been disabled - URLs will be kept forever', 'CONFIG');
        
    } catch (error) {
        logWithTimestamp(`Initialization error: ${error.message}`, 'FATAL');
        process.exit(1);
    }
});

// Add new event handler for threadMembersUpdate event
client.on('threadMembersUpdate', async (oldMembers, newMembers) => {
    if (!memberTracker) return;
    
    const threadId = newMembers.thread.id;
    
    // Check if this is a thread we're tracking
    if (memberTracker.trackedThreads.has(threadId)) {
        logWithTimestamp(`Thread members updated in tracked thread ${threadId}`, 'INFO');
        await memberTracker.checkThreadMemberCount(threadId);
    }
});

client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot || !message.guild || !message.member) return;

        // Handle commands
        if (message.content.startsWith('!fetch links')) {
            await handleFetchLinksCommand(message);
            return;
        }
        
        // Handle member check command
        if (message.content.startsWith('!check members')) {
            await handleCheckMembersCommand(message);
            return;
        }

        const isForumPost = await isMessageInForumPost(message);
        if (!isForumPost) return;

        if (!checkBotPermissions(message.guild, message.channel)) {
            logWithTimestamp(`Insufficient permissions in channel ${message.channel.name}`, 'ERROR');
            return;
        }

        const threadNameData = await getThreadName(message.channel.id);
        try {
            if (checkRateLimit(message.author.id)) return;

            if (message.member.roles.cache.some(role => ignoredRoles.has(role.id))) return;

            const highestRoleIndex = findHighestRole(message.member.roles.cache);
            if (highestRoleIndex === -1) return;

            const correctThreadId = process.env[`THREAD_${highestRoleIndex}_ID`];
            
            if (message.channel.id !== correctThreadId) {
                await handleWrongThread(message, correctThreadId);
                return;
            }

            const urls = message.content.match(urlTracker.urlRegex);
            if (urls) {
                // Create a function for the timeout callback
                const checkAndStoreUrls = async () => {
                    try {
                        const messageExists = await checkMessageExists(message);
                        if (messageExists) {
                            await urlTracker.handleUrlMessage(message, urls);
                        } else {
                            logWithTimestamp(`Message ${message.id} no longer exists, skipping URL check`, 'INFO');
                        }
                    } catch (error) {
                        logWithTimestamp(`Error in URL check: ${error.message}`, 'ERROR');
                    }
                };

                // Set the timeout with the async function
                setTimeout(checkAndStoreUrls, URL_CHECK_TIMEOUT);
            }
        } finally {
            threadNameData.done();
        }
    } catch (error) {
        logWithTimestamp(`Error processing message: ${error.message}`, 'ERROR');
    }
});

client.on('error', error => {
    logWithTimestamp(`Client error: ${error.message}`, 'ERROR');
});

process.on('uncaughtException', error => {
    logWithTimestamp(`Fatal error: ${error.message}`, 'FATAL');
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    logWithTimestamp(`Unhandled rejection: ${reason}`, 'ERROR');
    try {
        await promise;
    } catch (error) {
        logWithTimestamp(`Failed to handle rejection: ${error}`, 'ERROR');
    }
});

process.on('SIGINT', () => {
    logWithTimestamp('Shutting down...', 'SHUTDOWN');
    urlStore.shutdown();
    urlTracker.shutdown();
    if (memberTracker) memberTracker.shutdown();
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logWithTimestamp('Shutting down...', 'SHUTDOWN');
    urlStore.shutdown();
    urlTracker.shutdown();
    if (memberTracker) memberTracker.shutdown();
    client.destroy();
    process.exit(0);
});

validateEnvironmentVariables();

client.login(process.env.DISCORD_TOKEN).catch(error => {
    logWithTimestamp(`Login failed: ${error.message}`, 'FATAL');
    process.exit(1);
});