require('dotenv').config(); //Load .env files contents into process.env



const express = require('express')
const cors = require('cors')
const mysql = require('mysql2/promise')
const port = process.env.PORT
const jwt = require('jsonwebtoken');
// Import required packages for session management
const session = require('express-session');
// MySQL session store to persist sessions in database
const MySQLStore = require('express-mysql-session')(session);



const app = express()
app.use(cors())
app.use(express.json()) // Add this to parse JSON bodies


// Create a connection pool instead of a single connection
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: 'pepe_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database and tables
async function initializeDatabase() {
  try {
    // Create database if it doesn't exist
    await pool.query(`CREATE DATABASE IF NOT EXISTS pepe_db`);
    
    // Switch to pepe_db
    await pool.query(`USE pepe_db`);
    
    // Create users table
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS users (
        id INT PRIMARY KEY AUTO_INCREMENT,
        username VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) NOT NULL,
        coins BIGINT DEFAULT 0,
        last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`;
    
    await pool.query(createTableQuery);
    
    // Create referrals table
    const createReferralsTable = `
      CREATE TABLE IF NOT EXISTS referrals (
        id INT PRIMARY KEY AUTO_INCREMENT,
        referrer_id INT NOT NULL,
        referred_user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (referrer_id) REFERENCES users(id),
        FOREIGN KEY (referred_user_id) REFERENCES users(id)
      )`;
    
    // Create tasks table
    const createTasksTable = `
      CREATE TABLE IF NOT EXISTS tasks (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        task_type VARCHAR(50) NOT NULL,
        coins_earned INT NOT NULL,
        completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`;
    
    // Create coin_clicks table
    const createCoinClicksTable = `
      CREATE TABLE IF NOT EXISTS coin_clicks (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        coins_earned INT NOT NULL,
        clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`;
    
    await pool.query(createReferralsTable);
    await pool.query(createTasksTable);
    await pool.query(createCoinClicksTable);
    
    console.log('Database and tables initialized successfully');
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  }
}

// Initialize database on startup
initializeDatabase().catch(console.error);

// Add JWT secret to your environment variables
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Configure the MySQL session store with database credentials
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: 'pepe_db'
});

// Configure session middleware
app.use(session({
  key: 'session_cookie_name',     // Name of the cookie
  secret: process.env.SESSION_SECRET || 'session_cookie_secret', // Secret used to sign the session ID cookie
  store: sessionStore,            // Use MySQL to store sessions
  resave: false,                  // Don't save session if unmodified
  saveUninitialized: false,       // Don't create session until something stored
  cookie: {
    maxAge: 1000 * 60 * 60 * 24  // Cookie expires after 24 hours
  }
}));

// Signup endpoint
app.post('/signup', async (req, res) => {
  const { username, email, referralCode } = req.body;

  try {
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // Create new user
      const [result] = await connection.query(
        'INSERT INTO users (username, email, coins) VALUES (?, ?, 0)',
        [username, email]
      );
      const newUserId = result.insertId;

      // If there's a referral code, record the referral and reward the referrer
      if (referralCode) {
        await connection.query(
          'INSERT INTO referrals (referrer_id, referred_user_id) VALUES (?, ?)',
          [referralCode, newUserId]
        );

        await connection.query(
          'UPDATE users SET coins = coins + 500 WHERE id = ?',
          [referralCode]
        );
      }

      // Generate JWT
      const token = jwt.sign(
        { userId: newUserId, username },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      await connection.commit();
      connection.release();

      res.status(201).json({
        message: 'User created successfully',
        userId: newUserId,
        username,
        email,
        coins: 0,
        token
      });
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (err) {
    console.error('Error in signup:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Error creating account' });
    }
  }
});

// Signin endpoint - handles user authentication
app.post('/signin', async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ 
      error: 'Username is required' 
    });
  }

  try {
    // SQL query to find user by username
    const [rows] = await pool.query(
      'SELECT id, username, email, coins FROM users WHERE username = ?',
      [username]
    );

    // Check if user exists
    if (rows.length === 0) {
      return res.status(404).json({ 
        error: 'User not found. Please check your username or sign up.' 
      });
    }

    const user = rows[0];

    // Generate JWT token with user data
    const token = jwt.sign(
      { 
        userId: user.id, 
        username: user.username 
      }, 
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Update user's last login timestamp
    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
      [user.id]
    );

    // Send successful response with user data and token
    res.json({
      message: 'Signin successful',
      userId: user.id,
      username: user.username,
      email: user.email,
      coins: user.coins,
      token,
      isLoggedIn: true
    });
  } catch (err) {
    console.error('Error in signin:', err);
    res.status(500).json({ 
      error: 'Server error. Please try again later.' 
    });
  }
});

// Signout endpoint - handles user logout
app.post('/signout', authenticateToken, (req, res) => {
  // Destroy the session
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ 
        error: 'Error signing out' 
      });
    }

    res.json({ 
      message: 'Signed out successfully',
      isLoggedIn: false
    });
  });
});

// Get current user state endpoint
app.get('/user/state', authenticateToken, (req, res) => {
  // Get user ID from the authenticated token
  const userId = req.user.userId;

  // SQL query to get fresh user data
  const query = `
    SELECT id, username, email, coins 
    FROM users 
    WHERE id = ?
  `;

  pool.query(query, [userId], (err, results) => {
    if (err) {
      console.error('Error fetching user state:', err);
      return res.status(500).json({ 
        error: 'Error fetching user data' 
      });
    }

    // Check if user exists
    if (results.length === 0) {
      return res.status(404).json({ 
        error: 'User not found' 
      });
    }

    const user = results[0];

    res.json({
      userId: user.id,
      username: user.username,
      email: user.email,
      coins: user.coins,
      isAuthenticated: true
    });
  });
});

// Error handler for token expiration
app.use((err, req, res, next) => {
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Token expired',
      isAuthenticated: false
    });
  }
  next(err);
});

// Example protected route
app.get('/protected', authenticateToken, (req, res) => {
  res.json({ 
    message: 'Access granted', 
    user: req.user 
  });
});

// Add coin endpoint
app.post('/add-coin', authenticateToken, (req, res) => {
  const userId = req.user.userId;

  // Update coins in database
  pool.query(
    'UPDATE users SET coins = coins + 1 WHERE id = ?',
    [userId],
    (err, result) => {
      if (err) {
        console.error('Error updating coins:', err);
        return res.status(500).json({ 
          error: 'Error updating coins' 
        });
      }

      // Get updated coin count
      pool.query(
        'SELECT coins FROM users WHERE id = ?',
        [userId],
        (err, results) => {
          if (err) {
            console.error('Error fetching updated coins:', err);
            return res.status(500).json({ 
              error: 'Error fetching updated coins' 
            });
          }

          res.json({
            message: 'Coin added successfully',
            coins: results[0].coins
          });
        }
      );
    }
  );
});

// Add endpoint to get user's referral link
app.get('/referral-link', authenticateToken, (req, res) => {
  const userId = req.user.userId;
  const referralLink = `${process.env.FRONTEND_URL}/signup?ref=${userId}`;
  res.json({ referralLink });
});

// Add coins endpoint with task tracking
app.post('/add-coins', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const { amount, taskType } = req.body;

  try {
    // Get a connection from the pool
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // Only check for existing tasks if it's not a coin click
      if (taskType !== 'click_coin') {
        const [existingTasks] = await connection.query(
          'SELECT id FROM tasks WHERE user_id = ? AND task_type = ?',
          [userId, taskType]
        );

        if (existingTasks.length > 0) {
          await connection.rollback();
          connection.release();
          return res.status(400).json({ error: 'Task already completed' });
        }
      }

      // Update user's coins
      await connection.query(
        'UPDATE users SET coins = coins + ? WHERE id = ?',
        [amount, userId]
      );

      // Record task completion (for non-coin-clicks) or coin click
      if (taskType === 'click_coin') {
        await connection.query(
          'INSERT INTO coin_clicks (user_id, coins_earned, clicked_at) VALUES (?, ?, NOW())',
          [userId, amount]
        );
      } else {
        await connection.query(
          'INSERT INTO tasks (user_id, task_type, coins_earned) VALUES (?, ?, ?)',
          [userId, taskType, amount]
        );
      }

      // Get updated user data
      const [rows] = await connection.query(
        'SELECT coins FROM users WHERE id = ?',
        [userId]
      );

      await connection.commit();
      connection.release();

      res.json({
        message: 'Coins added successfully',
        coins: rows[0].coins
      });
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (err) {
    console.error('Error adding coins:', err);
    res.status(500).json({ error: 'Failed to add coins' });
  }
});

// Add endpoint to get user stats
app.get('/user/stats', authenticateToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    // Get referral stats
    const [referrals] = await pool.query(`
      SELECT 
        u.username as referred_user,
        r.created_at
      FROM referrals r
      JOIN users u ON u.id = r.referred_user_id
      WHERE r.referrer_id = ?
      ORDER BY r.created_at DESC
    `, [userId]);

    // Get task completion stats
    const [tasks] = await pool.query(`
      SELECT 
        task_type,
        coins_earned,
        completed_at
      FROM tasks
      WHERE user_id = ?
      ORDER BY completed_at DESC
    `, [userId]);

    res.json({
      referrals,
      tasks
    });
  } catch (err) {
    console.error('Error fetching user stats:', err);
    res.status(500).json({ error: 'Failed to fetch user stats' });
  }
});

// Add user data endpoint
app.get('/user', authenticateToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const [rows] = await pool.query(
      'SELECT id, username, email, coins FROM users WHERE id = ?',
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];
    res.json({
      userId: user.id,
      username: user.username,
      email: user.email,
      coins: user.coins
    });
  } catch (err) {
    console.error('Error fetching user data:', err);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

app.listen(port, () => {
    console.log(`Server is running on port: ${port}`)
})