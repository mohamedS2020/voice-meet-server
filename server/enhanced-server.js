const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const multer = require('multer');

const PORT = process.env.PORT || 8080;
const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration for production
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
  process.env.FRONTEND_URL, // Will be set to your Vercel domain
  // Add your Vercel domain here when you get it
  'https://your-app-name.vercel.app'
];

const io = socketIo(server, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.includes(origin) || origin.includes('vercel.app')) {
        callback(null, true);
      } else {
        console.log(`🚫 Blocked CORS request from: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Enhanced CORS middleware for HTTP requests
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin) || (origin && origin.includes('vercel.app'))) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Store room, video state, microphone states, and active streams
const rooms = {};
const videoStates = {};
const micStates = {}; // Track microphone states: { roomId: { userName: boolean } }
const activeStreams = {}; // Track active file streams: { roomId: Set<ReadStream> } // { roomId: { filePath, isPlaying, currentTime, host } }

console.log(`🎬 Enhanced Movie Party Server starting on http://localhost:${PORT}`);


// API Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Voice Meet Server is running',
    timestamp: new Date().toISOString(),
    activeRooms: Object.keys(rooms).length,
    activeVideoStates: Object.keys(videoStates).length
  });
});

// API status endpoint
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'running',
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    activeConnections: Object.keys(rooms).reduce((total, room) => total + rooms[room].length, 0)
  });
});

// Configure multer for video file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const roomId = req.body.roomId || 'default';
    const ext = path.extname(file.originalname);
    cb(null, `movie-${roomId}-${Date.now()}${ext}`);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Accept video files only
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024 // 2GB limit
  }
});

// Video upload endpoint
app.post('/upload-video', upload.single('video'), (req, res) => {
  try {
    const { roomId, hostName } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    console.log(`📹 Video uploaded for room ${roomId} by ${hostName}`);
    
    // Store video state
    videoStates[roomId] = {
      filePath: req.file.path,
      fileName: req.file.originalname,
      isPlaying: false,
      currentTime: 0,
      host: hostName,
      uploadTime: Date.now(),
      lastUpdateTime: Date.now() // CRITICAL: Track when state was last updated
    };

    // Notify all clients in the room about new video
    io.to(roomId).emit('video-uploaded', {
      fileName: req.file.originalname,
      host: hostName
    });

    res.json({ 
      success: true, 
      fileName: req.file.originalname,
      message: 'Video uploaded successfully' 
    });
  } catch (error) {
    console.error('Video upload error:', error);
    res.status(500).json({ error: 'Failed to upload video' });
  }
});

