const { EmbedBuilder, ChannelType } = require('discord.js');
const UrlStorage = require('./urlStore');
const { logWithTimestamp } = require('./utils');
const { DB_TIMEOUT, THRESHOLD_DUPE_AGE } = require('./config');

class UrlTracker {
    constructor(client, urlStore) {
        this.client = client;
        this.urlStore = urlStore; // Use the provided instance instead of creating a new one
        this.urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
    }

    async syncWithStorage(channelId) {
        try {
            // Skip fetching URLs during initialization
            // Only sync when explicitly requested after startup
            if (this.initializing) {
                logWithTimestamp(`Skipping URL sync for channel ${channelId} during initialization`, 'INFO');
                return;
            }
            
            const urls = await this.fetchAllUrlsFromChannel(channelId);
            if (urls.length > 0) {
                await this.urlStore.saveUrls(channelId, urls);
                logWithTimestamp(`Synced ${urls.length} URLs for channel ${channelId}`, 'INFO');
            }
        } catch (error) {
            logWithTimestamp(`Error syncing channel ${channelId}: ${error.message}`, 'ERROR');
        }
    }

    async init() {
        try {
            // Add a flag to track initialization state
            this.initializing = true;
            
            // Get channel IDs but don't sync during initialization
            const channelIds = await this.urlStore.getAllChannelIds();
            logWithTimestamp(`Found ${channelIds.length} channels in storage. Skipping sync during initialization.`, 'INFO');
            
            // Turn off initialization flag when complete
            this.initializing = false;
            
            logWithTimestamp('URL Tracker initialized successfully', 'INFO');
        } catch (error) {
            this.initializing = false;
            logWithTimestamp(`Failed to initialize URL Tracker: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    async sendLogToChannel(title, fields) {
    try {
        // Check if logging is enabled via environment variable
        const logChannelId = process.env.LOG_CHANNEL_ID;
        if (!logChannelId) {
            return false; // Logging disabled, no channel ID specified
        }

        // Get the logging channel
        const logChannel = await this.client.channels.fetch(logChannelId).catch(() => null);
        if (!logChannel) {
            logWithTimestamp(`Failed to fetch log channel (${logChannelId}), ensure it exists and bot has access`, 'ERROR');
            return false;
        }

        // Create and send the embed - NO PROCESSING
        const embed = new EmbedBuilder()
            .setColor('#ff9900')
            .setTitle(title)
            .addFields(...fields)
            .setTimestamp()
            .setFooter({
                text: 'Botanix Labs URL Tracker',
                iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
            });

        await logChannel.send({ embeds: [embed] });
        return true;
    } catch (error) {
        logWithTimestamp(`Error sending log to channel: ${error.message}`, 'ERROR');
        return false;
    }
}

    async handleUrlMessage(message, urls) {
        try {
            // Scenario 0: Check if any of the URLs contain BOTANIX_TWITTER value
            if (process.env.BOTANIX_TWITTER && process.env.BOTANIX_TWITTER.trim() !== '') {
                const botanixTwitterValue = process.env.BOTANIX_TWITTER.trim().toLowerCase();
                const containsBotanixTwitter = urls.some(url => 
                    url.toLowerCase().includes(botanixTwitterValue));
                
                if (containsBotanixTwitter) {
                    logWithTimestamp(`Found Botanix Twitter URL: ${urls.join(', ')}`, 'INFO');
                    const embed = new EmbedBuilder()
                        .setColor('#ff0000')
                        .setDescription(`<@${message.author.id}>, simply resharing Botanix tweets doesn't add much value\nPlease contribute with your own original content`)
                        .setFooter({
                            text: 'Botanix Labs',
                            iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                        });

                    // Send as a reply instead of a standalone message
                    const replyMessage = await message.reply({ embeds: [embed] });

                    // Delete the user's message
                    if (message.deletable) {
                        await message.delete();
                    }
                    
                    // Send log to designated channel
                    await this.sendLogToChannel(
                        'Botanix Twitter URL Posted and Removed',
                        [
                            { name: 'Sender', value: `<@${message.author.id}> (${message.author.id})` },
                            { name: 'URL', value: urls.find(url => url.toLowerCase().includes(botanixTwitterValue)) || 'Unknown' }
                        ]
                    );
                    
                    return [];
                }
            }
            
            const urlsToStore = []; // Add this array to collect new URLs
            
            for (const url of urls) {
                logWithTimestamp(`Checking URL: ${url}`, 'INFO');
                const existingUrl = await this.urlStore.findUrlHistory(url);
                
                if (existingUrl) {
                    logWithTimestamp(`Found existing URL: ${url} from author: ${existingUrl.author}`, 'INFO'); 
                    
                    // Check if the original poster is the same as current author
                    if (existingUrl.author !== message.author.tag) {
                        // Different author - not allowed (Scenario 1)
                        const embed = new EmbedBuilder()
                            .setColor('#ff0000')
                            .setTitle('Please share only your own original content!')
                            .setDescription(`${message.author}, this URL was previously shared by another user`)
                            .addFields(
                                {name: 'Original message:', value: `https://discord.com/channels/${message.guild.id}/${existingUrl.threadId}/${existingUrl.messageId}` },
                                { name: 'URL:', value: url }
                            )
                            .setFooter({
                                text: 'Botanix Labs',
                                iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                            });

                        await message.reply({ embeds: [embed] });
                        await message.react('🚫'); // Add no_entry_sign reaction
                        
                        // Send log to designated channel
                        await this.sendLogToChannel(
                            'Different User Posted Same URL',
                            [
                                { name: 'Sender', value: `<@${message.author.id}> (${message.author.id})` },
                                { name: 'Message', value: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`, inline: true},
                                { name: 'Original Message', value: `https://discord.com/channels/${message.guild.id}/${existingUrl.threadId}/${existingUrl.messageId}`, inline: false},
                                { name: 'Original Poster', value: existingUrl.userId ? `<@${existingUrl.userId}> (${existingUrl.userId})` : existingUrl.author || 'Unknown' },
                                { name: 'URL', value: url },
								{ name: 'Warning', value: 'Sent to user', inline: false }
                            ]
                        );
                        
                        logWithTimestamp(`Sent duplicate URL notification for: ${url}`, 'INFO');
                    } else {
                        // Same author - check if same thread
                        if (existingUrl.channelId !== message.channel.id) {
                            // Different thread
                            const embed = new EmbedBuilder()
                                .setColor('#ff0000')
                                .setTitle(`You have posted this before`)
                                .setDescription(`${message.author}, you shared this URL in a different thread`)
                                .addFields(
                                    { name: 'Original message:', value: `https://discord.com/channels/${message.guild.id}/${existingUrl.threadId}/${existingUrl.messageId}` },
                                    { name: 'URL:', value: url }
                                )
                                .setFooter({
                                    text: 'Botanix Labs',
                                    iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                                });

                            await message.reply({ embeds: [embed] });
                            await message.react('🚫'); 
                            
                            // Send log to designated channel
                            await this.sendLogToChannel(
                                'Same User Posted URL in Different Thread',
                                [                                   
                                    { name: 'Sender', value: `<@${message.author.id}> (${message.author.id})` },
                                    { name: 'Message', value: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}` },
                                    { name: 'Original Message', value: `https://discord.com/channels/${message.guild.id}/${existingUrl.threadId}/${existingUrl.messageId}` },
                                    { name: 'URL', value: url },
									{ name: 'Warning', value: 'Sent to user' }
                                ]
                            );
                            
                            logWithTimestamp(`Sent same-author different-thread notification for: ${url}`, 'INFO');
                        } else {
                            // Same thread - check if original message exists
                            const originalMessage = await message.channel.messages
                                .fetch(existingUrl.messageId)
                                .catch(() => null);

                            if (originalMessage) {
                                // Original message still exists
                                const embed = new EmbedBuilder()
                                    .setColor('#ff0000')
                                    .setTitle(`You have posted this before`)
                                    .setDescription(`${message.author}, you already shared this URL in this thread`)
                                    .addFields(
                                        { name: 'Original Message:', value: `https://discord.com/channels/${message.guild.id}/${existingUrl.threadId}/${existingUrl.messageId}` },
                                        { name: 'URL', value: url }
                                    )
                                    .setFooter({
                                        text: 'Botanix Labs',
                                        iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                                    });

                                await message.reply({ embeds: [embed] });
                                await message.react('⭕');
                                
                                // Send log to designated channel
                                await this.sendLogToChannel(
                                    'Same User Reposted URL in Same Thread',
                                    [
                                        
                                        { name: 'Sender', value: `<@${message.author.id}> (${message.author.id})` },
                                        { name: 'Message', value: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}` },
                                        { name: 'Original Message', value: `https://discord.com/channels/${message.guild.id}/${existingUrl.threadId}/${existingUrl.messageId}` },
                                        { name: 'URL', value: url },
										{ name: 'Warning', value: 'Sent to user' }
                                    ]
                                );
                                
                                logWithTimestamp(`Sent same-thread notification for: ${url}`, 'INFO');
                            } else {
                                // Original message is gone - check age threshold
                                const currentTime = Date.now();
                                const originalTime = existingUrl.timestamp;
                                const ageInMinutes = (currentTime - originalTime) / (60 * 1000);
                                
                                if (ageInMinutes < THRESHOLD_DUPE_AGE) {
                                    // Less than threshold - treat as new URL
                                    await this.urlStore.deleteUrl(url);
                                    logWithTimestamp(`Deleted old URL entry as original message no longer exists and age (${ageInMinutes.toFixed(2)} min) is less than threshold: ${url}`, 'INFO');
                                    urlsToStore.push({
                                        url,
                                        timestamp: message.createdTimestamp,
                                        author: message.author.tag,
                                        authorId: message.author.id,
                                        threadName: message.channel.name,
                                        threadId: message.channel.id,                      // Explicit thread ID
                                        forumChannelId: message.channel.parent?.id,        // Parent forum channel ID
                                        messageId: message.id,
                                        messageUrl: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`,
                                        guildId: message.guild.id
                                    });
                                    
                                    // Send log to designated channel
                                    await this.sendLogToChannel(
                                        'URL Reposted After Original Was Deleted (Within Threshold)',
                                        [
                                            { name: 'Sender', value: `<@${message.author.id}> (${message.author.id})` },
                                            { name: 'Message', value: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}` },
                                            { name: 'Original Message', value: `deleted (age: ${ageInMinutes.toFixed(1)} minutes)` },
                                            { name: 'URL', value: url },
											{ name: 'Warning', value: 'Not sent - URL treated as new' }
                                        ]
                                    );
                                } else {
                                    // More than threshold - send warning as duplicate
                                    const embed = new EmbedBuilder()
                                        .setColor('#ff0000')
                                        .setTitle(`You have posted this before`)
                                        .setDescription(`${message.author}, you already shared this URL in this thread`)
                                        .addFields(
                                            { name: 'Original Message:', value: `deleted` },
                                        )
                                        .setFooter({
                                            text: 'Botanix Labs',
                                            iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                                        });

                                    await message.reply({ embeds: [embed] });
                                    await message.react('⭕');
                                    
                                    // Send log to designated channel  
                                    await this.sendLogToChannel(
                                        'URL Reposted After Original Was Deleted (Beyond Threshold)',
                                        [
                                            
                                            { name: 'Sender', value: `<@${message.author.id}> (${message.author.id})` },
                                            { name: 'Message', value: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}` },
                                            { name: 'Original Message', value: `deleted (age: ${ageInMinutes.toFixed(1)} minutes)` },
                                { name: 'URL', value: url },
								{ name: 'Warning', value: 'Sent to user' }
                                        ]
                                    );
                                    
                                    logWithTimestamp(`Sent same-thread notification for deleted message with age (${ageInMinutes.toFixed(2)} min) exceeding threshold: ${url}`, 'INFO');
                                }
                            }
                        }
                    }
                } else {
                    // New URL - add it to store
                    urlsToStore.push({
                        url,
                        timestamp: message.createdTimestamp,
                        author: message.author.tag,
                        authorId: message.author.id,
                        threadName: message.channel.name,
                        threadId: message.channel.id,
                        forumChannelId: message.channel.parent?.id || null,
                        messageId: message.id,
                        messageUrl: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`,
                        guildId: message.guild.id
                    });
                }
            }
            
            // Store new URLs if any
            if (urlsToStore.length > 0) {
                try {
                    await this.urlStore.saveUrls(message.channel.id, urlsToStore);
                } catch (error) {
                    logWithTimestamp(`Failed to store URLs: ${error.message}`, 'ERROR');
                }
            }
            
            return urlsToStore; // Return the stored URLs for reference
        } catch (error) {
            logWithTimestamp(`Error handling URL message: ${error.message}`, 'ERROR');
            return [];
        }
    }

    async fetchAllUrlsFromChannel(channelId) {
        try {
            const channel = await this.client.channels.fetch(channelId).catch(() => null);
            if (!channel) {
                logWithTimestamp(`Channel not found: ${channelId}`, 'ERROR');
                return [];
            }
            
            const urls = [];
            
            // Check if it's a forum channel
            if (channel.type === ChannelType.GuildForum) {
                const threads = await channel.threads.fetch();
                
                for (const [threadId, thread] of threads.threads) {
                    const messages = await thread.messages.fetch({ limit: 100 });
                    
                    messages.forEach(msg => {
                        if (msg.author.bot) return;
                        
                        const foundUrls = msg.content.match(this.urlRegex);
                        if (foundUrls) {
                            const messageUrl = `https://discord.com/channels/${msg.guild.id}/${msg.channel.id}/${msg.id}`;
                            foundUrls.forEach(url => {
                                urls.push({
                                    url,
                                    timestamp: msg.createdTimestamp,
                                    userId: msg.author.id,
                                    author: msg.author.tag,
                                    threadId: msg.channel.id,
                                    forumChannelId: channel.id,
                                    messageId: msg.id,
                                    messageUrl: messageUrl,
                                    guildId: msg.guild.id
                                });
                            });
                        }
                    });
                }
            } else {
                // Regular channel
                const messages = await channel.messages.fetch({ limit: 100 });
                
                messages.forEach(msg => {
                    if (msg.author.bot) return;
                    
                    const foundUrls = msg.content.match(this.urlRegex);
                    if (foundUrls) {
                        const messageUrl = `https://discord.com/channels/${msg.guild.id}/${msg.channel.id}/${msg.id}`;
                        foundUrls.forEach(url => {
                            urls.push({
                                url,
                                timestamp: msg.createdTimestamp,
                                userId: msg.author.id,
                                author: msg.author.tag,
                                channelId: channel.id,
                                threadId: channel.isThread() ? channel.id : null,
                                forumChannelId: channel.isThread() ? channel.parent?.id : null,
                                messageId: msg.id,
                                messageUrl: messageUrl,
                                guildId: msg.guild.id
                            });
                        });
                    }
                });
            }
            
            return urls;
        } catch (error) {
            logWithTimestamp(`Error fetching URLs from channel ${channelId}: ${error.message}`, 'ERROR');
            return [];
        }
    }

    shutdown() {
        logWithTimestamp('URL Tracker shutting down...', 'SHUTDOWN');
        // No cleanup needed since we're using the shared UrlStorage instance
    }
}

module.exports = UrlTracker;
