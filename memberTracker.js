const { PermissionsBitField } = require('discord.js');
const { logWithTimestamp } = require('./utils');

class MemberTracker {
    constructor(client) {
        this.client = client;
        this.trackedThreads = new Map(); // Map to store thread IDs and their configurations
        this.checkInterval = null;
        this.initializing = true;
        this.checkFrequency = parseInt(process.env.MEMBER_CHECK_FREQUENCY) || 5 * 60 * 1000; // Default: 5 minutes
        this.processingThreads = new Set(); // Track threads being processed to prevent race conditions
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
        this.processingThreads.delete(threadId); // Remove from processing set
        return;
    }
    
    try {
        // Fetch the thread with proper error handling
        const thread = await this.client.channels.fetch(threadId)
            .catch(error => {
                logWithTimestamp(`Error fetching thread ${threadId}: ${error.message}`, 'ERROR');
                return null;
            });
        
        // Enhanced null/undefined checks
        if (!thread) {
            logWithTimestamp(`Thread ${threadId} no longer exists or could not be fetched`, 'WARN');
            this.processingThreads.delete(threadId); // Remove from processing set
            return;
        }
        
        // Verify that it's actually a thread
        if (!thread.isThread || typeof thread.isThread !== 'function' || !thread.isThread()) {
            logWithTimestamp(`Channel ${threadId} exists but is not a thread`, 'WARN');
            this.processingThreads.delete(threadId); // Remove from processing set
            return;
        }
        
        // Verify that thread.members exists and is an object
        if (!thread.members || typeof thread.members !== 'object') {
            logWithTimestamp(`Thread ${threadId} has invalid members property`, 'ERROR');
            this.processingThreads.delete(threadId);
            return;
        }
        
        // Check if we have an ongoing removal process
        if (threadConfig.removalState) {
            logWithTimestamp(`Continuing batch removal for thread ${thread.name || threadId} (${threadId})`, 'INFO');
            await this.removeExcessMembers(thread, threadConfig.maxMembers);
            
            // Update last check timestamp even when continuing batch operations
            threadConfig.lastCheck = Date.now();
            this.trackedThreads.set(threadId, threadConfig);
            this.processingThreads.delete(threadId); // Remove from processing set
            return;
        }
        
        // Get the current member count with better error handling
        let memberCount;
        try {
            // First check if fetch method exists
            if (!thread.members.fetch || typeof thread.members.fetch !== 'function') {
                logWithTimestamp(`Thread ${threadId} members object does not have a fetch method`, 'ERROR');
                this.processingThreads.delete(threadId);
                return;
            }
            
            // Then attempt to fetch members
            const members = await thread.members.fetch()
                .catch(error => {
                    logWithTimestamp(`Error fetching members for thread ${threadId}: ${error.message}`, 'ERROR');
                    return null;
                });
            
            // Check if members were fetched successfully
            if (!members) {
                logWithTimestamp(`Failed to fetch members for thread ${threadId}`, 'ERROR');
                this.processingThreads.delete(threadId);
                return;
            }
            
            // Safely get the size
            memberCount = members.size ?? 0;
            
        } catch (error) {
            logWithTimestamp(`Unexpected error fetching member count for thread ${threadId}: ${error.message}`, 'ERROR');
            // If we can't get the member count, skip this check
            this.processingThreads.delete(threadId); // Remove from processing set
            return;
        }
        
        // Use thread.name if available, otherwise fall back to threadId for logging
        const threadName = thread.name || threadId;
        
        // Log current count periodically
        logWithTimestamp(`Thread ${threadName} (${threadId}) has ${memberCount}/${threadConfig.maxMembers} members`, 'INFO');
        
        // Check if count exceeds maximum
        if (memberCount > threadConfig.maxMembers) {
            logWithTimestamp(`Thread ${threadName} (${threadId}) exceeds max members: ${memberCount}/${threadConfig.maxMembers}`, 'WARN');
            await this.removeExcessMembers(thread, threadConfig.maxMembers);
        }
        
        // Update last check timestamp
        threadConfig.lastCheck = Date.now();
        this.trackedThreads.set(threadId, threadConfig);
        
    } catch (error) {
        logWithTimestamp(`Error checking thread ${threadId} member count: ${error.message}`, 'ERROR');
        logWithTimestamp(`Error stack: ${error.stack}`, 'ERROR'); // Add stack trace for better debugging
    } finally {
        // Always remove the thread from the processing set when done
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
            
            // Fetch the members of the thread with error handling
            const members = await thread.members.fetch()
                .catch(error => {
                    logWithTimestamp(`Error fetching thread members: ${error.message}`, 'ERROR');
                    return new Map(); // Return empty map on error
                });
                
            return members ? members.size : 0;
        } catch (error) {
            logWithTimestamp(`Unexpected error in getThreadMemberCount: ${error.message}`, 'ERROR');
            return 0;
        }
    }
    
    async removeExcessMembers(thread, maxMembers) {
    try {
        // Get the thread members
        const threadMembers = await thread.members.fetch()
            .catch(error => {
                logWithTimestamp(`Error fetching thread members: ${error.message}`, 'ERROR');
                return new Map(); // Return empty map on error
            });
        
        // If we're already at or below the limit, no action needed
        if (!threadMembers || threadMembers.size <= maxMembers) return;
        
        // Get the guild for role information
        const guild = thread.guild;
        if (!guild) {
            logWithTimestamp(`Cannot access guild for thread ${thread.id}`, 'ERROR');
            return;
        }
        
        // Parse ignored roles from environment variable
        const ignoredRoles = new Set(
            process.env.IGNORED_ROLES
                ? process.env.IGNORED_ROLES.split(',').map(role => role.trim())
                : []
        );
        
        // Calculate how many members need to be removed
        const excessCount = threadMembers.size - maxMembers;
        
        if (excessCount <= 0) {
            return;
        }
        
        logWithTimestamp(`Removing ${excessCount} members from thread ${thread.name || thread.id} (${thread.id})`, 'INFO');
        
        // Store thread state in the trackedThreads Map
        const threadConfig = this.trackedThreads.get(thread.id) || {};
        
        // Check if we're continuing a previous removal session
        if (threadConfig.removalState && 
            threadConfig.removalState.remainingMembers && 
            threadConfig.removalState.remainingMembers.length > 0) {
            logWithTimestamp(`Found ${threadConfig.removalState.remainingMembers.length} members from previous removal session`, 'INFO');
        }
        // Initialize removal state if it doesn't exist or if remainingMembers is empty
        else {
            threadConfig.removalState = {
                processedCount: 0,
                targetCount: excessCount,
                lastBatchTime: Date.now(),
                remainingMembers: []
            };
            
            // Log the ignored roles for debugging
            logWithTimestamp(`Ignored roles: ${Array.from(ignoredRoles).join(', ')}`, 'INFO');
            
            // Structure to store members for different categories
            const categorizedMembers = {
                nonGuildMembers: [], // Members not in the guild anymore
                regularMembers: []   // Normal guild members (will be sorted by role and join time)
            };
            
            let memberCount = 0;
            let skippedCount = 0;
            
            logWithTimestamp(`Starting member processing: ${threadMembers.size} total thread members`, 'INFO');
            
            // Process all thread members
            for (const [id, threadMember] of threadMembers) {
                try {
                    // Enhanced safety check for undefined threadMember
                    if (!threadMember) {
                        logWithTimestamp(`Skipping undefined thread member at position ${memberCount}`, 'WARN');
                        skippedCount++;
                        continue;
                    }

                    // Ensure threadMember.id exists before using it
                    if (!threadMember.id) {
                        logWithTimestamp(`Thread member at position ${memberCount} has no id property`, 'WARN');
                        skippedCount++;
                        continue;
                    }
                    
                    // Get join timestamp from the thread member
                    const joinTimestamp = threadMember.joinedTimestamp || 0;
                    
                    // Try to get the guild member with proper error handling
                    let guildMember;
                    try {
                        guildMember = await guild.members.fetch(threadMember.id)
                            .catch(err => {
                                logWithTimestamp(`Could not fetch guild member ${threadMember.id}: ${err.message}`, 'INFO');
                                return null;
                            });
                    } catch (error) {
                        logWithTimestamp(`Error fetching guild member ${threadMember.id}: ${error.message}`, 'ERROR');
                        guildMember = null;
                    }
                    
                    if (!guildMember) {
                        // This is a thread member who is no longer in the guild
                        categorizedMembers.nonGuildMembers.push({
                            id: threadMember.id,
                            username: 'Unknown (Left Guild)',
                            joinTimestamp: joinTimestamp
                        });
                        memberCount++;
                        continue;
                    }
                    
                    // Skip bot accounts
                    if (guildMember.user?.bot) {
                        skippedCount++;
                        continue;
                    }
                    
                    // Skip members with ignored roles - with enhanced safety checks
                    if (guildMember.roles && guildMember.roles.cache && 
                        guildMember.roles.cache.some(role => ignoredRoles.has(role.id))) {
                        logWithTimestamp(`Skipping member ${guildMember.user?.username || 'Unknown'} (${guildMember.id}) with ignored role`, 'INFO');
                        skippedCount++;
                        continue;
                    }
                    
                    // Find the highest role position (with enhanced safety checks)
                    let highestRolePosition = 0;
                    try {
                        highestRolePosition = guildMember.roles?.highest?.position || 0;
                    } catch (error) {
                        logWithTimestamp(`Error getting highest role for member ${guildMember.id}: ${error.message}`, 'ERROR');
                        // Continue with default value of 0
                    }
                    
                    // Safely get username
                    const username = guildMember.user?.username || 'Unknown';
                    logWithTimestamp(`Adding member to removal list: ${username} (${guildMember.id})`, 'DEBUG');
                    
                    categorizedMembers.regularMembers.push({
                        id: threadMember.id,
                        username: username,
                        highestRolePosition: highestRolePosition,
                        joinTimestamp: joinTimestamp
                    });
                    
                    memberCount++;
                } catch (error) {
                    logWithTimestamp(`Error processing member: ${error.message}`, 'ERROR');
                    skippedCount++;
                }
            }
            
            // Sort and process remainder of the function...
            // (Rest of the sorting and processing logic)
            
            // Sort regular members by:
            // 1. Higher role position first
            // 2. Earlier join timestamp first (when roles are equal)
            categorizedMembers.regularMembers.sort((a, b) => {
                // First sort by role position (higher roles first)
                if (b.highestRolePosition !== a.highestRolePosition) {
                    return b.highestRolePosition - a.highestRolePosition;
                }
                // Then sort by join timestamp (earlier joins first)
                return a.joinTimestamp - b.joinTimestamp;
            });
            
            // Sort non-guild members by join timestamp (if available)
            categorizedMembers.nonGuildMembers.sort((a, b) => a.joinTimestamp - b.joinTimestamp);
            
            // Combine the lists in priority order: 
            // 1. Non-guild members first
            // 2. Then regular members sorted by role and join time
            const sortedMembers = [
                ...categorizedMembers.nonGuildMembers,
                ...categorizedMembers.regularMembers
            ];
            
            // Store the sorted list for batch processing
            threadConfig.removalState.remainingMembers = sortedMembers;
            
            logWithTimestamp(`Prepared ${sortedMembers.length} members for batch removal in thread ${thread.name || thread.id}. Non-guild members: ${categorizedMembers.nonGuildMembers.length}, Regular members: ${categorizedMembers.regularMembers.length}`, 'INFO');
            
            // If we don't have enough members to remove after filtering, adjust the target
            if (sortedMembers.length < excessCount) {
                const originalTarget = threadConfig.removalState.targetCount;
                threadConfig.removalState.targetCount = sortedMembers.length;
                logWithTimestamp(`Not enough removable members available. Adjusted target from ${originalTarget} to ${sortedMembers.length}`, 'WARN');
                
                // If no members are available for removal at all, exit early
                if (sortedMembers.length === 0) {
                    logWithTimestamp(`No removable members found. All members are either bots or have ignored roles. Canceling removal.`, 'WARN');
                    delete threadConfig.removalState;
                    this.trackedThreads.set(thread.id, threadConfig);
                    return;
                }
            }
        }
        
        // Define batch size
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
        
        // Get bot member with error handling
        let botMember = null;
        try {
            botMember = guild.members.me;
            if (!botMember) {
                botMember = await guild.members.fetchMe().catch(() => null);
            }
        } catch (error) {
            logWithTimestamp(`Error fetching bot member: ${error.message}`, 'ERROR');
        }
        
        if (!botMember) {
            logWithTimestamp(`Could not determine bot member for permission checking`, 'ERROR');
            // Continue anyway - we'll skip permission checks if needed
        }
        
        // Process up to BATCH_SIZE members in this run
        const currentBatch = removalState.remainingMembers.slice(0, BATCH_SIZE);
        removalState.remainingMembers = removalState.remainingMembers.slice(BATCH_SIZE);
        
        logWithTimestamp(`Processing batch of up to ${currentBatch.length} members (${removalState.processedCount}/${removalState.targetCount} processed)`, 'INFO');
        
        // If the current batch is empty, we might be done
        if (currentBatch.length === 0) {
            logWithTimestamp(`No more members to process in this batch. Either all members have been removed or no removable members were found.`, 'INFO');
            logWithTimestamp(`Completed member removal: ${removalState.processedCount}/${removalState.targetCount} members removed from ${thread.name || thread.id}`, 'INFO');
            delete threadConfig.removalState;
            this.trackedThreads.set(thread.id, threadConfig);
            return;
        }
        
        // Track successful removals in this batch
        let removedInBatch = 0;
        
        for (const member of currentBatch) {
            if (removalState.processedCount >= removalState.targetCount) {
                break; // We've removed enough members
            }
            
            try {
                // Enhanced safety check for member object
                if (!member) {
                    logWithTimestamp(`Skipping null member object in removal batch`, 'WARN');
                    continue;
                }
                
                // Enhanced safety check for member.id
                if (!member.id) {
                    logWithTimestamp(`Skipping member with missing id in removal batch`, 'WARN');
                    continue;
                }
                
                // For regular guild members, check role permissions
                if (member.username !== 'Unknown (Left Guild)') {
                    // Check permissions before removing - if botMember is available
                    if (botMember && botMember.roles && botMember.roles.highest) {
                        if (typeof member.highestRolePosition === 'number' && 
                            botMember.roles.highest.position <= member.highestRolePosition) {
                            logWithTimestamp(`Cannot remove member ${member.username} (${member.id}) - higher role than bot`, 'WARN');
                            removalState.processedCount++; // Count as processed even if we couldn't remove
                            continue;
                        }
                    }
                }
                
                // Remove member from thread with proper error handling
                await thread.members.remove(member.id)
                    .then(() => {
                        const joinDate = member.joinTimestamp ? new Date(member.joinTimestamp).toISOString() : 'unknown date';
                        const memberType = member.username === 'Unknown (Left Guild)' ? 'non-guild member' : 'member';
                        logWithTimestamp(`Removed ${memberType} ${member.username} (${member.id}) from thread ${thread.name || thread.id} (joined: ${joinDate})`, 'INFO');
                        removalState.processedCount++;
                        removedInBatch++;
                    })
                    .catch(error => {
                        logWithTimestamp(`Failed to remove member ${member.username} (${member.id}): ${error.message}`, 'ERROR');
                    });
                
                // Add a small delay between removals to avoid hitting rate limits
                await new Promise(resolve => setTimeout(resolve, 200));
                
            } catch (error) {
                logWithTimestamp(`Error in member removal process: ${error.message}`, 'ERROR');
            }
        }
        
        // Update the last batch time
        removalState.lastBatchTime = Date.now();
        
        // Save the updated state
        this.trackedThreads.set(thread.id, threadConfig);
        
        // Determine if we're done or need to continue in future checks
        if (removalState.processedCount >= removalState.targetCount || removalState.remainingMembers.length === 0) {
            logWithTimestamp(`Completed member removal: ${removalState.processedCount}/${removalState.targetCount} members removed from ${thread.name || thread.id}`, 'INFO');
            // Reset the removal state when we're done
            delete threadConfig.removalState;
            this.trackedThreads.set(thread.id, threadConfig);
        } else {
            logWithTimestamp(`Batch completed: ${removedInBatch} members removed in this batch. ${removalState.remainingMembers.length} members remaining for future batches.`, 'INFO');
        }
        
    } catch (error) {
        logWithTimestamp(`Error removing excess members from thread ${thread?.id || 'unknown'}: ${error.message}`, 'ERROR');
        logWithTimestamp(`Error stack: ${error.stack}`, 'ERROR');
    }
}
    
    shutdown() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        
        this.trackedThreads.clear();
        this.processingThreads.clear(); // Clear the processing threads set
        logWithTimestamp('Member Tracker shutting down...', 'SHUTDOWN');
    }
}

module.exports = MemberTracker;