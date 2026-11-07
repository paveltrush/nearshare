import { useEffect, useRef, useState } from 'react'

import './App.css'

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  `ws://${window.location.hostname}:3001`

type Screen = 'home' | 'send' | 'receive'
type SenderStep = 'connect' | 'files' | 'success'
type SentFile = { name: string; size: number }



type ServerMessage = {

  type: string

  code?: string

  message?: string

  reason?: string

  expiresInSeconds?: number

  offer?: RTCSessionDescriptionInit

  answer?: RTCSessionDescriptionInit

  candidate?: RTCIceCandidateInit

}



type TransferMessage =

  | { type: 'file-start'; name: string; size: number; mimeType: string }

  | { type: 'file-end' }

  | { type: 'session-end'; reason?: 'sender-disconnected' }



type IncomingFile = {

  name: string

  size: number

  mimeType: string

  chunks: BlobPart[]

  receivedBytes: number

}



const CHUNK_SIZE = 64 * 1024

const RTC_CONFIG: RTCConfiguration = {

  // STUN helps browsers discover possible direct routes. No TURN relay is configured.

  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],

}

type SenderRecovery = {
  code: string
  expiresAt: number
  senderStep: SenderStep
}

const SENDER_RECOVERY_KEY = 'nearshare.sender-recovery'
const SENDER_RECOVERY_WINDOW_MS = 120_000
const SENDER_RETRY_DELAY_MS = 1_500

const FILES_DB_NAME = 'nearshare-local-state'
const FILES_DB_VERSION = 1
const FILES_STORE_NAME = 'app-state'
const SELECTED_FILES_KEY = 'sender-selected-files'

type StoredFileRecord = {
  name: string
  type: string
  lastModified: number
  blob: Blob
}

function readSenderRecovery(): SenderRecovery | null {
  try {
    const raw = window.localStorage.getItem(SENDER_RECOVERY_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<SenderRecovery>
    if (
      typeof parsed.code !== 'string' ||
      !/^\d{6}$/.test(parsed.code) ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= Date.now()
    ) {
      window.localStorage.removeItem(SENDER_RECOVERY_KEY)
      void clearPersistedFiles()
      return null
    }

    return {
      code: parsed.code,
      expiresAt: parsed.expiresAt,
      senderStep: parsed.senderStep === 'success' ? 'success' : 'files',
    }
  } catch {
    return null
  }
}

function saveSenderRecovery(code: string, senderStep: SenderStep, refreshWindow = false) {
  try {
    const current = readSenderRecovery()
    const expiresAt =
      !refreshWindow && current?.code === code
        ? current.expiresAt
        : Date.now() + SENDER_RECOVERY_WINDOW_MS

    window.localStorage.setItem(
      SENDER_RECOVERY_KEY,
      JSON.stringify({ code, expiresAt, senderStep }),
    )
  } catch {
    // Recovery is best-effort when browser storage is unavailable.
  }
}

function clearSenderRecovery() {
  try {
    window.localStorage.removeItem(SENDER_RECOVERY_KEY)
  } catch {
    // Ignore unavailable browser storage.
  }
}

function openFilesDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is unavailable'))
      return
    }

    const request = window.indexedDB.open(FILES_DB_NAME, FILES_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(FILES_STORE_NAME)) {
        db.createObjectStore(FILES_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open local file storage'))
  })
}

async function persistSelectedFiles(files: File[]): Promise<void> {
  const db = await openFilesDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(FILES_STORE_NAME, 'readwrite')
      const records: StoredFileRecord[] = files.map((file) => ({
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        blob: file,
      }))
      transaction.objectStore(FILES_STORE_NAME).put(records, SELECTED_FILES_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save selected files'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Saving selected files was aborted'))
    })
  } finally {
    db.close()
  }
}

async function restoreSelectedFiles(): Promise<File[]> {
  const db = await openFilesDatabase()
  try {
    return await new Promise<File[]>((resolve, reject) => {
      const transaction = db.transaction(FILES_STORE_NAME, 'readonly')
      const request = transaction.objectStore(FILES_STORE_NAME).get(SELECTED_FILES_KEY)
      request.onsuccess = () => {
        const records = request.result as StoredFileRecord[] | undefined
        resolve(
          (records ?? []).map(
            (record) =>
              new File([record.blob], record.name, {
                type: record.type,
                lastModified: record.lastModified,
              }),
          ),
        )
      }
      request.onerror = () => reject(request.error ?? new Error('Could not restore selected files'))
    })
  } finally {
    db.close()
  }
}

async function clearPersistedFiles(): Promise<void> {
  try {
    const db = await openFilesDatabase()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(FILES_STORE_NAME, 'readwrite')
        transaction.objectStore(FILES_STORE_NAME).delete(SELECTED_FILES_KEY)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear local file storage'))
        transaction.onabort = () => reject(transaction.error ?? new Error('Clearing local file storage was aborted'))
      })
    } finally {
      db.close()
    }
  } catch {
    // Ignore unavailable or blocked local storage.
  }
}


