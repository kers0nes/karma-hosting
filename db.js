const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');

// Initialize empty DB if not exists
if (!fs.existsSync(DB_FILE)) {
  const initialData = {
    users: [],
    scripts: [],
    owners: [
      { id: 'ow-1', email: 'owner@karmaforges.com', username: 'owner', createdAt: new Date().toISOString() },
      { id: 'ow-2', email: 'admin@karmaforges.com', username: 'admin', createdAt: new Date().toISOString() }
    ],
    referrals: [],
    keys: [] // Add whitelisting keys collection
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), 'utf8');
}

class JSONDatabase {
  constructor() {
    this.filePath = DB_FILE;
  }

  read() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      console.error('Error reading DB:', e);
      return { users: [], scripts: [], owners: [], referrals: [], keys: [] };
    }
  }

  write(data) {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error('Error writing DB:', e);
      return false;
    }
  }

  // --- Users Table Operations ---
  getUsers() {
    return this.read().users;
  }

  getUserById(id) {
    return this.getUsers().find(u => u.id === id);
  }

  getUserByEmail(email) {
    if (!email) return null;
    return this.getUsers().find(u => u.email.toLowerCase() === email.toLowerCase());
  }

  getUserByUsername(username) {
    if (!username) return null;
    return this.getUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
  }

  getUserByDiscordId(discordId) {
    if (!discordId) return null;
    return this.getUsers().find(u => u.discordId === discordId);
  }

  addUser(user) {
    const db = this.read();
    db.users.push(user);
    this.write(db);
    return user;
  }

  updateUser(id, updates) {
    const db = this.read();
    const index = db.users.findIndex(u => u.id === id);
    if (index !== -1) {
      db.users[index] = { ...db.users[index], ...updates };
      this.write(db);
      return db.users[index];
    }
    return null;
  }

  // --- Scripts Table Operations ---
  getScripts() {
    return this.read().scripts;
  }

  getScriptById(id) {
    return this.getScripts().find(s => s.id === id);
  }

  getScriptsByUserId(userId) {
    return this.getScripts().filter(s => s.userId === userId);
  }

  addScript(script) {
    const db = this.read();
    db.scripts.push(script);
    this.write(db);
    return script;
  }

  updateScript(id, updates) {
    const db = this.read();
    const index = db.scripts.findIndex(s => s.id === id);
    if (index !== -1) {
      db.scripts[index] = { ...db.scripts[index], ...updates };
      this.write(db);
      return db.scripts[index];
    }
    return null;
  }

  deleteScript(id) {
    const db = this.read();
    const index = db.scripts.findIndex(s => s.id === id);
    if (index !== -1) {
      db.scripts.splice(index, 1);
      this.write(db);
      return true;
    }
    return false;
  }

  // --- Whitelist Keys Table Operations ---
  getKeys() {
    const db = this.read();
    return db.keys || [];
  }

  getKeysByUserId(userId) {
    return this.getKeys().filter(k => k.userId === userId);
  }

  getKeyByString(keyString) {
    return this.getKeys().find(k => k.keyString === keyString);
  }

  addKey(key) {
    const db = this.read();
    if (!db.keys) db.keys = [];
    db.keys.push(key);
    this.write(db);
    return key;
  }

  updateKey(id, updates) {
    const db = this.read();
    const index = db.keys.findIndex(k => k.id === id);
    if (index !== -1) {
      db.keys[index] = { ...db.keys[index], ...updates };
      this.write(db);
      return db.keys[index];
    }
    return null;
  }

  deleteKey(id) {
    const db = this.read();
    const index = db.keys.findIndex(k => k.id === id);
    if (index !== -1) {
      db.keys.splice(index, 1);
      this.write(db);
      return true;
    }
    return false;
  }

  // --- Owners Table Operations ---
  getOwners() {
    return this.read().owners;
  }

  addOwner(email, username) {
    const db = this.read();
    const cleanEmail = email ? email.toLowerCase() : null;
    const cleanUsername = username ? username.toLowerCase() : null;

    const exists = db.owners.find(o => 
      (cleanEmail && o.email === cleanEmail) || 
      (cleanUsername && o.username === cleanUsername)
    );

    if (exists) return exists;

    const newOwner = {
      id: 'ow-' + Math.random().toString(36).substr(2, 9),
      email: cleanEmail,
      username: cleanUsername,
      createdAt: new Date().toISOString()
    };

    db.owners.push(newOwner);
    this.write(db);
    return newOwner;
  }

  removeOwner(id) {
    const db = this.read();
    const index = db.owners.findIndex(o => o.id === id);
    if (index !== -1) {
      db.owners.splice(index, 1);
      this.write(db);
      return true;
    }
    return false;
  }

  isUserOwner(email, username) {
    const db = this.read();
    const cleanEmail = email ? email.toLowerCase() : null;
    const cleanUsername = username ? username.toLowerCase() : null;

    return db.owners.some(o => 
      (cleanEmail && o.email === cleanEmail) || 
      (cleanUsername && o.username === cleanUsername)
    );
  }

  // --- Referrals Table Operations ---
  getReferrals() {
    return this.read().referrals;
  }

  addReferral(referral) {
    const db = this.read();
    db.referrals.push(referral);
    this.write(db);
    return referral;
  }
}

module.exports = new JSONDatabase();
