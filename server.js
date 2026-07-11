const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const https = require('https');
const querystring = require('querystring');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Discord OAuth Configurations
const DISCORD_CLIENT_ID = '1524112001394282616';
const DISCORD_CLIENT_SECRET = 'KHas2lF7ozsVVk-EjEVkFBFeil9cg0w9';

// Enable CORS for frontend hosting domains (like Cloudflare Pages)
app.use(cors({
  origin: true, 
  credentials: true
}));

app.use(express.json());
app.use(cookieParser('karmaforges_secret_session_token_123'));
app.use(express.urlencoded({ extended: true }));

// Serve static files from 'public' directory, and fallback to root directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// --- DISCORD OAUTH HELPER FUNCTIONS ---
function exchangeDiscordCode(code, redirectUri) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri
    });

    const options = {
      hostname: 'discord.com',
      path: '/api/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            resolve(data.access_token);
          } catch (e) {
            reject(new Error(`Failed to parse token response: ${e.message}`));
          }
        } else {
          reject(new Error(`Token exchange failed with status ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', (e) => { reject(e); });
    req.write(postData);
    req.end();
  });
}

function getDiscordProfile(accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'discord.com',
      path: '/api/users/@me',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            resolve(data);
          } catch (e) {
            reject(new Error(`Failed to parse profile response: ${e.message}`));
          }
        } else {
          reject(new Error(`Profile fetch failed with status ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', (e) => { reject(e); });
    req.end();
  });
}

// Helper: Get logged-in user from session/cookie or Authorization header
function getSessionUser(req) {
  let token = null;
  
  // 1. Check Authorization Header (Bearer Token)
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }
  
  // 2. Fallback to Cookie
  if (!token) {
    token = req.cookies.auth_token;
  }
  
  if (!token) return null;
  
  return db.getUserById(token);
}

// Middleware: Authenticate user
function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }
  req.user = user;
  next();
}

// Middleware: Require owner (admin) permissions
function requireOwner(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  
  const isOwner = db.isUserOwner(user.email, user.username);
  if (!isOwner) {
    return res.status(403).json({ error: 'Access denied. Owner dashboard only.' });
  }
  req.user = user;
  next();
}

