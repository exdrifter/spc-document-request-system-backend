/**
 * @fileoverview Main server file for San Pablo Colleges Document Request System API
 * This file sets up the Express server, configures middleware, establishes database connections,
 * and defines the core application structure for the document request management system.
 *
 * Key Features:
 * - Express.js web server setup
 * - CORS configuration for frontend communication
 * - Database connection management with retry logic
 * - Rate limiting for API protection
 * - Request logging and monitoring
 * - Graceful shutdown handling
 * - Health check endpoints
 */

// Import required Node.js modules and dependencies
require('dotenv').config(); // Load environment variables
const express = require('express'); // Web framework for Node.js
const cors = require('cors'); // Cross-Origin Resource Sharing middleware
const path = require('path'); // File and directory path utilities
const { createServer } = require('http'); // HTTP server module
const { Server } = require('socket.io'); // Socket.IO server
const multer = require('multer'); // File upload middleware

// Import our modular application components
const DatabaseManager = require('./config/db'); // Database connection and management
const MailService = require('./services/mailer'); // Email service
const routes = require('./routes'); // All API route definitions
const { errorHandler, notFound } = require('./middleware/errorHandler'); // Error handling middleware

// Create Express application instance
const app = express();

// Define server port - can be overridden by environment variable
const port = process.env.PORT || 5000;
console.log(`🔍 Server port configured: ${port}`);

// Create HTTP server instance
const httpServer = createServer(app);

// Initialize database manager instance for handling all database operations
const dbManager = new DatabaseManager();

// Initialize mail service instance
const mailService = new MailService();

// Verify SMTP connection on startup (optional but helpful for debugging)
mailService.verifyConnection().catch(err => {
    console.warn('⚠️  SMTP verification failed on startup:', err.message);
    console.warn('⚠️  Email functionality may not work until SMTP is properly configured');
});

/**
 * Initialize application with database setup
 * This function handles the critical startup sequence including:
 * 1. Database connection establishment
 * 2. Database connectivity verification with retry mechanism
 * 3. Database schema and table creation
 * 4. Default data population (users, statuses, etc.)
 *
 * If any step fails, the application will exit to prevent running in an inconsistent state.
 */
async function initializeApp() {
    try {
        console.log('🚀 Initializing Registrar API...');

        // Step 1: Create database connection pool
        // This establishes a pool of connections for efficient database access
        dbManager.createConnection();

        // Step 2: Test database connectivity with automatic retry
        // Implements exponential backoff for resilient startup
        await dbManager.connectWithRetry();

        // Step 3: Set up database schema and initial data
        // Creates all required tables and inserts default lookup data
        await dbManager.initializeDatabase();

        console.log('✅ Application initialized successfully');

    } catch (error) {
        console.error('❌ Failed to initialize application:', error.message);
        console.warn('⚠️  Server will exit due to critical initialization failure');
        process.exit(1); // Exit to prevent running without proper database setup
    }
}

