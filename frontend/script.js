// ==================== Vector Clock Manager ====================
class VectorClockManager {
    constructor(userId) {
        this.userId = userId;
        this.clock = new Map(); // userId -> timestamp
        this.clock.set(userId, 0); // Initialize own clock
    }

    addUser(userId) {
        if (!this.clock.has(userId)) {
            this.clock.set(userId, 0);
        }
    }

    increment() {
        const current = this.clock.get(this.userId) || 0;
        this.clock.set(this.userId, current + 1);
        console.log(`Incremented ${this.userId} to ${current + 1}`);
        return this.getClockArray();
    }

    

    getClock() {
        return new Map(this.clock);
    }

    getClockArray() {
        const arr = Array.from(this.clock.entries());
        console.log('Current clock array:', arr);
        return arr;
    }

    getClockString() {
        const entries = Array.from(this.clock.entries());
        entries.sort((a, b) => a[0].localeCompare(b[0]));
        const values = entries.map(([_, time]) => time);
        return `[${values.join(', ')}]`;
    }

    // FIXED: Simplified causal readiness check
    isCausallyReady(messageClockArray, senderId) {
        console.log('Checking causal readiness:');
        console.log('Local clock:', Array.from(this.clock.entries()));
        console.log('Message clock:', messageClockArray);
        console.log('Sender ID:', senderId);
        
        // Convert message clock array to map for easy lookup
        const messageClock = new Map(messageClockArray);
        
        // For the sender: message clock should be exactly local + 1
        const senderLocalTime = this.clock.get(senderId) || 0;
        const senderMessageTime = messageClock.get(senderId) || 0;
        
        console.log(`Sender ${senderId}: local=${senderLocalTime}, message=${senderMessageTime}`);
        
        if (senderMessageTime !== senderLocalTime + 1) {
            console.log(`❌ Failed: sender time mismatch (expected ${senderLocalTime + 1}, got ${senderMessageTime})`);
            return false;
        }
        
        // For all other users: message time <= local time
        for (const [userId, localTime] of this.clock.entries()) {
            if (userId === senderId) continue;
            
            const messageTime = messageClock.get(userId) || 0;
            
            if (messageTime > localTime) {
                console.log(`❌ Failed: ${userId} has message time ${messageTime} > local time ${localTime}`);
                return false;
            }
        }
        
        console.log('✅ Message is causally ready');
        return true;
    }

    // New: Check if we can deliver a buffered message
    canDeliverBufferedMessage(messageClockArray, senderId) {
        return this.isCausallyReady(messageClockArray, senderId);
    }

    getAllClocks(users) {
        const clocks = [];
        const userMap = new Map(users.map(u => [u.id, u]));
        
        // Sort users alphabetically for consistent display
        const sortedUsers = Array.from(this.clock.entries())
            .sort((a, b) => {
                const userA = userMap.get(a[0]);
                const userB = userMap.get(b[0]);
                const nameA = userA ? userA.username : a[0];
                const nameB = userB ? userB.username : b[0];
                return nameA.localeCompare(nameB);
            });
        
        sortedUsers.forEach(([userId, time]) => {
            const user = userMap.get(userId);
            clocks.push({
                userId,
                username: user ? user.username : userId.substring(0, 8),
                value: time,
                isSelf: userId === this.userId,
                clockString: this.getIndividualClockString(userId)
            });
        });
        
        return clocks;
    }

    getIndividualClockString(userId) {
        const entries = Array.from(this.clock.entries());
        entries.sort((a, b) => a[0].localeCompare(b[0]));
        
        return `[${entries.map(([id, time]) => 
            id === userId ? `<strong>${time}</strong>` : time
        ).join(', ')}]`;
    }

    // Add all users from a list
    syncWithUsers(users) {
        users.forEach(user => {
            if (!this.clock.has(user.id)) {
                this.clock.set(user.id, 0);
            }
        });
    }
}

// ==================== Causal Order Engine ====================
class CausalOrderEngine {
    constructor() {
        this.messageBuffer = new Map(); // messageId -> {message, receivedAt, attempts}
        this.deliveredMessages = [];
        this.stats = {
            totalProcessed: 0,
            deliveredImmediately: 0,
            buffered: 0,
            maxBufferSize: 0
        };
    }

    processMessage(message, vectorClock, senderId) {
        this.stats.totalProcessed++;
        
        console.log(`Processing message from ${senderId}:`, message.text);
        
        const isReady = vectorClock.isCausallyReady(message.vectorClock, senderId);
        
        if (isReady) {
            this.stats.deliveredImmediately++;
            console.log(`✅ Message delivered immediately: ${message.text}`);
            
            this.deliveredMessages.push({
                id: message.id,
                timestamp: message.timestamp,
                deliveredAt: Date.now()
            });
            
            return {
                isCausallyReady: true,
                messageId: message.id,
                action: 'deliver_immediately'
            };
        } else {
            this.stats.buffered++;
            console.log(`⏳ Message buffered: ${message.text}`);
            
            // Buffer the message
            this.messageBuffer.set(message.id, {
                message,
                receivedAt: Date.now(),
                attempts: 0
            });
            
            this.stats.maxBufferSize = Math.max(this.stats.maxBufferSize, this.messageBuffer.size);
            
            return {
                isCausallyReady: false,
                messageId: message.id,
                action: 'buffered',
                reason: 'waiting_for_causal_dependencies'
            };
        }
    }

