const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-key';
const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

// Auth middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Get prayer times from AlAdhan API
async function getPrayerTimes(date, city = 'Cairo', country = 'Egypt') {
  try {
    const response = await axios.get(
      `https://api.aladhan.com/v1/timingsByCity/${date}`,
      { params: { city, country } }
    );
    
    const timings = response.data.data.timings;
    const result = {};
    
    PRAYERS.forEach(prayer => {
      const time = timings[prayer];
      const [hours, minutes] = time.split(':');
      const prayerDate = new Date(date);
      prayerDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
      result[prayer] = prayerDate.toISOString();
    });
    
    return result;
  } catch (error) {
    console.error('Error fetching prayer times:', error);
    throw error;
  }
}

// Check if prayer can be marked
function canMarkPrayer(prayerTime, nextPrayerTime, currentTime) {
  const prayer = new Date(prayerTime);
  const current = new Date(currentTime);
  
  if (current < prayer) return false;
  
  if (nextPrayerTime) {
    const next = new Date(nextPrayerTime);
    if (current >= next) return false;
  } else {
    const midnight = new Date(prayer);
    midnight.setHours(23, 59, 59, 999);
    if (current > midnight) return false;
  }
  
  return true;
}

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Prayer Tracker API', version: '1.0.0' });
});

app.post('/auth/register', async (req, res) => {
  try {
    const { username, password, displayName, location } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, display_name, location) VALUES ($1, $2, $3, $4) RETURNING id, username, display_name',
      [username, passwordHash, displayName || username, location || 'Cairo, Egypt']
    );
    
    await pool.query(
      'INSERT INTO group_members (group_id, user_id) VALUES (1, $1)',
      [result.rows[0].id]
    );
    
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        location: user.location
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/prayers/times', async (req, res) => {
  try {
    const { date, city, country } = req.query;
    const times = await getPrayerTimes(
      date || new Date().toISOString().split('T')[0],
      city || 'Cairo',
      country || 'Egypt'
    );
    res.json({ times });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/prayer/mark', authMiddleware, async (req, res) => {
  try {
    const { date, prayerName } = req.body;
    const userId = req.userId;
    const currentTime = new Date();
    
    const user = await pool.query(
      'SELECT location FROM users WHERE id = $1',
      [userId]
    );
    
    const [city, country] = user.rows[0].location.split(', ');
    const prayerTimes = await getPrayerTimes(date, city, country || 'Egypt');
    
    const prayerIdx = PRAYERS.indexOf(prayerName);
    const nextPrayer = prayerIdx < PRAYERS.length - 1 ? PRAYERS[prayerIdx + 1] : null;
    
    if (!canMarkPrayer(
      prayerTimes[prayerName],
      nextPrayer ? prayerTimes[nextPrayer] : null,
      currentTime
    )) {
      return res.status(400).json({
        error: 'Prayer cannot be marked outside its valid time window'
      });
    }
    
    const existing = await pool.query(
      'SELECT id FROM prayer_marks WHERE user_id = $1 AND date = $2 AND prayer_name = $3',
      [userId, date, prayerName]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Prayer already marked' });
    }
    
    await pool.query(
      'INSERT INTO prayer_marks (user_id, date, prayer_name, marked_at, status) VALUES ($1, $2, $3, $4, $5)',
      [userId, date, prayerName, currentTime.toISOString(), 'done']
    );
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/calendar/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { month } = req.query;
    
    const marks = await pool.query(
      'SELECT * FROM prayer_marks WHERE user_id = $1 AND date >= $2 AND date < $3',
      [userId, `${month}-01`, `${month}-31`]
    );
    
    res.json({ marks: marks.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/group/:groupId/progress', authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { period } = req.query;
    
    const now = new Date();
    let startDate;
    
    if (period === 'week') {
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 7);
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    
    const members = await pool.query(
      `SELECT u.id, u.username, u.display_name,
              COUNT(pm.id) as marked_count
       FROM users u
       JOIN group_members gm ON u.id = gm.user_id
       LEFT JOIN prayer_marks pm ON u.id = pm.user_id AND pm.date >= $1
       WHERE gm.group_id = $2
       GROUP BY u.id, u.username, u.display_name
       ORDER BY marked_count DESC`,
      [startDate.toISOString().split('T')[0], groupId]
    );
    
    const daysPassed = Math.ceil((now - startDate) / (1000 * 60 * 60 * 24));
    const totalPossible = PRAYERS.length * daysPassed;
    
    const progress = members.rows.map(member => ({
      userId: member.id,
      username: member.username,
      displayName: member.display_name,
      markedCount: parseInt(member.marked_count),
      totalPossible,
      percentage: totalPossible > 0 
        ? parseFloat(((member.marked_count / totalPossible) * 100).toFixed(1))
        : 0
    }));
    
    res.json({ progress });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});