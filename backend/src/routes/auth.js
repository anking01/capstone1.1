const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const mysql = require('mysql2/promise');

// Moodle database connection (same as moodleSchedule.js)
const moodleDbConfig = {
  host: process.env.MOODLE_DB_HOST || 'capstone11-moodle-db-1',
  user: process.env.MOODLE_DB_USER || 'moodle',
  password: process.env.MOODLE_DB_PASSWORD || 'moodle_secret',
  database: process.env.MOODLE_DB_NAME || 'moodle',
  port: process.env.MOODLE_DB_PORT || 3306
};

const moodlePool = mysql.createPool({
  ...moodleDbConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const oauthService = require('../services/oauth');

// Register new teacher/admin
router.post('/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    // Hash password
    const password_hash = await bcrypt.hash(password, 10);
    
    // Insert user
    const result = await moodlePool.query(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id, username, role',
      [username, password_hash, role || 'teacher']
    );
    
    console.log(`✓ User registered: ${username}`);
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === '23505') { // Duplicate username
      return res.status(400).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Login - Query Moodle DB for teacher authentication
router.post('/login', async (req, res) => {
  try {
    console.log('LOGIN REQUEST RECEIVED:', req.body);
    const { username, password } = req.body;
    
    if (!username || !password) {
      console.log('LOGIN ERROR: Missing username or password');
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    console.log(` Login attempt - Username: ${username}`);

    // ---- LOCAL DEV AUTH BYPASS (Postgres-based, skips Moodle) ----
    if (process.env.LOCAL_DEV_AUTH === 'true') {
      try {
        const localResult = await db.query(
          'SELECT id, username, password_hash, role FROM users WHERE username = $1',
          [username]
        );
        if (localResult.rows.length > 0) {
          const localUser = localResult.rows[0];
          const localValid = await bcrypt.compare(password, localUser.password_hash);
          if (localValid) {
            const token = jwt.sign(
              {
                id: localUser.id,
                username: localUser.username,
                email: `${localUser.username}@local.dev`,
                name: localUser.username,
                role: localUser.role,
                course_id: 1,
                course_name: 'Local Dev Course'
              },
              process.env.JWT_SECRET || 'default_secret_change_this',
              { expiresIn: '24h' }
            );
            console.log(`[LOCAL DEV AUTH] Logged in via Postgres: ${username} (${localUser.role})`);
            return res.json({
              success: true,
              token,
              user: { id: localUser.id, username: localUser.username, role: localUser.role }
            });
          }
        }
        console.log('[LOCAL DEV AUTH] No Postgres match, falling back to Moodle auth flow');
      } catch (localErr) {
        console.error('[LOCAL DEV AUTH] error, falling back to Moodle:', localErr.message);
      }
    }
    // ---- END LOCAL DEV AUTH BYPASS ----
    
    // Test database connection
    try {
      await moodlePool.query('SELECT 1');
      console.log('DATABASE CONNECTION: OK');
    } catch (dbError) {
      console.error('DATABASE CONNECTION ERROR:', dbError);
      return res.status(500).json({ error: 'Database connection failed' });
    }
    
    // Query Moodle user database
    const [moodleRows] = await moodlePool.query(
      'SELECT id, username, password, email, firstname, lastname FROM mdl_user WHERE username = ? AND deleted = 0',
      [username]
    );
    
    console.log('MOODLE QUERY RESULT:', moodleRows.length, 'rows found');
    console.log('MOODLE ROWS:', JSON.stringify(moodleRows, null, 2));
    
    if (moodleRows.length === 0) {
      console.log(` Login failed - User not found: ${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const moodleUser = moodleRows[0];
    console.log(` User found - ID: ${moodleUser.id}, Username: ${moodleUser.username}`);
    
    // Verify password using Moodle's bcrypt hash
    const verifyPassword = async (input, hash) => {
      console.log(`=== PASSWORD VERIFICATION ===`);
      console.log(`Input password length: ${input.length}`);
      console.log(`DB hash (original): ${hash.substring(0, 10)}...`);
      
      // Check if it's a bcrypt hash (starts with $2y$ or $2b$)
      if (!hash || (!hash.startsWith('$2y$') && !hash.startsWith('$2b$'))) {
        console.log(` Invalid password hash format: ${hash}`);
        return false;
      }
      
      // Convert Moodle bcrypt hash ($2y$) to Node.js compatible format ($2b$)
      let nodeCompatibleHash = hash;
      if (hash.startsWith('$2y$')) {
        nodeCompatibleHash = hash.replace('$2y$', '$2b$');
        console.log(`Converted hash: ${nodeCompatibleHash.substring(0, 10)}...`);
      }
      
      try {
        const isValid = await bcrypt.compare(input, nodeCompatibleHash);
        console.log(`Password verification: ${isValid ? 'SUCCESS' : 'FAILED'}`);
        return isValid;
      } catch (error) {
        console.error(`Bcrypt comparison error: ${error.message}`);
        return false;
      }
    };
    
    const valid = await verifyPassword(password, moodleUser.password);
    
    if (!valid) {
      console.log(` Login failed - Password mismatch for user: ${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Check if user is a teacher using Moodle role assignments
    const [roleRows] = await moodlePool.query(`
      SELECT ra.roleid, r.shortname, c.id as course_id, c.fullname as course_name
      FROM mdl_role_assignments ra
      JOIN mdl_role r ON ra.roleid = r.id
      JOIN mdl_context ctx ON ra.contextid = ctx.id
      JOIN mdl_course c ON ctx.instanceid = c.id
      WHERE ra.userid = ? 
      AND ctx.contextlevel = 50  -- Course context level
      AND r.shortname IN ('editingteacher', 'teacher', 'manager')
      LIMIT 1
    `, [moodleUser.id]);
    
    if (roleRows.length === 0) {
  roleRows.push({
    shortname: 'manager',
    course_id: 1,
    course_name: 'Default Course'
  });
}
    
    const userRole = roleRows[0].shortname;
    
    // Generate JWT token
    const token = jwt.sign(
      { 
        id: moodleUser.id, 
        username: moodleUser.username, 
        email: moodleUser.email,
        name: `${moodleUser.firstname} ${moodleUser.lastname}`,
        role: userRole,
        course_id: roleRows[0].course_id,
        course_name: roleRows[0].course_name
      },
      process.env.JWT_SECRET || 'default_secret_change_this',
      { expiresIn: '24h' }
    );
    
    console.log(` Teacher logged in: ${username} (${userRole})`);
    res.json({ 
      success: true, 
      token, 
      user: { 
        id: moodleUser.id, 
        username: moodleUser.username,
        email: moodleUser.email,
        name: `${moodleUser.firstname} ${moodleUser.lastname}`,
        role: userRole,
        course_id: roleRows[0].course_id,
        course_name: roleRows[0].course_name
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Test endpoint to verify authentication system
router.get('/test', async (req, res) => {
  try {
    console.log('=== AUTH SYSTEM TEST ===');
    
    // Test database connection
    await moodlePool.query('SELECT 1');
    console.log('Database connection: OK');
    
    // Test hash conversion
    const testHash = '$2y$10$JcmLcKMiTWyjYIV4HvYeD.sWMR8aE12r2GHeWK7Zh1i0caNnHi1q.';
    const convertedHash = testHash.replace('$2y$', '$2b$');
    console.log('Hash conversion: OK');
    
    // Count active users
    const userCount = await moodlePool.query('SELECT COUNT(*) as count FROM mdl_user WHERE deleted = 0 AND suspended = 0');
    console.log(`Active users: ${userCount[0].count}`);
    
    res.json({
      success: true,
      message: 'Authentication system test successful',
      database: {
        connected: true,
        activeUsers: userCount[0].count
      },
      hashConversion: {
        original: testHash.substring(0, 10) + '...',
        converted: convertedHash.substring(0, 10) + '...'
      },
      testCredentials: {
        username: 'admin',
        password: 'Admin@123',
        note: 'Test with actual Moodle admin credentials'
      }
    });
  } catch (error) {
    console.error('Auth test error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Authentication system test failed',
      error: error.message 
    });
  }
});

// Verify token (optional, for frontend to check if still logged in)
router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret_change_this');
    res.json({ valid: true, user: decoded });
  } catch (error) {
    res.status(401).json({ valid: false, error: 'Invalid token' });
  }
});

// Get current user info (protected)
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_secret_change_this');
    
    // Get fresh user data from Moodle database
    const result = await moodlePool.query(
      'SELECT id, username, email, firstname, lastname FROM mdl_user WHERE id = ? AND deleted = 0',
      [decoded.id]
    );
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get user role
    const roleResult = await moodlePool.query(`
      SELECT r.shortname, c.id as course_id, c.fullname as course_name
      FROM mdl_role_assignments ra
      JOIN mdl_role r ON ra.roleid = r.id
      JOIN mdl_context ctx ON ra.contextid = ctx.id
      JOIN mdl_course c ON ctx.instanceid = c.id
      WHERE ra.userid = ? 
      AND ctx.contextlevel = 50
      AND r.shortname IN ('editingteacher', 'teacher', 'manager')
      LIMIT 1
    `, [decoded.id]);
    
    const user = result[0];
    user.role = roleResult.length > 0 ? roleResult[0].shortname : 'student';
    user.course_id = roleResult.length > 0 ? roleResult[0].course_id : null;
    user.course_name = roleResult.length > 0 ? roleResult[0].course_name : null;
    user.name = `${user.firstname} ${user.lastname}`;
    
    res.json({ user });
  } catch (error) {
    console.error('Get user info error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
