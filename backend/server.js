import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';

/* =========================================================
   HTTP SERVER (REQUIRED FOR RENDER)
========================================================= */
const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Casual Chat Server is running');
});

/* =========================================================
   WEBSOCKET SERVER
========================================================= */
const wss = new WebSocketServer({ server });

class ChatServer {
    constructor() {
        this.clients = new Map();
        this.rooms = new Map();
        this.messageHistory = new Map();
        this.userStats = new Map();
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
            ws,
            username: null,
            roomId: 'main',
            joinedAt: Date.now(),
            vectorClock: new Map()
        };

        this.clients.set(ws, clientInfo);

        ws.send(JSON.stringify({
            type: 'init',
            clientId,
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

            switch (data.type) {
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
        if (!room) return;

        room.users.add(client.id);
        client.vectorClock = new Map();

        this.clients.forEach(existingClient => {
            if (
                existingClient.roomId === client.roomId &&
                existingClient.id !== client.id
            ) {
                const time = existingClient.vectorClock?.get(existingClient.id) || 0;
                client.vectorClock.set(existingClient.id, time);
            }
        });

        client.vectorClock.set(client.id, 0);

        this.broadcastUserList(client.roomId);

        this.broadcastToRoom(client.roomId, {
            type: 'system',
            message: `${client.username} joined the chat`,
            timestamp: Date.now(),
            userId: client.id
        });

        client.ws.send(JSON.stringify({
            type: 'join_success',
            room,
            users: this.getRoomUsers(client.roomId),
            messageCount: this.messageHistory.get(client.roomId)?.length || 0
        }));
    }

    handleChat(client, data) {
        const roomId = client.roomId;
        const room = this.rooms.get(roomId);
        if (!room) return;

        const currentValue = client.vectorClock.get(client.id) || 0;
        client.vectorClock.set(client.id, currentValue + 1);

        const message = {
            id: uuidv4(),
            type: 'chat',
            userId: client.id,
            username: client.username,
            text: data.text,
            vectorClock: Array.from(client.vectorClock.entries()),
            timestamp: Date.now(),
            roomId,
            metadata: data.metadata || {}
        };

        const history = this.messageHistory.get(roomId) || [];
        history.push(message);
        this.messageHistory.set(roomId, history);

        this.updateUserStats(client.id, 'messagesSent');

        if (data.metadata?.simulateDelay) {
            setTimeout(() => {
                this.broadcastToRoom(roomId, message, client.ws);
            }, data.metadata.delayMs || 1000);
        } else {
            this.broadcastToRoom(roomId, message, client.ws);
        }

        client.ws.send(JSON.stringify({
            type: 'message_delivered',
            messageId: message.id,
            timestamp: Date.now()
        }));
    }

    broadcastToRoom(roomId, message, excludeWs = null) {
        this.clients.forEach((client, ws) => {
            if (
                client.roomId === roomId &&
                ws !== excludeWs &&
                ws.readyState === 1
            ) {
                ws.send(JSON.stringify(message));
            }
        });
    }

    broadcastUserList(roomId) {
        this.broadcastToRoom(roomId, {
            type: 'user_list',
            users: this.getRoomUsers(roomId),
            timestamp: Date.now()
        });
    }

    getRoomUsers(roomId) {
        const users = [];
        this.clients.forEach(client => {
            if (client.roomId === roomId && client.username) {
                users.push({
                    id: client.id,
                    username: client.username,
                    joinedAt: client.joinedAt,
                    vectorClock: Array.from(client.vectorClock.entries())
                });
            }
        });
        return users;
    }

    sendHistory(client) {
        const history = this.messageHistory.get(client.roomId) || [];
        client.ws.send(JSON.stringify({
            type: 'history',
            messages: history.slice(-50),
            total: history.length
        }));
    }

    sendUserList(client) {
        client.ws.send(JSON.stringify({
            type: 'user_list',
            users: this.getRoomUsers(client.roomId),
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
        if (!client) return;

        const room = this.rooms.get(client.roomId);
        if (room) {
            room.users.delete(client.id);
            this.broadcastToRoom(client.roomId, {
                type: 'system',
                message: `${client.username} left the chat`,
                timestamp: Date.now()
            });
            setTimeout(() => this.broadcastUserList(client.roomId), 100);
        }

        this.clients.delete(ws);
    }

    handleError(ws, error) {
        console.error('WebSocket error:', error);
        this.handleDisconnect(ws);
    }
}

/* =========================================================
   START SERVER (RENDER SAFE)
========================================================= */
const chatServer = new ChatServer();

wss.on('connection', (ws) => {
    chatServer.handleConnection(ws);
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
