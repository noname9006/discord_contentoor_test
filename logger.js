const fs = require('fs');
const path = require('path');
const { createWriteStream } = require('fs');
const { format } = require('util');

// Log levels with numeric values for filtering
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    FATAL: 4,
    STARTUP: 1,
    SHUTDOWN: 1,
    RATELIMIT: 2,
    CONFIG: 1
};

class Logger {
    constructor(options = {}) {
        // Default configuration
        this.config = {
            minLevel: process.env.LOG_LEVEL || 'INFO',
            console: true,
            timestamps: true,
            logToFile: false,
            logDir: path.join(__dirname, 'logs'),
            maxLogSize: 5 * 1024 * 1024, // 5MB
            maxFiles: 5,
            ...options
        };
        
        this.streams = [];
        
        // Set up console logging
        if (this.config.console) {
            this.streams.push({ type: 'console', stream: process.stdout });
        }
        
        // Set up file logging if enabled
        if (this.config.logToFile) {
            this._setupFileLogging();
        }
    }
    
    _setupFileLogging() {
        try {
            // Make sure the log directory exists
            if (!fs.existsSync(this.config.logDir)) {
                fs.mkdirSync(this.config.logDir, { recursive: true });
            }
            
            const logFilePath = path.join(this.config.logDir, 'application.log');
            const stream = createWriteStream(logFilePath, { flags: 'a' });
            
            this.streams.push({ type: 'file', stream });
            
            // Setup log rotation
            this._setupLogRotation();
            
        } catch (error) {
            console.error(`Failed to setup file logging: ${error.message}`);
        }
    }
    
    _setupLogRotation() {
        // Check log file size periodically
        setInterval(() => {
            try {
                const logFilePath = path.join(this.config.logDir, 'application.log');
                const stats = fs.statSync(logFilePath);
                
                if (stats.size >= this.config.maxLogSize) {
                    this._rotateLogFiles();
                }
            } catch (error) {
                console.error(`Error checking log file size: ${error.message}`);
            }
        }, 60000); // Check every minute
    }
    
    _rotateLogFiles() {
        try {
            // Rotate existing log files
            for (let i = this.config.maxFiles - 1; i >= 0; i--) {
                const currentFile = i === 0 
                    ? path.join(this.config.logDir, 'application.log')
                    : path.join(this.config.logDir, `application.${i}.log`);
                    
                const nextFile = path.join(this.config.logDir, `application.${i + 1}.log`);
                
                if (fs.existsSync(currentFile)) {
                    if (i === this.config.maxFiles - 1) {
                        fs.unlinkSync(currentFile); // Delete the oldest log file
                    } else {
                        fs.renameSync(currentFile, nextFile);
                    }
                }
            }
            
            // Close current file stream and create a new one
            const fileStream = this.streams.find(s => s.type === 'file');
            if (fileStream) {
                fileStream.stream.end();
                this.streams = this.streams.filter(s => s.type !== 'file');
                
                const logFilePath = path.join(this.config.logDir, 'application.log');
                const newStream = createWriteStream(logFilePath, { flags: 'a' });
                this.streams.push({ type: 'file', stream: newStream });
            }
        } catch (error) {
            console.error(`Error rotating log files: ${error.message}`);
        }
    }
    
    _formatMessage(message, type) {
        const date = new Date();
        let formattedMessage = message;
        
        // Format objects and arrays for better readability
        if (typeof message === 'object' && message !== null) {
            formattedMessage = JSON.stringify(message);
        }
        
        // Add timestamp if configured
        if (this.config.timestamps) {
            const timestamp = date.toISOString()
                .replace('T', ' ')
                .replace(/\.\d+Z$/, '');
            return `[${timestamp}] [${type}] ${formattedMessage}`;
        }
        
        return `[${type}] ${formattedMessage}`;
    }
    
    _shouldLog(type) {
        const configLevel = this.config.minLevel.toUpperCase();
        const messageLevel = type.toUpperCase();
        
        return LOG_LEVELS[messageLevel] >= LOG_LEVELS[configLevel];
    }
    
    log(message, type = 'INFO', ...args) {
        if (!this._shouldLog(type)) return;
        
        // Format the message with additional arguments
        let formattedMsg = args.length ? format(message, ...args) : message;
        formattedMsg = this._formatMessage(formattedMsg, type);
        
        // Write to all configured streams
        this.streams.forEach(({ stream }) => {
            stream.write(formattedMsg + '\n');
        });
    }
    
    debug(message, ...args) {
        this.log(message, 'DEBUG', ...args);
    }
    
    info(message, ...args) {
        this.log(message, 'INFO', ...args);
    }
    
    warn(message, ...args) {
        this.log(message, 'WARN', ...args);
    }
    
    error(message, ...args) {
        this.log(message, 'ERROR', ...args);
    }
    
    fatal(message, ...args) {
        this.log(message, 'FATAL', ...args);
    }
    
    startup(message, ...args) {
        this.log(message, 'STARTUP', ...args);
    }
    
    shutdown(message, ...args) {
        this.log(message, 'SHUTDOWN', ...args);
    }
    
    config(message, ...args) {
        this.log(message, 'CONFIG', ...args);
    }
    
    ratelimit(message, ...args) {
        this.log(message, 'RATELIMIT', ...args);
    }
    
    close() {
        // Close file streams when shutting down
        this.streams.forEach(({ type, stream }) => {
            if (type === 'file' && stream.end) {
                stream.end();
            }
        });
    }
}

// Create and export a singleton instance
const logger = new Logger();

// Export the Logger class and the singleton instance
module.exports = {
    Logger,
    logger,
    // For backward compatibility
    logWithTimestamp: (message, type = 'INFO') => logger.log(message, type)
};