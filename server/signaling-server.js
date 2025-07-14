const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
const rooms = {};

console.log(`Signaling server starting on ws://localhost:${PORT}`);

wss.on('connection', ws => {
  console.log('New WebSocket connection');
  let roomId, name;

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
      console.log('Received message:', data);

      switch(data.type) {
        case 'join':
          roomId = data.roomId;
          name = data.name;
          
          // Get existing participants before adding new one
          const existingParticipants = (rooms[roomId] || [])
            .map(client => client.userName)
            .filter(userName => userName); // Filter out undefined names
          
          rooms[roomId] = rooms[roomId] || [];
          
          // Store the user name on the WebSocket connection
          ws.userName = name;
          
          rooms[roomId].push(ws);
          
          console.log(`${name} joined room ${roomId}. Room now has ${rooms[roomId].length} participants.`);
          console.log('Existing participants:', existingParticipants);

          // Send existing participants to the new joiner
          existingParticipants.forEach(existingName => {
            ws.send(JSON.stringify({ 
              type: 'existing-peer', 
              name: existingName 
            }));
          });

          // Notify ALL participants (including existing ones) about the new peer
          // This ensures everyone knows about everyone else
          rooms[roomId].forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'new-peer', name }));
            }
          });
          
          // Also send a signal to trigger cross-connections between existing peers
          if (existingParticipants.length >= 2) {
            // When C joins and A,B already exist, make sure B knows about A (and vice versa)
            existingParticipants.forEach(peer1 => {
              existingParticipants.forEach(peer2 => {
                if (peer1 !== peer2) {
                  const client1 = rooms[roomId].find(c => c.userName === peer1);
                  if (client1 && client1.readyState === WebSocket.OPEN) {
                    client1.send(JSON.stringify({
                      type: 'refresh-peer',
                      name: peer2
                    }));
                  }
                }
              });
            });
          }
          break;

        case 'signal':
          console.log(`Forwarding WebRTC signal from ${name} in room ${roomId}`);
          if (data.to) {
            // Targeted signal to specific peer
            const targetClient = rooms[roomId]?.find(client => client.userName === data.to);
            if (targetClient && targetClient.readyState === WebSocket.OPEN) {
              targetClient.send(JSON.stringify({
                type: 'signal',
                from: name,
                signal: data.signal,
              }));
            } else {
              console.log(`Target peer ${data.to} not found or not connected`);
            }
          } else {
            // Broadcast to all peers (fallback)
            (rooms[roomId] || []).forEach(client => {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: 'signal',
                  from: name,
                  signal: data.signal,
                }));
              }
            });
          }
          break;

        case 'emoji':
          console.log(`${name} sent emoji: ${data.emoji}`);
          (rooms[roomId] || []).forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'emoji',
                from: name,
                emoji: data.emoji,
              }));
            }
          });
          break;
          
        case 'mic-status':
          console.log(`${name} mic status: ${data.muted ? 'muted' : 'unmuted'}`);
          (rooms[roomId] || []).forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'mic-status',
                name: name,
                muted: data.muted,
              }));
            }
          });
          break;
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  // ✅ Proper disconnect handler
  ws.on('close', () => {
    if (rooms[roomId] && name) {
      console.log(`${name} left room ${roomId}`);
      rooms[roomId] = rooms[roomId].filter(c => c !== ws);
      rooms[roomId].forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'peer-left',
            name
          }));
        }
      });
      
      // Clean up empty rooms
      if (rooms[roomId].length === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted (empty)`);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

console.log(`Signaling server running on ws://localhost:${PORT}`);
