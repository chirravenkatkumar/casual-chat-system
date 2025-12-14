# Causal Chat System with Vector Clocks

A real-time chat application that demonstrates causal ordering using vector clocks in distributed systems.

## Features

- Real-time chat with multiple users
- Vector clocks for tracking causal relationships
- Causal ordering of messages (not arrival-time ordering)
- Message buffering for causally unready messages
- Network delay simulation
- Visual display of vector clocks
- Online user list

## How It Works

1. **Vector Clocks**: Each user maintains a vector [time_user1, time_user2, ...]
2. **Sending**: Increment your own counter, attach vector to message
3. **Receiving**: Compare vector timestamps, display only when causally ready
4. **Causal Ordering**: Messages appear in causal order, not arrival order

## Setup Instructions

### 1. Install Backend Dependencies
```bash
cd backend
npm install