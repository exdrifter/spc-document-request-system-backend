/**
 * @fileoverview Centralized error handling middleware for the Document Request System
 *
 * This module provides comprehensive error handling for the entire application:
 * - Global error catching and formatting
 * - Database error translation and user-friendly messages
 * - JWT authentication error handling
 * - Validation error processing
 * - Development vs production error responses
 * - Consistent error response format across the API
 *
 * Error Handling Strategy:
 * - Catches all unhandled errors in the application
 * - Translates technical errors into user-friendly messages
 * - Provides detailed error information in development mode
 * - Maintains security by not exposing sensitive information in production
 * - Uses appropriate HTTP status codes for different error types
 */

/**
 * Global error handler middleware
 * Final error handling middleware that catches all unhandled errors
 *
 * Error Processing:
 * 1. Logs error for debugging and monitoring
 * 2. Identifies error type and provides appropriate response
 * 3. Translates technical errors into user-friendly messages
 * 4. Returns consistent error response format
 * 5. Includes stack trace in development mode only
 *
 * @param {Error} err - Error object thrown by application
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function (required for error middleware signature)
 */
const errorHandler = (err, req, res, next) => {
    console.error('Unhandled error:', err);

    // Mongoose validation error
    if (err.name === 'ValidationError') {
        const errors = Object.values(err.errors).map(val => val.message);
        return res.status(400).json({
            error: 'Validation Error',
            message: 'Invalid input data',
            errors: errors
        });
    }

    // Mongoose duplicate key error
    if (err.code === 11000) {
        const field = Object.keys(err.keyValue)[0];
        return res.status(409).json({
            error: 'Duplicate field value',
            message: `${field} already exists`
        });
    }

    // JWT errors
    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            error: 'Invalid token',
            message: 'Not authorized'
        });
    }

    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
            error: 'Token expired',
            message: 'Please login again'
        });
    }

    // MySQL errors
    if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
            error: 'Duplicate entry',
            message: 'A record with this information already exists'
        });
    }

    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
        return res.status(400).json({
            error: 'Invalid reference',
            message: 'Referenced record does not exist'
        });
    }

    // Default server error
    res.status(err.statusCode || 500).json({
        error: err.name || 'Internal server error',
        message: err.message || 'An unexpected error occurred',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};

/**
 * 404 Not Found handler middleware
 * Handles requests to non-existent endpoints by creating a standardized error
 *
 * Purpose:
 * - Provides consistent 404 error handling across all routes
 * - Creates proper error object for the global error handler
 * - Includes requested URL in error for debugging
 * - Works with the global error handler for consistent responses
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const notFound = (req, res, next) => {
    // Create error object with descriptive message including the requested URL
    const error = new Error(`Not found - ${req.originalUrl}`);
    error.statusCode = 404; // Set HTTP status code for the error
    next(error); // Pass error to global error handler
};

/**
 * Async error wrapper utility
 * Higher-order function that wraps async route handlers to catch promise rejections
 *
 * Problem Solved:
 * - Express doesn't automatically catch errors from async functions
 * - Without this wrapper, unhandled promise rejections would crash the server
 * - Provides consistent error handling for all async route handlers
 *
 * Usage:
 * Instead of: router.get('/endpoint', async (req, res) => { ... })
 * Use: router.get('/endpoint', asyncHandler(async (req, res) => { ... }))
 *
 * @param {Function} fn - Async function to wrap (typically a route handler)
 * @returns {Function} Wrapped function that catches errors and passes to next()
 */
const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Export middleware functions
 * Makes these utilities available to other parts of the application
 */
module.exports = {
    errorHandler,  // Global error handler (must be last middleware)
    notFound,      // 404 handler (must be before error handler)
    asyncHandler   // Async error wrapper utility
};