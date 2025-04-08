const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const crypto = require('crypto');

// Initialize the app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  maxHttpBufferSize: 15 * 1024 * 1024 // 15MB max message size for images
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Create uploads directory for images and serve it
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Admin code for admin commands
const ADMIN_CODE = "1744112265930-74887f40cb38a925.jpeg"; // Admin Code

// Message file path
const MESSAGE_FILE = path.join(__dirname, 'messages.json');
const BANNED_FILE = path.join(__dirname, 'banned.json');

// Initialize message file if it doesn't exist
if (!fs.existsSync(MESSAGE_FILE)) {
  fs.writeFileSync(MESSAGE_FILE, JSON.stringify([]));
}

// Initialize banned users file if it doesn't exist
if (!fs.existsSync(BANNED_FILE)) {
  fs.writeFileSync(BANNED_FILE, JSON.stringify([]));
}

// Load existing messages
let chatMessages = [];
try {
  const data = fs.readFileSync(MESSAGE_FILE, 'utf8');
  chatMessages = JSON.parse(data);
} catch (err) {
  console.error('Error loading messages:', err);
  chatMessages = [];
}

// Load banned users
let bannedUsers = [];
try {
  const data = fs.readFileSync(BANNED_FILE, 'utf8');
  bannedUsers = JSON.parse(data);
} catch (err) {
  console.error('Error loading banned users:', err);
  bannedUsers = [];
}

// Active users
let activeUsers = 0;

// Map to store connected users' information
const connectedUsers = new Map(); // Maps socket ID to user info

// Function to save messages to file
function saveMessages() {
  fs.writeFileSync(MESSAGE_FILE, JSON.stringify(chatMessages, null, 2));
}

// Function to save banned users to file
function saveBannedUsers() {
  fs.writeFileSync(BANNED_FILE, JSON.stringify(bannedUsers, null, 2));
}

// Function to check if a user is banned (by IP or username)
function isUserBanned(ip, username) {
  // First check for exact IP match (strongest ban indicator)
  const ipBan = bannedUsers.find(user => user.ip === ip);
  if (ipBan) return ipBan;
  
  // If no IP match, check for username match
  if (username) {
    // For exact username match
    const exactUsernameBan = bannedUsers.find(
      user => user.username.toLowerCase() === username.toLowerCase()
    );
    if (exactUsernameBan) return exactUsernameBan;
    
    // For guest usernames (User1234, etc.)
    if (username.startsWith('User') && /^User\d+$/.test(username)) {
      // Get the user number
      const userNumber = username.substring(4);
      
      // Check if we have a ban for this specific guest user number
      const guestBan = bannedUsers.find(
        user => user.guestNumber && user.guestNumber === userNumber
      );
      if (guestBan) return guestBan;
    }
  }
  
  return null; // Not banned
}

// Function to create backup before clearing
function createBackup() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  const backupFileName = `MessageLog${year}${month}${day}${hours}${minutes}${seconds}.json`;
  const backupFilePath = path.join(__dirname, backupFileName);
  
  fs.writeFileSync(backupFilePath, JSON.stringify(chatMessages, null, 2));
  console.log(`Backup created: ${backupFileName}`);
  
  return backupFileName;
}

// Function to save image from base64 data
function saveImage(imageData) {
  try {
    // Extract the base64 content
    const matches = imageData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    
    if (!matches || matches.length !== 3) {
      console.error('Invalid image data');
      return null;
    }
    
    const type = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    
    // Create a unique filename
    const extension = type.split('/')[1];
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
    const filepath = path.join(UPLOADS_DIR, filename);
    
    // Save the file
    fs.writeFileSync(filepath, buffer);
    console.log(`Image saved: ${filename}`);
    return `/uploads/${filename}`; // Return the path to access the image
  } catch (error) {
    console.error('Error saving image:', error);
    return null;
  }
}

