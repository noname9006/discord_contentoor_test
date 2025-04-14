require('dotenv').config();

// Database timeout configuration
const DB_TIMEOUT_MINUTES = parseInt(process.env.DB_TIMEOUT) || 1; // Default to 1 minute
const DB_TIMEOUT = DB_TIMEOUT_MINUTES * 60 * 1000; // Convert to milliseconds

// Rate limiting configuration
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 5; // Default to 5 requests
const RATE_LIMIT_COOLDOWN = parseInt(process.env.RATE_LIMIT_COOLDOWN) || 1000; // Default to 1 second

// URL duplication age threshold (in minutes)
const THRESHOLD_DUPE_AGE = parseInt(process.env.THRESHOLD_DUPE_AGE) || 60; // Default to 60 minutes if not specified

// Member tracker configuration
const MAX_MEMBERS = parseInt(process.env.MAX_MEMBERS) || 100; // Default to 100 members
const MEMBER_CHECK_FREQUENCY = parseInt(process.env.MEMBER_CHECK_FREQUENCY) || 300000; // Default to 5 minutes (300000 ms)

module.exports = {
    DB_TIMEOUT,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_COOLDOWN,
    THRESHOLD_DUPE_AGE,
    MAX_MEMBERS,
    MEMBER_CHECK_FREQUENCY
};