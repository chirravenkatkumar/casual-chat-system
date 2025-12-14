import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';

const server = createServer();
const wss = new WebSocketServer({ server });

class ChatServer {
    constructor() {
        this.clients = new Map(); // ws -> client info
        this.rooms = new Map(); // roomId -> room info
        this.messageHistory = new Map(); // roomId -> messages
        this.userStats = new Map(); // userId -> stats
        
        this.initDefaultRoom();
    }

    initDefaultRoom() {
        const roomId = 'main';
        this.rooms.set(roomId, {
            id: roomId,
            name: 'Main Chat Room',
            users: new Set(),
            created: Date.now()
        });
        this.messageHistory.set(roomId, []);
    }

    handleConnection(ws) {
        const clientId = uuidv4();
        const clientInfo = {
            id: clientId,
            ws: ws,
            username: null,
            roomId: 'main',
            joinedAt: Date.now(),
            vectorClock: new Map() // userId -> timestamp
        };
        
        this.clients.set(ws, clientInfo);
        
        ws.send(JSON.stringify({
            type: 'init',
            clientId: clientId,
            serverTime: Date.now(),
            defaultRoom: 'main'
        }));

        ws.on('message', (data) => this.handleMessage(ws, data));
        ws.on('close', () => this.handleDisconnect(ws));
        ws.on('error', (error) => this.handleError(ws, error));
    }

    handleMessage(ws, rawData) {
        try {
            const data = JSON.parse(rawData);
            const client = this.clients.get(ws);
            
            if (!client) return;

            switch(data.type) {
                case 'join':
                    this.handleJoin(client, data);
                    break;
                    
                case 'chat':
                    this.handleChat(client, data);
                    break;
                    
                case 'typing':
                    this.broadcastToRoom(client.roomId, {
                        type: 'user_typing',
                        userId: client.id,
                        username: client.username,
                        isTyping: data.isTyping
                    }, ws);
                    break;
                    
                case 'request_history':
                    this.sendHistory(client);
                    break;
                    
                case 'get_users':
                    this.sendUserList(client);
                    break;
                    
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
            }
        } catch (error) {
            console.error('Message handling error:', error);
        }
    }

    handleJoin(client, data) {
    client.username = data.username;
    client.roomId = data.roomId || 'main';
    
    const room = this.rooms.get(client.roomId);
    if (room) {
        room.users.add(client.id);
        
        // Get all current users in the room
        const roomUsers = this.getRoomUsers(client.roomId);
        
        // Initialize vector clock for new user
        client.vectorClock = new Map();
        
        // Add all existing users to vector clock with their current times
        this.clients.forEach((existingClient, ws) => {
            if (existingClient.roomId === client.roomId && 
                existingClient.vectorClock && 
                existingClient.id !== client.id) {
                
                // Get the existing user's current timestamp
                const existingTime = existingClient.vectorClock.get(existingClient.id) || 0;
                
                // Set it in the new user's vector clock
                client.vectorClock.set(existingClient.id, existingTime);
                console.log(`Added ${existingClient.username}'s time ${existingTime} to ${client.username}'s clock`);
            }
        });
        
        // Add self with time 0
        client.vectorClock.set(client.id, 0);
        
        console.log(`${client.username} vector clock initialized:`, 
            Array.from(client.vectorClock.entries()));
        
        // Broadcast updated user list to ALL users
        this.broadcastUserList(client.roomId);
        
        // Send welcome message
        this.broadcastToRoom(client.roomId, {
            type: 'system',
            message: `${client.username} joined the chat`,
            timestamp: Date.now(),
            userId: client.id
        });
        
        // Send current state to new user
        client.ws.send(JSON.stringify({
            type: 'join_success',
            room: room,
            users: this.getRoomUsers(client.roomId),
            messageCount: this.messageHistory.get(client.roomId)?.length || 0
        }));
        
        console.log(`${client.username} joined successfully`);
    }
}