// Security middleware - Enhanced CORS configuration for frontend communication
// CORS (Cross-Origin Resource Sharing) controls which domains can access this API
app.use(cors({
    // Dynamic origin validation function
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, server-to-server requests)
        if (!origin) return callback(null, true);

        // Allow all localhost origins for development (React dev server, etc.)
        if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
            return callback(null, true);
        }

        // Explicitly allow common development ports used by modern frontend tools
        const allowedOrigins = [
            'http://localhost:3000',    // React dev server (Create React App)
            'http://127.0.0.1:3000',   // React dev server (alternative)
            'http://localhost:5173',    // Vite dev server
            'http://127.0.0.1:5173',   // Vite dev server (alternative)
            'http://localhost:5174',    // Vite dev server (alternative port)
            'http://127.0.0.1:5174',   // Vite dev server (alternative port)
            'http://localhost:4173',    // Vite preview server
            'http://127.0.0.1:4173'    // Vite preview server (alternative)
        ];

        // Check if the requesting origin is in our allowed list
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true); // Allow the request
        } else {
            console.log(`CORS: Blocked origin: ${origin}`); // Log blocked attempts for security monitoring
            callback(new Error('Not allowed by CORS')); // Reject the request
        }
    },
    // Allow credentials (cookies, authorization headers) to be sent with requests
    credentials: true,
    // Specify which HTTP methods are allowed
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    // Specify which headers can be sent in requests
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Rate limiting middleware - Basic DDoS protection
// This implements a simple in-memory rate limiter to prevent abuse
// In production, consider using Redis or a dedicated rate limiting service
const rateLimit = new Map(); // In-memory storage for rate limit data
app.use((req, res, next) => {
    // Get client IP address (handles proxy scenarios)
    const ip = req.ip || req.connection.remoteAddress;

    // Current timestamp for time window calculations
    const now = Date.now();

    // Rate limiting configuration
    const windowMs = 15 * 60 * 1000; // 15-minute time window
    const maxRequests = 500; // Maximum requests per window (increased for development)

    // Check if this IP has rate limit data
    if (!rateLimit.has(ip)) {
        // First request from this IP - initialize rate limit data
        rateLimit.set(ip, {
            count: 1, // Current request count
            resetTime: now + windowMs // When the window resets
        });
        return next(); // Allow the request
    }

    // Get existing rate limit data for this IP
    const userLimit = rateLimit.get(ip);

    // Check if the time window has expired
    if (now > userLimit.resetTime) {
        // Window expired - reset counter and time window
        userLimit.count = 1;
        userLimit.resetTime = now + windowMs;
        return next(); // Allow the request
    }

    // Check if rate limit exceeded
    if (userLimit.count >= maxRequests) {
        // Rate limit exceeded - return 429 (Too Many Requests) error
        return res.status(429).json({
            error: 'Too many requests',
            message: 'Rate limit exceeded. Please try again later.'
        });
    }

    // Increment request count and allow the request
    userLimit.count++;
    next();
});

// File upload configuration
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, 'uploads');
        // Create uploads directory if it doesn't exist
        const fs = require('fs');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        // Generate unique filename with timestamp
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'alumni-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: function (req, file, cb) {
        // Check file types
        const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, and PDF files are allowed.'), false);
        }
    }
});

// Body parsing middleware - Parse incoming request bodies
// These middleware functions parse different types of request data
app.use(express.json({ limit: '10mb' })); // Parse JSON payloads (limit to 10MB for security)
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded form data

