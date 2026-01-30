const WebSocket = require('ws');
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Раздаем статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Запускаем HTTP сервер
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// WebSocket сервер
const wss = new WebSocket.Server({ server });
const rooms = {}; // { roomId: [клиенты] }
const clients = {}; // { ws: { roomId, userId, nick } }

wss.on('connection', (ws) => {
    console.log('New client connected');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received:', data.type);
            
            switch(data.type) {
                case 'join':
                    handleJoin(ws, data);
                    break;
                case 'signal':
                    handleSignal(ws, data);
                    break;
                case 'chat':
                    handleChat(ws, data);
                    break;
                case 'leave':
                    handleLeave(ws);
                    break;
            }
        } catch (err) {
            console.error('Error parsing message:', err);
        }
    });
    
    ws.on('close', () => {
        handleLeave(ws);
        console.log('Client disconnected');
    });
});

function handleJoin(ws, data) {
    const { roomId, userId, nick } = data;
    
    if (!rooms[roomId]) {
        rooms[roomId] = [];
    }
    
    // Сохраняем информацию о клиенте
    clients[ws] = { roomId, userId, nick };
    rooms[roomId].push({ ws, userId, nick });
    
    // Отправляем список участников новому пользователю
    const usersInRoom = rooms[roomId].map(client => ({
        userId: client.userId,
        nick: client.nick
    }));
    
    ws.send(JSON.stringify({
        type: 'joined',
        users: usersInRoom,
        yourId: userId
    }));
    
    // Уведомляем других участников о новом пользователе
    rooms[roomId].forEach(client => {
        if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({
                type: 'user-joined',
                userId,
                nick
            }));
        }
    });
    
    console.log(`${nick} joined room ${roomId}`);
}

function handleSignal(ws, data) {
    const client = clients[ws];
    if (!client) return;
    
    const { to, signal } = data;
    
    // Находим получателя
    const room = rooms[client.roomId];
    if (!room) return;
    
    room.forEach(clientInRoom => {
        if (clientInRoom.userId === to && clientInRoom.ws.readyState === WebSocket.OPEN) {
            clientInRoom.ws.send(JSON.stringify({
                type: 'signal',
                from: client.userId,
                signal: signal
            }));
        }
    });
}

function handleChat(ws, data) {
    const client = clients[ws];
    if (!client) return;
    
    const { message } = data;
    const room = rooms[client.roomId];
    if (!room) return;
    
    // Рассылаем сообщение всем в комнате
    room.forEach(clientInRoom => {
        if (clientInRoom.ws.readyState === WebSocket.OPEN) {
            clientInRoom.ws.send(JSON.stringify({
                type: 'chat',
                from: client.userId,
                fromNick: client.nick,
                message,
                timestamp: Date.now()
            }));
        }
    });
}

function handleLeave(ws) {
    const client = clients[ws];
    if (!client) return;
    
    const { roomId, userId } = client;
    
    // Удаляем из комнаты
    if (rooms[roomId]) {
        rooms[roomId] = rooms[roomId].filter(c => c.ws !== ws);
        
        // Если комната пустая, удаляем ее
        if (rooms[roomId].length === 0) {
            delete rooms[roomId];
        } else {
            // Уведомляем остальных
            rooms[roomId].forEach(clientInRoom => {
                if (clientInRoom.ws.readyState === WebSocket.OPEN) {
                    clientInRoom.ws.send(JSON.stringify({
                        type: 'user-left',
                        userId
                    }));
                }
            });
        }
    }
    
    // Удаляем клиента
    delete clients[ws];
    
    console.log(`${userId} left room ${roomId}`);
}