// Video streaming endpoint with Range Request support and proper stream cleanup
app.get('/movie/:roomId', (req, res) => {
  // Add CORS headers for video streaming
  res.header('Access-Control-Allow-Origin', 'http://localhost:3000');
  res.header('Access-Control-Allow-Credentials', 'true');
  const { roomId } = req.params;
  const videoState = videoStates[roomId];

  if (!videoState || !videoState.filePath) {
    return res.status(404).json({ error: 'No video found for this room' });
  }

  const videoPath = videoState.filePath;
  
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video file not found' });
  }

  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  console.log(`🎥 Streaming video for room ${roomId}, range: ${range || 'full'}`);

  if (range) {
    // Handle Range Requests for video streaming
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    
    const file = fs.createReadStream(videoPath, { start, end });
    
    // Track this stream for cleanup
    if (!activeStreams[roomId]) {
      activeStreams[roomId] = new Set();
    }
    activeStreams[roomId].add(file);
    
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mime.lookup(videoPath) || 'video/mp4',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range'
    };
    
    res.writeHead(206, head);
    
    // Properly handle stream cleanup
    const cleanupStream = () => {
      if (activeStreams[roomId]) {
        activeStreams[roomId].delete(file);
      }
      file.destroy();
    };
    
    file.on('error', (err) => {
      console.error(`❌ Stream error: ${err.message}`);
      cleanupStream();
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    
    file.on('end', () => {
      cleanupStream();
    });
    
    res.on('close', () => {
      cleanupStream();
    });
    
    file.pipe(res);
  } else {
    // Send full file
    const file = fs.createReadStream(videoPath);
    
    // Track this stream for cleanup
    if (!activeStreams[roomId]) {
      activeStreams[roomId] = new Set();
    }
    activeStreams[roomId].add(file);
    
    const head = {
      'Content-Length': fileSize,
      'Content-Type': mime.lookup(videoPath) || 'video/mp4',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range'
    };
    
    res.writeHead(200, head);
    
    // Properly handle stream cleanup
    const cleanupStream = () => {
      if (activeStreams[roomId]) {
        activeStreams[roomId].delete(file);
      }
      file.destroy();
    };
    
    file.on('error', (err) => {
      console.error(`❌ Stream error: ${err.message}`);
      cleanupStream();
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    
    file.on('end', () => {
      cleanupStream();
    });
    
    res.on('close', () => {
      cleanupStream();
    });
    
    file.pipe(res);
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('🔌 New Socket.IO connection:', socket.id);
  let roomId, userName;

  // Join room (upgraded from WebSocket)
  socket.on('join', (data) => {
    roomId = data.roomId;
    userName = data.name;
    
    console.log(`👤 ${userName} joined room ${roomId}`);
    
    // Join the Socket.IO room
    socket.join(roomId);
    
    // Initialize room if it doesn't exist
    if (!rooms[roomId]) {
      rooms[roomId] = [];
    }
    
    // Initialize microphone states for room if it doesn't exist
    if (!micStates[roomId]) {
      micStates[roomId] = {};
    }
    
    // Set default mic state for new user (unmuted by default)
    micStates[roomId][userName] = false; // false = unmuted, true = muted
    
    // Get existing participants
    const existingParticipants = rooms[roomId].map(client => client.userName);
    
    // Add user to room
    rooms[roomId].push({ socketId: socket.id, userName, isHost: data.isHost });
    
    // Send existing participants to new user
    existingParticipants.forEach(existingName => {
      socket.emit('existing-peer', { name: existingName });
    });
    
    // Send current microphone states of existing users to new joiner
    for (const [existingUserName, isMuted] of Object.entries(micStates[roomId])) {
      if (existingUserName !== userName) { // Don't send their own state
        socket.emit('mic-status', {
          name: existingUserName,
          muted: isMuted
        });
      }
    }
    
    // Notify others about new participant
    socket.to(roomId).emit('new-peer', { name: userName });
    
    // Send current video state if exists
    if (videoStates[roomId]) {
      socket.emit('video-state-sync', {
        hasVideo: true,
        fileName: videoStates[roomId].fileName,
        isPlaying: videoStates[roomId].isPlaying,
        currentTime: videoStates[roomId].currentTime,
        host: videoStates[roomId].host
      });
    }
  });

  // Handle WebRTC signaling (backward compatible)
  socket.on('signal', (data) => {
    console.log(`📡 Forwarding WebRTC signal from ${userName}`);
    if (data.to) {
      const targetClient = rooms[roomId]?.find(client => client.userName === data.to);
      if (targetClient) {
        io.to(targetClient.socketId).emit('signal', {
          from: userName,
          signal: data.signal
        });
      }
    } else {
      socket.to(roomId).emit('signal', {
        from: userName,
        signal: data.signal
      });
    }
  });

  // Movie Party Controls
  socket.on('movie-play', (data) => {
    console.log(`▶️ ${userName} played video in room ${roomId}`);
    if (videoStates[roomId] && videoStates[roomId].host === userName) {
      videoStates[roomId].isPlaying = true;
      videoStates[roomId].currentTime = data.currentTime || 0;
      videoStates[roomId].lastUpdateTime = Date.now(); // CRITICAL: Track update time
      
      socket.to(roomId).emit('movie-play', {
        currentTime: data.currentTime,
        timestamp: Date.now()
      });
    }
  });

  socket.on('movie-pause', (data) => {
    console.log(`⏸️ ${userName} paused video in room ${roomId}`);
    if (videoStates[roomId] && videoStates[roomId].host === userName) {
      videoStates[roomId].isPlaying = false;
      videoStates[roomId].currentTime = data.currentTime || 0;
      videoStates[roomId].lastUpdateTime = Date.now(); // CRITICAL: Track update time
      
      socket.to(roomId).emit('movie-pause', {
        currentTime: data.currentTime,
        timestamp: Date.now()
      });
    }
  });

  socket.on('movie-seek', (data) => {
    console.log(`⏩ ${userName} seeked video to ${data.currentTime}s in room ${roomId}`);
    if (videoStates[roomId] && videoStates[roomId].host === userName) {
      videoStates[roomId].currentTime = data.currentTime || 0;
      videoStates[roomId].lastUpdateTime = Date.now(); // CRITICAL: Track update time
      
      socket.to(roomId).emit('movie-seek', {
        currentTime: data.currentTime,
        timestamp: Date.now()
      });
    }
  });

  // CRITICAL: Handle movie audio state for enhanced echo cancellation
  socket.on('movie-audio-state', (data) => {
    const { roomId, isPlaying, host } = data;
    console.log(`🎬 Movie audio state change in room ${roomId}: ${isPlaying ? 'playing' : 'stopped'} by ${host}`);
    
    // Broadcast to all other participants in the room (except the host)
    socket.to(roomId).emit('movie-audio-state', {
      isPlaying,
      host
    });
  });

  // ENHANCED: Request current video state with better timing and logging
  socket.on('request-video-state', (data) => {
    const requestingUser = data?.userName || userName;
    const requestingRoom = data?.roomId || roomId;
    
    console.log(`🔄 Video state requested by ${requestingUser} in room ${requestingRoom}`);
    
    if (videoStates[requestingRoom]) {
      const currentState = videoStates[requestingRoom];
      
      // CRITICAL: Calculate accurate current time for playing videos
      let adjustedCurrentTime = currentState.currentTime;
      if (currentState.isPlaying && currentState.lastUpdateTime) {
        const timeSinceUpdate = (Date.now() - currentState.lastUpdateTime) / 1000;
        adjustedCurrentTime = currentState.currentTime + timeSinceUpdate;
      }
      
      const stateData = {
        hasVideo: true,
        fileName: currentState.fileName,
        isPlaying: currentState.isPlaying,
        currentTime: adjustedCurrentTime,
        host: currentState.host
      };
      
      console.log(`📤 Sending state sync to ${requestingUser}:`, stateData);
      socket.emit('video-state-sync', stateData);
    } else {
      console.log(`ℹ️ No video state found for room ${requestingRoom}`);
      socket.emit('video-state-sync', {
        hasVideo: false,
        fileName: null,
        isPlaying: false,
        currentTime: 0,
        host: null
      });
    }
  });

  // Emoji handling (backward compatible)
  socket.on('emoji', (data) => {
    console.log(`😊 ${userName} sent emoji: ${data.emoji}`);
    socket.to(roomId).emit('emoji', {
      from: userName,
      emoji: data.emoji
    });
  });

  // Mic status (with state tracking)
  socket.on('mic-status', (data) => {
    console.log(`🎤 ${userName} mic status: ${data.muted ? 'muted' : 'unmuted'}`);
    
    // Update the stored mic state for this user
    if (micStates[roomId]) {
      micStates[roomId][userName] = data.muted;
    }
    
    // Broadcast to other users in the room
    socket.to(roomId).emit('mic-status', {
      name: userName,
      muted: data.muted
    });
  });

  // CRITICAL: Handle host stopping movie party (cleanup video file)
  socket.on('stop-movie-party', (data) => {
    const { roomId, host } = data;
    console.log(`🛑 Host ${host} stopped movie party in room ${roomId}`);
    
    // Verify the user is actually the host
    if (videoStates[roomId] && videoStates[roomId].host === host && userName === host) {
      const videoPath = videoStates[roomId].filePath;
      
      // Clean up video file with retry logic for file locks
      if (fs.existsSync(videoPath)) {
        setTimeout(() => {
          try {
            fs.unlinkSync(videoPath);
            console.log(`🗑️ Cleaned up video file: ${videoPath}`);
          } catch (error) {
            if (error.code === 'EPERM' || error.code === 'EBUSY') {
              console.log(`⏳ Video file is locked, scheduling retry cleanup`);
              setTimeout(() => {
                try {
                  fs.unlinkSync(videoPath);
                  console.log(`🗑️ Retry successful: cleaned up ${videoPath}`);
                } catch (retryError) {
                  console.log(`⚠️ Video file cleanup will be handled by periodic cleanup: ${retryError.message}`);
                }
              }, 5000);
            } else {
              console.error(`❌ Error deleting video file: ${error.message}`);
            }
          }
        }, 1000);
      }
      
      // Clean up video state
      delete videoStates[roomId];
      console.log(`🧹 Video state cleared for room ${roomId}`);
      
      // Force close all active streams to release file handles
      closeActiveStreams(roomId);
      
      // Notify all participants that movie party ended
      io.to(roomId).emit('movie-party-ended', {
        host: host,
        message: 'Movie party has ended'
      });
    } else {
      console.log(`⚠️ Unauthorized attempt to stop movie party by ${userName} in room ${roomId}`);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`👋 ${userName} left room ${roomId}`);
    
    // CRITICAL: Check if disconnecting user was the movie party host
    let wasHost = false;
    if (videoStates[roomId] && videoStates[roomId].host === userName) {
      wasHost = true;
      console.log(`🎬 Movie party host ${userName} disconnected from room ${roomId}`);
    }
    
    if (rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter(client => client.socketId !== socket.id);
      
      // Clean up microphone state for this user
      if (micStates[roomId]) {
        delete micStates[roomId][userName];
        console.log(`🎤 Cleaned up mic state for ${userName}`);
      }
      
      // Notify others about disconnection
      socket.to(roomId).emit('peer-left', { name: userName });
      
      // CRITICAL: If host disconnected, clean up movie party and notify participants
      if (wasHost && videoStates[roomId]) {
        const videoPath = videoStates[roomId].filePath;
        
        // Clean up video file
        if (fs.existsSync(videoPath)) {
          try {
            fs.unlinkSync(videoPath);
            console.log(`🗑️ Cleaned up video file after host disconnect: ${videoPath}`);
          } catch (error) {
            console.error(`❌ Error deleting video file: ${error.message}`);
          }
        }
        
        // Notify participants that movie party ended due to host leaving
        socket.to(roomId).emit('movie-party-ended', {
          host: userName,
          message: 'Movie party ended - host disconnected'
        });
        
        delete videoStates[roomId];
        console.log(`🧹 Video state cleared after host disconnect for room ${roomId}`);
        
        // Force close all active streams to release file handles
        closeActiveStreams(roomId);
        
        // Immediate cleanup of orphaned files
        cleanupOrphanedVideos();
      }
      
      // Clean up empty rooms and remaining video/mic states
      if (rooms[roomId].length === 0) {
        delete rooms[roomId];
        
        // Clean up microphone states for the room
        if (micStates[roomId]) {
          delete micStates[roomId];
          console.log(`🎤 Cleaned up all mic states for room ${roomId}`);
        }
        
        // Clean up any remaining video file and state (fallback)
        if (videoStates[roomId]) {
          const videoPath = videoStates[roomId].filePath;
          if (fs.existsSync(videoPath)) {
            fs.unlinkSync(videoPath);
            console.log(`🗑️ Cleaned up video file for empty room ${roomId}`);
          }
          delete videoStates[roomId];
        }
        
        // Force close any remaining streams for this room
        closeActiveStreams(roomId);
        
        // Final cleanup of any orphaned files
        cleanupOrphanedVideos();
        
        console.log(`🧹 Room ${roomId} deleted (empty)`);
      }
    }
  });
});

// Error handling
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 2GB.' });
    }
  }
  res.status(500).json({ error: error.message });
});