function App() {
  const [initialRecovery] = useState<SenderRecovery | null>(() => readSenderRecovery())

  const [screen, setScreen] = useState<Screen>(() => initialRecovery ? 'send' : 'home')

  const [files, setFiles] = useState<File[]>([])
  const [senderStep, setSenderStep] = useState<SenderStep>(() => initialRecovery?.senderStep ?? 'connect')
  const [sentFiles, setSentFiles] = useState<SentFile[]>([])
  const [isSending, setIsSending] = useState(false)

  const [pairingCode, setPairingCode] = useState('')
  const [codeExpiresAt, setCodeExpiresAt] = useState<number | null>(null)
  const [codeSecondsLeft, setCodeSecondsLeft] = useState(0)

  const [enteredCode, setEnteredCode] = useState(() => initialRecovery?.code ?? '')

  const [connectionStatus, setConnectionStatus] = useState(initialRecovery ? 'Reconnecting...' : 'Ready to connect')

  const [pairingStatus, setPairingStatus] = useState(initialRecovery ? 'Restoring your previous connection...' : '')

  const [error, setError] = useState('')

  const [peerJoined, setPeerJoined] = useState(false)

  const [dataChannelReady, setDataChannelReady] = useState(false)

  const [transferStatus, setTransferStatus] = useState('')

  const [transferProgress, setTransferProgress] = useState(0)

  const [receivedFiles, setReceivedFiles] = useState<string[]>([])



  const fileInputRef = useRef<HTMLInputElement>(null)

  const socketRef = useRef<WebSocket | null>(null)

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)

  const dataChannelRef = useRef<RTCDataChannel | null>(null)

  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([])

  const incomingFileRef = useRef<IncomingFile | null>(null)

  const transferBusyRef = useRef(false)
  const activeSenderCodeRef = useRef(initialRecovery?.code ?? '')
  const sessionActiveRef = useRef(Boolean(initialRecovery))
  const intentionalDisconnectRef = useRef(false)
  const recoveryAttemptRef = useRef(false)
  const recoveryStartedRef = useRef(false)
  const retryTimerRef = useRef<number | null>(null)
  const channelErrorTimerRef = useRef<number | null>(null)
  const screenRef = useRef(screen)
  const senderStepRef = useRef(senderStep)
  screenRef.current = screen
  senderStepRef.current = senderStep

  useEffect(() => {
    if (!initialRecovery || recoveryStartedRef.current) return
    recoveryStartedRef.current = true

    if (initialRecovery.expiresAt <= Date.now()) {
      clearSenderRecovery()
      sessionActiveRef.current = false
      activeSenderCodeRef.current = ''
      setSenderStep('connect')
      setError('The previous connection recovery period expired. Ask the receiving device for a new pairing code.')
      return
    }

    intentionalDisconnectRef.current = false
    recoveryAttemptRef.current = true
    activeSenderCodeRef.current = initialRecovery.code
    sessionActiveRef.current = true
    setPairingStatus('Restoring your previous connection...')
    setConnectionStatus('Reconnecting...')

    void restoreSelectedFiles()
      .then((restoredFiles) => {
        setFiles((currentFiles) => {
          const mergedFiles = [...restoredFiles]
          for (const currentFile of currentFiles) {
            const alreadyRestored = mergedFiles.some(
              (file) =>
                file.name === currentFile.name &&
                file.size === currentFile.size &&
                file.lastModified === currentFile.lastModified,
            )
            if (!alreadyRestored) mergedFiles.push(currentFile)
          }
          void persistSelectedFiles(mergedFiles).catch(() => {
            // Restored files remain available for this page load even if persistence is unavailable.
          })
          return mergedFiles
        })
      })
      .catch(() => {
        setError('Your connection is being restored, but the browser could not restore the previously selected files. Please select them again.')
      })

    startSenderSocket(initialRecovery.code, true)
  }, [])

  useEffect(() => {
    const markSenderForRecovery = () => {
      const code = activeSenderCodeRef.current
      if (
        screenRef.current === 'send' &&
        senderStepRef.current !== 'success' &&
        sessionActiveRef.current &&
        !intentionalDisconnectRef.current &&
        /^\d{6}$/.test(code)
      ) {
        saveSenderRecovery(code, senderStepRef.current === 'connect' ? 'connect' : 'files', true)
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        markSenderForRecovery()
        return
      }

      if (document.visibilityState === 'visible') {
        const recovery = readSenderRecovery()
        if (
          recovery &&
          screenRef.current === 'send' &&
          !intentionalDisconnectRef.current
        ) {
          recoverSenderConnection(recovery.code)
        }
      }
    }

    const handlePageShow = () => {
      const recovery = readSenderRecovery()
      if (
        recovery &&
        screenRef.current === 'send' &&
        !intentionalDisconnectRef.current
      ) {
        recoverSenderConnection(recovery.code)
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', markSenderForRecovery)
    window.addEventListener('pageshow', handlePageShow)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', markSenderForRecovery)
      window.removeEventListener('pageshow', handlePageShow)
    }
  }, [])

  // The pairing code expires while waiting for the first device to join.
  // Once paired, this timer stops; the active session remains open until disconnect.
  useEffect(() => {
    if (screen !== 'receive' || codeExpiresAt === null || peerJoined) return

    const expireIfNeeded = () => {
      const secondsRemaining = Math.ceil((codeExpiresAt - Date.now()) / 1000)
      setCodeSecondsLeft(Math.max(0, secondsRemaining))
      if (secondsRemaining > 0) return

      // Closing the receiver socket notifies the server that this waiting session ended.
      const socket = socketRef.current
      socketRef.current = null
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close()
      }

      closePeerConnection()
      setPairingCode('')
      setCodeExpiresAt(null)
      setPairingStatus('This pairing code has expired. Return home and start a new receiving session.')
      setConnectionStatus('Code expired')
    }

    expireIfNeeded()
    const intervalId = window.setInterval(expireIfNeeded, 1000)
    return () => window.clearInterval(intervalId)
  }, [screen, codeExpiresAt, peerJoined])

  useEffect(() => {
    if (screen === 'send' && dataChannelReady && senderStep === 'connect') {
      setSenderStep('files')
      setError('')
    }
  }, [screen, dataChannelReady, senderStep])

  useEffect(() => {

    if (screen !== 'receive') return



    setPairingCode('')
    setCodeExpiresAt(null)
    setCodeSecondsLeft(0)

    setPairingStatus('Connecting to signaling server...')

    setConnectionStatus('Connecting...')

    setError('')

    setPeerJoined(false)

    setDataChannelReady(false)

    setTransferStatus('')

    setTransferProgress(0)

    setReceivedFiles([])



    const socket = new WebSocket(SIGNALING_URL)

    socketRef.current = socket



    socket.onopen = () => {

      setConnectionStatus('Waiting for device')

      setPairingStatus('Creating your pairing code...')

      socket.send(JSON.stringify({ type: 'create-session' }))

    }



    socket.onmessage = (event) => {

      void handleServerMessage(event.data)

    }



    socket.onerror = () => {

      setError('Could not connect to the signaling server.')

      setConnectionStatus('Connection failed')

      setPairingStatus('')

    }



    socket.onclose = () => {

      if (socketRef.current === socket) {

        socketRef.current = null

        setConnectionStatus('Disconnected')

      }

    }



    return () => {

      socket.onopen = null

      socket.onmessage = null

      socket.onerror = null

      socket.onclose = null

      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {

        socket.close()

      }

      if (socketRef.current === socket) socketRef.current = null

      closePeerConnection()

    }

    // Screen changes intentionally create/tear down the receiving session.

    // eslint-disable-next-line react-hooks/exhaustive-deps

  }, [screen])



  function sendSignalingMessage(message: Record<string, unknown>) {

    const socket = socketRef.current

    if (!socket || socket.readyState !== WebSocket.OPEN) {

      setError('The signaling connection is not available. Reconnect and try again.')

      return

    }

    socket.send(JSON.stringify(message))

  }



  function clearChannelErrorTimer() {
    if (channelErrorTimerRef.current !== null) {
      window.clearTimeout(channelErrorTimerRef.current)
      channelErrorTimerRef.current = null
    }
  }


  function closePeerConnection() {

    clearChannelErrorTimer()

    const channel = dataChannelRef.current
    dataChannelRef.current = null
    if (channel) {
      // Detach callbacks before a deliberate local close. Closing a data
      // channel is a normal part of disconnecting, not a transfer failure.
      channel.onopen = null
      channel.onclose = null
      channel.onerror = null
      channel.onmessage = null
      channel.close()
    }

    peerConnectionRef.current?.close()

    peerConnectionRef.current = null

    pendingCandidatesRef.current = []

    setDataChannelReady(false)

  }



  function setupDataChannel(channel: RTCDataChannel) {

    dataChannelRef.current = channel

    channel.binaryType = 'arraybuffer'



    channel.onopen = () => {

      clearChannelErrorTimer()
      setDataChannelReady(true)

      setConnectionStatus('Direct connection ready')

      setPairingStatus('Secure direct connection established.')

      setError('')

    }



    channel.onclose = () => {

      clearChannelErrorTimer()
      setDataChannelReady(false)

      // A remote user pressing Disconnect closes the DataChannel normally.
      // The signaling socket will provide the user-facing disconnect status.
      if (screenRef.current === 'receive') {
        setError('')
      }
      setConnectionStatus('Transfer connection closed')

    }



    channel.onerror = () => {

      // Some browsers emit an RTCDataChannel error as the remote peer is
      // shutting down. Wait briefly for the normal close/disconnect signal
      // before presenting an actual transfer error.
      clearChannelErrorTimer()
      channelErrorTimerRef.current = window.setTimeout(() => {
        channelErrorTimerRef.current = null
        const currentPeer = peerConnectionRef.current
        if (
          dataChannelRef.current !== channel ||
          channel.readyState !== 'open' ||
          !currentPeer ||
          currentPeer.connectionState !== 'connected'
        ) {
          return
        }
        setError('The direct transfer connection encountered an error.')
      }, 1000)

    }



    channel.onmessage = (event: MessageEvent) => {

      void handleDataChannelMessage(event.data)

    }

  }



  function createPeerConnection(): RTCPeerConnection {

    closePeerConnection()

    const pc = new RTCPeerConnection(RTC_CONFIG)

    peerConnectionRef.current = pc



    pc.onicecandidate = (event) => {

      if (event.candidate) {

        sendSignalingMessage({

          type: 'webrtc-ice-candidate',

          candidate: event.candidate.toJSON(),

        })

      }

    }



    pc.onconnectionstatechange = () => {

      if (pc.connectionState === 'failed') {

        setError('Could not establish a direct connection. This network may require a TURN relay.')

        setConnectionStatus('Direct connection failed')

      } else if (pc.connectionState === 'disconnected') {

        setConnectionStatus('Connection interrupted')

      } else if (pc.connectionState === 'connecting') {

        setConnectionStatus('Establishing direct connection...')

      }

    }



    return pc

  }



  async function createOffer() {

    try {

      const pc = createPeerConnection()

      const channel = pc.createDataChannel('nearshare-files')

      setupDataChannel(channel)

      const offer = await pc.createOffer()

      await pc.setLocalDescription(offer)

      sendSignalingMessage({ type: 'webrtc-offer', offer: pc.localDescription })

      setConnectionStatus('Establishing direct connection...')

      setPairingStatus('Paired. Establishing direct connection...')

    } catch (err) {

      setError(getErrorMessage(err, 'Could not start the direct connection.'))

    }

  }



  async function handleServerMessage(rawMessage: string) {

    let message: ServerMessage

    try {

      message = JSON.parse(rawMessage) as ServerMessage

    } catch {

      setError('Received an invalid response from the server.')

      return

    }



    switch (message.type) {

      case 'session-created': {

        setPairingCode(message.code ?? '')
        const validitySeconds = Math.max(0, message.expiresInSeconds ?? 300)
        const expiresAt = Date.now() + validitySeconds * 1000
        setCodeExpiresAt(expiresAt)
        setCodeSecondsLeft(validitySeconds)

        setPairingStatus('Share this code with the sending device.')

        setConnectionStatus('Waiting for device')

        break
      }


      case 'session-joined':

        sessionActiveRef.current = true
        recoveryAttemptRef.current = false
        clearSenderRecovery()
        setPairingStatus('Joined the session. Waiting for direct connection...')

        setConnectionStatus('Paired; connecting directly...')

        break



      case 'peer-joined':

        setPeerJoined(true)
        setCodeExpiresAt(null)
        setCodeSecondsLeft(0)

        setPairingStatus('Another device has joined. Establishing direct connection...')

        setConnectionStatus('Paired; connecting directly...')

        await createOffer()

        break



      case 'webrtc-offer': {

        if (!message.offer) {

          setError('The other device sent an invalid connection offer.')

          break

        }

        try {

          const pc = createPeerConnection()

          pc.ondatachannel = (event) => setupDataChannel(event.channel)

          await pc.setRemoteDescription(message.offer)

          for (const candidate of pendingCandidatesRef.current) {

            await pc.addIceCandidate(candidate)

          }

          pendingCandidatesRef.current = []

          const answer = await pc.createAnswer()

          await pc.setLocalDescription(answer)

          sendSignalingMessage({ type: 'webrtc-answer', answer: pc.localDescription })

          setConnectionStatus('Establishing direct connection...')

        } catch (err) {

          setError(getErrorMessage(err, 'Could not answer the connection offer.'))

        }

        break

      }



      case 'webrtc-answer': {

        if (!message.answer) {

          setError('The other device sent an invalid connection answer.')

          break

        }

        try {

          const pc = peerConnectionRef.current

          if (!pc) break

          await pc.setRemoteDescription(message.answer)

          for (const candidate of pendingCandidatesRef.current) {

            await pc.addIceCandidate(candidate)

          }

          pendingCandidatesRef.current = []

        } catch (err) {

          setError(getErrorMessage(err, 'Could not apply the connection answer.'))

        }

        break

      }



      case 'webrtc-ice-candidate': {

        if (!message.candidate) break

        const pc = peerConnectionRef.current

        if (!pc || !pc.remoteDescription) {

          pendingCandidatesRef.current.push(message.candidate)

        } else {

          try {

            await pc.addIceCandidate(message.candidate)

          } catch (err) {

            setError(getErrorMessage(err, 'Could not add a network candidate.'))

          }

        }

        break

      }



      case 'peer-disconnected':

        setPeerJoined(false)
        if (screen === 'receive') setError('')

        setPairingStatus(
          screen === 'receive'
            ? 'The sending device disconnected. NearShare will try to reconnect for up to two minutes. Keep this page open.'
            : 'The receiving device disconnected.',
        )

        setConnectionStatus('Waiting for device')

        if (screen === 'send') {
          clearSenderRecovery()
          sessionActiveRef.current = false
          activeSenderCodeRef.current = ''
          setError('The receiving device disconnected. Your completed transfer is safe, but you must connect to a new receiving session before sending more files.')
        }

        closePeerConnection()

        break



      case 'session-ended':

        if (screen === 'receive') setError('')
        clearSenderRecovery()
        sessionActiveRef.current = false
        activeSenderCodeRef.current = ''
        recoveryAttemptRef.current = false
        if (retryTimerRef.current !== null) {
          window.clearTimeout(retryTimerRef.current)
          retryTimerRef.current = null
        }

        setPeerJoined(false)

        setPairingCode('')

        setPairingStatus(message.reason ?? 'The session ended.')

        setConnectionStatus('Session ended')

        if (screen === 'send') {
          setError('The receiving device ended the session. Your completed transfer is safe, but you must enter a new pairing code to send more files.')
        }

        closePeerConnection()

        break



      case 'error':

        if (recoveryAttemptRef.current && screen === 'send') {
          const serverMessage = message.message ?? 'Could not restore the previous connection.'
          const sessionIsGone = /expired|not found|invalid|ended|no longer active|does not exist|no session|not active/i.test(serverMessage)

          closePeerConnection()

          if (sessionIsGone) {
            clearSenderRecovery()
            sessionActiveRef.current = false
            activeSenderCodeRef.current = ''
            recoveryAttemptRef.current = false
            if (retryTimerRef.current !== null) {
              window.clearTimeout(retryTimerRef.current)
              retryTimerRef.current = null
            }
            setSenderStep('connect')
            setConnectionStatus('Connection failed')
            setPairingStatus('The previous receiving session is no longer available. Ask the receiving device to create a new code.')
            setError(serverMessage)
          } else {
            setPairingStatus('Temporary connection problem. Trying again...')
            setConnectionStatus('Reconnecting...')
            const failedSocket = socketRef.current
            socketRef.current = null
            if (failedSocket) failedSocket.close()
            scheduleSenderRetry(activeSenderCodeRef.current)
          }
        } else {
          setError(message.message ?? 'Something went wrong.')
        }

        break



      default:

        break

    }

  }



  function connectToCode() {
    const normalizedCode = enteredCode.trim()

    if (!/^\d{6}$/.test(normalizedCode)) {
      setError('Please enter a valid six-digit pairing code.')
      return
    }

    intentionalDisconnectRef.current = false
    recoveryAttemptRef.current = false
    sessionActiveRef.current = false
    activeSenderCodeRef.current = normalizedCode
    clearSenderRecovery()

    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }

    setError('')
    setPairingStatus('Connecting to receiving device...')
    setConnectionStatus('Connecting...')
    setPeerJoined(false)
    closePeerConnection()

    startSenderSocket(normalizedCode, false)
  }

  function startSenderSocket(code: string, isRecovery: boolean) {
    if (intentionalDisconnectRef.current) return

    const connectFresh = () => {
      if (intentionalDisconnectRef.current) return

      recoveryAttemptRef.current = isRecovery
      setPairingStatus(
        isRecovery
          ? 'Restoring your previous connection...'
          : 'Connecting to receiving device...',
      )
      setConnectionStatus(isRecovery ? 'Reconnecting...' : 'Connecting...')

      const socket = new WebSocket(`ws://${window.location.hostname}:3001`)
      socketRef.current = socket

      socket.onopen = () => {
        if (socketRef.current !== socket) return
        socket.send(JSON.stringify({ type: 'join-session', code }))
      }

      socket.onmessage = (event) => {
        void handleServerMessage(event.data)
      }

      socket.onerror = () => {
        if (isRecovery) {
          setPairingStatus('Connection interrupted. Trying again...')
        } else {
          setError('Could not connect to the signaling server.')
          setConnectionStatus('Connection failed')
        }
      }

      socket.onclose = () => {
        if (socketRef.current !== socket) return

        socketRef.current = null
        setConnectionStatus('Disconnected')

        if (
          sessionActiveRef.current &&
          senderStepRef.current !== 'success' &&
          !intentionalDisconnectRef.current &&
          activeSenderCodeRef.current === code
        ) {
          saveSenderRecovery(code, senderStepRef.current === 'connect' ? 'connect' : 'files')
          scheduleSenderRetry(code)
        }
      }
    }

    const previousSocket = socketRef.current
    if (previousSocket && previousSocket.readyState !== WebSocket.CLOSED) {
      socketRef.current = null
      previousSocket.onopen = null
      previousSocket.onmessage = null
      previousSocket.onerror = null
      previousSocket.onclose = () => connectFresh()
      previousSocket.close()
      return
    }

    connectFresh()
  }

  function scheduleSenderRetry(code: string) {
    if (intentionalDisconnectRef.current || retryTimerRef.current !== null) return

    const recovery = readSenderRecovery()
    if (!recovery || recovery.code !== code || recovery.expiresAt <= Date.now()) {
      clearSenderRecovery()
      sessionActiveRef.current = false
      activeSenderCodeRef.current = ''
      setSenderStep('connect')
      setConnectionStatus('Connection failed')
      setError('Automatic reconnection timed out. Ask the receiving device for a new pairing code.')
      return
    }

    setPairingStatus('Connection interrupted. Trying to reconnect...')
    setConnectionStatus('Reconnecting...')

    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null
      const latestRecovery = readSenderRecovery()
      if (
        latestRecovery &&
        latestRecovery.code === code &&
        latestRecovery.expiresAt > Date.now() &&
        !intentionalDisconnectRef.current
      ) {
        startSenderSocket(code, true)
      } else {
        clearSenderRecovery()
        sessionActiveRef.current = false
        activeSenderCodeRef.current = ''
        setSenderStep('connect')
        setConnectionStatus('Connection failed')
        setError('Automatic reconnection timed out. Ask the receiving device for a new pairing code.')
      }
    }, SENDER_RETRY_DELAY_MS)
  }

  function recoverSenderConnection(code: string) {
    if (
      screenRef.current !== 'send' ||
      intentionalDisconnectRef.current ||
      activeSenderCodeRef.current !== code
    ) {
      return
    }

    const recovery = readSenderRecovery()
    if (!recovery || recovery.code !== code || recovery.expiresAt <= Date.now()) {
      clearSenderRecovery()
      return
    }

    const socketState = socketRef.current?.readyState
    const channelState = dataChannelRef.current?.readyState
    const peerState = peerConnectionRef.current?.connectionState

    if (socketState === WebSocket.CONNECTING) {
      return
    }

    if (
      socketState === WebSocket.OPEN &&
      channelState === 'open' &&
      peerState === 'connected'
    ) {
      clearSenderRecovery()
      return
    }

    if (
      socketState === WebSocket.OPEN &&
      channelState !== 'closed' &&
      peerState !== 'failed' &&
      peerState !== 'closed'
    ) {
      return
    }

    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }

    closePeerConnection()
    startSenderSocket(code, true)
  }


  function disconnect() {

    // When the sender explicitly leaves, notify the receiver over the already
    // established WebRTC DataChannel. Unexpected socket/page interruptions do
    // not send this control message, so the receiver can keep its recovery flow.
    const activeChannel = dataChannelRef.current
    if (screenRef.current === 'send' && activeChannel?.readyState === 'open') {
      try {
        activeChannel.send(JSON.stringify({
          type: 'session-end',
          reason: 'sender-disconnected',
        } satisfies TransferMessage))
      } catch {
        // The receiver will still detect the peer's transport closing.
      }
    }

    // An explicit Disconnect click must never trigger automatic recovery.
    intentionalDisconnectRef.current = true
    sessionActiveRef.current = false
    activeSenderCodeRef.current = ''
    recoveryAttemptRef.current = false
    clearSenderRecovery()
    void clearPersistedFiles()

    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }

    const socket = socketRef.current

    socketRef.current = null

    if (screenRef.current === 'send' && activeChannel?.readyState === 'open') {
      // Give the reliable DataChannel control message a moment to reach the
      // receiver before the signaling socket closes and announces a peer drop.
      window.setTimeout(() => {
        if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
        closePeerConnection()
      }, 250)
    } else {
      if (socket) socket.close()
      closePeerConnection()
    }

    setPairingCode('')
    setCodeExpiresAt(null)
    setCodeSecondsLeft(0)

    setEnteredCode('')

    setPeerJoined(false)

    setPairingStatus('')

    setError('')

    setConnectionStatus('Ready to connect')

    setTransferStatus('')

    setTransferProgress(0)

    setReceivedFiles([])

    setSenderStep('connect')

    setSentFiles([])

    setIsSending(false)

    transferBusyRef.current = false

  }



  function handleFilesSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? [])
    setFiles((currentFiles) => {
      const newFiles = selectedFiles.filter(
        (newFile) =>
          !currentFiles.some(
            (existingFile) =>
              existingFile.name === newFile.name &&
              existingFile.size === newFile.size &&
              existingFile.lastModified === newFile.lastModified,
          ),
      )
      const updatedFiles = [...currentFiles, ...newFiles]
      void persistSelectedFiles(updatedFiles).catch(() => {
        // The transfer remains available even when local persistence is blocked.
      })
      return updatedFiles
    })
    event.target.value = ''
  }

  function removeFile(indexToRemove: number) {
    setFiles((currentFiles) => {
      const updatedFiles = currentFiles.filter((_, index) => index !== indexToRemove)
      void persistSelectedFiles(updatedFiles).catch(() => {
        // The transfer remains available even when local persistence is blocked.
      })
      return updatedFiles
    })
  }


  function openFilePicker() {
    const code = activeSenderCodeRef.current
    if (
      sessionActiveRef.current &&
      !intentionalDisconnectRef.current &&
      /^\d{6}$/.test(code)
    ) {
      // Save before launching Android's native picker, in case the browser reloads.
      saveSenderRecovery(code, 'files', true)
    }

    fileInputRef.current?.click()
  }


  function openScreen(nextScreen: Screen) {

    if (nextScreen === screen) return

    disconnect()

    setFiles([])
    void clearPersistedFiles()

    setScreen(nextScreen)

    if (nextScreen === 'send') setSenderStep('connect')

    if (fileInputRef.current) fileInputRef.current.value = ''

  }



  async function sendFiles() {

    const channel = dataChannelRef.current

    if (!channel || channel.readyState !== 'open') {

      setError('Wait until the direct connection is ready before sending files.')

      return

    }

    if (files.length === 0 || transferBusyRef.current) return



    transferBusyRef.current = true

    setIsSending(true)

    setError('')

    setTransferProgress(0)



    const totalBytes = files.reduce((total, file) => total + file.size, 0)

    let sentBytes = 0



    try {

      for (const file of files) {

        channel.send(JSON.stringify({

          type: 'file-start',

          name: file.name,

          size: file.size,

          mimeType: file.type || 'application/octet-stream',

        } satisfies TransferMessage))



        for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {

          await waitForDataChannelCapacity(channel)

          const buffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()

          channel.send(buffer)

          sentBytes += buffer.byteLength

          setTransferProgress(totalBytes === 0 ? 100 : Math.round((sentBytes / totalBytes) * 100))

        }



        channel.send(JSON.stringify({ type: 'file-end' } satisfies TransferMessage))

      }

      setTransferProgress(100)

      setSentFiles(files.map((file) => ({ name: file.name, size: file.size })))

      setTransferStatus(`Sent ${files.length} file${files.length === 1 ? '' : 's'} successfully.`)

      clearSenderRecovery()
      void clearPersistedFiles()
      setSenderStep('success')

    } catch (err) {

      setError(getErrorMessage(err, 'File transfer failed.'))

      setTransferStatus('Transfer failed.')

    } finally {

      transferBusyRef.current = false

      setIsSending(false)

    }

  }



  function sendMoreFiles() {
    setFiles([])
    void clearPersistedFiles()
    setSentFiles([])
    setTransferStatus('')
    setTransferProgress(0)
    if (fileInputRef.current) fileInputRef.current.value = ''

    const channel = dataChannelRef.current
    if (!dataChannelReady || !channel || channel.readyState !== 'open') {
      clearSenderRecovery()
      sessionActiveRef.current = false
      activeSenderCodeRef.current = ''
      setEnteredCode('')
      setError('The receiving device is no longer connected. Enter a new pairing code to continue.')
      setPairingStatus('Your previous transfer completed successfully. Connect to a new receiving session to send more files.')
      setSenderStep('connect')
      return
    }

    setError('')
    setSenderStep('files')
  }


  async function handleDataChannelMessage(data: unknown) {

    if (typeof data === 'string') {

      let message: TransferMessage

      try {

        message = JSON.parse(data) as TransferMessage

      } catch {

        setError('Received an invalid file-transfer message.')

        return

      }



      if (message.type === 'session-end') {
        // This is an explicit sender action, not a temporary picker/background
        // interruption. Return the receiving device to Home and release its
        // local socket and WebRTC resources.
        if (screenRef.current === 'receive') {
          setPairingStatus('The sending device disconnected.')
          setConnectionStatus('Session ended')
          openScreen('home')
        }
        return
      }

      if (message.type === 'file-start') {

        const start = message as Extract<TransferMessage, { type: 'file-start' }>

        incomingFileRef.current = {

          name: sanitizeFileName(start.name),

          size: Math.max(0, start.size),

          mimeType: start.mimeType || 'application/octet-stream',

          chunks: [],

          receivedBytes: 0,

        }

        setTransferStatus(`Receiving ${sanitizeFileName(start.name)}...`)

        setTransferProgress(0)

      } else if (message.type === 'file-end') {

        const incoming = incomingFileRef.current

        if (!incoming) return

        const blob = new Blob(incoming.chunks, { type: incoming.mimeType })

        downloadBlob(blob, incoming.name)

        setReceivedFiles((current) => [...current, incoming.name])

        setTransferStatus(`Received ${incoming.name} successfully.`)

        setTransferProgress(100)

        incomingFileRef.current = null

      }

      return

    }



    const incoming = incomingFileRef.current

    if (!incoming) {

      setError('Received file data without file metadata.')

      return

    }



    const chunk = data instanceof Blob ? data : new Blob([data as BlobPart])

    incoming.chunks.push(chunk)

    incoming.receivedBytes += chunk.size

    setTransferProgress(incoming.size === 0 ? 100 : Math.min(100, Math.round((incoming.receivedBytes / incoming.size) * 100)))

  }



  function waitForDataChannelCapacity(channel: RTCDataChannel): Promise<void> {

    const HIGH_WATER_MARK = 1024 * 1024

    if (channel.readyState !== 'open') {

      return Promise.reject(new Error('The direct connection closed during transfer.'))

    }

    if (channel.bufferedAmount < HIGH_WATER_MARK) return Promise.resolve()



    return new Promise((resolve, reject) => {

      const timeout = window.setTimeout(() => {

        cleanup()

        reject(new Error('Timed out while sending file data.'))

      }, 30_000)



      const cleanup = () => {

        window.clearTimeout(timeout)

        channel.removeEventListener('bufferedamountlow', onLow)

        channel.removeEventListener('close', onClose)

      }

      const onLow = () => {

        cleanup()

        resolve()

      }

      const onClose = () => {

        cleanup()

        reject(new Error('The direct connection closed during transfer.'))

      }



      channel.bufferedAmountLowThreshold = HIGH_WATER_MARK / 2

      channel.addEventListener('bufferedamountlow', onLow, { once: true })

      channel.addEventListener('close', onClose, { once: true })

    })

  }



  const totalSize = files.reduce((total, file) => total + file.size, 0)



  return (

    <div className="app">
      <style>{`
        .how-it-works {
          width: min(100%, 980px);
          margin: clamp(2.75rem, 6vw, 4.5rem) auto 0;
          text-align: left;
        }
        .how-it-works-heading {
          margin: 0 0 .45rem;
          font-size: clamp(1.35rem, 2.4vw, 1.75rem);
          line-height: 1.2;
        }
        .how-it-works-intro {
          margin: 0 0 1.4rem;
          color: #64748b;
          line-height: 1.6;
        }
        .how-it-works-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 1rem;
        }
        .how-it-works-card {
          min-width: 0;
          padding: 1rem;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          background: #fff;
          box-shadow: 0 5px 18px rgba(15, 23, 42, .045);
        }
        .how-it-works-art {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 112px;
          margin-bottom: .75rem;
          border-radius: 12px;
          background: linear-gradient(135deg, #f8fafc 0%, #eef2ff 100%);
          overflow: hidden;
        }
        .how-it-works-art svg { width: 100%; max-width: 250px; height: 112px; }
        .how-step-label {
          display: inline-flex;
          align-items: center;
          gap: .4rem;
          margin-bottom: .45rem;
          color: #475569;
          font-size: .75rem;
          font-weight: 700;
          letter-spacing: .07em;
          text-transform: uppercase;
        }
        .how-step-number {
          display: inline-grid;
          width: 1.35rem;
          height: 1.35rem;
          place-items: center;
          border-radius: 50%;
          background: #e0e7ff;
          color: #4338ca;
          font-size: .75rem;
          letter-spacing: 0;
        }
        .how-it-works-card h3 { margin: 0 0 .35rem; font-size: 1rem; }
        .how-it-works-card p { margin: 0; color: #64748b; font-size: .9rem; line-height: 1.55; }
        .step-instruction {
          display: flex;
          align-items: flex-start;
          gap: .8rem;
          margin: 1.15rem 0 1.35rem;
          padding: .9rem 1rem;
          border: 1px solid #dbeafe;
          border-radius: 12px;
          background: #f8fbff;
          color: #334155;
          text-align: left;
        }
        .step-instruction-icon {
          display: inline-grid;
          flex: 0 0 auto;
          width: 1.7rem;
          height: 1.7rem;
          place-items: center;
          border-radius: 50%;
          background: #dbeafe;
          color: #1d4ed8;
          font-weight: 700;
          font-size: .85rem;
        }
        .step-instruction strong { display: block; margin: 0 0 .15rem; font-size: .9rem; }
        .step-instruction p { margin: 0; color: #64748b; font-size: .875rem; line-height: 1.5; }
        .success-actions-note { margin: .85rem 0 1rem; color: #64748b; font-size: .875rem; line-height: 1.5; }
        @media (max-width: 720px) {
          .how-it-works-grid { grid-template-columns: 1fr; gap: .75rem; }
          .how-it-works-card { display: grid; grid-template-columns: 104px minmax(0, 1fr); align-items: center; column-gap: .9rem; padding: .8rem; }
          .how-it-works-art { grid-row: 1 / span 3; min-height: 92px; margin: 0; }
          .how-it-works-art svg { height: 92px; }
          .how-step-label { margin: 0 0 .25rem; }
        }
      `}</style>

      <header className="header">

        <button className="brand" onClick={() => openScreen('home')} aria-label="NearShare home">

          <span className="brand-icon">N</span>

          <span>NearShare</span>

        </button>

        <span className="connection-status">

          <span className="status-dot" />

          {connectionStatus}

        </span>

      </header>



      <main className="main">

        {screen === 'home' && (

          <section className="home-screen">

            <div className="eyebrow">SIMPLE. PRIVATE. DIRECT.</div>

            <h1>Your files.<br /><span className="heading-accent">Your devices.</span></h1>

            <p className="intro">Transfer files between your phone and computer. No accounts or complicated setup.</p>

            <div className="action-grid">

              <button className="action-card" onClick={() => openScreen('send')}>

                <span className="action-icon send-icon" aria-hidden="true">↑</span>

                <span className="action-title">Send files</span>

                <span className="action-description">Choose files to share with another device.</span>

                <span className="action-link">Choose files →</span>

              </button>

              <button className="action-card" onClick={() => openScreen('receive')}>

                <span className="action-icon receive-icon" aria-hidden="true">↓</span>

                <span className="action-title">Receive files</span>

                <span className="action-description">Connect another device and receive files.</span>

                <span className="action-link">Start receiving →</span>

              </button>

            </div>

            <section className="how-it-works" aria-labelledby="how-it-works-title">
              <h2 className="how-it-works-heading" id="how-it-works-title">How NearShare works</h2>
              <p className="how-it-works-intro">Three simple steps to move files between your devices.</p>
              <div className="how-it-works-grid">
                <article className="how-it-works-card">
                  <div className="how-it-works-art"><WorkflowIllustration kind="connect" /></div>
                  <div className="how-step-label"><span className="how-step-number">1</span> First, connect</div>
                  <h3>Pair your devices</h3>
                  <p>Choose Receive files on one device, then enter its six-digit code on the device sending files.</p>
                </article>
                <article className="how-it-works-card">
                  <div className="how-it-works-art"><WorkflowIllustration kind="choose" /></div>
                  <div className="how-step-label"><span className="how-step-number">2</span> Next, choose</div>
                  <h3>Select your files</h3>
                  <p>Pick documents, photos, videos, or other files from the device you want to send from.</p>
                </article>
                <article className="how-it-works-card">
                  <div className="how-it-works-art"><WorkflowIllustration kind="transfer" /></div>
                  <div className="how-step-label"><span className="how-step-number">3</span> Finally, transfer</div>
                  <h3>Send and receive</h3>
                  <p>Send your files. They transfer directly between the devices, and the receiving device downloads them.</p>
                </article>
              </div>
            </section>

            <div className="privacy-note"><span aria-hidden="true">◇</span><span>Designed for direct transfers between your devices.</span></div>

          </section>

        )}



        {screen === 'send' && (
          <section className="sub-screen">
            <button className="back-button" onClick={() => openScreen('home')}>← Back</button>

            <div className="eyebrow">
              {senderStep === 'connect' ? 'STEP 1 OF 3' : senderStep === 'files' ? 'STEP 2 OF 3' : 'STEP 3 OF 3'}
            </div>

            {senderStep === 'connect' && (
              <>
                <h1>Connect to a device</h1>
                <p className="intro">Enter the six-digit code displayed on the receiving device.</p>

                <div className="step-instruction">
                  <span className="step-instruction-icon">1</span>
                  <div><strong>On your receiving device</strong><p>Open NearShare, choose <b>Receive files</b>, and keep the screen with the pairing code open. Enter that code here.</p></div>
                </div>

                <div className="pairing-form">
                  <label htmlFor="pairing-code">Pairing code</label>
                  <input
                    id="pairing-code"
                    className="pairing-code-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="Enter 6-digit code"
                    value={enteredCode}
                    onChange={(event) => {
                      setEnteredCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                      setConnectionStatus('')
                      setError('')
                    }}
                  />
                  <button
                    className="connect-button"
                    onClick={connectToCode}
                    disabled={enteredCode.length !== 6 || connectionStatus === 'Connecting...'}
                  >
                    Connect to device
                  </button>
                </div>

                {pairingStatus && <p className="pairing-status" role="status">{pairingStatus}</p>}
                {connectionStatus === 'Establishing direct connection...' && (
                  <p className="pairing-status">Establishing secure direct connection...</p>
                )}
                {error && <p className="pairing-error" role="alert">{error}</p>}
              </>
            )}

            {senderStep === 'files' && (
              <>
                <h1>Add files</h1>
                <p className="intro">Your devices are connected. Choose the files you want to send.</p>
                <div className="step-instruction">
                  <span className="step-instruction-icon">2</span>
                  <div><strong>Select what you want to share</strong><p>You can choose several files at once or add more files before sending. When your selection is ready, press <b>Send</b> and keep NearShare open until the transfer finishes.</p></div>
                </div>
                {dataChannelReady ? (
                  <div className="peer-connected" role="status">
                    <strong>Direct connection ready</strong>
                    <p>You can now send files to the receiving device.</p>
                  </div>
                ) : connectionStatus === 'Reconnecting...' ? (
                  <div className="peer-connected" role="status">
                    <strong>Restoring connection</strong>
                    <p>NearShare is trying to reconnect to the same receiving session. Keep both devices open.</p>
                  </div>
                ) : (
                  <div className="pairing-error" role="alert">
                    <strong>Connection lost</strong>
                    <p>The receiving device is no longer connected. You can retry automatically while the recovery window is active, or enter a new pairing code.</p>
                    <button
                      className="back-button"
                      onClick={() => {
                        clearSenderRecovery()
                        sessionActiveRef.current = false
                        activeSenderCodeRef.current = ''
                        recoveryAttemptRef.current = false
                        if (retryTimerRef.current !== null) {
                          window.clearTimeout(retryTimerRef.current)
                          retryTimerRef.current = null
                        }
                        const socket = socketRef.current
                        socketRef.current = null
                        if (socket) socket.close()
                        closePeerConnection()
                        setEnteredCode('')
                        setError('Enter a new pairing code from the receiving device to continue.')
                        setSenderStep('connect')
                      }}
                    >
                      Reconnect
                    </button>
                  </div>
                )}

                <button className="file-picker" onClick={openFilePicker}>
                  <span className="file-picker-icon" aria-hidden="true">+</span>
                  <span className="file-picker-title">{files.length > 0 ? 'Add more files' : 'Select files from your device'}</span>
                  <span className="file-picker-description">Choose documents, photos, videos, or other files</span>
                </button>
                <input ref={fileInputRef} type="file" multiple hidden onChange={handleFilesSelected} />

                {files.length > 0 && (
                  <div className="selected-files">
                    <div className="selected-files-header">
                      <h2>Selected files ({files.length})</h2>
                      <span className="total-size">Total: {formatFileSize(totalSize)}</span>
                    </div>
                    {files.map((file, index) => (
                      <div className="file-row" key={`${file.name}-${file.lastModified}-${index}`}>
                        <span className="file-symbol" aria-hidden="true">▤</span>
                        <span className="file-details">
                          <span className="file-name">{file.name}</span>
                          <span className="file-size">{formatFileSize(file.size)}</span>
                        </span>
                        <button className="remove-file-button" onClick={() => removeFile(index)} aria-label={`Remove ${file.name}`} title="Remove file">×</button>
                      </div>
                    ))}
                  </div>
                )}

                {error && <p className="pairing-error" role="alert">{error}</p>}
                {!dataChannelReady && !error && (
                  <p className="pairing-error" role="alert">
                    The direct connection is unavailable. Reconnect before sending files.
                  </p>
                )}
                {isSending && (
                  <>
                    <p className="pairing-status" role="status">Sending files... {transferProgress}%</p>
                    <progress className="transfer-progress" max={100} value={transferProgress} />
                  </>
                )}
                <button
                  className="connect-button"
                  onClick={() => void sendFiles()}
                  disabled={files.length === 0 || isSending || !dataChannelReady}
                >
                  {isSending ? 'Sending...' : `Send ${files.length} file${files.length === 1 ? '' : 's'}`}
                </button>
              </>
            )}

            {senderStep === 'success' && (
              <>
                <h1>Files sent successfully!</h1>
                <p className="intro">NearShare has finished sending the selected files.</p>
                <div className="step-instruction">
                  <span className="step-instruction-icon">3</span>
                  <div><strong>What would you like to do next?</strong><p><b>Send more files</b> keeps this connection open so you can select another batch. <b>Disconnect</b> ends the session and returns you to the home page.</p></div>
                </div>
                {!dataChannelReady && error && (
                  <p className="pairing-error" role="alert">{error}</p>
                )}
                <div className="peer-connected" role="status">
                  <strong>Transfer complete</strong>
                  <p>{sentFiles.length} file{sentFiles.length === 1 ? '' : 's'} sent · {formatFileSize(sentFiles.reduce((total, file) => total + file.size, 0))} total</p>
                </div>
                <div className="selected-files">
                  <div className="selected-files-header">
                    <h2>Sent files ({sentFiles.length})</h2>
                  </div>
                  {sentFiles.map((file, index) => (
                    <div className="file-row" key={`${file.name}-${index}`}>
                      <span className="file-symbol" aria-hidden="true">✓</span>
                      <span className="file-details">
                        <span className="file-name">{file.name}</span>
                        <span className="file-size">{formatFileSize(file.size)}</span>
                      </span>
                    </div>
                  ))}
                </div>
                <button className="connect-button" onClick={sendMoreFiles}>Send more files</button>
                <button className="connect-button" onClick={() => openScreen('home')}>Disconnect</button>
              </>
            )}
          </section>
        )}


        {screen === 'receive' && (

          <section className="sub-screen receive-screen">

            <button className="back-button" onClick={() => openScreen('home')}>← Back</button>

            <div className="eyebrow">READY TO RECEIVE</div>

            <h1>Connect a device</h1>

            <p className="intro">Enter this code on the device you want to send files from.</p>

            <div className="step-instruction">
              <span className="step-instruction-icon">1</span>
              <div><strong>Share this code with the sending device</strong><p>Open NearShare on your other device, choose <b>Send files</b>, and enter the six-digit code below. Keep this page open while connecting and receiving files.</p></div>
            </div>

            <div className="pairing-code-card">

              <span className="pairing-code-label">YOUR PAIRING CODE</span>

              <div className="pairing-code">{pairingCode || '------'}</div>

              <p>
                {peerJoined
                  ? 'Pairing code used. Your devices are connected.'
                  : codeExpiresAt === null
                    ? 'Preparing your pairing code...'
                    : `Code expires in ${formatCountdown(codeSecondsLeft)}.`}
              </p>

            </div>

            <div className="waiting-indicator"><span className="status-dot" />{pairingStatus || 'Connecting to signaling server...'}</div>

            {peerJoined && (

              <div className="peer-connected" role="status">

                <strong>{dataChannelReady ? 'Direct connection ready!' : 'Device paired!'}</strong>

                <p>{dataChannelReady ? 'You can now receive files directly from the other device.' : 'Negotiating a direct connection...'}</p>

              </div>

            )}

            {error && <p className="pairing-error" role="alert">{error}</p>}

            {transferStatus && <p className="pairing-status" role="status">{transferStatus}</p>}

            {(transferStatus || transferProgress > 0) && <progress className="transfer-progress" max={100} value={transferProgress} />}

            {peerJoined && dataChannelReady && (
              <div className="step-instruction">
                <span className="step-instruction-icon">2</span>
                <div><strong>Ready to receive</strong><p>Keep this page open. When the other device sends files, your browser will download them. Check your device's Downloads folder if you don't see them immediately.</p></div>
              </div>
            )}

            {receivedFiles.length > 0 && (

              <div className="selected-files">

                <h2>Received files</h2>

                {receivedFiles.map((name, index) => <p className="pairing-status" key={`${name}-${index}`}>✓ {name}</p>)}

              </div>

            )}

            <button className="connect-button" onClick={() => openScreen('home')}>Disconnect</button>

          </section>

        )}

      </main>



      <footer className="footer"><span>NearShare</span><span>Simple file sharing between devices</span></footer>

    </div>

  )

}



