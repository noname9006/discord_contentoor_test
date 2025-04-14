function logWithTimestamp(message, type = 'INFO') {
    const date = new Date();
    const timestamp = date.toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, '');
    console.log(`[${timestamp}] [${type}] ${message}`);
}

module.exports = {
    logWithTimestamp
};