// --- DISCORD OAUTH CALLBACK ROUTE ---
app.get('/api/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.redirect('/?error=oauth_failed');
  }

  // Dynamically resolve redirect_uri to match current protocol and host
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/discord/callback`;

  try {
    const accessToken = await exchangeDiscordCode(code, redirectUri);
    const profile = await getDiscordProfile(accessToken);

    if (!profile || !profile.id) {
      return res.redirect('/?error=profile_failed');
    }

    // Check if user already exists by discord ID
    let user = db.getUserByDiscordId(profile.id);
    
    // Fallback: Check if user exists by email
    if (!user && profile.email) {
      user = db.getUserByEmail(profile.email);
    }

    if (!user) {
      // Setup initial credits (check referral cookie)
      let userCredits = 0;
      let referredByUser = null;
      const activeRefCode = req.cookies.referred_by;
      if (activeRefCode) {
        referredByUser = db.getUserByUsername(activeRefCode);
      }

      if (referredByUser) {
        userCredits = 50; // New user gets 50 bonus credits!
      }

      // Create new user (Discord SSO)
      user = {
        id: 'ur-' + Math.random().toString(36).substr(2, 9),
        discordId: profile.id,
        username: profile.username,
        email: profile.email || `${profile.username}@discord.auth`,
        avatar: profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` : '',
        credits: userCredits,
        referredBy: referredByUser ? referredByUser.username : null,
        createdAt: new Date().toISOString()
      };

      db.addUser(user);

      // If referred, award points to referrer
      if (referredByUser) {
        const updatedReferrerCredits = (referredByUser.credits || 0) + 100; // Referrer gets 100 credits!
        db.updateUser(referredByUser.id, { credits: updatedReferrerCredits });

        db.addReferral({
          id: 'ref-' + Math.random().toString(36).substr(2, 9),
          referrerId: referredByUser.id,
          referrerName: referredByUser.username,
          referredId: user.id,
          referredName: user.username,
          creditsAwarded: 100,
          createdAt: new Date().toISOString()
        });
      }
    } else {
      // Update discord profile details if needed
      db.updateUser(user.id, {
        discordId: profile.id,
        avatar: profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` : user.avatar
      });
    }

    // Clear referred_by cookie
    res.clearCookie('referred_by');

    // Sign in the user
    res.cookie('auth_token', user.id, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true });

    // Redirect to dashboard with token parameter as fallback for separate frontend hosts
    res.redirect(`/?token=${user.id}`);
  } catch (err) {
    console.error('Discord OAuth error:', err);
    res.redirect('/?error=internal_oauth_error');
  }
});

// --- REFERRAL & INVITE ROUTE ---
app.get('/invite/:username', (req, res) => {
  const referrerUsername = req.params.username;
  const referrer = db.getUserByUsername(referrerUsername);
  
  if (referrer) {
    res.cookie('referred_by', referrer.username, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: false });
  }
  res.redirect('/');
});

app.get('/ref/:username', (req, res) => {
  res.redirect(`/invite/${req.params.username}`);
});

// --- AUTHENTICATION API ---

// Check session
app.get('/api/auth/session', (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.json({ loggedIn: false });
  }
  const isOwner = db.isUserOwner(user.email, user.username);
  res.json({
    loggedIn: true,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar || '',
      credits: user.credits,
      isOwner: isOwner
    }
  });
});

// Sign Up (Manual Override Fallback)
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, username, password, referralCode } = req.body;
    
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Please enter all fields.' });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existingEmail = db.getUserByEmail(email);
    if (existingEmail) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const existingUsername = db.getUserByUsername(username);
    if (existingUsername) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    let userCredits = 0;
    let referredByUser = null;

    const activeRefCode = referralCode || req.cookies.referred_by;
    if (activeRefCode) {
      referredByUser = db.getUserByUsername(activeRefCode);
    }

    if (referredByUser) {
      userCredits = 50;
    }

    const newUser = {
      id: 'ur-' + Math.random().toString(36).substr(2, 9),
      email: email,
      username: username,
      password: passwordHash,
      credits: userCredits,
      referredBy: referredByUser ? referredByUser.username : null,
      createdAt: new Date().toISOString()
    };

    db.addUser(newUser);

    if (referredByUser) {
      const updatedReferrerCredits = (referredByUser.credits || 0) + 100;
      db.updateUser(referredByUser.id, { credits: updatedReferrerCredits });

      db.addReferral({
        id: 'ref-' + Math.random().toString(36).substr(2, 9),
        referrerId: referredByUser.id,
        referrerName: referredByUser.username,
        referredId: newUser.id,
        referredName: newUser.username,
        creditsAwarded: 100,
        createdAt: new Date().toISOString()
      });
    }

    res.clearCookie('referred_by');
    res.cookie('auth_token', newUser.id, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true });

    const isOwner = db.isUserOwner(newUser.email, newUser.username);

    res.status(201).json({
      success: true,
      token: newUser.id,
      user: {
        id: newUser.id,
        email: newUser.email,
        username: newUser.username,
        credits: newUser.credits,
        isOwner: isOwner
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error during sign up.' });
  }
});

// Sign In (Manual Override Fallback)
app.post('/api/auth/signin', async (req, res) => {
  try {
    const { loginIdentifier, password } = req.body;
    
    if (!loginIdentifier || !password) {
      return res.status(400).json({ error: 'Please enter all fields.' });
    }

    let user = db.getUserByEmail(loginIdentifier);
    if (!user) {
      user = db.getUserByUsername(loginIdentifier);
    }

    if (!user || !user.password) {
      return res.status(400).json({ error: 'Invalid credentials or Discord Auth account.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials.' });
    }

    res.cookie('auth_token', user.id, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true });

    const isOwner = db.isUserOwner(user.email, user.username);

    res.json({
      success: true,
      token: user.id,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        credits: user.credits,
        isOwner: isOwner
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error during sign in.' });
  }
});

// Sign Out
app.post('/api/auth/signout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});


// --- SCRIPTS STORAGE API ---

// Get current user's scripts
app.get('/api/scripts', requireAuth, (req, res) => {
  const scripts = db.getScriptsByUserId(req.user.id);
  res.json(scripts);
});

// Upload/Create Script
app.post('/api/scripts', requireAuth, async (req, res) => {
  try {
    const { name, description, code } = req.body;

    if (!name || !code) {
      return res.status(400).json({ error: 'Script name and code are required.' });
    }

    // Upgraded limit to 100 scripts
    const userScripts = db.getScriptsByUserId(req.user.id);
    if (userScripts.length >= 100) {
      return res.status(400).json({ error: 'Script storage limit reached (Max 100 scripts).' });
    }

    const newScript = {
      id: 'sc-' + Math.random().toString(36).substr(2, 9),
      userId: req.user.id,
      name: name,
      description: description || '',
      code: code,
      createdAt: new Date().toISOString()
    };

    db.addScript(newScript);
    res.status(201).json(newScript);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save script.' });
  }
});

// Edit Script
app.put('/api/scripts/:id', requireAuth, async (req, res) => {
  try {
    const scriptId = req.params.id;
    const { name, description, code } = req.body;

    const script = db.getScriptById(scriptId);
    if (!script || script.userId !== req.user.id) {
      return res.status(404).json({ error: 'Script not found.' });
    }

    const updates = {};
    if (name) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (code !== undefined) updates.code = code;

    const updatedScript = db.updateScript(scriptId, updates);
    res.json(updatedScript);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update script.' });
  }
});

// Delete Script
app.delete('/api/scripts/:id', requireAuth, (req, res) => {
  const scriptId = req.params.id;
  const script = db.getScriptById(scriptId);
  
  if (!script || script.userId !== req.user.id) {
    return res.status(404).json({ error: 'Script not found.' });
  }

  // Also clean up any whitelist keys for this script
  const keys = db.getKeys();
  const scriptKeys = keys.filter(k => k.scriptId === scriptId);
  scriptKeys.forEach(k => db.deleteKey(k.id));

  db.deleteScript(scriptId);
  res.json({ success: true, message: 'Script deleted successfully.' });
});


// --- LICENSING & WHITELIST KEYS API ---

// Get current user's generated keys
app.get('/api/keys', requireAuth, (req, res) => {
  const keys = db.getKeysByUserId(req.user.id);
  res.json(keys);
});

// Generate a new whitelist key
app.post('/api/keys', requireAuth, (req, res) => {
  const { scriptId, expiresDays } = req.body;
  if (!scriptId) {
    return res.status(400).json({ error: 'Script selection is required.' });
  }

  const script = db.getScriptById(scriptId);
  if (!script || script.userId !== req.user.id) {
    return res.status(404).json({ error: 'Selected script not found.' });
  }

  // Generate high-quality key: KARMA-XXXX-XXXX-XXXX
  const randBlock = () => Math.random().toString(36).substr(2, 4).toUpperCase();
  const keyString = `KARMA-${randBlock()}-${randBlock()}-${randBlock()}`;

  const days = Number(expiresDays) || 30;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);

  const newKey = {
    id: 'ky-' + Math.random().toString(36).substr(2, 9),
    userId: req.user.id,
    scriptId: scriptId,
    scriptName: script.name,
    keyString: keyString,
    hwid: '', // Blank initially, locks on first run
    status: 'active',
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString()
  };

  db.addKey(newKey);
  res.status(201).json(newKey);
});

// Update whitelist key (toggle active/revoked, or reset HWID)
app.put('/api/keys/:id', requireAuth, (req, res) => {
  const keyId = req.params.id;
  const { status, resetHwid } = req.body;

  const key = db.getKeys().find(k => k.id === keyId);
  if (!key || key.userId !== req.user.id) {
    return res.status(404).json({ error: 'Whitelist key not found.' });
  }

  const updates = {};
  if (status) updates.status = status;
  if (resetHwid) updates.hwid = ''; // Clear HWID to allow re-lock

  const updatedKey = db.updateKey(keyId, updates);
  res.json(updatedKey);
});

// Delete key
app.delete('/api/keys/:id', requireAuth, (req, res) => {
  const keyId = req.params.id;
  const key = db.getKeys().find(k => k.id === keyId);
  
  if (!key || key.userId !== req.user.id) {
    return res.status(404).json({ error: 'Key not found.' });
  }

  db.deleteKey(keyId);
  res.json({ success: true, message: 'Key deleted successfully.' });
});


// --- SECURE RAW GATEWAY & ANTI-DUMP SHIELD ---
// ONLY serves script source if request comes from Roblox executor with a valid whitelist key and HWID lock.
app.get('/raw/:id', (req, res) => {
  const scriptId = req.params.id;
  const script = db.getScriptById(scriptId);

  if (!script) {
    res.status(404).setHeader('Content-Type', 'text/plain');
    return res.send('Not Found');
  }

  // Check anti-dump headers
  const userAgent = (req.headers['user-agent'] || '').toLowerCase();
  const isRobloxClient = userAgent.includes('roblox');
  const isExecutor = userAgent.includes('synapse') || 
                     userAgent.includes('wave') || 
                     userAgent.includes('celery') || 
                     userAgent.includes('solara') || 
                     userAgent.includes('delta') || 
                     userAgent.includes('fluxus') || 
                     userAgent.includes('electron') || 
                     userAgent.includes('macsploit') || 
                     userAgent.includes('krnl') || 
                     userAgent.includes('hydra') ||
                     userAgent.includes('executor');

  // Verify whitelist key & HWID parameter
  const keyParam = req.query.key;
  const hwidParam = req.query.hwid || '';

  // Explicit raw bypass for owner/tester query
  const isExplicitRaw = req.query.raw === 'true';

  // If a Discord bot, standard browser, scraper bot, or unauthenticated script calls, return 404 Not Found!
  if (!isRobloxClient && !isExecutor && !isExplicitRaw) {
    res.status(404).setHeader('Content-Type', 'text/plain');
    return res.send('Not Found');
  }

  // If key is required, validate it!
  if (!isExplicitRaw) {
    if (!keyParam) {
      res.status(404).setHeader('Content-Type', 'text/plain');
      return res.send('Not Found'); // Says Not Found to frustrate hackers!
    }

    const whitelistKey = db.getKeyByString(keyParam);
    if (!whitelistKey || whitelistKey.scriptId !== scriptId || whitelistKey.status !== 'active') {
      res.status(404).setHeader('Content-Type', 'text/plain');
      return res.send('Not Found');
    }

    // Check expiration date
    if (new Date(whitelistKey.expiresAt) < new Date()) {
      res.status(404).setHeader('Content-Type', 'text/plain');
      return res.send('Not Found');
    }

    // HWID-lock validation
    if (hwidParam) {
      if (!whitelistKey.hwid) {
        // Lock key to first HWID run!
        db.updateKey(whitelistKey.id, { hwid: hwidParam });
      } else if (whitelistKey.hwid !== hwidParam) {
        // HWID mismatch! Block request with "Not Found" to prevent dumper bots
        res.status(404).setHeader('Content-Type', 'text/plain');
        return res.send('Not Found');
      }
    }
  }

  // Serve verified, un-scrapable script
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(script.code);
});


// --- ADMIN OWNER DASHBOARD API ---

// Get stats
app.get('/api/admin/stats', requireOwner, (req, res) => {
  const users = db.getUsers();
  const scripts = db.getScripts();
  const owners = db.getOwners();
  const referrals = db.getReferrals();

  res.json({
    totalUsers: users.length,
    totalScripts: scripts.length,
    totalOwners: owners.length,
    totalReferrals: referrals.length,
    totalCreditsCirculated: users.reduce((sum, u) => sum + (u.credits || 0), 0)
  });
});

// Get owners list
app.get('/api/admin/owners', requireOwner, (req, res) => {
  const owners = db.getOwners();
  res.json(owners);
});

// Add owner (by email or username)
app.post('/api/admin/owners', requireOwner, (req, res) => {
  const { email, username } = req.body;
  
  if (!email && !username) {
    return res.status(400).json({ error: 'Please provide either an email or username.' });
  }

  const newOwner = db.addOwner(email, username);
  res.status(201).json(newOwner);
});

// Delete owner
app.delete('/api/admin/owners/:id', requireOwner, (req, res) => {
  const ownerId = req.params.id;
  if (ownerId === 'ow-1' || ownerId === 'ow-2') {
    return res.status(400).json({ error: 'Cannot remove base developer accounts.' });
  }

  const success = db.removeOwner(ownerId);
  if (success) {
    res.json({ success: true, message: 'Owner removed successfully.' });
  } else {
    res.status(404).json({ error: 'Owner not found.' });
  }
});

// Get all users
app.get('/api/admin/users', requireOwner, (req, res) => {
  const users = db.getUsers().map(u => ({
    id: u.id,
    email: u.email,
    username: u.username,
    credits: u.credits || 0,
    referredBy: u.referredBy || null,
    createdAt: u.createdAt
  }));
  res.json(users);
});

// Modify user credits
app.post('/api/admin/users/:id/credits', requireOwner, (req, res) => {
  const userId = req.params.id;
  const { credits } = req.body;

  if (credits === undefined || isNaN(credits)) {
    return res.status(400).json({ error: 'Please specify a valid credit amount.' });
  }

  const user = db.getUserById(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const updatedUser = db.updateUser(userId, { credits: Number(credits) });
  res.json({
    id: updatedUser.id,
    username: updatedUser.username,
    credits: updatedUser.credits
  });
});


// Catch-all route to serve index.html for frontend routing
app.get(/.*/, (req, res) => {
  const publicPath = path.join(__dirname, 'public', 'index.html');
  const rootPath = path.join(__dirname, 'index.html');
  
  if (fs.existsSync(publicPath)) {
    res.sendFile(publicPath);
  } else if (fs.existsSync(rootPath)) {
    res.sendFile(rootPath);
  } else {
    res.status(404).send('index.html not found in public/ or root directory.');
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` KARMA LUA HOSTING SERVER RUNNING ON PORT ${PORT}`);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(`=========================================`);
});
