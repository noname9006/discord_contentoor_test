const { PermissionsBitField } = require('discord.js');
const { logWithTimestamp } = require('./utils');

class MemberTracker {
    constructor(client) {
        this.client = client;
        this.trackedThreads = new Map(); // Map to store thread IDs and their configurations
        this.checkInterval = null;
        this.initializing = true;
        this.checkFrequency = parseInt(process.env.MEMBER_CHECK_FREQUENCY) || 12 * 60 * 60 * 1000; // Default: 12 hours
        this.processingThreads = new Set(); // Track threads being processed to prevent race conditions
        this.roleToThread = new Map();
        this.threadToRole = new Map();
    }

    async init() {
        try {
            this.initializing = true;
            
            // Parse ignored roles from environment variable
            this.ignoredRoles = new Set(
                process.env.IGNORED_ROLES
                    ? process.env.IGNORED_ROLES.split(',').map(role => role.trim())
                    : []
            );
            
            // Find all THREAD_X_ID environment variables
            const threadEnvs = Object.keys(process.env)
                .filter(key => key.match(/^THREAD_\d+_ID$/))
                .sort();
            
            if (threadEnvs.length === 0) {
                throw new Error('No THREAD_X_ID variables found in environment');
            }
            
            // Initialize tracked threads and role mappings
            for (const threadEnv of threadEnvs) {
                const threadId = process.env[threadEnv];
                if (!threadId) continue;
                
                try {
                    // Extract the index from THREAD_X_ID
                    const index = threadEnv.match(/^THREAD_(\d+)_ID$/)[1];
                    const roleId = process.env[`ROLE_${index}_ID`];
                    
                    if (!roleId) {
                        logWithTimestamp(`Warning: No corresponding ROLE_${index}_ID found for ${threadEnv}`, 'WARN');
                        continue;
                    }
                    
                    const thread = await this.client.channels.fetch(threadId);
                    if (!thread || !thread.isThread()) {
                        logWithTimestamp(`Warning: ${threadEnv} (${threadId}) is not a valid thread. Skipping.`, 'WARN');
                        continue;
                    }
                    
                    // Add to trackedThreads Map
                    this.trackedThreads.set(threadId, {
                        id: threadId,
                        envName: threadEnv,
                        index: index,
                        correspondingRoleId: roleId,
                        lastCheck: 0,
                    });
                    
                    // Add to role-thread mappings
                    this.roleToThread.set(roleId, threadId);
                    this.threadToRole.set(threadId, roleId);
                    
                    logWithTimestamp(`Thread tracked: ${thread.name} (${threadId}) corresponding to role ${roleId}`, 'INFO');
                } catch (error) {
                    logWithTimestamp(`Error initializing thread ${threadEnv} (${threadId}): ${error.message}`, 'ERROR');
                }
            }
            
            if (this.trackedThreads.size === 0) {
                throw new Error('No valid threads found for tracking');
            }
            
            logWithTimestamp(`Ignored roles: ${Array.from(this.ignoredRoles).join(', ')}`, 'INFO');
            
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
        logWithTimestamp(`Running scheduled check for all ${this.trackedThreads.size} threads`, 'INFO');
        for (const [threadId, threadConfig] of this.trackedThreads.entries()) {
            try {
                await this.checkThreadMembers(threadId);
            } catch (error) {
                logWithTimestamp(`Error checking thread ${threadId}: ${error.message}`, 'ERROR');
            }
        }
    }
    
    async checkThreadMembers(threadId) {
        // Check if this thread is already being processed
        if (this.processingThreads.has(threadId)) {
            logWithTimestamp(`Thread ${threadId} is already being processed, skipping duplicate check`, 'INFO');
            return;
        }

        // Mark this thread as being processed
        this.processingThreads.add(threadId);
        
        const threadConfig = this.trackedThreads.get(threadId);
        if (!threadConfig) {
            logWithTimestamp(`Thread ${threadId} is not configured for tracking`, 'WARN');
            this.processingThreads.delete(threadId);
            return;
        }
        
        try {
            // Fetch the thread with proper error handling
            const thread = await this.client.channels.fetch(threadId)
                .catch(error => {
                    logWithTimestamp(`Error fetching thread ${threadId}: ${error.message}`, 'ERROR');
                    return null;
                });
            
            // Make sure thread exists and is actually a thread
            if (!thread) {
                logWithTimestamp(`Thread ${threadId} no longer exists or could not be fetched`, 'WARN');
                this.processingThreads.delete(threadId);
                return;
            }
            
            if (!thread.isThread || typeof thread.isThread !== 'function' || !thread.isThread()) {
                logWithTimestamp(`Channel ${threadId} exists but is not a thread`, 'WARN');
                this.processingThreads.delete(threadId);
                return;
            }
            
            // Check if thread.members exists
            if (!thread.members || typeof thread.members !== 'object') {
                logWithTimestamp(`Thread ${threadId} has invalid members property`, 'ERROR');
                this.processingThreads.delete(threadId);
                return;
            }
            
            // Check if we have an ongoing removal process
            if (threadConfig.removalState) {
                logWithTimestamp(`Continuing batch removal for thread ${thread.name || threadId}`, 'INFO');
                await this.removeInvalidMembers(thread);
                threadConfig.lastCheck = Date.now();
                this.trackedThreads.set(threadId, threadConfig);
                this.processingThreads.delete(threadId);
                return;
            }
            
            // Log current count periodically
            const memberCount = await this.getThreadMemberCount(thread);
            logWithTimestamp(`Thread ${thread.name || threadId} has ${memberCount} members`, 'INFO');
            
            // Start member role verification process
            await this.removeInvalidMembers(thread);
            
            // Update last check timestamp
            threadConfig.lastCheck = Date.now();
            this.trackedThreads.set(threadId, threadConfig);
            
        } catch (error) {
            logWithTimestamp(`Error checking thread ${threadId}: ${error.message}`, 'ERROR');
            logWithTimestamp(`Error stack: ${error.stack}`, 'ERROR'); // Keep stack trace for debugging
        } finally {
            // Always remove the thread from processing
            this.processingThreads.delete(threadId);
        }
    }
    
    async getThreadMemberCount(thread) {
        try {
            // Check if thread is valid
            if (!thread || !thread.members) {
                logWithTimestamp(`Invalid thread object when getting member count`, 'ERROR');
                return 0;
            }
            
            // Fetch the members with error handling
            const members = await thread.members.fetch()
                .catch(error => {
                    logWithTimestamp(`Error fetching thread members: ${error.message}`, 'ERROR');
                    return new Map();
                });
                
            return members ? members.size : 0;
        } catch (error) {
            logWithTimestamp(`Unexpected error in getThreadMemberCount: ${error.message}`, 'ERROR');
            return 0;
        }
    }
    
    async shouldMemberBeInThread(member, threadId) {
        try {
            // If member has any ignored role, they can be in any thread
            if (member.roles.cache.some(role => this.ignoredRoles.has(role.id))) {
                return true;
            }
            
            // Get the role ID associated with this thread
            const requiredRoleId = this.threadToRole.get(threadId);
            if (!requiredRoleId) {
                logWithTimestamp(`No role mapping found for thread ${threadId}`, 'WARN');
                return true; // Default to letting them stay
            }

            // Check if member has the required role
            return member.roles.cache.has(requiredRoleId);
        } catch (error) {
            logWithTimestamp(`Error checking if member ${member.id} should be in thread ${threadId}: ${error.message}`, 'ERROR');
            return true; // In case of error, default to letting them stay
        }
    }
    
    async removeInvalidMembers(thread) {
        try {
            const threadId = thread.id;
            const threadConfig = this.trackedThreads.get(threadId);
            if (!threadConfig) {
                logWithTimestamp(`No configuration found for thread ${threadId}`, 'ERROR');
                return;
            }
            
            // Get the thread members with error handling
            const threadMembers = await thread.members.fetch()
                .catch(error => {
                    logWithTimestamp(`Error fetching thread members: ${error.message}`, 'ERROR');
                    return new Map();
                });
            
            if (!threadMembers || threadMembers.size === 0) return;
            
            // Get the guild for role information
            const guild = thread.guild;
            if (!guild) {
                logWithTimestamp(`Cannot access guild for thread ${thread.id}`, 'ERROR');
                return;
            }
            
            // Store thread state in the trackedThreads Map if not already initialized
            if (!threadConfig.removalState) {
                threadConfig.removalState = {
                    processedCount: 0,
                    totalCount: 0,
                    lastBatchTime: Date.now(),
                    remainingMembers: []
                };
                
                // Build the list of members to check
                const membersToCheck = [];
                let skippedCount = 0;
                
                logWithTimestamp(`Starting role verification for ${threadMembers.size} members in thread ${thread.name || thread.id}`, 'INFO');
                
                // Process all thread members
                for (const [id, threadMember] of threadMembers) {
                    try {
                        // Enhanced safety check for undefined threadMember
                        if (!threadMember || !threadMember.id) {
                            logWithTimestamp(`Skipping invalid thread member in thread ${thread.id}`, 'WARN');
                            skippedCount++;
                            continue;
                        }
                        
                        // Get join timestamp from the thread member
                        const joinTimestamp = threadMember.joinedTimestamp || 0;
                        
                        // Try to get the guild member
                        const guildMember = await guild.members.fetch(threadMember.id)
                            .catch(err => {
                                logWithTimestamp(`Could not fetch guild member ${threadMember.id} in thread ${thread.id}: ${err.message}`, 'INFO');
                                return null;
                            });
                        
                        if (!guildMember) {
                            // This is a thread member who is no longer in the guild - add to removal list
                            membersToCheck.push({
                                id: threadMember.id,
                                username: 'Unknown (Left Guild)',
                                joinTimestamp: joinTimestamp,
                                shouldRemove: true,
                                reason: 'No longer in guild'
                            });
                            continue;
                        }
                        
                        // Skip bot accounts
                        if (guildMember.user?.bot) {
                            skippedCount++;
                            continue;
                        }
                        
                        // Check if member should be in this thread based on roles
                        const shouldBeInThread = await this.shouldMemberBeInThread(guildMember, thread.id);
                        
                        // If member should not be in this thread, add to removal list
                        if (!shouldBeInThread) {
                            // Find the highest role position for permission checking
                            const highestRolePosition = guildMember.roles?.highest?.position || 0;
                            
                            membersToCheck.push({
                                id: threadMember.id,
                                username: guildMember.user?.username || 'Unknown',
                                highestRolePosition: highestRolePosition,
                                joinTimestamp: joinTimestamp,
                                shouldRemove: true,
                                reason: 'Role does not match thread'
                            });
                        } else {
                            skippedCount++;
                        }
                    } catch (error) {
                        logWithTimestamp(`Error processing member in thread ${thread.id}: ${error.message}`, 'ERROR');
                        skippedCount++;
                    }
                }
                
                // Sort by join timestamp (later joins first, for fairness)
                membersToCheck.sort((a, b) => b.joinTimestamp - a.joinTimestamp);
                
                // Store the sorted list for batch processing
                threadConfig.removalState.remainingMembers = membersToCheck;
                threadConfig.removalState.totalCount = membersToCheck.length;
                
                logWithTimestamp(`Prepared ${membersToCheck.length} members for removal from thread ${thread.name || thread.id} (${skippedCount} members can stay)`, 'INFO');
                
                // If no members need to be removed, exit early
                if (membersToCheck.length === 0) {
                    logWithTimestamp(`All members in thread ${thread.name || thread.id} have appropriate roles. No removals needed.`, 'INFO');
                    delete threadConfig.removalState;
                    this.trackedThreads.set(thread.id, threadConfig);
                    return;
                }
            }
            
            // Define batch size for removals
            const BATCH_SIZE = 50;
            
            // Process a batch of members
            const removalState = threadConfig.removalState;
            
            // Safety check for removalState
            if (!removalState) {
                logWithTimestamp(`Invalid removal state for thread ${thread.id}`, 'ERROR');
                return;
            }
            
            // Safety check for remainingMembers
            if (!removalState.remainingMembers || !Array.isArray(removalState.remainingMembers)) {
                logWithTimestamp(`Invalid remainingMembers array for thread ${thread.id}`, 'ERROR');
                delete threadConfig.removalState;
                this.trackedThreads.set(thread.id, threadConfig);
                return;
            }
            
            // Get bot member for permission checking
            const botMember = guild.members.me;
            if (!botMember) {
                logWithTimestamp(`Could not determine bot member for permission checking in thread ${thread.id}`, 'ERROR');
            }
            
            // Process up to BATCH_SIZE members in this run
            const currentBatch = removalState.remainingMembers.slice(0, BATCH_SIZE);
            removalState.remainingMembers = removalState.remainingMembers.slice(BATCH_SIZE);
            
            logWithTimestamp(`Processing batch of ${currentBatch.length} members in thread ${thread.name || thread.id} (${removalState.processedCount}/${removalState.totalCount} processed)`, 'INFO');
            
            // If the current batch is empty, we're done
            if (currentBatch.length === 0) {
                logWithTimestamp(`Member role verification complete for thread ${thread.name || thread.id}`, 'INFO');
                delete threadConfig.removalState;
                this.trackedThreads.set(thread.id, threadConfig);
                return;
            }
            
            // Track successful removals in this batch
            let removedInBatch = 0;
            
            for (const member of currentBatch) {
                try {
                    // Skip if member object is invalid
                    if (!member || !member.id) {
                        logWithTimestamp(`Skipping invalid member object in removal batch for thread ${thread.id}`, 'WARN');
                        continue;
                    }
                    
                    // Skip if we shouldn't remove this member
                    if (!member.shouldRemove) {
                        removalState.processedCount++;
                        continue;
                    }
                    
                    // For regular guild members, check role permissions
                    if (member.username !== 'Unknown (Left Guild)' && botMember) {
                        // Check if bot can remove this member
                        if (typeof member.highestRolePosition === 'number' && 
                            botMember.roles.highest.position <= member.highestRolePosition) {
                            logWithTimestamp(`Cannot remove member ${member.username} (${member.id}) from thread ${thread.name || thread.id} - higher role than bot`, 'WARN');
                            removalState.processedCount++; // Count as processed even if we couldn't remove
                            continue;
                        }
                    }
                    
                    // Remove member from thread with proper error handling
                    await thread.members.remove(member.id)
                        .then(() => {
                            logWithTimestamp(`Removed ${member.username} (${member.id}) from thread ${thread.name || thread.id} - Reason: ${member.reason}`, 'INFO');
                            removalState.processedCount++;
                            removedInBatch++;
                        })
                        .catch(error => {
                            logWithTimestamp(`Failed to remove member ${member.username} (${member.id}) from thread ${thread.id}: ${error.message}`, 'ERROR');
                        });
                    
                    // Add a small delay between removals to avoid hitting rate limits
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                } catch (error) {
                    logWithTimestamp(`Error in member removal process for thread ${thread.id}: ${error.message}`, 'ERROR');
                }
            }
            
            // Update the last batch time
            removalState.lastBatchTime = Date.now();
            
            // Save the updated state
            this.trackedThreads.set(thread.id, threadConfig);
            
            // Determine if we're done or need to continue in future checks
            if (removalState.remainingMembers.length === 0) {
                logWithTimestamp(`Completed member role verification for thread ${thread.name || thread.id}: ${removalState.processedCount}/${removalState.totalCount} members removed`, 'INFO');
                // Reset the removal state when we're done
                delete threadConfig.removalState;
                this.trackedThreads.set(thread.id, threadConfig);
            } else {
                logWithTimestamp(`Batch completed for thread ${thread.name || thread.id}: ${removedInBatch} members removed in this batch. ${removalState.remainingMembers.length} members remaining for future batches.`, 'INFO');
            }
            
        } catch (error) {
            logWithTimestamp(`Error removing invalid members from thread ${thread?.id || 'unknown'}: ${error.message}`, 'ERROR');
            logWithTimestamp(`Error stack: ${error.stack}`, 'ERROR');
        }
    }
    
    shutdown() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        
        this.trackedThreads.clear();
        this.processingThreads.clear();
        this.roleToThread.clear();
        this.threadToRole.clear();
        logWithTimestamp('Member Tracker shutting down...', 'SHUTDOWN');
    }
}

module.exports = MemberTracker;