// Function to clean up old image files (older than 7 days)
function cleanupOldImages() {
  console.log("Running scheduled image cleanup task...");
  
  const currentTime = Date.now();
  const sevenDaysAgo = currentTime - (7 * 24 * 60 * 60 * 1000); // 7 days in milliseconds
  
  try {
    fs.readdir(UPLOADS_DIR, (err, files) => {
      if (err) {
        console.error("Error reading uploads directory:", err);
        return;
      }
      
      files.forEach(file => {
        const filePath = path.join(UPLOADS_DIR, file);
        
        // Get file stats
        fs.stat(filePath, (err, stats) => {
          if (err) {
            console.error(`Error checking file stats for ${file}:`, err);
            return;
          }
          
          // Check if file is older than 7 days
          if (stats.mtime.getTime() < sevenDaysAgo) {
            // Remove the file
            fs.unlink(filePath, err => {
              if (err) {
                console.error(`Error deleting file ${file}:`, err);
              } else {
                console.log(`Deleted old image: ${file}`);
              }
            });
          }
        });
      });
    });
    
    // Also clean up image references in messages older than 7 days
    const newMessages = chatMessages.filter(msg => {
      if (msg.date) {
        const msgDate = new Date(msg.date).getTime();
        return msgDate >= sevenDaysAgo || !msg.image; // Keep messages without images or recent ones
      }
      return true; // Keep messages without date (shouldn't happen)
    });
    
    if (newMessages.length !== chatMessages.length) {
      chatMessages = newMessages;
      saveMessages();
      console.log(`Cleaned up ${chatMessages.length - newMessages.length} old message images from records`);
    }
    
  } catch (error) {
    console.error("Error during image cleanup:", error);
  }
}

// Function to handle IP lookups
function handleIPLookup(socket, targetUsername) {
  // Convert the map to an array and find the user
  let targetUser = null;
  for (const [socketId, userInfo] of connectedUsers.entries()) {
    if (userInfo.username && userInfo.username.toLowerCase() === targetUsername.toLowerCase()) {
      targetUser = userInfo;
      break;
    }
  }
  
  if (targetUser) {
    socket.emit('ip lookup result', {
      success: true,
      username: targetUsername,
      ip: targetUser.ip
    });
    console.log(`IP lookup performed for user ${targetUsername} by admin`);
  } else {
    socket.emit('ip lookup result', {
      success: false,
      message: `User '${targetUsername}' not found or not currently connected`
    });
  }
}

// Function to ban a user
function banUser(socket, targetUsername, reason) {
  // Find the user to ban
  let targetUser = null;
  let targetSocketId = null;
  
  for (const [socketId, userInfo] of connectedUsers.entries()) {
    if (userInfo.username && userInfo.username.toLowerCase() === targetUsername.toLowerCase()) {
      targetUser = userInfo;
      targetSocketId = socketId;
      break;
    }
  }
  
  if (targetUser) {
    // Create ban record
    const banRecord = {
      username: targetUsername,
      ip: targetUser.ip,
      reason: reason,
      date: new Date().toISOString()
    };
    
    // If this is a guest user (User1234), store the user number in a specific field
    if (targetUsername.startsWith('User') && /^User\d+$/.test(targetUsername)) {
      banRecord.guestNumber = targetUsername.substring(4);
    }
    
    // Add to banned users list
    const existingBanIndex = bannedUsers.findIndex(
      user => user.ip === targetUser.ip || user.username.toLowerCase() === targetUsername.toLowerCase()
    );
    
    if (existingBanIndex !== -1) {
      bannedUsers[existingBanIndex] = banRecord;
    } else {
      bannedUsers.push(banRecord);
    }
    
    saveBannedUsers();
    
    // Notify the banned user if they're online
    const bannedSocket = io.sockets.sockets.get(targetSocketId);
    if (bannedSocket) {
      bannedSocket.emit('banned', banRecord);
    }
    
    socket.emit('ban result', {
      success: true,
      username: targetUsername,
      reason: reason
    });
    
    // Notify all users about the ban
    io.emit('system message', {
      message: `${targetUsername} has been banned from the chat.`,
      timestamp: new Date().toLocaleTimeString()
    });
    
    console.log(`User ${targetUsername} (IP: ${targetUser.ip}) has been banned. Reason: ${reason}`);
    return true;
  } else {
    socket.emit('ban result', {
      success: false,
      message: `User '${targetUsername}' not found or not currently connected`
    });
    return false;
  }
}

// Function to unban a user
function unbanUser(socket, targetUsername) {
  const initialLength = bannedUsers.length;
  
  // Remove from banned users list
  bannedUsers = bannedUsers.filter(user => 
    user.username.toLowerCase() !== targetUsername.toLowerCase()
  );
  
  if (initialLength !== bannedUsers.length) {
    saveBannedUsers();
    
    socket.emit('unban result', {
      success: true,
      username: targetUsername
    });
    
    // Notify all users about the unban
    io.emit('system message', {
      message: `${targetUsername} has been unbanned from the chat.`,
      timestamp: new Date().toLocaleTimeString()
    });
    
    console.log(`User ${targetUsername} has been unbanned`);
    return true;
  } else {
    socket.emit('unban result', {
      success: false,
      message: `User '${targetUsername}' was not found in the banned users list`
    });
    return false;
  }
}

