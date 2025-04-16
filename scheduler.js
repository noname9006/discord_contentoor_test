const cron = require('node-cron');
const { ChannelType } = require('discord.js');
const { logWithTimestamp } = require('./utils');

class ThreadCleaner {
    constructor(client) {
        this.client = client;
        this.schedule = null;
        this.isRunning = false;
    }

    init(cronExpression) {
        if (!cronExpression || typeof cronExpression !== 'string') {
            logWithTimestamp('Invalid cron expression for thread cleaning schedule', 'ERROR');
            return false;
        }

        try {
            // Validate the cron expression
            if (!cron.validate(cronExpression)) {
                throw new Error('Invalid cron expression format');
            }

            this.schedule = cron.schedule(cronExpression, () => {
                this.performCleanup()
                    .catch(err => logWithTimestamp(`Error during scheduled thread cleanup: ${err.message}`, 'ERROR'));
            });

            logWithTimestamp(`Thread cleaner initialized with schedule: ${cronExpression}`, 'STARTUP');
            return true;
        } catch (error) {
            logWithTimestamp(`Failed to initialize thread cleaner: ${error.message}`, 'ERROR');
            return false;
        }
    }

    getThreadAndRoleMappings() {
        const threadIds = [];
        const roleToThread = new Map();
        const threadToRole = new Map();
        const ignoredRoles = new Set(
            process.env.IGNORED_ROLES
                ? process.env.IGNORED_ROLES.split(',').map(role => role.trim())
                : []
        );

        // Map threads to roles and vice versa
        for (let i = 0; i <= 5; i++) {
            const roleId = process.env[`ROLE_${i}_ID`];
            const threadId = process.env[`THREAD_${i}_ID`];
            
            if (roleId && threadId) {
                threadIds.push(threadId);
                roleToThread.set(roleId, threadId);
                threadToRole.set(threadId, roleId);
            }
        }

        return { threadIds, roleToThread, threadToRole, ignoredRoles };
    }

    findHighestRole(memberRoles) {
        for (let i = 5; i >= 0; i--) {
            const roleId = process.env[`ROLE_${i}_ID`];
            if (memberRoles.has(roleId)) {
                return i;
            }
        }
        return -1;
    }

    memberHasCorrectRoleForThread(member, threadId, threadToRole, ignoredRoles) {
        // Members with ignored roles are always allowed
        if (member.roles.cache.some(role => ignoredRoles.has(role.id))) {
            return true;
        }

        // Get the highest role index for this member
        const highestRoleIndex = this.findHighestRole(member.roles.cache);
        if (highestRoleIndex === -1) {
            return false;
        }

        // Get the correct thread for this role index
        const correctThreadId = process.env[`THREAD_${highestRoleIndex}_ID`];
        
        // Check if the member is in the correct thread for their highest role
        return threadId === correctThreadId;
    }

    async performCleanup() {
        if (this.isRunning) {
            logWithTimestamp('Thread cleanup is already in progress, skipping', 'WARN');
            return;
        }

        this.isRunning = true;
        const startTime = Date.now();
        logWithTimestamp('Starting scheduled thread cleanup', 'INFO');

        try {
            const { threadIds, threadToRole, ignoredRoles } = this.getThreadAndRoleMappings();
            
            if (threadIds.length === 0) {
                logWithTimestamp('No threads configured for cleanup', 'WARN');
                this.isRunning = false;
                return;
            }

            let totalChecked = 0;
            let totalRemoved = 0;
            let failedThreads = 0;

            // Process each thread
            for (const threadId of threadIds) {
                try {
                    const thread = await this.client.channels.fetch(threadId);
                    
                    if (!thread) {
                        logWithTimestamp(`Thread ${threadId} not found`, 'ERROR');
                        failedThreads++;
                        continue;
                    }

                    // Skip non-thread channels
                    if (!thread.isThread()) {
                        logWithTimestamp(`Channel ${threadId} (${thread.name}) is not a thread, skipping`, 'WARN');
                        continue;
                    }

                    // Fetch all thread members
                    const threadMembers = await thread.members.fetch();
                    logWithTimestamp(`Checking ${threadMembers.size} members in thread ${thread.name} (${threadId})`, 'INFO');

                    let removedFromThread = 0;

                    // Process each member in the thread
                    for (const [memberId, threadMember] of threadMembers) {
                        // Skip the bot itself
                        if (memberId === this.client.user.id) continue;
                        
                        totalChecked++;

                        try {
                            // Try to fetch the guild member
                            const guildMember = await thread.guild.members.fetch(memberId).catch(() => null);
                            
                            // If member left the server or doesn't have correct role, remove them
                            if (!guildMember || 
                                !this.memberHasCorrectRoleForThread(guildMember, threadId, threadToRole, ignoredRoles)) {
                                
                                await thread.members.remove(memberId);
                                removedFromThread++;
                                totalRemoved++;
                                
                                const reason = !guildMember ? 'left server' : 'incorrect role';
                                logWithTimestamp(`Removed member ${memberId} from thread ${thread.name}: ${reason}`, 'INFO');
                            }
                        } catch (memberError) {
                            logWithTimestamp(`Error processing member ${memberId} in thread ${thread.name}: ${memberError.message}`, 'ERROR');
                        }
                    }

                    logWithTimestamp(`Thread ${thread.name}: Removed ${removedFromThread} of ${threadMembers.size} members`, 'INFO');
                } catch (threadError) {
                    logWithTimestamp(`Error processing thread ${threadId}: ${threadError.message}`, 'ERROR');
                    failedThreads++;
                }
            }

            const duration = (Date.now() - startTime) / 1000;
            logWithTimestamp(`Thread cleanup completed in ${duration.toFixed(2)}s: Checked ${totalChecked} members, removed ${totalRemoved}, failed threads: ${failedThreads}`, 'INFO');
        } catch (error) {
            logWithTimestamp(`Thread cleanup failed: ${error.message}`, 'ERROR');
        } finally {
            this.isRunning = false;
        }
    }

