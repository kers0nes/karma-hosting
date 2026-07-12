const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration from environment variables
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1524112001394282616';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // e.g., https://your-app.onrender.com/api/auth/discord/callback

// Middleware
app.use(express.json( ));
app.use(cors());
app.use(express.static(path.join(__dirname)));
app.use(session({
    secret: 'karma-protect-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Mock Database (In production, use MongoDB or PostgreSQL)
const DATA_FILE = path.join(__dirname, 'database.json');
if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
        scripts: [],
        panels: [],
        keys: [],
        bannedHWIDs: [],
        serverTime: Date.now()
    }, null, 4));
}

function getData() {
    return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 4));
}

// --- API ROUTES ---

// Discord Auth Login
app.get('/api/auth/discord', (req, res) => {
    const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI )}&response_type=code&scope=identify`;
    res.redirect(url);
});

// Discord Auth Callback
app.get('/api/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/?error=no_code');

    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
        } ), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` }
        } );

        const user = userResponse.data;
        // Redirect to frontend with user info
        res.redirect(`/?user=${encodeURIComponent(user.username)}&id=${user.id}&avatar=${user.avatar}`);
    } catch (error) {
        console.error('Discord Auth Error:', error.response ? error.response.data : error.message);
        res.redirect('/?error=auth_failed');
    }
});

// Get Dashboard Data
app.get('/api/data', (req, res) => {
    const data = getData();
    data.serverTime = Date.now();
    res.json(data);
});

// Create Script
app.post('/api/create-script', (req, res) => {
    const { name, code, compressMode } = req.body;
    const data = getData();
    const newScript = {
        id: Math.random().toString(36).substring(2, 10),
        name,
        code,
        compressMode,
        status: 'active',
        ffaMode: false,
        createdAt: Date.now()
    };
    data.scripts.push(newScript);
    saveData(data);
    res.json({ success: true, script: newScript });
});

// Update Script
app.post('/api/update-script', (req, res) => {
    const { id, name, code, compressMode } = req.body;
    const data = getData();
    const index = data.scripts.findIndex(s => s.id === id);
    if (index !== -1) {
        data.scripts[index] = { ...data.scripts[index], name, code, compressMode };
        saveData(data);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Script not found' });
    }
});

// Delete Script
app.post('/api/delete-script', (req, res) => {
    const { id } = req.body;
    const data = getData();
    data.scripts = data.scripts.filter(s => s.id !== id);
    saveData(data);
    res.json({ success: true });
});

// Generate Key
app.post('/api/generate-key', (req, res) => {
    const { durationHours, panelId, note } = req.body;
    const data = getData();
    const key = `KARMA-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const expiresAt = durationHours > 0 ? Date.now() + (durationHours * 60 * 60 * 1000) : null;
    
    const newKey = {
        key,
        panelId,
        note,
        expiresAt,
        claimedBy: null,
        claimedTag: null,
        hwid: null,
        createdAt: Date.now()
    };
    data.keys.push(newKey);
    saveData(data);
    res.json({ success: true, key: newKey });
});

// Ban HWID
app.post('/api/ban-hwid', (req, res) => {
    const { hwid } = req.body;
    const data = getData();
    if (!data.bannedHWIDs.some(h => h.hwid === hwid)) {
        data.bannedHWIDs.push({ hwid, bannedAt: Date.now() });
        saveData(data);
    }
    res.json({ success: true });
});

// Unban HWID
app.post('/api/unban-hwid', (req, res) => {
    const { hwid } = req.body;
    const data = getData();
    data.bannedHWIDs = data.bannedHWIDs.filter(h => h.hwid !== hwid);
    saveData(data);
    res.json({ success: true });
});

// Loader Route (for Lua HttpGet)
app.get('/loader/:id', (req, res) => {
    const { id } = req.params;
    const data = getData();
    const script = data.scripts.find(s => s.id === id);
    
    if (!script || script.status === 'disabled') {
        return res.status(404).send('-- Script not found or disabled');
    }

    // Basic protection wrapper
    const protectedCode = `
-- Protected by Karma Protect
-- Script: ${script.name}
local _v = "${Math.random().toString(36)}"
${script.code}
    `;
    
    res.setHeader('Content-Type', 'text/plain');
    res.send(protectedCode);
});

// Fallback to index.html for SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Karma Protect Server running on port ${PORT}`);
});