    checkBufferedMessages(vectorClock) {
        const readyMessages = [];
        
        for (const [messageId, bufferEntry] of this.messageBuffer) {
            const { message } = bufferEntry;
            
            if (vectorClock.canDeliverBufferedMessage(message.vectorClock, message.userId)) {
                readyMessages.push({
                    messageId,
                    message,
                    receivedAt: bufferEntry.receivedAt,
                    attempts: bufferEntry.attempts,
                    waitTime: Date.now() - bufferEntry.receivedAt
                });
            } else {
                bufferEntry.attempts++;
            }
        }
        
        return readyMessages;
    }

    deliverMessage(messageId) {
        if (!this.messageBuffer.has(messageId)) {
            return null;
        }
        
        const bufferEntry = this.messageBuffer.get(messageId);
        const message = bufferEntry.message;
        
        // Remove from buffer
        this.messageBuffer.delete(messageId);
        
        // Add to delivered
        this.deliveredMessages.push({
            id: messageId,
            timestamp: message.timestamp,
            deliveredAt: Date.now(),
            waitTime: Date.now() - bufferEntry.receivedAt
        });
        
        console.log(`📨 Delivered buffered message: ${message.text}`);
        
        return {
            message,
            bufferInfo: {
                receivedAt: bufferEntry.receivedAt,
                attempts: bufferEntry.attempts,
                waitTime: Date.now() - bufferEntry.receivedAt
            }
        };
    }

    getBufferedMessages() {
        return Array.from(this.messageBuffer.entries()).map(([id, entry]) => ({
            id,
            ...entry,
            waitTime: Date.now() - entry.receivedAt
        }));
    }

    getStats() {
        return {
            ...this.stats,
            currentBufferSize: this.messageBuffer.size,
            totalDelivered: this.deliveredMessages.length
        };
    }

    reset() {
        this.messageBuffer.clear();
        this.deliveredMessages = [];
        this.stats = {
            totalProcessed: 0,
            deliveredImmediately: 0,
            buffered: 0,
            maxBufferSize: 0
        };
    }
}

// ==================== UI Manager ====================
class UIManager {
    constructor() {
        this.messageCount = 0;
        this.initTemplates();
    }

    initTemplates() {
        this.templates = {
            message: `
                <div class="message {{messageClass}}" data-message-id="{{id}}" data-user-id="{{userId}}">
                    <div class="message-header">
                        <div class="message-sender">
                            <div class="sender-avatar">{{avatarLetter}}</div>
                            <span class="sender-name">{{username}}</span>
                        </div>
                        <div class="message-time">{{time}}</div>
                    </div>
                    <div class="message-body">{{text}}</div>
                    {{delayIndicator}}
                    <div class="message-clock-display">
                        <span class="clock-values">Vector: {{vectorClock}}</span>
                        <div class="message-status">
                            {{statusIcons}}
                        </div>
                    </div>
                </div>
            `,
            
            systemMessage: `
                <div class="system-message">
                    <i class="fas fa-info-circle"></i>
                    <span>{{message}}</span>
                    <span class="message-time">{{time}}</span>
                </div>
            `,
            
            userItem: `
                <div class="user-item" data-user-id="{{userId}}">
                    <div class="user-avatar">{{avatarLetter}}</div>
                    <div class="user-details">
                        <div class="user-name">{{username}}</div>
                        <div class="user-status">Online</div>
                    </div>
                    <div class="user-clock">{{clock}}</div>
                </div>
            `,
            
            clockItem: `
                <div class="clock-item {{clockClass}}" data-user-id="{{userId}}">
                    <div class="clock-user">{{username}}</div>
                    <div class="clock-values">{{clock}}</div>
                </div>
            `,
            
            bufferItem: `
                <div class="buffer-message" data-message-id="{{id}}">
                    <div class="buffer-header">
                        <strong>{{username}}</strong>
                        <small>{{timeAgo}} ago</small>
                    </div>
                    <div class="buffer-text">{{text}}</div>
                    <div class="buffer-info">
                        <small>Waiting: {{reason}}</small>
                        <br>
                        <small>Attempts: {{attempts}}</small>
                    </div>
                </div>
            `
        };
    }