// Serve static files from the public directory
// This allows serving static assets like images, CSS, or client-side files
app.use(express.static(path.join(__dirname, "public")));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Request logging middleware - Monitor all incoming requests
// Logs HTTP method, URL, timestamp, and client IP for debugging and monitoring
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url} - IP: ${req.ip}`);
    next(); // Continue to next middleware
});

// Database manager and mail service injection middleware
// Makes the database manager and mail service available to all route handlers
// This follows the dependency injection pattern for better testability and modularity
app.use((req, res, next) => {
    console.log(`🔗 Injecting dependencies for ${req.method} ${req.url}`);
    req.dbManager = dbManager;
    req.mailService = mailService;
    req.app.locals.dbManager = dbManager;
    req.app.locals.mailService = mailService;
    console.log('Injected mailService type:', typeof req.app.locals.mailService);
    console.log('Injected mailService has sendMail:', typeof req.app.locals.mailService?.sendMail);
    next();
});

// Mount API routes
// All API endpoints are prefixed with '/api' for clear URL structure
// Example: /api/auth/login, /api/requests, /api/admin/users
app.use('/api', routes);

// Initialize Socket.IO with CORS configuration
const io = new Server(httpServer, {
    cors: {
        origin: function (origin, callback) {
            // Allow requests with no origin (mobile apps, Postman, server-to-server requests)
            if (!origin) return callback(null, true);

            // Allow all localhost origins for development (React dev server, etc.)
            if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
                return callback(null, true);
            }

            // Explicitly allow common development ports used by modern frontend tools
            const allowedOrigins = [
                'http://localhost:3000',    // React dev server (Create React App)
                'http://127.0.0.1:3000',   // React dev server (alternative)
                'http://localhost:5173',    // Vite dev server
                'http://127.0.0.1:5173',   // Vite dev server (alternative)
                'http://localhost:5174',    // Vite dev server (alternative port)
                'http://127.0.0.1:5174',   // Vite dev server (alternative port)
                'http://localhost:4173',    // Vite preview server
                'http://127.0.0.1:4173'    // Vite preview server (alternative)
            ];

            // Check if the requesting origin is in our allowed list
            if (allowedOrigins.indexOf(origin) !== -1) {
                callback(null, true); // Allow the request
            } else {
                console.log(`Socket.IO CORS: Blocked origin: ${origin}`); // Log blocked attempts
                callback(new Error('Not allowed by CORS')); // Reject the request
            }
        },
        credentials: true,
        methods: ['GET', 'POST']
    }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// Export Socket.IO instance for use in controllers
global.io = io;


// Error handling middleware - Order matters!
// 1. 404 handler for undefined routes (must come before general error handler)
app.use(notFound); // Handles 404 errors from routes

// 2. Global error handler (must come after all routes and other middleware)
app.use(errorHandler); // Catches and formats all errors

// Fallback 404 handler for any routes not handled by the above middleware
// This provides a consistent error response format for undefined endpoints
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        message: 'The requested endpoint does not exist',
        path: req.originalUrl // Include the requested path for debugging
    });
});

// Initialize the application (but don't fail if DB is not available)
// This allows the server to start even if database is temporarily unavailable
// Useful for development and Docker container orchestration
initializeApp().catch(error => {
    console.warn('⚠️  Database connection failed, but server will start anyway for development');
    console.warn('⚠️  API endpoints will return database errors until MySQL is available');
});



// Export the Express app for testing purposes
// Allows the application to be imported and tested in other modules
module.exports = app;
// Health check endpoint (outside of /api for easier access)
// Provides system health information for monitoring and load balancer health checks
app.get('/health', (req, res) => {
    res.json({
        status: 'OK', // Simple status indicator
        timestamp: new Date().toISOString(), // Current server time
        uptime: process.uptime(), // Server uptime in seconds
        service: 'Smart Registrar API', // Service identification
        version: '1.0.0', // API version
        database: dbManager.isConnected ? 'connected' : 'disconnected' // Database status
    });
});


// Start the HTTP server and listen for incoming requests
httpServer.listen(port, () => {
    console.log(`🚀 San Pablo Colleges Online Document Request API running on port ${port}`);
    console.log(`📊 Health check: http://localhost:${port}/health`);
    console.log(`🔗 API base URL: http://localhost:${port}/api`);
    console.log(`📚 API Documentation - Key Endpoints:`);
    console.log(`   🔐 Authentication:`);
    console.log(`   POST   http://localhost:${port}/api/auth/login`);
    console.log(`   POST   http://localhost:${port}/api/auth/logout`);
    console.log(`   GET    http://localhost:${port}/api/auth/profile`);
    console.log(`   📄 Document Requests:`);
    console.log(`   POST   http://localhost:${port}/api/requests`);
    console.log(`   GET    http://localhost:${port}/api/requests/track/:referenceNumber`);
    console.log(`   GET    http://localhost:${port}/api/requests`);
    console.log(`   📢 Announcements:`);
    console.log(`   GET    http://localhost:${port}/api/announcements`);
    console.log(`   GET    http://localhost:${port}/api/announcements/latest`);
    console.log(`   📅 Transaction Days:`);
    console.log(`   GET    http://localhost:${port}/api/transactions`);
    console.log(`   GET    http://localhost:${port}/api/transactions/upcoming`);
    console.log(`   👥 Admin Functions:`);
    console.log(`   GET    http://localhost:${port}/api/admin/stats`);
    console.log(`   GET    http://localhost:${port}/api/admin/users`);
    console.log(`   GET    http://localhost:${port}/api/admin/documents`);
    console.log(`   👨‍💼 Staff Functions:`);
    console.log(`   GET    http://localhost:${port}/api/staff/stats`);
    console.log(`   GET    http://localhost:${port}/api/staff/requests`);
});

// Graceful shutdown handlers for different termination signals
// Ensures clean shutdown when server is restarted

// Handle Ctrl+C (SIGINT) signal
process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT received. Shutting down gracefully...');
    httpServer.close(() => {
        console.log('🔐 HTTP server closed');
        dbManager.close(); // Close database connections
        process.exit(0); // Exit cleanly
    });
});

// Handle termination signal (SIGTERM) - used by process managers and Docker
process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM received. Shutting down gracefully...');
    httpServer.close(() => {
        console.log('🔐 HTTP server closed');
        dbManager.close(); // Close database connections
        process.exit(0); // Exit cleanly
    });
});

// Export the Express app for testing purposes
// Allows the application to be imported and tested in other modules
module.exports = app;""