    handleChat(client, data) {
    const roomId = client.roomId;
    const room = this.rooms.get(roomId);
    
    if (!room) {
        console.error(`Room ${roomId} not found for message from ${client.username}`);
        return;
    }
    
    console.log(`=== Message from ${client.username} ===`);
    console.log(`Text: "${data.text}"`);
    console.log(`Room: ${roomId} (${room.users.size} users)`);
    
    // Ensure client has vector clock
    if (!client.vectorClock) {
        client.vectorClock = new Map();
        client.vectorClock.set(client.id, 0);
    }
    
    // Increment sender's vector clock
    const currentValue = client.vectorClock.get(client.id) || 0;
    client.vectorClock.set(client.id, currentValue + 1);
    
    // Get current vector clock state
    const vectorClockArray = Array.from(client.vectorClock.entries());
    
    console.log(`Sender ${client.username} vector clock after increment:`, vectorClockArray);
    
    const message = {
        id: uuidv4(),
        type: 'chat',
        userId: client.id,
        username: client.username,
        text: data.text,
        vectorClock: vectorClockArray,
        timestamp: Date.now(),
        roomId: roomId,
        metadata: data.metadata || {}
    };
    
    // Store message
    const history = this.messageHistory.get(roomId) || [];
    history.push(message);
    this.messageHistory.set(roomId, history);
    
    // Update user stats
    this.updateUserStats(client.id, 'messagesSent');
    
    // Log before broadcasting
    console.log(`Broadcasting message to room ${roomId}:`);
    console.log(`  From: ${client.username}`);
    console.log(`  Vector: ${JSON.stringify(vectorClockArray)}`);
    console.log(`  Users in room: ${Array.from(room.users).join(', ')}`);
    
    // Apply simulation delays if configured
    if (data.metadata?.simulateDelay) {
        console.log(`Applying ${data.metadata.delayMs}ms delay to message`);
        setTimeout(() => {
            this.broadcastToRoom(roomId, message, client.ws);
        }, data.metadata.delayMs || 1000);
    } else {
        // Broadcast immediately
        this.broadcastToRoom(roomId, message, client.ws);
    }
    
    // Send delivery confirmation
    client.ws.send(JSON.stringify({
        type: 'message_delivered',
        messageId: message.id,
        timestamp: Date.now()
    }));
}

    // handleChat(client, data) {
    //     const roomId = client.roomId;
    //     const room = this.rooms.get(roomId);
        
    //     if (!room) {
    //         console.error(`Room ${roomId} not found for message from ${client.username}`);
    //         return;
    //     }
        
    //     // Update client's vector clock
    //     if (data.vectorClock) {
    //         data.vectorClock.forEach((timestamp, userId) => {
    //             client.vectorClock.set(userId, Math.max(
    //                 client.vectorClock.get(userId) || 0,
    //                 timestamp
    //             ));
    //         });
    //     }
        
    //     const message = {
    //         id: uuidv4(),
    //         type: 'chat',
    //         userId: client.id,
    //         username: client.username,
    //         text: data.text,
    //         vectorClock: Array.from(client.vectorClock.entries()),
    //         timestamp: Date.now(),
    //         roomId: roomId,
    //         metadata: data.metadata || {}
    //     };
        
    //     // Store message
    //     const history = this.messageHistory.get(roomId) || [];
    //     history.push(message);
    //     this.messageHistory.set(roomId, history);
        
    //     // Update user stats
    //     this.updateUserStats(client.id, 'messagesSent');
        
    //     // Increment sender's vector clock
    //     const currentValue = client.vectorClock.get(client.id) || 0;
    //     client.vectorClock.set(client.id, currentValue + 1);
        
    //     // Apply simulation delays if configured
    //     if (data.metadata?.simulateDelay) {
    //         setTimeout(() => {
    //             this.broadcastToRoom(roomId, message, client.ws);
    //         }, data.metadata.delayMs || 1000);
    //     } else {
    //         this.broadcastToRoom(roomId, message, client.ws);
    //     }
        