    addMessage(message) {
        const container = document.getElementById('messagesContainer');
        
        // Remove welcome message if it's the first real message
        const welcome = container.querySelector('.welcome-message');
        if (welcome && this.messageCount === 0) {
            welcome.remove();
        }
        
        // Prepare message data
        const messageData = {
            id: message.id,
            userId: message.userId,
            username: message.username,
            avatarLetter: message.username ? message.username[0].toUpperCase() : '?',
            text: this.escapeHtml(message.text),
            time: this.formatTime(message.timestamp),
            vectorClock: this.formatVectorClock(message.vectorClock),
            isOwn: message.isOwn
        };
        
        // Determine message class
        messageData.messageClass = message.isOwn ? 'own' : '';
        if (message.metadata?.delayMs) {
            messageData.messageClass += ' delayed';
            messageData.delayIndicator = `
                <div class="message-delay">
                    <i class="fas fa-hourglass-half"></i>
                    Delayed: ${message.metadata.delayMs}ms
                </div>
            `;
        }
        
        // Add status icons
        messageData.statusIcons = message.isOwn ? 
            '<i class="fas fa-check status-icon"></i>' : '';
        
        // Render message
        const messageHtml = this.renderTemplate('message', messageData);
        const messageElement = this.htmlToElement(messageHtml);
        
        // Add animation
        if (message.isOwn) {
            messageElement.style.animation = 'slideInRight 0.3s ease';
        } else {
            messageElement.style.animation = 'slideInLeft 0.3s ease';
        }
        
        container.appendChild(messageElement);
        this.scrollToBottom();
        
        this.messageCount++;
        console.log(`Added message #${this.messageCount}: ${message.text}`);
        return messageElement;
    }

    addSystemMessage(text) {
        const container = document.getElementById('messagesContainer');
        
        const messageData = {
            message: text,
            time: this.formatTime(Date.now())
        };
        
        const messageHtml = this.renderTemplate('systemMessage', messageData);
        const messageElement = this.htmlToElement(messageHtml);
        
        container.appendChild(messageElement);
        this.scrollToBottom();
        console.log(`Added system message: ${text}`);
    }