function WorkflowIllustration({ kind }: { kind: 'connect' | 'choose' | 'transfer' }) {
  if (kind === 'connect') {
    return (
      <svg viewBox="0 0 250 112" role="img" aria-label="A phone and computer pairing with a code">
        <rect x="22" y="13" width="54" height="84" rx="10" fill="#ffffff" stroke="#64748b" strokeWidth="2" />
        <rect x="29" y="23" width="40" height="60" rx="4" fill="#eef2ff" />
        <circle cx="49" cy="90" r="2.5" fill="#94a3b8" />
        <rect x="145" y="23" width="82" height="55" rx="5" fill="#ffffff" stroke="#64748b" strokeWidth="2" />
        <path d="M137 86h98l-8 8h-82z" fill="#cbd5e1" stroke="#64748b" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M78 54h57" stroke="#6366f1" strokeWidth="2.5" strokeDasharray="4 4" strokeLinecap="round" />
        <path d="m127 47 8 7-8 7" fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="88" y="34" width="40" height="24" rx="6" fill="#e0e7ff" stroke="#a5b4fc" />
        <text x="108" y="49.5" textAnchor="middle" fontSize="9" fontWeight="700" fill="#4338ca">123456</text>
        <circle cx="49" cy="48" r="10" fill="#c7d2fe" />
        <path d="M43 48h12M49 42v12" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" />
        <rect x="161" y="38" width="50" height="7" rx="3.5" fill="#e2e8f0" />
        <rect x="161" y="51" width="34" height="6" rx="3" fill="#c7d2fe" />
      </svg>
    )
  }

  if (kind === 'choose') {
    return (
      <svg viewBox="0 0 250 112" role="img" aria-label="Selecting files to send">
        <rect x="75" y="13" width="69" height="86" rx="8" fill="#ffffff" stroke="#94a3b8" strokeWidth="2" />
        <path d="M124 13v20h20" fill="#e0e7ff" stroke="#94a3b8" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M90 47h37M90 57h37M90 67h26" stroke="#cbd5e1" strokeWidth="4" strokeLinecap="round" />
        <rect x="91" y="78" width="36" height="12" rx="4" fill="#e0e7ff" />
        <path d="M108 81v6M105 84h6" stroke="#4f46e5" strokeWidth="1.6" strokeLinecap="round" />
        <rect x="36" y="29" width="34" height="43" rx="6" fill="#dbeafe" stroke="#93c5fd" strokeWidth="1.5" />
        <path d="M44 42h18M44 50h14M44 58h10" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" />
        <rect x="153" y="39" width="39" height="47" rx="6" fill="#ede9fe" stroke="#c4b5fd" strokeWidth="1.5" />
        <path d="M162 52h20M162 60h20M162 68h13" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="202" cy="30" r="17" fill="#4f46e5" />
        <path d="M202 22v16M194 30h16" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 250 112" role="img" aria-label="Files moving from one device to another">
      <rect x="14" y="20" width="55" height="73" rx="9" fill="#ffffff" stroke="#64748b" strokeWidth="2" />
      <rect x="21" y="29" width="41" height="51" rx="4" fill="#eef2ff" />
      <circle cx="41.5" cy="86" r="2.5" fill="#94a3b8" />
      <rect x="181" y="25" width="58" height="42" rx="4" fill="#ffffff" stroke="#64748b" strokeWidth="2" />
      <path d="M173 75h74l-7 7h-60z" fill="#cbd5e1" stroke="#64748b" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M75 55h96" stroke="#6366f1" strokeWidth="3" strokeLinecap="round" />
      <path d="m161 45 11 10-11 10" fill="none" stroke="#6366f1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="91" y="27" width="28" height="35" rx="4" fill="#dbeafe" stroke="#93c5fd" strokeWidth="1.5" />
      <path d="M98 38h14M98 45h14M98 52h9" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" />
      <rect x="128" y="48" width="25" height="31" rx="4" fill="#ede9fe" stroke="#c4b5fd" strokeWidth="1.5" />
      <path d="M134 58h13M134 64h13M134 70h8" stroke="#8b5cf6" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="208" cy="44" r="9" fill="#dcfce7" stroke="#86efac" />
      <path d="m204 44 3 3 5-6" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}


function formatCountdown(totalSeconds: number): string {
  const safeSeconds = Math.max(0, totalSeconds)
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = safeSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function sanitizeFileName(name: string): string {

  const cleaned = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').trim()

  return cleaned || 'received-file'

}



function downloadBlob(blob: Blob, name: string) {

  const url = URL.createObjectURL(blob)

  const anchor = document.createElement('a')

  anchor.href = url

  anchor.download = name

  anchor.style.display = 'none'

  document.body.appendChild(anchor)

  anchor.click()

  anchor.remove()

  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)

}



function getErrorMessage(error: unknown, fallback: string): string {

  return error instanceof Error ? error.message : fallback

}



function formatFileSize(bytes: number): string {

  if (bytes < 1024) return `${bytes} B`

  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`

}



export default App