    //     // Send delivery confirmation
    //     client.ws.send(JSON.stringify({
    //         type: 'message_delivered',
    //         messageId: message.id,
    //         timestamp: Date.now()
    //     }));
    // }

    broadcastToRoom(roomId, message, excludeWs = null) {
    const room = this.rooms.get(roomId);
    if (!room) {
        console.warn(`Room ${roomId} not found`);
        return;
    }
    
    console.log(`Broadcasting ${message.type} to ${room.users.size} users in ${roomId}`);
    
    let sentCount = 0;
    this.clients.forEach((client, ws) => {
        if (client.roomId === roomId && 
            client.ws !== excludeWs && 
            client.ws.readyState === 1) {
            
            try {
                // FIX: Ensure ALL users get ALL messages
                client.ws.send(JSON.stringify(message));
                sentCount++;
                
                // Log who received the message
                if (message.type === 'chat') {
                    console.log(`  → Sent to ${client.username} (${client.id})`);
                }
            } catch (error) {
                console.error(`Error sending to ${client.username}:`, error);
            }
        }
    });
    
    console.log(`Broadcast completed: ${sentCount}/${room.users.size} users`);
    
    // Debug: Check if any users missed the message
    if (message.type === 'chat') {
        this.clients.forEach((client, ws) => {
            if (client.roomId === roomId && client.ws === excludeWs) {
                console.log(`  → Excluded sender: ${client.username}`);
            } else if (client.roomId === roomId && client.ws.readyState !== 1) {
                console.log(`  → Skipped (not ready): ${client.username}`);
            }
        });
    }
}

    broadcastUserList(roomId) {
        const users = this.getRoomUsers(roomId);
        this.broadcastToRoom(roomId, {
            type: 'user_list',
            users: users,
            timestamp: Date.now()
        });
    }

    getRoomUsers(roomId) {
    const users = [];
    this.clients.forEach((client) => {
        if (client.roomId === roomId && client.username) {
            users.push({
                id: client.id,
                username: client.username,
                joinedAt: client.joinedAt,
                vectorClock: client.vectorClock ? Array.from(client.vectorClock.entries()) : []
            });
        }
    });
    return users;
}

    sendHistory(client) {
        const history = this.messageHistory.get(client.roomId) || [];
        client.ws.send(JSON.stringify({
            type: 'history',
            messages: history.slice(-50), // Last 50 messages
            total: history.length
        }));
    }

    sendUserList(client) {
        const users = this.getRoomUsers(client.roomId);
        client.ws.send(JSON.stringify({
            type: 'user_list',
            users: users,
            timestamp: Date.now()
        }));
    }

    updateUserStats(userId, stat) {
        const stats = this.userStats.get(userId) || {
            messagesSent: 0,
            messagesReceived: 0,
            joinCount: 1
        };
        stats[stat] = (stats[stat] || 0) + 1;
        this.userStats.set(userId, stats);
    }

    handleDisconnect(ws) {
        const client = this.clients.get(ws);
        if (client) {
            const room = this.rooms.get(client.roomId);
            if (room) {
                room.users.delete(client.id);
                
                this.broadcastToRoom(client.roomId, {
                    type: 'system',
                    message: `${client.username} left the chat`,
                    timestamp: Date.now()
                });
                
                // Delay a bit before sending user list to ensure client is removed
                setTimeout(() => {
                    this.broadcastUserList(client.roomId);
                }, 100);
            }
            this.clients.delete(ws);
        }
    }

    handleError(ws, error) {
        console.error('WebSocket error:', error);
        this.handleDisconnect(ws);
    }

    getStats() {
        return {
            totalClients: this.clients.size,
            totalRooms: this.rooms.size,
            totalMessages: Array.from(this.messageHistory.values())
                .reduce((sum, msgs) => sum + msgs.length, 0)
        };
    }
}

// Initialize server
const chatServer = new ChatServer();

wss.on('connection', (ws) => {
    chatServer.handleConnection(ws);
});

server.listen(8080, () => {
    console.log('Server running on ws://localhost:8080');
    console.log('Open frontend/index.html in your browser');
});