// Schedule cleanup job to run daily at midnight
cron.schedule('0 0 * * *', () => {
  cleanupOldImages();
});

// Express route to serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.io connection handling
io.on('connection', (socket) => {
  activeUsers++;
  console.log('New user connected. Total active users:', activeUsers);
  
  // Store user's IP address
  const userIP = socket.handshake.headers['x-forwarded-for'] || 
                socket.handshake.address;
                
  connectedUsers.set(socket.id, {
    ip: userIP,
    username: null // Will be updated when they send a message
  });
  
  io.emit('user count', activeUsers);
  
  // Check if user is banned
  socket.on('check ban status', (username) => {
    if (username) {
      connectedUsers.get(socket.id).username = username;
    }
    
    const userInfo = connectedUsers.get(socket.id);
    const banRecord = isUserBanned(userInfo.ip, userInfo.username);
    
    if (banRecord) {
      socket.emit('banned', banRecord);
    } else {
      socket.emit('not banned');
    }
  });
  
  // Update username
  socket.on('update username', (username) => {
    if (username && connectedUsers.has(socket.id)) {
      connectedUsers.get(socket.id).username = username;
      
      // Check if the new username is banned
      const userInfo = connectedUsers.get(socket.id);
      const banRecord = isUserBanned(userInfo.ip, username);
      
      if (banRecord) {
        socket.emit('banned', banRecord);
      }
    }
  });
  
  // Send message history to newly connected user
  socket.emit('message history', chatMessages);
  
  // Handle chat messages
  socket.on('chat message', (msg) => {
    // Update the username in our records
    if (connectedUsers.has(socket.id)) {
      connectedUsers.get(socket.id).username = msg.username;
    }
    
    // Check if user is banned
    const userInfo = connectedUsers.get(socket.id);
    const banRecord = isUserBanned(userInfo.ip, userInfo.username);
    
    if (banRecord) {
      socket.emit('banned', banRecord);
      return;
    }
    
    // Check if message is a command
    if (msg.message && (
      msg.message.startsWith('/clear') || 
      msg.message.startsWith('/ip') ||
      msg.message.startsWith('/ban') ||
      msg.message.startsWith('/unban')
    )) {
      // These are handled on the client side with verification
      return;
    }
    
    // Create message object
    const messageObj = {
      username: msg.username,
      message: msg.message,
      timestamp: new Date().toLocaleTimeString(),
      date: new Date().toISOString()
    };
    
    // Handle image if present
    if (msg.image) {
      const imagePath = saveImage(msg.image);
      if (imagePath) {
        messageObj.image = imagePath;
      }
    }
    
    // Add message to array and save to file
    chatMessages.push(messageObj);
    saveMessages();
    
    // Broadcast message to all clients
    io.emit('chat message', messageObj);
  });
  
  // Handle admin verification
  socket.on('verify admin', (data) => {
    if (data.code === ADMIN_CODE) {
      socket.emit('admin verified', { 
        verified: true,
        action: data.action
      });
      
      // Handle specific admin actions
      if (data.action === 'ip' && data.targetUsername) {
        handleIPLookup(socket, data.targetUsername);
      } else if (data.action === 'ban' && data.targetUsername) {
        banUser(socket, data.targetUsername, data.reason);
      } else if (data.action === 'unban' && data.targetUsername) {
        unbanUser(socket, data.targetUsername);
      }
    } else {
      socket.emit('admin verified', { 
        verified: false,
        action: data.action
      });
    }
  });
  
  // Handle clear messages command
  socket.on('clear messages', () => {
    // Create backup
    const backupFile = createBackup();
    
    // Clear messages
    chatMessages = [];
    saveMessages();
    
    // Notify all clients to clear messages
    io.emit('clear chat');
    io.emit('system message', {
      message: `Chat has been cleared by an admin. A backup was created: ${backupFile}`,
      timestamp: new Date().toLocaleTimeString()
    });
    
    console.log(`Chat cleared by admin. Backup created: ${backupFile}`);
  });
  
  // Handle user typing
  socket.on('typing', (username) => {
    // Check if user is banned before broadcasting typing status
    const userInfo = connectedUsers.get(socket.id);
    if (userInfo && !isUserBanned(userInfo.ip, userInfo.username)) {
      socket.broadcast.emit('user typing', username);
    }
  });
  
  // Handle user stopped typing
  socket.on('stop typing', () => {
    socket.broadcast.emit('user stop typing');
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    activeUsers--;
    // Remove user from connected users map
    connectedUsers.delete(socket.id);
    console.log('User disconnected. Total active users:', activeUsers);
    io.emit('user count', activeUsers);
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
