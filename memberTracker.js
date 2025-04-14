const { PermissionsBitField } = require('discord.js');
const { logWithTimestamp } = require('./utils');

class MemberTracker {
    constructor(client) {
        this.client = client;
        this.trackedThreads = new Map(); // Map to store thread IDs and their configurations
        this.checkInterval = null;
        this.initializing = true;
        this.checkFrequency = parseInt(process.env.MEMBER_CHECK_FREQUENCY) || 5 * 60 * 1000; // Default: 5 minutes
    }

    async init() {
        try {
            this.initializing = true;
            
            // Get MAX_MEMBERS from environment
            const maxMembers = parseInt(process.env.MAX_MEMBERS);
            if (isNaN(maxMembers) || maxMembers <= 0) {
                throw new Error('MAX_MEMBERS environment variable must be a positive number');
            }
            
            // Find all THREAD_X_ID environment variables
            const threadEnvs = Object.keys(process.env)
                .filter(key => key.match(/^THREAD_\d+_ID$/))
                .sort();
            
            if (threadEnvs.length === 0) {
                throw new Error('No THREAD_X_ID variables found in environment');
            }
            
            // Initialize tracked threads
            for (const threadEnv of threadEnvs) {
                const threadId = process.env[threadEnv];
                if (!threadId) continue;
                
                try {
                    const thread = await this.client.channels.fetch(threadId);
                    if (!thread || !thread.isThread()) {
                        logWithTimestamp(`Warning: ${threadEnv} (${threadId}) is not a valid thread. Skipping.`, 'WARN');
                        continue;
                    }
                    
                    this.trackedThreads.set(threadId, {
                        id: threadId,
                        envName: threadEnv,
                        maxMembers: maxMembers,
                        lastCheck: 0,
                    });
                    
                    logWithTimestamp(`Thread tracked: ${thread.name} (${threadId}) with max ${maxMembers} members`, 'INFO');
                } catch (error) {
                    logWithTimestamp(`Error initializing thread ${threadEnv} (${threadId}): ${error.message}`, 'ERROR');
                }
            }
            
            if (this.trackedThreads.size === 0) {
                throw new Error('No valid threads found for tracking');
            }
            
            // Set up interval for checking member counts
            this.checkInterval = setInterval(() => this.checkAllThreads(), this.checkFrequency);
            
            // Do an initial check
            await this.checkAllThreads();
            
            this.initializing = false;
            logWithTimestamp(`Member Tracker initialized with ${this.trackedThreads.size} threads`, 'STARTUP');
        } catch (error) {
            this.initializing = false;
            logWithTimestamp(`Failed to initialize Member Tracker: ${error.message}`, 'ERROR');
            throw error;
        }
    }
    
    async checkAllThreads() {
        for (const [threadId, threadConfig] of this.trackedThreads.entries()) {
            try {
                await this.checkThreadMemberCount(threadId);
            } catch (error) {
                logWithTimestamp(`Error checking thread ${threadId}: ${error.message}`, 'ERROR');
            }
        }
    }
    
    async checkThreadMemberCount(threadId) {
        const threadConfig = this.trackedThreads.get(threadId);
        if (!threadConfig) return;
        
        try {
            const thread = await this.client.channels.fetch(threadId);
            if (!thread || !thread.isThread()) {
                logWithTimestamp(`Thread ${threadId} no longer exists or is not a thread`, 'WARN');
                return;
            }
            
            // Get the current member count
            const memberCount = await this.getThreadMemberCount(thread);
            
            // Log current count periodically
            logWithTimestamp(`Thread ${thread.name} (${threadId}) has ${memberCount}/${threadConfig.maxMembers} members`, 'INFO');
            
            // Check if count exceeds maximum
            if (memberCount > threadConfig.maxMembers) {
                logWithTimestamp(`Thread ${thread.name} (${threadId}) exceeds max members: ${memberCount}/${threadConfig.maxMembers}`, 'WARN');
                await this.removeExcessMembers(thread, threadConfig.maxMembers);
            }
            
            // Update last check timestamp
            threadConfig.lastCheck = Date.now();
            this.trackedThreads.set(threadId, threadConfig);
            
        } catch (error) {
            logWithTimestamp(`Error checking thread ${threadId} member count: ${error.message}`, 'ERROR');
        }
    }
    
    async getThreadMemberCount(thread) {
        // Fetch the members of the thread
        const members = await thread.members.fetch();
        return members.size;
    }
    
    async removeExcessMembers(thread, maxMembers) {
        try {
            // Get the thread members
            const threadMembers = await thread.members.fetch();
            
            // If we're already at or below the limit, no action needed
            if (threadMembers.size <= maxMembers) return;
            
            // Get the guild for role information
            const guild = thread.guild;
            
            // Get all members with their roles
            const membersWithRoles = await Promise.all(
                threadMembers.map(async threadMember => {
                    try {
                        // Get the guild member
                        const guildMember = await guild.members.fetch(threadMember.id);
                        if (!guildMember) return null;
                        
                        // Skip bot accounts
                        if (guildMember.user.bot) return null;
                        
                        // Find the highest role position
                        const highestRolePosition = guildMember.roles.highest.position;
                        
                        return {
                            id: threadMember.id,
                            username: guildMember.user.username,
                            threadMember: threadMember,
                            highestRolePosition: highestRolePosition
                        };
                    } catch (error) {
                        logWithTimestamp(`Error getting member ${threadMember.id}: ${error.message}`, 'ERROR');
                        return null;
                    }
                })
            );
            
            // Filter out null values and sort by role position (higher roles first)
            const sortedMembers = membersWithRoles
                .filter(member => member !== null)
                .sort((a, b) => b.highestRolePosition - a.highestRolePosition);
            
            // Calculate how many members need to be removed
            const excessCount = threadMembers.size - maxMembers;
            
            if (excessCount <= 0) {
                return;
            }
            
            logWithTimestamp(`Removing ${excessCount} members from thread ${thread.name} (${thread.id})`, 'INFO');
            
            // Remove members starting from highest role position
            let removedCount = 0;
            for (const member of sortedMembers) {
                if (removedCount >= excessCount) break;
                
                try {
                    // Check permissions before removing
                    const botMember = guild.members.me;
                    if (botMember.roles.highest.position <= member.highestRolePosition) {
                        logWithTimestamp(`Cannot remove member ${member.username} (${member.id}) - higher role than bot`, 'WARN');
                        continue;
                    }
                    
                    // Remove member from thread
                    await thread.members.remove(member.id);
                    logWithTimestamp(`Removed member ${member.username} (${member.id}) from thread ${thread.name}`, 'INFO');
                    removedCount++;
                } catch (error) {
                    logWithTimestamp(`Failed to remove member ${member.username} (${member.id}): ${error.message}`, 'ERROR');
                }
            }
            
            logWithTimestamp(`Successfully removed ${removedCount}/${excessCount} excess members from thread ${thread.name}`, 'INFO');
            
        } catch (error) {
            logWithTimestamp(`Error removing excess members from thread ${thread.id}: ${error.message}`, 'ERROR');
        }
    }
    
    shutdown() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        
        this.trackedThreads.clear();
        logWithTimestamp('Member Tracker shutting down...', 'SHUTDOWN');
    }
}

module.exports = MemberTracker;