// CRITICAL: Force close all active streams for a room to release file handles
function closeActiveStreams(roomId) {
  if (activeStreams[roomId] && activeStreams[roomId].size > 0) {
    console.log(`🔒 Closing ${activeStreams[roomId].size} active streams for room ${roomId}`);
    for (const stream of activeStreams[roomId]) {
      try {
        stream.destroy();
      } catch (error) {
        console.error(`❌ Error closing stream: ${error.message}`);
      }
    }
    activeStreams[roomId].clear();
    delete activeStreams[roomId];
  }
}

// CRITICAL: Immediate cleanup function for orphaned files (with delay to avoid locks)
function cleanupOrphanedVideos(delay = 2000) {
  setTimeout(() => {
    const uploadsDir = path.join(__dirname, 'uploads');
    
    if (!fs.existsSync(uploadsDir)) return;
    
    try {
      const files = fs.readdirSync(uploadsDir);
      const activeFilePaths = Object.values(videoStates).map(state => state.filePath);
      
      files.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        
        // If file is not referenced by any active video state, delete it
        if (!activeFilePaths.includes(filePath)) {
          try {
            // Additional check if file is still locked
            const fd = fs.openSync(filePath, 'r+');
            fs.closeSync(fd);
            
            // If we can open it, it's safe to delete
            fs.unlinkSync(filePath);
            console.log(`🗑️ Successfully cleaned up orphaned video file: ${file}`);
          } catch (error) {
            if (error.code === 'EPERM' || error.code === 'EBUSY') {
              console.log(`⏳ File ${file} is still in use, will retry later`);
              // Retry after another delay
              setTimeout(() => {
                try {
                  fs.unlinkSync(filePath);
                  console.log(`🗑️ Retry successful: cleaned up ${file}`);
                } catch (retryError) {
                  console.log(`⚠️ File ${file} cleanup will be handled by periodic cleanup`);
                }
              }, 5000);
            } else {
              console.error(`❌ Error deleting orphaned file: ${error.message}`);
            }
          }
        }
      });
    } catch (error) {
      console.error(`❌ Error during orphaned file cleanup: ${error.message}`);
    }
  }, delay);
}