    async runNow() {
        return this.performCleanup();
    }
	
	async cleanSpecificThread(threadId) {
    if (this.isRunning) {
        logWithTimestamp('Thread cleanup is already in progress, skipping', 'WARN');
        return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    logWithTimestamp(`Starting thread cleanup for specific thread: ${threadId}`, 'INFO');

    try {
        const { threadToRole, ignoredRoles } = this.getThreadAndRoleMappings();
        
        // Check if this thread is configured
        if (!threadToRole.has(threadId)) {
            logWithTimestamp(`Thread ${threadId} not configured for cleanup`, 'WARN');
            this.isRunning = false;
            return;
        }

        let totalChecked = 0;
        let totalRemoved = 0;

        try {
            const thread = await this.client.channels.fetch(threadId);
            
            if (!thread) {
                logWithTimestamp(`Thread ${threadId} not found`, 'ERROR');
                this.isRunning = false;
                return;
            }

            // Skip non-thread channels
            if (!thread.isThread()) {
                logWithTimestamp(`Channel ${threadId} (${thread.name}) is not a thread, skipping`, 'WARN');
                this.isRunning = false;
                return;
            }

            // Fetch all thread members
            const threadMembers = await thread.members.fetch();
            logWithTimestamp(`Checking ${threadMembers.size} members in thread ${thread.name} (${threadId})`, 'INFO');

            let removedFromThread = 0;

            // Process each member in the thread
            for (const [memberId, threadMember] of threadMembers) {
                // Skip the bot itself
                if (memberId === this.client.user.id) continue;
                
                totalChecked++;

                try {
                    // Try to fetch the guild member
                    const guildMember = await thread.guild.members.fetch(memberId).catch(() => null);
                    
                    // If member left the server or doesn't have correct role, remove them
                    if (!guildMember || 
                        !this.memberHasCorrectRoleForThread(guildMember, threadId, threadToRole, ignoredRoles)) {
                        
                        await thread.members.remove(memberId);
                        removedFromThread++;
                        totalRemoved++;
                        
                        const reason = !guildMember ? 'left server' : 'incorrect role';
                        logWithTimestamp(`Removed member ${memberId} from thread ${thread.name}: ${reason}`, 'INFO');
                    }
                } catch (memberError) {
                    logWithTimestamp(`Error processing member ${memberId} in thread ${thread.name}: ${memberError.message}`, 'ERROR');
                }
            }

            logWithTimestamp(`Thread ${thread.name}: Removed ${removedFromThread} of ${threadMembers.size} members`, 'INFO');
        } catch (threadError) {
            logWithTimestamp(`Error processing thread ${threadId}: ${threadError.message}`, 'ERROR');
        }

        const duration = (Date.now() - startTime) / 1000;
        logWithTimestamp(`Thread cleanup completed in ${duration.toFixed(2)}s: Checked ${totalChecked} members, removed ${totalRemoved}`, 'INFO');
    } catch (error) {
        logWithTimestamp(`Thread cleanup failed: ${error.message}`, 'ERROR');
    } finally {
        this.isRunning = false;
    }
}

    stop() {
        if (this.schedule) {
            this.schedule.stop();
            logWithTimestamp('Thread cleaner schedule stopped', 'INFO');
        }
    }
}

module.exports = ThreadCleaner;