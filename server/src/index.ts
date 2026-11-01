import { createServer } from 'node:http'
import { randomInt, randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT ?? 3001)
const PAIRING_TTL_MS = 5 * 60 * 1000

type PeerRole = 'sender' | 'receiver'

type ClientMessage =
  | { type: 'create-session' }
  | { type: 'join-session'; code: string }
  | { type: 'webrtc-offer'; offer: unknown }
  | { type: 'webrtc-answer'; answer: unknown }
  | { type: 'webrtc-ice-candidate'; candidate: unknown }

type Session = {
  code: string
  receiver: WebSocket
  sender?: WebSocket
  expiresAt: number
}

const server = createServer()
const wss = new WebSocketServer({ server })

const sessions = new Map<string, Session>()
const clientSessions = new Map<WebSocket, string>()
const clientRoles = new Map<WebSocket, PeerRole>()

function sendJson(
  socket: WebSocket,
  message: Record<string, unknown>,
) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message))
  }
}

function forwardToPeer(
  socket: WebSocket,
  message: Record<string, unknown>,
) {
  const code = clientSessions.get(socket)

  if (!code) {
    sendJson(socket, {
      type: 'error',
      message: 'You are not connected to a session.',
    })
    return
  }

  const session = sessions.get(code)

  if (!session) {
    sendJson(socket, {
      type: 'error',
      message: 'The session no longer exists.',
    })
    return
  }

  const peer =
    session.receiver === socket
      ? session.sender
      : session.sender === socket
        ? session.receiver
        : undefined

  if (!peer || peer.readyState !== WebSocket.OPEN) {
    sendJson(socket, {
      type: 'error',
      message: 'The other device is not connected.',
    })
    return
  }

  sendJson(peer, message)
}

function generatePairingCode(): string {
  return String(randomInt(100000, 1000000))
}

function createUniquePairingCode(): string {
  let code: string

  do {
    code = generatePairingCode()
  } while (sessions.has(code))

  return code
}

function removeSession(code: string, reason: string) {
  const session = sessions.get(code)

  if (!session) return

  sessions.delete(code)

  for (const peer of [session.receiver, session.sender]) {
    if (!peer) continue

    clientSessions.delete(peer)
    clientRoles.delete(peer)

    sendJson(peer, {
      type: 'session-ended',
      reason,
    })
  }
}

function handleDisconnect(socket: WebSocket) {
  const code = clientSessions.get(socket)

  if (!code) return

  const session = sessions.get(code)

  if (!session) {
    clientSessions.delete(socket)
    clientRoles.delete(socket)
    return
  }

  if (session.receiver === socket) {
    removeSession(code, 'The receiving device disconnected.')
    return
  }

  if (session.sender === socket) {
    session.sender = undefined

    clientSessions.delete(socket)
    clientRoles.delete(socket)

    sendJson(session.receiver, {
      type: 'peer-disconnected',
    })
  }
}

function handleMessage(socket: WebSocket, raw: Buffer) {
  let message: ClientMessage

  try {
    message = JSON.parse(raw.toString()) as ClientMessage
  } catch {
    sendJson(socket, {
      type: 'error',
      message: 'Invalid JSON message.',
    })
    return
  }

  if (!message || typeof message.type !== 'string') {
    sendJson(socket, {
      type: 'error',
      message: 'Invalid message format.',
    })
    return
  }

  if (message.type === 'create-session') {
    if (clientSessions.has(socket)) {
      sendJson(socket, {
        type: 'error',
        message: 'This connection already belongs to a session.',
      })
      return
    }

    const code = createUniquePairingCode()

    const session: Session = {
      code,
      receiver: socket,
      expiresAt: Date.now() + PAIRING_TTL_MS,
    }

    sessions.set(code, session)
    clientSessions.set(socket, code)
    clientRoles.set(socket, 'receiver')

    sendJson(socket, {
      type: 'session-created',
      code,
      expiresInSeconds: PAIRING_TTL_MS / 1000,
    })

    return
  }

  if (message.type === 'join-session') {
    if (clientSessions.has(socket)) {
      sendJson(socket, {
        type: 'error',
        message: 'This connection already belongs to a session.',
      })
      return
    }

    if (typeof message.code !== 'string' || !/^\d{6}$/.test(message.code)) {
      sendJson(socket, {
        type: 'error',
        message: 'Enter a valid six-digit pairing code.',
      })
      return
    }

    const session = sessions.get(message.code)

    if (!session || session.expiresAt <= Date.now()) {
      if (session) {
        removeSession(message.code, 'The pairing code expired.')
      }

      sendJson(socket, {
        type: 'error',
        message: 'Pairing code not found or expired.',
      })
      return
    }

    if (session.sender) {
      sendJson(socket, {
        type: 'error',
        message: 'Another device has already joined this session.',
      })
      return
    }

    session.sender = socket

    clientSessions.set(socket, message.code)
    clientRoles.set(socket, 'sender')

    sendJson(socket, {
      type: 'session-joined',
      message: 'Successfully joined the session.',
    })

    sendJson(session.receiver, {
      type: 'peer-joined',
      message: 'Another device has joined.',
    })

    return
  }

    if (message.type === 'webrtc-offer') {
    if (!message.offer || typeof message.offer !== 'object') {
      sendJson(socket, {
        type: 'error',
        message: 'Invalid WebRTC offer.',
      })
      return
    }

    forwardToPeer(socket, {
      type: 'webrtc-offer',
      offer: message.offer,
    })

    return
  }

  if (message.type === 'webrtc-answer') {
    if (!message.answer || typeof message.answer !== 'object') {
      sendJson(socket, {
        type: 'error',
        message: 'Invalid WebRTC answer.',
      })
      return
    }

    forwardToPeer(socket, {
      type: 'webrtc-answer',
      answer: message.answer,
    })

    return
  }

  if (message.type === 'webrtc-ice-candidate') {
    if (
      message.candidate === undefined ||
      message.candidate === null ||
      typeof message.candidate !== 'object'
    ) {
      sendJson(socket, {
        type: 'error',
        message: 'Invalid ICE candidate.',
      })
      return
    }

    forwardToPeer(socket, {
      type: 'webrtc-ice-candidate',
      candidate: message.candidate,
    })

    return
  }

  sendJson(socket, {
    type: 'error',
    message: 'Unsupported message type.',
  })
}

wss.on('connection', (socket) => {
  socket.on('message', (raw: Buffer) => {
    handleMessage(socket, raw)
  })

  socket.on('close', () => {
    handleDisconnect(socket)
  })

  socket.on('error', () => {
    handleDisconnect(socket)
  })
})

// Expire unused pairing sessions automatically.
const cleanupTimer = setInterval(() => {
  for (const [code, session] of sessions) {
    if (session.expiresAt <= Date.now()) {
      removeSession(code, 'The pairing code expired.')
    }
  }
}, 10_000)

cleanupTimer.unref()

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NearShare signaling server listening on port ${PORT}`)
})

process.on('SIGINT', () => {
  clearInterval(cleanupTimer)

  for (const code of sessions.keys()) {
    removeSession(code, 'The server is shutting down.')
  }

  wss.close()
  server.close(() => process.exit(0))
})