    updateUserList(users) {
        const container = document.getElementById('usersList');
        
        if (!users || users.length === 0) {
            container.innerHTML = `
                <div class="empty-users">
                    <i class="fas fa-user-friends"></i>
                    <p>No users online</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = '';
        
        users.forEach(user => {
            const userData = {
                userId: user.id,
                username: user.username,
                avatarLetter: user.username ? user.username[0].toUpperCase() : '?',
                clock: this.formatCompactClock(user.vectorClock)
            };
            
            const userHtml = this.renderTemplate('userItem', userData);
            const userElement = this.htmlToElement(userHtml);
            container.appendChild(userElement);
        });
        
        // Update room count
        document.getElementById('roomCount').textContent = users.length;
        console.log(`Updated user list: ${users.length} users`);
    }

    updateVectorClocks(clocks) {
        const container = document.getElementById('clocksGrid');
        
        if (!clocks || clocks.length === 0) {
            container.innerHTML = `
                <div class="empty-clocks">
                    <i class="fas fa-clock"></i>
                    <p>No vector clocks to display</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = '';
        
        clocks.forEach(clock => {
            const clockData = {
                userId: clock.userId,
                username: clock.username,
                clock: clock.clockString,
                clockClass: clock.isSelf ? 'self' : ''
            };
            
            const clockHtml = this.renderTemplate('clockItem', clockData);
            const clockElement = this.htmlToElement(clockHtml);
            container.appendChild(clockElement);
        });
        
        // Update user count
        document.getElementById('userCount').textContent = clocks.length;
    }

    updateBufferList(bufferedMessages) {
        const container = document.getElementById('bufferList');
        
        if (!bufferedMessages || bufferedMessages.length === 0) {
            container.innerHTML = `
                <div class="empty-buffer">
                    <i class="fas fa-inbox"></i>
                    <p>No buffered messages</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = '';
        
        bufferedMessages.forEach(msg => {
            const bufferData = {
                id: msg.id,
                username: msg.message.username,
                text: this.truncateText(msg.message.text, 50),
                timeAgo: this.getTimeAgo(msg.receivedAt),
                attempts: msg.attempts || 0,
                reason: msg.message.metadata?.reason || 'causal_deps'
            };
            
            const bufferHtml = this.renderTemplate('bufferItem', bufferData);
            const bufferElement = this.htmlToElement(bufferHtml);
            container.appendChild(bufferElement);
        });
        
        console.log(`Updated buffer: ${bufferedMessages.length} messages`);
    }

    updateTypingIndicator(typingUsers) {
        const container = document.getElementById('typingIndicator');
        
        if (typingUsers.length === 0) {
            container.innerHTML = '';
            return;
        }
        
        const users = Array.from(typingUsers);
        let text;
        
        if (users.length === 1) {
            text = `${users[0]} is typing...`;
        } else if (users.length === 2) {
            text = `${users[0]} and ${users[1]} are typing...`;
        } else {
            text = `${users[0]} and ${users.length - 1} others are typing...`;
        }
        
        container.innerHTML = `
            <div class="typing-bubble">
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-text">${text}</span>
            </div>
        `;
    }

    updateStats(totalMessages, bufferedCount, vectorSize) {
        document.getElementById('totalMessages').textContent = totalMessages;
        document.getElementById('bufferSize').textContent = bufferedCount;
        document.getElementById('vectorSize').textContent = vectorSize;
        document.getElementById('bufferCount').textContent = bufferedCount;
    }

    clearMessages() {
        const container = document.getElementById('messagesContainer');
        container.innerHTML = `
            <div class="welcome-message">
                <i class="fas fa-rocket"></i>
                <h3>Welcome to Causal Chat</h3>
                <p>Messages are ordered based on causal relationships, not arrival time</p>
                <p class="hint">Enter a username and click Connect to join</p>
            </div>
        `;
        this.messageCount = 0;
        console.log('Cleared all messages');
    }

    showNotification(message, type = 'info') {
        console.log(`Notification (${type}): ${message}`);
        
        // Remove existing notifications
        document.querySelectorAll('.notification').forEach(n => n.remove());
        
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <i class="fas fa-${this.getNotificationIcon(type)}"></i>
            <span>${message}</span>
        `;
        
        // Add to body
        document.body.appendChild(notification);
        
        // Remove after 3 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 3000);
    }

    scrollToBottom() {
        const container = document.getElementById('messagesContainer');
        setTimeout(() => {
            container.scrollTop = container.scrollHeight;
        }, 100);
    }

    // Helper methods
    formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    formatVectorClock(clockArray) {
        if (!clockArray || !Array.isArray(clockArray)) return '[]';
        const sorted = [...clockArray].sort((a, b) => a[0].localeCompare(b[0]));
        const values = sorted.map(([_, time]) => time);
        return `[${values.join(', ')}]`;
    }

    formatCompactClock(clockArray) {
        if (!clockArray || !Array.isArray(clockArray)) return '[]';
        const values = clockArray.map(([_, time]) => time);
        if (values.length <= 3) return `[${values.join(',')}]`;
        return `[${values.slice(0, 3).join(',')}...]`;
    }

    truncateText(text, maxLength) {
        if (!text) return '';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...';
    }

    getTimeAgo(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;
        
        if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
        return `${Math.floor(diff / 86400000)}d`;
    }

    getNotificationIcon(type) {
        switch(type) {
            case 'success': return 'check-circle';
            case 'warning': return 'exclamation-triangle';
            case 'error': return 'times-circle';
            default: return 'info-circle';
        }
    }

    renderTemplate(templateName, data) {
        let html = this.templates[templateName];
        
        for (const [key, value] of Object.entries(data)) {
            const placeholder = new RegExp(`{{${key}}}`, 'g');
            html = html.replace(placeholder, value || '');
        }
        
        // Remove any unused placeholders
        html = html.replace(/{{[^{}]*}}/g, '');
        
        return html;
    }

    htmlToElement(html) {
        const template = document.createElement('template');
        html = html.trim();
        template.innerHTML = html;
        return template.content.firstChild;
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// ==================== Main Application ====================
class CausalChatApp {
    constructor() {
        this.ws = null;
        this.userId = null;
        this.username = null;
        this.vectorClock = null;
        this.causalEngine = new CausalOrderEngine();
        this.ui = new UIManager();
        
        this.isConnected = false;
        this.currentRoom = 'main';
        this.users = new Map();
        this.messages = [];
        this.bufferedMessages = [];
        this.typingUsers = new Set();
        this.lastPing = Date.now();
        this.latency = 0;
        
        this.init();
    }

    init() {
        this.bindEvents();
        this.setupKeyboardShortcuts();
        this.setupAutoResize();
        this.setupHeartbeat();
        
        console.log('Causal Chat App initialized');
    }

    bindEvents() {
        // Connection
        document.getElementById('connectBtn').addEventListener('click', () => this.connect());
        document.getElementById('usernameInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.connect();
        });

        // Message sending
        document.getElementById('sendBtn').addEventListener('click', () => this.sendMessage());
        const messageInput = document.getElementById('messageInput');
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Typing indicator
        let typingTimeout;
        messageInput.addEventListener('input', () => {
            if (!this.isConnected) return;
            
            clearTimeout(typingTimeout);
            this.sendTyping(true);
            
            typingTimeout = setTimeout(() => {
                this.sendTyping(false);
            }, 1000);
        });

        // Simulation controls
        document.getElementById('simulateBtn').addEventListener('click', () => {
            const controls = document.getElementById('simulationControls');
            controls.style.display = controls.style.display === 'none' ? 'block' : 'none';
        });

        document.getElementById('enableSimulation').addEventListener('change', (e) => {
            this.ui.showNotification(
                e.target.checked ? 'Simulation enabled' : 'Simulation disabled',
                'info'
            );
        });

        document.getElementById('delaySlider').addEventListener('input', (e) => {
            document.getElementById('delayValue').textContent = `${e.target.value}ms`;
        });

        // Quick actions
        document.getElementById('testConcurrent').addEventListener('click', () => this.testConcurrent());
        document.getElementById('testCausal').addEventListener('click', () => this.testCausal());
        document.getElementById('refreshData').addEventListener('click', () => this.refreshData());
        document.getElementById('clearChatBtn').addEventListener('click', () => this.clearChat());
        document.getElementById('helpBtn').addEventListener('click', () => this.showHelp());

        // Modal
        document.querySelector('.close-modal').addEventListener('click', () => {
            document.getElementById('helpModal').classList.remove('active');
        });

        window.addEventListener('click', (e) => {
            if (e.target.id === 'helpModal') {
                document.getElementById('helpModal').classList.remove('active');
            }
        });

        // Debug button (added for testing)
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key === 'D') {
                e.preventDefault();
                this.debugInfo();
            }
        });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl+K: Clear chat
            if (e.ctrlKey && e.key === 'k') {
                e.preventDefault();
                this.clearChat();
            }
            // Ctrl+S: Toggle simulation
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                const checkbox = document.getElementById('enableSimulation');
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
            }
        });
    }

    
    setupAutoResize() {
    const textarea = document.getElementById('messageInput');
    
    const autoResize = function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        
        // Limit max height to 120px
        if (this.scrollHeight > 120) {
            this.style.overflowY = 'auto';
            this.style.height = '120px';
        } else {
            this.style.overflowY = 'hidden';
        }
    };
    
    textarea.addEventListener('input', autoResize);
    
    // Also resize on window resize
    window.addEventListener('resize', () => {
        autoResize.call(textarea);
    });
}

    setupHeartbeat() {
        setInterval(() => {
            if (this.ws && this.isConnected) {
                this.lastPing = Date.now();
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);
    }

    connect() {
        const usernameInput = document.getElementById('usernameInput');
        const username = usernameInput.value.trim();
        
        if (!username) {
            this.ui.showNotification('Please enter a username', 'error');
            return;
        }
        
        if (username.length < 2) {
            this.ui.showNotification('Username must be at least 2 characters', 'error');
            return;
        }
        
        this.username = username;
        
        try {
            this.ws = new WebSocket('https://casual-chat-system.onrender.com');
            
            this.ws.onopen = () => this.handleConnectionOpen();
            this.ws.onmessage = (event) => this.handleMessage(event);
            this.ws.onclose = () => this.handleConnectionClose();
            this.ws.onerror = (error) => this.handleConnectionError(error);
            
            this.updateConnectionStatus('Connecting...');
            document.getElementById('connectBtn').disabled = true;
            document.getElementById('usernameInput').disabled = true;
            
        } catch (error) {
            console.error('Connection error:', error);
            this.updateConnectionStatus('Connection failed');
            this.ui.showNotification('Connection failed: ' + error.message, 'error');
            this.resetConnectionUI();
        }
    }

    handleConnectionOpen() {
        this.isConnected = true;
        this.updateConnectionStatus('Connected');
        this.ui.showNotification('Connected to chat server', 'success');
        
        // Update UI
        document.getElementById('userAvatar').textContent = this.username[0].toUpperCase();
        document.getElementById('connectBtn').innerHTML = '<i class="fas fa-sign-out-alt"></i> Disconnect';
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('connectBtn').onclick = () => this.disconnect();
        
        document.getElementById('messageInput').disabled = false;
        document.getElementById('sendBtn').disabled = false;
        
        console.log('WebSocket connected, joining chat...');
        
        // Join the chat room
        this.ws.send(JSON.stringify({
            type: 'join',
            username: this.username,
            roomId: this.currentRoom
        }));
    }

    handleMessage(event) {
        try {
            const data = JSON.parse(event.data);
            console.log('Received message:', data.type, data);
            
            switch(data.type) {
                case 'init':
                    this.handleInit(data);
                    break;
                    
                case 'join_success':
                    this.handleJoinSuccess(data);
                    break;
                    
                case 'user_list':
                    this.handleUserList(data);
                    break;
                    
                case 'chat':
                    this.handleChatMessage(data);
                    break;
                    
                case 'system':
                    this.handleSystemMessage(data);
                    break;
                    
                case 'history':
                    this.handleHistory(data);
                    break;
                    
                case 'user_typing':
                    this.handleTypingIndicator(data);
                    break;
                    
                case 'message_delivered':
                    this.handleDeliveryConfirmation(data);
                    break;
                    
                case 'pong':
                    this.handlePong(data);
                    break;
                    
                default:
                    console.log('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Error processing message:', error, event.data);
        }
    }

    handleInit(data) {
        this.userId = data.clientId;
        this.vectorClock = new VectorClockManager(this.userId);
        console.log('Initialized with ID:', this.userId);
    }

    handleJoinSuccess(data) {
        console.log('Join success:', data);
        
        // Store users
        this.users.clear();
        if (data.users && Array.isArray(data.users)) {
            data.users.forEach(user => {
                if (user && user.id && user.username) {
                    this.users.set(user.id, user);
                    // Add user to vector clock
                    if (this.vectorClock) {
                        this.vectorClock.addUser(user.id);
                    }
                }
            });
        }
        
        // Add self to users list and vector clock
        if (this.userId && !this.users.has(this.userId)) {
            this.users.set(this.userId, {
                id: this.userId,
                username: this.username,
                joinedAt: Date.now(),
                vectorClock: []
            });
            if (this.vectorClock) {
                this.vectorClock.addUser(this.userId);
            }
        }
        
        // Sync vector clock with all users
        if (this.vectorClock && data.users) {
            this.vectorClock.syncWithUsers(data.users);
        }
        
        this.updateUserDisplay();
        this.ui.showNotification(`Joined ${data.room ? data.room.name : 'Main Room'}`, 'success');
        
        // Request history
        setTimeout(() => {
            if (this.isConnected) {
                this.ws.send(JSON.stringify({ type: 'request_history' }));
            }
        }, 500);
    }

    handleUserList(data) {
        console.log('User list update:', data);
        
        if (!data.users || !Array.isArray(data.users)) {
            console.error('Invalid user list data:', data);
            return;
        }
        
        // Clear and rebuild user list
        const newUsers = new Map();
        
        data.users.forEach(user => {
            if (user && user.id && user.username) {
                newUsers.set(user.id, user);
                // Add user to vector clock
                if (this.vectorClock) {
                    this.vectorClock.addUser(user.id);
                }
            }
        });
        
        // Add self if not in list
        if (this.userId && !newUsers.has(this.userId)) {
            newUsers.set(this.userId, {
                id: this.userId,
                username: this.username,
                joinedAt: Date.now(),
                vectorClock: []
            });
            if (this.vectorClock) {
                this.vectorClock.addUser(this.userId);
            }
        }
        
        this.users = newUsers;
        
        // Sync vector clock with all users
        if (this.vectorClock) {
            this.vectorClock.syncWithUsers(Array.from(newUsers.values()));
        }
        
        this.updateUserDisplay();
        console.log(`Updated users: ${newUsers.size} users online`);
    }

    handleChatMessage(data) {
    console.log('Received chat message:', data);
    
    if (!data.userId || !data.username) {
        console.error('Invalid message data:', data);
        return;
    }
    
    // Ensure sender is in our users list
    if (!this.users.has(data.userId)) {
        const newUser = {
            id: data.userId,
            username: data.username,
            joinedAt: Date.now(),
            vectorClock: []
        };
        this.users.set(data.userId, newUser);
        if (this.vectorClock) {
            this.vectorClock.addUser(data.userId);
        }
        this.updateUserDisplay();
    }
    
    const message = {
        id: data.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        userId: data.userId,
        username: data.username,
        text: data.text,
        vectorClock: data.vectorClock || [],
        timestamp: data.timestamp || Date.now(),
        roomId: data.roomId || this.currentRoom,
        metadata: data.metadata || {},
        isOwn: data.userId === this.userId
    };
    
    console.log('Processing message details:', {
        id: message.id,
        from: message.username,
        text: message.text.substring(0, 50),
        clock: message.vectorClock,
        isOwn: message.isOwn,
        myUserId: this.userId
    });
    
    // CRITICAL FIX: Always merge vector clocks BEFORE checking causal readiness
    if (this.vectorClock && message.vectorClock) {
        console.log('Merging vector clocks before causal check');
        console.log('Before merge:', Array.from(this.vectorClock.clock.entries()));
        this.vectorClock.merge(message.vectorClock);
        console.log('After merge:', Array.from(this.vectorClock.clock.entries()));
    }
    
    // Process through causal ordering engine
    const result = this.causalEngine.processMessage(
        message,
        this.vectorClock,
        data.userId
    );
    
    if (result.isCausallyReady) {
        console.log('✅ Message causally ready, displaying');
        
        // Display the message
        this.displayMessage(message);
        
        // Deliver any buffered messages that are now ready
        this.deliverBufferedMessages();
    } else {
        console.log('⏳ Message buffered:', result.reason);
        
        // Buffer the message
        this.bufferMessage(message);
        
        this.ui.showNotification(
            `Message from ${message.username} buffered (${result.reason})`,
            'warning'
        );
    }
    
    this.updateDisplay();
}

    handleSystemMessage(data) {
        console.log('System message:', data.message);
        this.ui.addSystemMessage(data.message);
        this.updateStats();
    }

    handleHistory(data) {
        console.log('Received history:', data.total, 'messages');
        
        if (data.messages && Array.isArray(data.messages)) {
            // Process historical messages in order
            data.messages.forEach(msg => {
                this.handleChatMessage(msg);
            });
            
            this.ui.showNotification(`Loaded ${data.total} messages from history`, 'info');
        }
    }

    handleTypingIndicator(data) {
        if (data.isTyping) {
            this.typingUsers.add(data.username);
        } else {
            this.typingUsers.delete(data.username);
        }
        
        this.ui.updateTypingIndicator(this.typingUsers);
    }

    handleDeliveryConfirmation(data) {
        const messageElement = document.querySelector(`[data-message-id="${data.messageId}"]`);
        if (messageElement) {
            const statusElement = messageElement.querySelector('.message-status');
            if (statusElement) {
                statusElement.innerHTML = '<i class="fas fa-check-double"></i>';
            }
        }
    }

    handlePong() {
        this.latency = Date.now() - this.lastPing;
        this.updateLatency();
    }

    handleConnectionClose() {
        this.isConnected = false;
        this.updateConnectionStatus('Disconnected');
        this.ui.showNotification('Disconnected from server', 'warning');
        this.resetConnectionUI();
    }

    handleConnectionError(error) {
        console.error('WebSocket error:', error);
        this.ui.showNotification('Connection error occurred', 'error');
        this.updateConnectionStatus('Error');
    }

    updateConnectionStatus(status) {
        const statusElement = document.getElementById('connectionStatus');
        const statusDot = document.getElementById('statusDot');
        
        statusElement.textContent = status;
        
        if (status === 'Connected') {
            statusDot.classList.add('connected');
            document.getElementById('serverStatus').textContent = 'Online';
            document.getElementById('serverStatus').className = 'text-success';
        } else {
            statusDot.classList.remove('connected');
            document.getElementById('serverStatus').textContent = 'Offline';
            document.getElementById('serverStatus').className = 'text-danger';
        }
    }

    updateLatency() {
        const latencyElement = document.getElementById('latencyValue');
        latencyElement.textContent = `${this.latency}ms`;
        
        if (this.latency > 1000) {
            latencyElement.className = 'text-danger';
        } else if (this.latency > 500) {
            latencyElement.className = 'text-warning';
        } else {
            latencyElement.className = 'text-success';
        }
    }

    sendMessage() {
        const input = document.getElementById('messageInput');
        const text = input.value.trim();
        
        if (!text || !this.isConnected || !this.vectorClock) {
            console.log('Cannot send: missing requirements', {
                text: !!text,
                connected: this.isConnected,
                vectorClock: !!this.vectorClock
            });
            return;
        }
        
        console.log('Sending message:', text);
        
        // Increment vector clock
        const vectorClock = this.vectorClock.increment();
        
        // Prepare message
        const message = {
            type: 'chat',
            text: text,
            vectorClock: vectorClock,
            metadata: {}
        };
        
        // Apply simulation if enabled
        const simulationEnabled = document.getElementById('enableSimulation').checked;
        if (simulationEnabled) {
            const delayMs = parseInt(document.getElementById('delaySlider').value);
            
            message.metadata.simulateDelay = true;
            message.metadata.delayMs = delayMs;
        }
        
        // Send via WebSocket
        this.ws.send(JSON.stringify(message));
        
        // Create a local message for immediate display (optimistic update)
        const localMessage = {
            id: `local_${Date.now()}`,
            userId: this.userId,
            username: this.username,
            text: text,
            vectorClock: vectorClock,
            timestamp: Date.now(),
            isOwn: true,
            metadata: message.metadata
        };
        
        // Display immediately (optimistic)
        this.displayMessage(localMessage);
        
        // Clear input and reset height
        input.value = '';
        input.style.height = 'auto';
        input.focus();
        
        // Update typing status
        this.sendTyping(false);
    }

    sendTyping(isTyping) {
        if (!this.isConnected) return;
        
        this.ws.send(JSON.stringify({
            type: 'typing',
            isTyping: isTyping
        }));
    }

    displayMessage(message) {
        // Add to message history
        this.messages.push(message);
        
        // Update UI
        this.ui.addMessage(message);
        
        // Update stats
        this.updateStats();
        
        console.log(`Displayed message from ${message.username}: ${message.text}`);
    }

    bufferMessage(message) {
        this.bufferedMessages.push(message);
        this.updateBufferDisplay();
    }

    deliverBufferedMessages() {
        if (!this.vectorClock) return;
        
        const readyMessages = this.causalEngine.checkBufferedMessages(this.vectorClock);
        
        console.log(`Checking buffered messages: ${readyMessages.length} ready`);
        
        readyMessages.forEach(({ messageId }) => {
            const delivered = this.causalEngine.deliverMessage(messageId);
            if (delivered) {
                this.displayMessage(delivered.message);
                
                // Remove from buffered messages
                const index = this.bufferedMessages.findIndex(m => m.id === messageId);
                if (index !== -1) {
                    this.bufferedMessages.splice(index, 1);
                }
                
                // Merge vector clocks
                if (this.vectorClock) {
                    this.vectorClock.merge(delivered.message.vectorClock);
                }
                
                console.log(`✅ Delivered buffered message: ${delivered.message.text}`);
            }
        });
        
        this.updateDisplay();
    }

    updateUserDisplay() {
        const users = Array.from(this.users.values());
        this.ui.updateUserList(users);
        
        if (this.vectorClock) {
            const clocks = this.vectorClock.getAllClocks(users);
            this.ui.updateVectorClocks(clocks);
            
            document.getElementById('currentVectorClock').textContent = 
                this.vectorClock.getClockString();
        }
    }

    updateBufferDisplay() {
        const buffered = this.causalEngine.getBufferedMessages();
        this.ui.updateBufferList(buffered);
    }

    updateStats() {
        const stats = this.causalEngine.getStats();
        const vectorSize = this.vectorClock ? this.vectorClock.clock.size : 0;
        this.ui.updateStats(
            this.messages.length,
            stats.currentBufferSize,
            vectorSize
        );
    }

    updateDisplay() {
        this.updateUserDisplay();
        this.updateBufferDisplay();
        this.updateStats();
    }

    refreshData() {
        if (this.isConnected) {
            this.ws.send(JSON.stringify({ type: 'get_users' }));
            this.ui.showNotification('Refreshing data...', 'info');
        }
    }

    testConcurrent() {
        if (!this.isConnected) return;
        
        // Send multiple messages quickly to simulate concurrent messages
        const messages = [
            "Concurrent test message A",
            "Concurrent test message B",
            "Concurrent test message C"
        ];
        
        this.ui.showNotification('Sending concurrent test messages...', 'info');
        
        messages.forEach((msg, i) => {
            setTimeout(() => {
                this.sendTestMessage(msg);
            }, i * 100);
        });
    }

    testCausal() {
        if (!this.isConnected) return;
        
        // Send messages with delays to create a causal chain
        const messages = [
            "Causal chain: First message",
            "Causal chain: Second message (after first)",
            "Causal chain: Third message (after second)"
        ];
        
        this.ui.showNotification('Testing causal chain with delays...', 'info');
        
        messages.forEach((msg, i) => {
            setTimeout(() => {
                this.sendTestMessage(msg, i > 0 ? 2000 : 0);
            }, i * 2500);
        });
    }

    sendTestMessage(text, delayMs = 0) {
        if (!this.isConnected || !this.vectorClock) return;
        
        const vectorClock = this.vectorClock.increment();
        
        const message = {
            type: 'chat',
            text: text,
            vectorClock: vectorClock,
            metadata: {
                simulateDelay: delayMs > 0,
                delayMs: delayMs,
                isTest: true
            }
        };
        
        this.ws.send(JSON.stringify(message));
        console.log(`Sent test message with ${delayMs}ms delay: ${text}`);
    }

    clearChat() {
        if (confirm('Are you sure you want to clear all messages?')) {
            this.messages = [];
            this.causalEngine.reset();
            this.bufferedMessages = [];
            this.ui.clearMessages();
            this.updateDisplay();
            this.ui.showNotification('Chat cleared', 'info');
        }
    }

    showHelp() {
        document.getElementById('helpModal').classList.add('active');
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
        }
        this.isConnected = false;
        this.updateConnectionStatus('Disconnected');
        this.resetConnectionUI();
        this.ui.showNotification('Disconnected from server', 'warning');
    }

    resetConnectionUI() {
        document.getElementById('connectBtn').innerHTML = '<i class="fas fa-plug"></i> Connect';
        document.getElementById('connectBtn').disabled = false;
        document.getElementById('connectBtn').onclick = () => this.connect();
        
        document.getElementById('usernameInput').disabled = false;
        document.getElementById('messageInput').disabled = true;
        document.getElementById('sendBtn').disabled = true;
        
        this.typingUsers.clear();
        this.ui.updateTypingIndicator(this.typingUsers);
    }

    debugInfo() {
        console.group('=== DEBUG INFO ===');
        console.log('User ID:', this.userId);
        console.log('Username:', this.username);
        console.log('Connected:', this.isConnected);
        console.log('Users online:', this.users.size);
        console.log('Messages:', this.messages.length);
        console.log('Buffered:', this.bufferedMessages.length);
        
        if (this.vectorClock) {
            console.log('Vector Clock:', Array.from(this.vectorClock.clock.entries()));
        }
        
        console.groupEnd();
    }
}

// Initialize the application when the page loads
window.addEventListener('load', () => {
    console.log('Initializing Causal Chat App...');
    window.chatApp = new CausalChatApp();
    
    // Add animation styles
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideInRight {
            from {
                opacity: 0;
                transform: translateX(30px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }
        
        @keyframes slideInLeft {
            from {
                opacity: 0;
                transform: translateX(-30px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }
        
        .message {
            animation-duration: 0.3s;
            animation-fill-mode: both;
        }
        
        /* Debug panel */
        .debug-panel {
            position: fixed;
            bottom: 10px;
            left: 10px;
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 10px;
            border-radius: 5px;
            font-size: 12px;
            z-index: 10000;
        }
    `;
    document.head.appendChild(style);
    
    // Add debug button
    const debugBtn = document.createElement('button');
    debugBtn.textContent = 'Debug';
    debugBtn.style.position = 'fixed';
    debugBtn.style.bottom = '10px';
    debugBtn.style.right = '10px';
    debugBtn.style.zIndex = '10000';
    debugBtn.style.padding = '5px 10px';
    debugBtn.style.background = '#f0f0f0';
    debugBtn.style.border = '1px solid #ccc';
    debugBtn.style.borderRadius = '3px';
    debugBtn.style.cursor = 'pointer';
    debugBtn.onclick = () => window.chatApp.debugInfo();
    document.body.appendChild(debugBtn);
    
    console.log('Causal Chat App ready!');
});