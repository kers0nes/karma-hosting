const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { obfuscateScript } = require('./obfuscator');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for frontend hosting domains (like Cloudflare Pages)
app.use(cors({
  origin: true, // Allow any origin, or specify pages.dev domains
  credentials: true
}));

app.use(express.json());
app.use(cookieParser('karmaforges_secret_session_token_123'));
app.use(express.urlencoded({ extended: true }));

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Helper: Get logged-in user from session/cookie or Authorization header
function getSessionUser(req) {
  let token = null;
  
  // 1. Check Authorization Header (Bearer Token) - Crucial for separate cross-domain frontend hosting
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

// --- REFERRAL & INVITE ROUTE ---
// When someone visits /invite/:username or /ref/:username
app.get('/invite/:username', (req, res) => {
  const referrerUsername = req.params.username;
  const referrer = db.getUserByUsername(referrerUsername);
  
  if (referrer) {
    // Set cookie with referrer's username, expires in 30 days
    res.cookie('referred_by', referrer.username, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: false });
  }
  // Redirect to homepage/signup page
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
      credits: user.credits,
      isOwner: isOwner
    }
  });
});

// Sign Up
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

    // Check if user already exists
    const existingEmail = db.getUserByEmail(email);
    if (existingEmail) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const existingUsername = db.getUserByUsername(username);
    if (existingUsername) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Initial credits
    let userCredits = 0;
    let referredByUser = null;

    // Check referral (either passed in request or from cookie)
    const activeRefCode = referralCode || req.cookies.referred_by;
    if (activeRefCode) {
      referredByUser = db.getUserByUsername(activeRefCode);
    }

    if (referredByUser) {
      userCredits = 50; // New user gets 50 bonus credits!
    }

    // Create new user
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

    // If referred, award points to referrer
    if (referredByUser) {
      const updatedReferrerCredits = (referredByUser.credits || 0) + 100; // Referrer gets 100 credits!
      db.updateUser(referredByUser.id, { credits: updatedReferrerCredits });

      // Record referral
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

    // Clear referred_by cookie after successful signup
    res.clearCookie('referred_by');

    // Automatically sign in (set session cookie and return token)
    res.cookie('auth_token', newUser.id, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true });

    const isOwner = db.isUserOwner(newUser.email, newUser.username);

    res.status(201).json({
      success: true,
      token: newUser.id, // Return token for static cross-domain clients (Cloudflare Pages)
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
    res.status(500).json({ error: 'Server error during sign up. Please try again.' });
  }
});

// Sign In
app.post('/api/auth/signin', async (req, res) => {
  try {
    const { loginIdentifier, password } = req.body; // loginIdentifier can be email or username
    
    if (!loginIdentifier || !password) {
      return res.status(400).json({ error: 'Please enter all fields.' });
    }

    // Try finding user by email or username
    let user = db.getUserByEmail(loginIdentifier);
    if (!user) {
      user = db.getUserByUsername(loginIdentifier);
    }

    if (!user) {
      return res.status(400).json({ error: 'Invalid email/username or password.' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email/username or password.' });
    }

    // Set session cookie
    res.cookie('auth_token', user.id, { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true });

    const isOwner = db.isUserOwner(user.email, user.username);

    res.json({
      success: true,
      token: user.id, // Return token for static cross-domain clients (Cloudflare Pages)
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
    const { name, description, code, enableObfuscate } = req.body;

    if (!name || !code) {
      return res.status(400).json({ error: 'Script name and code are required.' });
    }

    // Check script storage limit (like 20 scripts)
    const userScripts = db.getScriptsByUserId(req.user.id);
    if (userScripts.length >= 20) {
      return res.status(400).json({ error: 'Script storage limit reached (Max 20 scripts). Please upgrade or delete existing scripts.' });
    }

    let finalObfuscatedCode = '';
    const isObfuscated = !!enableObfuscate;

    if (isObfuscated) {
      finalObfuscatedCode = await obfuscateScript(code);
    }

    const newScript = {
      id: 'sc-' + Math.random().toString(36).substr(2, 9),
      userId: req.user.id,
      name: name,
      description: description || '',
      code: code,
      obfuscatedCode: finalObfuscatedCode,
      obfuscated: isObfuscated,
      createdAt: new Date().toISOString()
    };

    db.addScript(newScript);

    res.status(201).json(newScript);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save or obfuscate script.' });
  }
});

// Edit Script
app.put('/api/scripts/:id', requireAuth, async (req, res) => {
  try {
    const scriptId = req.params.id;
    const { name, description, code, enableObfuscate } = req.body;

    const script = db.getScriptById(scriptId);
    if (!script || script.userId !== req.user.id) {
      return res.status(404).json({ error: 'Script not found.' });
    }

    const updates = {};
    if (name) updates.name = name;
    if (description !== undefined) updates.description = description;
    
    if (code !== undefined) {
      updates.code = code;
      // Re-obfuscate if toggled or currently obfuscated
      const isObfuscated = enableObfuscate !== undefined ? !!enableObfuscate : script.obfuscated;
      updates.obfuscated = isObfuscated;
      
      if (isObfuscated) {
        updates.obfuscatedCode = await obfuscateScript(code);
      } else {
        updates.obfuscatedCode = '';
      }
    } else if (enableObfuscate !== undefined) {
      updates.obfuscated = !!enableObfuscate;
      if (updates.obfuscated) {
        updates.obfuscatedCode = await obfuscateScript(script.code);
      } else {
        updates.obfuscatedCode = '';
      }
    }

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

  db.deleteScript(scriptId);
  res.json({ success: true, message: 'Script deleted successfully.' });
});


// --- DIRECT RAW LINK HANDLER & REDIRECT ---
// Secure raw access: Roblox clients get raw code, web browsers are redirected to the homepage
app.get('/raw/:id', (req, res) => {
  const scriptId = req.params.id;
  const script = db.getScriptById(scriptId);

  if (!script) {
    return res.status(404).send('Script not found.');
  }

  // Identify User-Agent
  const userAgent = req.headers['user-agent'] || '';
  const isRoblox = userAgent.toLowerCase().includes('roblox');
  const isCurlWget = userAgent.toLowerCase().includes('curl') || userAgent.toLowerCase().includes('wget');
  const isExplicitRaw = req.query.raw === 'true';

  // If unauthorized web browser accesses the raw link, redirect them to main page
  const isWebBrowser = userAgent.toLowerCase().includes('mozilla') || 
                      userAgent.toLowerCase().includes('chrome') || 
                      userAgent.toLowerCase().includes('safari') || 
                      userAgent.toLowerCase().includes('edge');

  if (isWebBrowser && !isRoblox && !isCurlWget && !isExplicitRaw) {
    return res.redirect('/');
  }

  // Set appropriate text/plain header for script executors
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  // Return obfuscated code if script is obfuscated, otherwise raw code
  if (script.obfuscated && script.obfuscatedCode) {
    res.send(script.obfuscatedCode);
  } else {
    res.send(script.code);
  }
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
    return res.status(400).json({ error: 'Please provide either an email or username to add to owners.' });
  }

  const newOwner = db.addOwner(email, username);
  res.status(201).json(newOwner);
});

// Delete owner
app.delete('/api/admin/owners/:id', requireOwner, (req, res) => {
  const ownerId = req.params.id;
  
  // Prevent deleting the super owner accounts (ow-1 and ow-2) to avoid lockout
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

// Get all users (for management)
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
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` KARMAFORGES SERVER RUNNING ON PORT ${PORT}`);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(`=========================================`);
});