// CRITICAL: Enhanced cleanup system for orphaned video files
setInterval(() => {
  const uploadsDir = path.join(__dirname, 'uploads');
  
  if (fs.existsSync(uploadsDir)) {
    fs.readdir(uploadsDir, (err, files) => {
      if (err) return;
      
      files.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        
        try {
          const stat = fs.statSync(filePath);
          const fileAge = Date.now() - stat.mtime.getTime();
          
          // Check if file is referenced in any active video state
          const isInUse = Object.values(videoStates).some(state => 
            state.filePath === filePath
          );
          
          // Delete files that are either:
          // 1. Older than 1 hour and not in use, OR
          // 2. Older than 10 minutes and no active video states exist
          const shouldDelete = (!isInUse && fileAge > 60 * 60 * 1000) || // 1 hour if not in use
                              (Object.keys(videoStates).length === 0 && fileAge > 10 * 60 * 1000); // 10 minutes if no active states
          
          if (shouldDelete) {
            try {
              // Check if file is locked before deletion
              const fd = fs.openSync(filePath, 'r+');
              fs.closeSync(fd);
              
              // File is not locked, safe to delete
              fs.unlinkSync(filePath);
              console.log(`🧹 Cleaned up orphaned video file: ${file} (age: ${Math.round(fileAge / 60000)} minutes)`);
            } catch (deleteError) {
              if (deleteError.code === 'EPERM' || deleteError.code === 'EBUSY') {
                console.log(`⏳ File ${file} is locked, skipping for now`);
              } else {
                console.error(`❌ Error processing file ${file}: ${deleteError.message}`);
              }
            }
          }
        } catch (error) {
          console.error(`❌ Error processing file ${file}: ${error.message}`);
        }
      });
    });
  }
}, 5 * 60 * 1000); // Run every 5 minutes for more aggressive cleanup

server.listen(PORT, () => {
  console.log(`🎬 Enhanced Movie Party Server running on http://localhost:${PORT}`);
  console.log(`📁 Video uploads stored in: ${path.join(__dirname, 'uploads')}`);
  cleanupOrphanedVideos(); // Initial cleanup on startup
});
