const fs = require('fs/promises');
const path = require('path');
const { logWithTimestamp } = require('./utils');

class UrlStorage {
    constructor() {
        this.urls = new Map();
        this.storageFile = '';
        this.isInitialized = false;
    }

    async init() {
        try {
            const mainChannelId = process.env.MAIN_CHANNEL_ID;
            if (!mainChannelId) {
                throw new Error('MAIN_CHANNEL_ID environment variable is not set');
            }

            this.storageFile = path.join(__dirname, `URL_DB_${mainChannelId}.json`);
            
            const data = await fs.readFile(this.storageFile, 'utf8').catch(() => '{}');
            const urlData = JSON.parse(data);
            
            for (const [channelId, urls] of Object.entries(urlData)) {
                this.urls.set(channelId, urls);
            }
            
            this.isInitialized = true;
            logWithTimestamp('URL storage initialized', 'STARTUP');
        } catch (error) {
            logWithTimestamp(`Error initializing URL storage: ${error.message}`, 'ERROR');
            this.urls = new Map();
            this.isInitialized = false;
            throw error;
        }
    }

    // Helper method to check for duplicates across all channels
    isDuplicateUrl(url) {
        for (const urls of this.urls.values()) {
            if (urls.some(entry => entry.url.trim() === url.trim())) {
                return true;
            }
        }
        return false;
    }

    async findUrlHistory(url) {
    if (!this.isInitialized) {
        logWithTimestamp('URL storage not initialized', 'ERROR');
        return null;
    }

    const trimmedUrl = url.trim();
    for (const [channelId, urls] of this.urls.entries()) {
        const foundUrl = urls.find(entry => entry.url.trim() === trimmedUrl);
        if (foundUrl) {
            logWithTimestamp(`URL history found for: ${url} in channel ${channelId}`, 'INFO');
            return {
                ...foundUrl,
                channelId
            };
        }
    }

    logWithTimestamp(`No URL history found for: ${url}`, 'INFO');
    return null;
}

async saveUrls(channelId, newUrls) {
    if (!this.isInitialized) {
        logWithTimestamp('URL storage not initialized', 'ERROR');
        return 0;
    }

    try {
        const existingUrls = this.urls.get(channelId) || [];
        const updatedUrls = [...existingUrls];
        let addedCount = 0;

        for (const newUrl of newUrls) {
            // Check if URL with the same messageId already exists
            const isDuplicate = updatedUrls.some(existing => 
                existing.messageId === newUrl.messageId && 
                existing.url.trim() === newUrl.url.trim()
            );
            
            // Only add if not a duplicate
            if (!isDuplicate) {
                updatedUrls.push({
                    ...newUrl,
                    url: newUrl.url.trim(),
                    messageUrl: newUrl.messageUrl,
                    userId: newUrl.userId,
                    messageId: newUrl.messageId
                });
                logWithTimestamp(`Added URL: ${newUrl.url}`, 'INFO');
                addedCount++;
            } else {
                logWithTimestamp(`Skipped duplicate message URL: ${newUrl.url} (messageId: ${newUrl.messageId})`, 'INFO');
            }
        }

        if (addedCount > 0) {
            // Sort by ascending timestamp (oldest first)
            updatedUrls.sort((a, b) => a.timestamp - b.timestamp);
            this.urls.set(channelId, updatedUrls);
            
            const urlData = Object.fromEntries(this.urls);
            await fs.writeFile(this.storageFile, JSON.stringify(urlData, null, 2));
            
            logWithTimestamp(`Saved ${addedCount} URLs for channel ${channelId}`, 'INFO');
        }
        
        return addedCount;
    } catch (error) {
        logWithTimestamp(`Error saving URLs: ${error.message}`, 'ERROR');
        return 0;
    }
}

    async addUrl(url, userId, channelId, threadId = null, messageId, author = 'Unknown') {
        if (!this.isInitialized) {
            logWithTimestamp('URL storage not initialized', 'ERROR');
            return null;
        }

        const trimmedUrl = url.trim();
        if (this.isDuplicateUrl(trimmedUrl)) {
            logWithTimestamp(`Skipped duplicate URL: ${trimmedUrl}`, 'INFO');
            return null;
        }

        const urlEntry = {
            url: trimmedUrl,
            userId,
            channelId,
            threadId,
            messageId,
            author,
            timestamp: Date.now()
        };

        const addedCount = await this.saveUrls(channelId, [urlEntry]);
        if (addedCount > 0) {
            logWithTimestamp(`Added URL: ${trimmedUrl} by ${author}`, 'INFO');
            return urlEntry;
        }
        return null;
    }

    async deleteUrl(url) {
        if (!this.isInitialized) {
            logWithTimestamp('URL storage not initialized', 'ERROR');
            return false;
        }

        let deleted = false;
        for (const [channelId, urls] of this.urls.entries()) {
            const index = urls.findIndex(entry => entry.url.trim() === url.trim());
            if (index !== -1) {
                urls.splice(index, 1);
                const urlData = Object.fromEntries(this.urls);
                await fs.writeFile(this.storageFile, JSON.stringify(urlData, null, 2));
                
                // Reload the storage after deletion
                await this.reload();
                
                deleted = true;
                logWithTimestamp(`Deleted URL: ${url}`, 'INFO');
                break;
            }
        }

        return deleted;
    }

    // Get URLs for a specific channel
    getUrls(channelId) {
        if (!this.isInitialized) {
            logWithTimestamp('URL storage not initialized', 'ERROR');
            return [];
        }
        return this.urls.get(channelId) || [];
    }

    async cleanup() {
        // This method is now disabled
        logWithTimestamp('URL cleanup is disabled - URLs will be kept forever', 'INFO');
        return;
    }

    async getAllChannelIds() {
        return Array.from(this.urls.keys());
    }

    async reload() {
        try {
            if (!this.storageFile) {
                throw new Error('Storage file path not set. Initialize first.');
            }
            
            const data = await fs.readFile(this.storageFile, 'utf8').catch(() => '{}');
            const urlData = JSON.parse(data);
            
            this.urls.clear();
            for (const [channelId, urls] of Object.entries(urlData)) {
                this.urls.set(channelId, urls);
            }
            
            logWithTimestamp('URL storage reloaded', 'INFO');
        } catch (error) {
            logWithTimestamp(`Error reloading URL storage: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    async getStats() {
        const stats = {
            totalUrls: 0,
            channelCount: this.urls.size,
            urlsPerChannel: {}
        };

        for (const [channelId, urls] of this.urls.entries()) {
            stats.totalUrls += urls.length;
            stats.urlsPerChannel[channelId] = urls.length;
        }

        return stats;
    }

    shutdown() {
        logWithTimestamp('URL Storage shutting down...', 'SHUTDOWN');
        this.isInitialized = false;
        // Any cleanup code if needed
    }
}

module.exports = UrlStorage;